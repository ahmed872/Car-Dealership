import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  allocatePayment,
  AllocationComponent,
  AllocationLine,
  buildSchedule,
  CurrencyCode,
  d,
  FutureInterestPolicy,
  InstallmentState,
  InstallmentTermsInput,
  settlementAllocation,
  SettlementAllocation,
  sum,
  todayInZone,
  validateScheduleInput,
  zEarlySettlement,
  zInstallmentListQuery,
} from '@autohub/shared';
import { assertBranchAccess, assertPermission, TenantContext } from '../../common/context';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { customers, installmentAllocations, installmentPlans, installments, receipts, sales } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { ReceiptsService } from '../finance/receipts.service';
import { JobsService } from '../jobs/jobs.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingLine, PostingService } from '../ledger/posting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommissionsService } from './commissions.service';

type PlanRow = typeof installmentPlans.$inferSelect;
type SaleRow = typeof sales.$inferSelect;

const REMINDER_JOB = 'installments.reminders';

/**
 * In-house installment plans (B-003/B-004/B-005). The schedule is frozen when the sale is
 * confirmed; collection starts when the sale is recognised. A payment is allocated oldest
 * installment first in the company's component order; the interest and fees it covers are
 * released from deferred finance income (2400) to finance income (4100). No late fees.
 */
@Injectable()
export class InstallmentsService {
  /** Settlement allocations in flight, keyed by plan id (set only around one receive() call). */
  private readonly settling = new Map<string, SettlementAllocation>();

  constructor(
    private readonly dbs: DbService,
    private readonly posting: PostingService,
    private readonly receipts: ReceiptsService,
    private readonly commissions: CommissionsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    jobs: JobsService,
  ) {
    ReceiptsService.register('installment', {
      describe: async (planId, lock) => {
        const { plan, sale } = await this.planWithSale(planId, lock);
        const st = await this.state(plan.id);
        const outstanding = this.outstanding(st);
        return {
          customerId: plan.customerId,
          branchId: sale.branchId,
          label: `${sale.number} (installments)`,
          acceptsPayment: plan.status === 'active',
          outstandingBase: outstanding.toFixed(2),
        };
      },
      creditLines: async (planId, amountBase, customerId) => {
        const { plan } = await this.planWithSale(planId, false);
        const lines = await this.allocationFor(plan, amountBase);
        return this.creditLinesFor(plan, lines, amountBase, customerId);
      },
      afterReceived: async (ctx, planId, amountBase, receipt) => {
        const { plan, sale } = await this.planWithSale(planId, true);
        const lines = await this.allocationFor(plan, amountBase);
        await this.dbs.db.insert(installmentAllocations).values(
          lines.map((l) => ({
            tenantId: ctx.tenant.id,
            receiptId: receipt.id,
            planId: plan.id,
            installmentId: l.installmentId,
            principal: l.principal,
            interest: l.interest,
            fees: l.fees,
          })),
        );
        const st = await this.state(plan.id);
        if (this.outstanding(st).isZero() && plan.status === 'active' && !this.settling.has(plan.id)) {
          await this.dbs.db.update(installmentPlans).set({ status: 'completed', version: plan.version + 1 }).where(eq(installmentPlans.id, plan.id));
          await this.audit.record({ action: 'installment_plan.completed', entityType: 'installment_plan', entityId: plan.id, summary: sale.number });
          await this.commissions.checkEarned(ctx, sale, await this.saleFullyPaid(sale, 'completed'));
        }
      },
      beforeVoid: async (_ctx, planId) => {
        const { plan } = await this.planWithSale(planId, true);
        if (plan.status === 'settled') throw conflict('plan_settled', 'This plan was settled early; its payments cannot be voided');
        if (plan.status === 'cancelled') throw conflict('plan_cancelled', 'The sale was cancelled or returned; refund the customer credit instead');
        if (plan.status === 'completed') {
          await this.dbs.db.update(installmentPlans).set({ status: 'active', version: plan.version + 1 }).where(eq(installmentPlans.id, plan.id));
        }
      },
    });
    jobs.register({ name: REMINDER_JOB, everyMs: 6 * 60 * 60_000, run: (ctx) => this.remind(ctx) });
  }

