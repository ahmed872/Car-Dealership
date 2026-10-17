import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CommissionRule, computeCommission, d, todayInZone, zCommissionListQuery, zCommissionPay } from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, forbidden, notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { commissions, sales, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { CommissionPoliciesService } from '../employees/commission-policies.service';
import { CashService } from '../finance/cash.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingService } from '../ledger/posting.service';

type SaleRow = typeof sales.$inferSelect;
type CommissionRow = typeof commissions.$inferSelect;

/**
 * Salesperson commissions (B-006/B-007): `expected` at confirmation, `earned` when the policy's
 * trigger occurs on a recognised sale (delivery, or full payment), then approved and paid.
 * Earning posts Dr 6100 / Cr 2300; paying goes through the cash book (Dr 2300 / Cr 1100).
 * A cancelled or returned sale reverses an unpaid commission; a paid one becomes a clawback
 * the employee owes (Dr 1400 / Cr 6100) — history is never deleted.
 */
@Injectable()
export class CommissionsService {
  constructor(
    private readonly dbs: DbService,
    private readonly posting: PostingService,
    private readonly cash: CashService,
    private readonly policies: CommissionPoliciesService,
    private readonly audit: AuditService,
  ) {}

  private async forSale(saleId: string, lock = false): Promise<CommissionRow | null> {
    const q = this.dbs.db.select().from(commissions).where(eq(commissions.saleId, saleId));
    const [c] = lock ? await q.for('update') : await q;
    return c ?? null;
  }

  private compute(ctx: TenantContext, rule: CommissionRule, saleNet: string, cost: string) {
    return computeCommission(rule, {
      saleNet,
      grossProfit: d(saleNet).minus(cost).toFixed(2),
      currency: ctx.tenant.baseCurrency,
    });
  }

  /** At confirmation: the salesperson's policy version in effect on the sale date, as a snapshot. */
  async createExpected(ctx: TenantContext, sale: SaleRow, costAtConfirmation: string): Promise<CommissionRow | null> {
    const policy = await this.policies.policyFor(sale.salespersonId, sale.saleDate);
    if (!policy) return null;
    const rule = policy.rule as CommissionRule & { earnOn?: 'delivery' | 'full_payment' };
    const result = this.compute(ctx, rule, sale.netAmount, costAtConfirmation);
    const [c] = await this.dbs.db
      .insert(commissions)
      .values({
        tenantId: ctx.tenant.id,
        saleId: sale.id,
        userId: sale.salespersonId,
        policyId: policy.id,
        ruleSnapshot: rule,
        earnOn: rule.earnOn ?? 'full_payment',
        baseAmount: result.base,
        amount: result.amount,
        explanation: result.explanation,
        status: 'expected',
      })
      .returning();
    await this.audit.record({ action: 'commission.expected', entityType: 'commission', entityId: c!.id, summary: `${sale.number}: ${result.amount}`, after: c });
    return c!;
  }

  /**
   * Earns the commission once the sale is recognised and the policy trigger holds. Amount is
   * recomputed on the recognised figures (net revenue − COGS). Idempotent.
   */
  async checkEarned(ctx: TenantContext, sale: SaleRow, fullyPaid: boolean): Promise<void> {
    const c = await this.forSale(sale.id, true);
    if (!c || c.status !== 'expected') return;
    if (!sale.recognizedAt || ['cancelled', 'returned'].includes(sale.status)) return;
    if (c.earnOn === 'full_payment' && !fullyPaid) return;
    const result = this.compute(ctx, c.ruleSnapshot as CommissionRule, sale.netAmount, sale.cogsAmount ?? sale.costAtConfirmation ?? '0');
    const today = todayInZone(ctx.tenant.settings.timezone);
    if (d(result.amount).gt(0)) {
      await this.posting.post({
        sourceType: 'commission',
        sourceId: c.id,
        event: 'commission.earned',
        date: today,
        description: `Commission ${sale.number}`,
        branchId: sale.branchId,
        lines: [
          { account: ACCOUNTS.COMMISSION_EXPENSE, debit: result.amount, userId: c.userId, saleId: sale.id },
          { account: ACCOUNTS.COMMISSIONS_PAYABLE, credit: result.amount, userId: c.userId, saleId: sale.id },
        ],
      });
    }
    const [after] = await this.dbs.db
      .update(commissions)
      .set({ status: 'earned', baseAmount: result.base, amount: result.amount, explanation: result.explanation, earnedAt: new Date(), version: c.version + 1 })
      .where(eq(commissions.id, c.id))
      .returning();
    await this.audit.record({ action: 'commission.earned', entityType: 'commission', entityId: c.id, before: { status: c.status, amount: c.amount }, after: { status: 'earned', amount: after!.amount } });
  }

  /** On cancellation/return of the sale. */
  async reverseForSale(ctx: TenantContext, sale: SaleRow, reason: string): Promise<void> {
    const c = await this.forSale(sale.id, true);
    if (!c || ['reversed', 'clawback'].includes(c.status)) return;
    const today = todayInZone(ctx.tenant.settings.timezone);
    let status: 'reversed' | 'clawback' = 'reversed';
    if ((c.status === 'earned' || c.status === 'approved') && d(c.amount).gt(0)) {
      await this.posting.reverse({ sourceType: 'commission', sourceId: c.id, event: 'commission.earned' }, 'commission.earned.reversed', today, `Reversal: ${reason}`.slice(0, 500));
    } else if (c.status === 'paid' && d(c.amount).gt(0)) {
      // Already paid out: the expense is reversed and the employee owes the amount back.
      status = 'clawback';
      await this.posting.post({
        sourceType: 'commission',
        sourceId: c.id,
        event: 'commission.clawback',
        date: today,
        description: `Commission clawback ${sale.number}`,
        branchId: sale.branchId,
        lines: [
          { account: ACCOUNTS.COMMISSION_ADVANCES, debit: c.amount, userId: c.userId, saleId: sale.id },
          { account: ACCOUNTS.COMMISSION_EXPENSE, credit: c.amount, userId: c.userId, saleId: sale.id },
        ],
      });
    }
    await this.dbs.db
      .update(commissions)
      .set({ status, reversedAt: new Date(), reverseReason: reason, version: c.version + 1 })
      .where(eq(commissions.id, c.id));
    await this.audit.record({ action: `commission.${status}`, entityType: 'commission', entityId: c.id, before: { status: c.status }, after: { status, reason } });
  }

  private async lockScoped(ctx: TenantContext, id: string): Promise<{ c: CommissionRow; sale: SaleRow }> {
    const [c] = await this.dbs.db.select().from(commissions).where(eq(commissions.id, id)).for('update');
    if (!c) throw notFound('Commission');
    if (c.userId !== ctx.userId && !hasPermission(ctx, 'commissions.read')) throw notFound('Commission');
    const [sale] = await this.dbs.db.select().from(sales).where(eq(sales.id, c.saleId));
    assertBranchAccess(ctx, sale!.branchId);
    return { c, sale: sale! };
  }

  async approve(ctx: TenantContext, id: string) {
    assertPermission(ctx, 'commissions.approve');
    const { c } = await this.lockScoped(ctx, id);
    if (c.userId === ctx.userId) throw forbidden('You cannot approve your own commission', { code: 'self_approval_forbidden' });
    if (c.status !== 'earned') throw conflict('commission_not_earned', 'Only earned commissions can be approved', { status: c.status });
    const [after] = await this.dbs.db
      .update(commissions)
      .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date(), version: c.version + 1 })
      .where(eq(commissions.id, id))
      .returning();
    await this.audit.record({ action: 'commission.approved', entityType: 'commission', entityId: id, before: { status: 'earned' }, after: { status: 'approved' } });
    return after!;
  }

  async pay(ctx: TenantContext, id: string, input: z.infer<typeof zCommissionPay>) {
    assertPermission(ctx, 'commissions.pay');
    const { c, sale } = await this.lockScoped(ctx, id);
    if (c.status !== 'approved') throw conflict('commission_not_approved', 'Only approved commissions can be paid', { status: c.status });
    const acct = await this.cash.lockAccount(ctx, input.cashAccountId);
    if (acct.currency !== ctx.tenant.baseCurrency) throw conflict('base_currency_only', 'Commissions are paid from a base-currency account');
    const paidAt = input.paidAt ?? todayInZone(ctx.tenant.settings.timezone);
    if (d(c.amount).gt(0)) {
      await this.cash.move(ctx, {
        cashAccountId: acct.id,
        direction: 'out',
        amount: c.amount,
        exchangeRate: '1',
        kind: 'commission_payment',
        sourceType: 'commission',
        sourceId: c.id,
        event: 'commission.paid',
        businessDate: paidAt,
        description: `Commission ${sale.number}`,
        reference: input.reference ?? null,
        branchId: sale.branchId,
        counterLines: [{ account: ACCOUNTS.COMMISSIONS_PAYABLE, debit: c.amount, userId: c.userId, saleId: sale.id }],
      });
    }
    const [after] = await this.dbs.db
      .update(commissions)
      .set({ status: 'paid', paidAt: new Date(), paidFromAccountId: acct.id, version: c.version + 1 })
      .where(eq(commissions.id, id))
      .returning();
    await this.audit.record({ action: 'commission.paid', entityType: 'commission', entityId: id, before: { status: 'approved' }, after: { status: 'paid', cashAccountId: acct.id, method: input.method } });
    return after!;
  }

  private assertCanRead(ctx: TenantContext): void {
    if (!hasPermission(ctx, 'commissions.read') && !hasPermission(ctx, 'commissions.read_own')) {
      throw forbidden('You do not have permission to view commissions', { permission: ['commissions.read', 'commissions.read_own'] });
    }
  }

  async list(ctx: TenantContext, q: z.infer<typeof zCommissionListQuery>) {
    this.assertCanRead(ctx);
    const conds: SQL[] = [];
    const readAll = hasPermission(ctx, 'commissions.read');
    if (!readAll || q.mine === 'true') conds.push(eq(commissions.userId, ctx.userId));
    else if (q.userId) conds.push(eq(commissions.userId, q.userId));
    if (q.status) conds.push(eq(commissions.status, q.status));
    if (q.saleId) conds.push(eq(commissions.saleId, q.saleId));
    if (!ctx.allBranches) conds.push(ctx.branchIds.length ? inArray(sales.branchId, ctx.branchIds) : sql`false`);
    const where = conds.length ? and(...conds) : undefined;
    const [items, [total]] = await Promise.all([
      this.dbs.db
        .select({
          c: commissions,
          saleNumber: sales.number,
          saleStatus: sales.status,
          saleDate: sales.saleDate,
          employeeName: users.fullName,
        })
        .from(commissions)
        .innerJoin(sales, eq(sales.id, commissions.saleId))
        .leftJoin(users, eq(users.id, commissions.userId))
        .where(where)
        .orderBy(desc(commissions.createdAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.dbs.db
        .select({ n: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${commissions.amount}), 0)::numeric(18,2)::text` })
        .from(commissions)
        .innerJoin(sales, eq(sales.id, commissions.saleId))
        .where(where),
    ]);
    return {
      items: items.map((r) => ({ ...r.c, saleNumber: r.saleNumber, saleStatus: r.saleStatus, saleDate: r.saleDate, employeeName: r.employeeName })),
      total: total?.n ?? 0,
      totalAmount: total?.amount ?? '0.00',
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async get(ctx: TenantContext, id: string) {
    this.assertCanRead(ctx);
    const [c] = await this.dbs.db.select().from(commissions).where(eq(commissions.id, id));
    if (!c || (c.userId !== ctx.userId && !hasPermission(ctx, 'commissions.read'))) throw notFound('Commission');
    const [sale] = await this.dbs.db.select({ number: sales.number, branchId: sales.branchId, status: sales.status }).from(sales).where(eq(sales.id, c.saleId));
    assertBranchAccess(ctx, sale!.branchId);
    return { ...c, saleNumber: sale!.number, saleStatus: sale!.status };
  }

  forSaleRead(saleId: string) {
    return this.forSale(saleId);
  }
}