  // ── State ─────────────────────────────────────────────────────────────────────────────

  private async planWithSale(planId: string, lock: boolean): Promise<{ plan: PlanRow; sale: SaleRow }> {
    const q = this.dbs.db.select().from(installmentPlans).where(eq(installmentPlans.id, planId));
    const [plan] = lock ? await q.for('update') : await q;
    if (!plan) throw notFound('Installment plan');
    const [sale] = await this.dbs.db.select().from(sales).where(eq(sales.id, plan.saleId));
    return { plan, sale: sale! };
  }

  /** Installments with what has been paid on them (receipts that are still posted). */
  async state(planId: string): Promise<InstallmentState[]> {
    const rows = await this.dbs.db
      .select({
        id: installments.id,
        seq: installments.seq,
        dueDate: installments.dueDate,
        principalDue: installments.principalDue,
        interestDue: installments.interestDue,
        feesDue: installments.feesDue,
        principalPaid: sql<string>`coalesce((SELECT sum(a.principal) FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.installment_id = installments.id AND r.status = 'posted'), 0)::numeric(18,2)::text`,
        interestPaid: sql<string>`coalesce((SELECT sum(a.interest) FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.installment_id = installments.id AND r.status = 'posted'), 0)::numeric(18,2)::text`,
        feesPaid: sql<string>`coalesce((SELECT sum(a.fees) FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.installment_id = installments.id AND r.status = 'posted'), 0)::numeric(18,2)::text`,
      })
      .from(installments)
      .where(eq(installments.planId, planId))
      .orderBy(asc(installments.seq));
    return rows;
  }

  private outstanding(st: InstallmentState[]) {
    return sum(
      st.map((i) =>
        d(i.principalDue).minus(i.principalPaid).plus(d(i.interestDue).minus(i.interestPaid)).plus(d(i.feesDue).minus(i.feesPaid)),
      ),
    );
  }

  private async allocationFor(plan: PlanRow, amountBase: string): Promise<AllocationLine[]> {
    const settlement = this.settling.get(plan.id);
    if (settlement) return settlement.lines;
    const st = await this.state(plan.id);
    const res = allocatePayment(st, amountBase, await this.baseCurrency(), plan.allocationOrder as AllocationComponent[]);
    if (!d(res.unallocated).isZero()) throw conflict('overpayment', 'The amount exceeds what is due on the plan', { unallocated: res.unallocated });
    return res.lines;
  }

  private async baseCurrency(): Promise<CurrencyCode> {
    const [t] = await this.dbs.query<{ base_currency: CurrencyCode }>(`SELECT base_currency FROM tenants WHERE id = app_current_tenant()`);
    return t!.base_currency;
  }

  private creditLinesFor(plan: PlanRow, lines: AllocationLine[], amountBase: string, customerId: string): PostingLine[] {
    const income = sum(lines.map((l) => d(l.interest).plus(l.fees)));
    const out: PostingLine[] = [{ account: ACCOUNTS.RECEIVABLES, credit: amountBase, customerId, saleId: plan.saleId, memo: 'installment' }];
    if (income.gt(0)) {
      out.push(
        { account: ACCOUNTS.DEFERRED_FINANCE_INCOME, debit: income.toFixed(2), saleId: plan.saleId },
        { account: ACCOUNTS.FINANCE_INCOME, credit: income.toFixed(2), customerId, saleId: plan.saleId },
      );
    }
    return out;
  }

  /** Whether the sale is fully paid given the plan is in `planStatus` (used for commissions). */
  async saleFullyPaid(sale: SaleRow, planStatus: string): Promise<boolean> {
    const held = d(await this.receipts.receivedBase('sale', sale.id)).plus(sale.tradeInCredit).plus(sale.depositTransferred);
    return ['completed', 'settled'].includes(planStatus) && held.gte(d(sale.downPayment ?? '0'));
  }

  // ── Lifecycle (called by the sales workflow) ──────────────────────────────────────────

  /** Validates terms for a financed amount (draft time, no side effects). */
  previewSchedule(ctx: TenantContext, financed: string, terms: InstallmentTermsInput) {
    const input = {
      principal: financed,
      annualRatePct: terms.method === 'zero_interest' ? '0' : terms.annualRatePct,
      count: terms.count,
      frequencyMonths: terms.frequencyMonths,
      firstDueDate: terms.firstDueDate,
      method: terms.method,
      feesTotal: terms.feesTotal ?? '0',
      currency: ctx.tenant.baseCurrency,
      rounding: ctx.tenant.settings.rounding,
    };
    const errors = validateScheduleInput(input);
    if (errors.length) throw unprocessable('invalid_installment_terms', errors.join('; '), { errors });
    return buildSchedule(input);
  }

  /** At confirmation: the plan with its frozen schedule ("scheduled" until the sale is recognised). */
  async createScheduled(ctx: TenantContext, sale: SaleRow, terms: InstallmentTermsInput): Promise<PlanRow> {
    const schedule = this.previewSchedule(ctx, sale.financedAmount!, terms);
    const settings = ctx.tenant.settings.installments;
    const policy: FutureInterestPolicy =
      terms.method === 'flat' ? settings.futureInterestPolicyFlat : terms.method === 'reducing_balance' ? settings.futureInterestPolicyReducing : 'waive_all';
    const [plan] = await this.dbs.db
      .insert(installmentPlans)
      .values({
        tenantId: ctx.tenant.id,
        saleId: sale.id,
        customerId: sale.customerId,
        method: terms.method,
        annualRatePct: terms.method === 'zero_interest' ? '0' : terms.annualRatePct,
        periodicRatePct: schedule.periodicRatePct,
        count: terms.count,
        frequencyMonths: terms.frequencyMonths,
        firstDueDate: terms.firstDueDate,
        principal: schedule.totals.principal,
        interestTotal: schedule.totals.interest,
        feesTotal: schedule.totals.fees,
        totalAmount: schedule.totals.total,
        allocationOrder: settings.allocationOrder,
        futureInterestPolicy: policy,
        status: 'scheduled',
        createdBy: ctx.userId,
      })
      .returning();
    await this.dbs.db.insert(installments).values(
      schedule.lines.map((l) => ({
        tenantId: ctx.tenant.id,
        planId: plan!.id,
        seq: l.seq,
        dueDate: l.dueDate,
        principalDue: l.principal,
        interestDue: l.interest,
        feesDue: l.fees,
        totalDue: l.total,
      })),
    );
    await this.audit.record({ action: 'installment_plan.created', entityType: 'installment_plan', entityId: plan!.id, summary: `${sale.number}: ${schedule.totals.total}`, after: { ...plan, lines: schedule.lines.length } });
    return plan!;
  }

  async forSale(saleId: string, lock = false): Promise<PlanRow | null> {
    const q = this.dbs.db.select().from(installmentPlans).where(eq(installmentPlans.saleId, saleId));
    const [p] = lock ? await q.for('update') : await q;
    return p ?? null;
  }

  async activate(ctx: TenantContext, plan: PlanRow): Promise<void> {
    if (plan.status !== 'scheduled') return;
    await this.dbs.db.update(installmentPlans).set({ status: 'active', activatedAt: new Date(), version: plan.version + 1 }).where(eq(installmentPlans.id, plan.id));
    await this.audit.record({ action: 'installment_plan.activated', entityType: 'installment_plan', entityId: plan.id, before: { status: 'scheduled' }, after: { status: 'active' } });
  }

  /** Money collected on the plan (posted receipts) and the finance income it released. */
  async collected(planId: string): Promise<{ total: string; income: string }> {
    const [row] = await this.dbs.query<{ total: string; income: string }>(
      `SELECT coalesce(sum(a.principal + a.interest + a.fees), 0)::numeric(18,2)::text AS total,
              coalesce(sum(a.interest + a.fees), 0)::numeric(18,2)::text AS income
         FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id
        WHERE a.plan_id = $1 AND r.status = 'posted'`,
      [planId],
    );
    return row ?? { total: '0.00', income: '0.00' };
  }

  /**
   * Cancellation/return of the sale: the plan stops; money already collected becomes customer
   * credit (Dr 1200 / Cr 2100) and the finance income it released is taken back (Dr 4100 /
   * Cr 2400), so reversing the recognition entry leaves AR and deferred income at zero.
   */
  async unwind(ctx: TenantContext, plan: PlanRow, sale: SaleRow, date: string): Promise<string> {
    const c = await this.collected(plan.id);
    if (plan.status === 'settled' && d(plan.waivedInterest).gt(0)) {
      await this.posting.reverse({ sourceType: 'installment_plan', sourceId: plan.id, event: 'plan.settlement_waiver' }, 'plan.settlement_waiver.reversed', date, `Sale ${sale.number} unwound`);
    }
    if (d(c.total).gt(0)) {
      const lines: PostingLine[] = [
        { account: ACCOUNTS.RECEIVABLES, debit: c.total, customerId: sale.customerId, saleId: sale.id },
        { account: ACCOUNTS.CUSTOMER_ADVANCES, credit: c.total, customerId: sale.customerId, saleId: sale.id, memo: 'installments collected' },
      ];
      if (d(c.income).gt(0)) {
        lines.push(
          { account: ACCOUNTS.FINANCE_INCOME, debit: c.income, customerId: sale.customerId, saleId: sale.id },
          { account: ACCOUNTS.DEFERRED_FINANCE_INCOME, credit: c.income, saleId: sale.id },
        );
      }
      await this.posting.post({ sourceType: 'installment_plan', sourceId: plan.id, event: 'plan.unwound', date, description: `Installments of ${sale.number} unwound`, branchId: sale.branchId, lines });
    }
    await this.dbs.db.update(installmentPlans).set({ status: 'cancelled', cancelledAt: new Date(), version: plan.version + 1 }).where(eq(installmentPlans.id, plan.id));
    await this.audit.record({ action: 'installment_plan.cancelled', entityType: 'installment_plan', entityId: plan.id, before: { status: plan.status }, after: { status: 'cancelled', collectedToCredit: c.total } });
    return c.total;
  }

  // ── Early settlement ──────────────────────────────────────────────────────────────────

  private policyFor(plan: PlanRow, override?: FutureInterestPolicy): FutureInterestPolicy {
    return override ?? (plan.futureInterestPolicy as FutureInterestPolicy);
  }

  async quote(ctx: TenantContext, planId: string, q: { asOf?: string; futureInterestPolicy?: FutureInterestPolicy }) {
    const { plan, sale } = await this.planWithSale(planId, false);
    assertBranchAccess(ctx, sale.branchId);
    if (plan.status !== 'active') throw conflict('plan_not_active', 'Only active plans can be settled', { status: plan.status });
    const asOf = q.asOf ?? todayInZone(ctx.tenant.settings.timezone);
    const alloc = settlementAllocation(await this.state(plan.id), asOf, this.policyFor(plan, q.futureInterestPolicy), ctx.tenant.baseCurrency);
    return { asOf, policy: this.policyFor(plan, q.futureInterestPolicy), ...alloc.quote, lines: alloc.lines };
  }

  async settle(ctx: TenantContext, planId: string, input: z.infer<typeof zEarlySettlement>) {
    assertPermission(ctx, 'installments.settle');
    const { plan, sale } = await this.planWithSale(planId, true);
    assertBranchAccess(ctx, sale.branchId);
    if (plan.status !== 'active') throw conflict('plan_not_active', 'Only active plans can be settled', { status: plan.status });
    const asOf = input.paidAt ?? todayInZone(ctx.tenant.settings.timezone);
    const alloc = settlementAllocation(await this.state(plan.id), asOf, this.policyFor(plan, input.futureInterestPolicy), ctx.tenant.baseCurrency);
    if (alloc.quote.total !== d(input.expectedTotal).toFixed(2)) {
      throw conflict('quote_changed', 'The settlement amount changed since the quote; get a new quote', { total: alloc.quote.total });
    }
    if (d(alloc.quote.total).lte(0)) throw conflict('nothing_due', 'Nothing is due on this plan');
    this.settling.set(plan.id, alloc);
    let receipt;
    try {
      receipt = await this.receipts.receive(ctx, {
        customerId: plan.customerId,
        cashAccountId: input.cashAccountId,
        amount: alloc.quote.total,
        exchangeRate: input.exchangeRate ?? null,
        method: input.method,
        reference: input.reference ?? null,
        notes: `Early settlement ${sale.number}`,
        receivedAt: asOf,
        branchId: sale.branchId,
        allocateTo: { targetType: 'installment', targetId: plan.id },
      });
    } finally {
      this.settling.delete(plan.id);
    }
    if (d(receipt.amountBase).toFixed(2) !== alloc.quote.total) {
      throw conflict('base_currency_only', 'Settle from a base-currency account (the amount must equal the quote exactly)');
    }
    const waived = alloc.quote.waivedInterest;
    if (d(waived).gt(0)) {
      // Forgiven interest leaves both the receivable and the deferred income.
      await this.posting.post({
        sourceType: 'installment_plan',
        sourceId: plan.id,
        event: 'plan.settlement_waiver',
        date: asOf,
        description: `Interest waived on early settlement of ${sale.number}`,
        branchId: sale.branchId,
        lines: [
          { account: ACCOUNTS.DEFERRED_FINANCE_INCOME, debit: waived, saleId: sale.id },
          { account: ACCOUNTS.RECEIVABLES, credit: waived, customerId: sale.customerId, saleId: sale.id },
        ],
      });
    }
    const [after] = await this.dbs.db
      .update(installmentPlans)
      .set({ status: 'settled', settledAt: new Date(), waivedInterest: waived, version: plan.version + 1 })
      .where(eq(installmentPlans.id, plan.id))
      .returning();
    await this.audit.record({
      action: 'installment_plan.settled',
      entityType: 'installment_plan',
      entityId: plan.id,
      before: { status: 'active' },
      after: { status: 'settled', paid: alloc.quote.total, waivedInterest: waived, receiptId: receipt.id },
    });
    await this.commissions.checkEarned(ctx, sale, await this.saleFullyPaid(sale, 'settled'));
    return { plan: after!, receipt, quote: alloc.quote };
  }

  // ── Queries ───────────────────────────────────────────────────────────────────────────

  async get(ctx: TenantContext, planId: string) {
    const { plan, sale } = await this.planWithSale(planId, false);
    assertBranchAccess(ctx, sale.branchId);
    const st = await this.state(plan.id);
    const today = todayInZone(ctx.tenant.settings.timezone);
    // Only an active plan has anything left to collect: after early settlement the unpaid
    // remainder is waived interest; after cancellation the collected money is customer credit.
    const closed = plan.status === 'settled' ? 'waived' : plan.status === 'cancelled' ? 'cancelled' : null;
    const lines = st.map((i) => {
      const due = d(i.principalDue).plus(i.interestDue).plus(i.feesDue);
      const paid = d(i.principalPaid).plus(i.interestPaid).plus(i.feesPaid);
      const unpaid = due.minus(paid);
      const remaining = closed ? d(0) : unpaid;
      return {
        ...i,
        totalDue: due.toFixed(2),
        paid: paid.toFixed(2),
        remaining: remaining.toFixed(2),
        waived: closed === 'waived' && unpaid.gt(0) ? unpaid.toFixed(2) : '0.00',
        status: unpaid.lte(0)
          ? 'paid'
          : closed ?? (paid.gt(0) ? (i.dueDate < today ? 'overdue' : 'partial') : i.dueDate < today ? 'overdue' : 'due'),
      };
    });
    const payments = await this.dbs.db
      .select({ receiptId: receipts.id, number: receipts.number, receivedAt: receipts.receivedAt, status: receipts.status, amount: sql<string>`sum(${installmentAllocations.principal} + ${installmentAllocations.interest} + ${installmentAllocations.fees})::numeric(18,2)::text` })
      .from(installmentAllocations)
      .innerJoin(receipts, eq(receipts.id, installmentAllocations.receiptId))
      .where(eq(installmentAllocations.planId, plan.id))
      .groupBy(receipts.id)
      .orderBy(asc(receipts.receivedAt));
    return {
      ...plan,
      saleNumber: sale.number,
      outstanding: closed ? '0.00' : this.outstanding(st).toFixed(2),
      overdueAmount: sum(lines.filter((l) => l.status === 'overdue').map((l) => l.remaining)).toFixed(2),
      lines,
      payments,
    };
  }

  async list(ctx: TenantContext, q: z.infer<typeof zInstallmentListQuery>) {
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(installmentPlans.status, q.status));
    if (q.customerId) conds.push(eq(installmentPlans.customerId, q.customerId));
    if (!ctx.allBranches) conds.push(ctx.branchIds.length ? inArray(sales.branchId, ctx.branchIds) : sql`false`);
    const today = todayInZone(ctx.tenant.settings.timezone);
    // Overdue = an installment due before today that is not fully paid by posted receipts.
    const overdueSql = sql<string>`(CASE WHEN installment_plans.status = 'active' THEN coalesce((
      SELECT sum(i.total_due - coalesce((SELECT sum(a.principal + a.interest + a.fees) FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.installment_id = i.id AND r.status = 'posted'), 0))
        FROM installments i WHERE i.plan_id = installment_plans.id AND i.due_date < ${today}::date), 0) ELSE 0 END)::numeric(18,2)::text`;
    if (q.overdue === 'true') conds.push(sql`${overdueSql}::numeric > 0`);
    const where = conds.length ? and(...conds) : undefined;
    const [items, [total]] = await Promise.all([
      this.dbs.db
        .select({ p: installmentPlans, saleNumber: sales.number, customerName: customers.fullName, overdueAmount: overdueSql })
        .from(installmentPlans)
        .innerJoin(sales, eq(sales.id, installmentPlans.saleId))
        .innerJoin(customers, eq(customers.id, installmentPlans.customerId))
        .where(where)
        .orderBy(desc(installmentPlans.createdAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(installmentPlans).innerJoin(sales, eq(sales.id, installmentPlans.saleId)).where(where),
    ]);
    return { items: items.map((r) => ({ ...r.p, saleNumber: r.saleNumber, customerName: r.customerName, overdueAmount: r.overdueAmount })), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  /** Job: tell the salesperson about installments coming due and overdue (once per state). No late fees (B-004). */
  async remind(ctx: TenantContext): Promise<{ notified: number }> {
    const ahead = ctx.tenant.settings.installments.reminderDaysBefore ?? 3;
    const today = todayInZone(ctx.tenant.settings.timezone);
    const rows = await this.dbs.query<{ id: string; seq: number; due_date: string; plan_id: string; sale_number: string; salesperson_id: string; customer: string; overdue: boolean }>(
      `SELECT i.id, i.seq, i.due_date::text, i.plan_id, s.number AS sale_number, s.salesperson_id, c.full_name AS customer,
              (i.due_date < $1::date) AS overdue
         FROM installments i
         JOIN installment_plans p ON p.id = i.plan_id AND p.status = 'active'
         JOIN sales s ON s.id = p.sale_id
         JOIN customers c ON c.id = p.customer_id
        WHERE i.due_date <= ($1::date + $2::int)
          AND i.total_due > coalesce((SELECT sum(a.principal + a.interest + a.fees) FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.installment_id = i.id AND r.status = 'posted'), 0)
        ORDER BY i.due_date LIMIT 1000`,
      [today, ahead],
    );
    let n = 0;
    for (const r of rows) {
      n += await this.notifications.notify(ctx, {
        userIds: [r.salesperson_id],
        type: r.overdue ? 'installment.overdue' : 'installment.due_soon',
        titleAr: r.overdue ? `قسط متأخر: ${r.sale_number} (#${r.seq})` : `قسط مستحق قريبًا: ${r.sale_number} (#${r.seq})`,
        titleEn: r.overdue ? `Installment overdue: ${r.sale_number} (#${r.seq})` : `Installment due soon: ${r.sale_number} (#${r.seq})`,
        bodyAr: `${r.customer} — ${r.due_date}`,
        bodyEn: `${r.customer} — ${r.due_date}`,
        link: `/app/installments/${r.plan_id}`,
        entityType: 'installment_plan',
        entityId: r.plan_id,
        dedupeKey: `installment.${r.overdue ? 'overdue' : 'due'}:${r.id}`,
        severity: r.overdue ? 'warning' : 'info',
      });
    }
    return { notified: n };
  }

}
