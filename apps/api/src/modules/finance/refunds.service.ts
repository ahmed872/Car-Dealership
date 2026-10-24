import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql, SQL } from 'drizzle-orm';
import { d, todayInZone } from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, forbidden, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { customers, receiptAllocations, receipts, refunds } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { ACCOUNTS } from '../ledger/chart';
import { NumberingService } from '../numbering/numbering.service';
import { ApprovalsService } from './approvals.service';
import { CashService } from './cash.service';

registerUniqueConstraint('refunds_number_uq', 'refund_number_taken', 'Refund number already exists');

export type RefundSourceType = 'reservation' | 'sale' | 'customer_credit';

export interface RefundSourceInfo {
  customerId: string;
  branchId: string | null;
  label: string;
  /** Base amount that can still be refunded (received − forfeited − refunds requested/approved/paid). */
  refundableBase: string;
}

export interface RefundSourceHandler {
  describe(sourceId: string, lock: boolean): Promise<RefundSourceInfo>;
}

type RefundRow = typeof refunds.$inferSelect;

/** A posted receipt behind a refund's source, as stored (its own currency, amount and rate). */
export interface RefundSourceReceipt {
  receiptId: string;
  number: string;
  receivedAt: string;
  /** What the receipt was allocated to: the source itself, or for a sale its plan / converted reservation. */
  targetType: string;
  currency: string;
  amount: string;
  exchangeRate: string;
  amountBase: string;
  /** Base amount of this receipt allocated to the source. */
  allocatedBase: string;
}

/** Read-only view of the customer money behind a refund (F6: the approver sees foreign rates). */
export interface RefundSourceFunds {
  baseCurrency: string;
  /** True when any of the money came in a currency other than the base currency. */
  foreignCurrency: boolean;
  receipts: RefundSourceReceipt[];
}

/** Refund amounts that are committed (not rejected/cancelled) against a source. */
const COMMITTED = ['requested', 'approved', 'paid'] as const;

/**
 * Customer refunds: requested → approved (maker-checker) → paid. Paying debits customer
 * advances (2100) and credits cash (1100) through the cash book. Amounts are frozen by a trigger
 * once approved; a refund can be rejected or cancelled before it is paid.
 */
@Injectable()
export class RefundsService {
  private static readonly sources = new Map<RefundSourceType, RefundSourceHandler>();

  static register(type: RefundSourceType, handler: RefundSourceHandler): void {
    RefundsService.sources.set(type, handler);
  }

  constructor(
    private readonly dbs: DbService,
    private readonly cash: CashService,
    private readonly approvals: ApprovalsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {
    // Customer credit (advances not tied to a document): received − refunds committed. Amounts
    // applied to sales are subtracted once sales exist (Phase 5 registers its own handler).
    RefundsService.register('customer_credit', {
      describe: async (customerId) => {
        const [c] = await this.dbs.db.select({ id: customers.id, name: customers.fullName, branchId: customers.branchId }).from(customers).where(eq(customers.id, customerId));
        if (!c) throw notFound('Customer');
        const [row] = await this.dbs.db
          .select({ v: sql<string>`coalesce(sum(${receiptAllocations.amountBase}), 0)::numeric(18,2)::text` })
          .from(receiptAllocations)
          .innerJoin(receipts, eq(receipts.id, receiptAllocations.receiptId))
          .where(and(eq(receiptAllocations.targetType, 'customer_credit'), eq(receiptAllocations.targetId, customerId), eq(receipts.status, 'posted')));
        const committed = await this.committedBase('customer_credit', customerId);
        const v = d(row?.v ?? 0).minus(committed);
        return { customerId: c.id, branchId: null, label: c.name, refundableBase: (v.isNegative() ? d(0) : v).toFixed(2) };
      },
    });
  }

  private source(type: RefundSourceType): RefundSourceHandler {
    const h = RefundsService.sources.get(type);
    if (!h) throw unprocessable('unsupported_source', `Refunds from ${type} are not supported yet`);
    return h;
  }

  /** Sum of refunds that are requested, approved or paid against a source. */
  async committedBase(sourceType: RefundSourceType, sourceId: string): Promise<string> {
    const [row] = await this.dbs.db
      .select({ v: sql<string>`coalesce(sum(${refunds.amountBase}), 0)::numeric(18,2)::text` })
      .from(refunds)
      .where(and(eq(refunds.sourceType, sourceType), eq(refunds.sourceId, sourceId), inArray(refunds.status, [...COMMITTED])));
    return row?.v ?? '0.00';
  }

  /**
   * The posted receipts behind a refund source, read from the stored rows: receipts allocated to
   * the source itself, and for a sale also those allocated to its installment plan and to the
   * reservation whose deposit was converted into it.
   */
  async sourceFunds(ctx: TenantContext, sourceType: string, sourceId: string): Promise<RefundSourceFunds> {
    const receipts = await this.dbs.query<RefundSourceReceipt & Record<string, unknown>>(
      `SELECT r.id AS "receiptId", r.number, r.received_at::text AS "receivedAt", ra.target_type AS "targetType",
              r.currency, r.amount::text AS amount, r.exchange_rate::text AS "exchangeRate", r.amount_base::text AS "amountBase",
              ra.amount_base::text AS "allocatedBase"
         FROM receipt_allocations ra
         JOIN receipts r ON r.id = ra.receipt_id
        WHERE r.status = 'posted'
          AND ((ra.target_type = $1 AND ra.target_id = $2)
            OR ($1 = 'sale' AND ra.target_type = 'installment' AND ra.target_id IN (SELECT p.id FROM installment_plans p WHERE p.sale_id = $2))
            OR ($1 = 'sale' AND ra.target_type = 'reservation'
                AND ra.target_id IN (SELECT s.reservation_id FROM sales s WHERE s.id = $2 AND s.deposit_transferred > 0)))
        ORDER BY r.received_at, r.number`,
      [sourceType, sourceId],
    );
    const baseCurrency = ctx.tenant.baseCurrency;
    return { baseCurrency, foreignCurrency: receipts.some((x) => x.currency !== baseCurrency), receipts };
  }

  /**
   * Opens a refund request. `internal` is used by workflows (e.g. reservation cancellation) that
   * already checked their own permission; the request still needs an approver.
   */
  async request(
    ctx: TenantContext,
    input: { sourceType: RefundSourceType; sourceId: string; amountBase: string; reason: string },
    opts: { internal?: boolean } = {},
  ): Promise<RefundRow> {
    if (!opts.internal) assertPermission(ctx, 'refunds.create');
    const amount = d(input.amountBase);
    if (amount.lte(0) || amount.decimalPlaces() > 2) throw unprocessable('invalid_amount', 'Refund amount must be positive with at most 2 decimals');
    const info = await this.source(input.sourceType).describe(input.sourceId, true);
    assertBranchAccess(ctx, info.branchId);
    if (amount.gt(info.refundableBase)) {
      throw conflict('refund_exceeds_available', `The refund exceeds what can be refunded on ${info.label}`, { refundable: info.refundableBase });
    }
    const number = await this.numbering.next('refund');
    const [r] = await this.dbs.db
      .insert(refunds)
      .values({
        tenantId: ctx.tenant.id,
        number,
        customerId: info.customerId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        branchId: info.branchId,
        amountBase: amount.toFixed(2),
        reason: input.reason,
        requestedBy: ctx.userId,
      })
      .returning();
    // The approver must see when the money came in a foreign currency, and at which rate (F6).
    const funds = await this.sourceFunds(ctx, input.sourceType, input.sourceId);
    const foreign = funds.receipts
      .filter((x) => x.currency !== ctx.tenant.baseCurrency)
      .map((x) => ({ number: x.number, currency: x.currency, amount: x.amount, exchangeRate: x.exchangeRate, amountBase: x.amountBase }));
    const foreignNote = foreign.length
      ? ` · ${foreign[0]!.amount} ${foreign[0]!.currency} @ ${d(foreign[0]!.exchangeRate).toString()}${foreign.length > 1 ? ` (+${foreign.length - 1})` : ''}`
      : '';
    await this.approvals.open(ctx, {
      type: 'refund',
      entityType: 'refund',
      entityId: r!.id,
      requiredPermission: 'refunds.approve',
      summary: `${number} · ${info.label}: ${r!.amountBase} ${ctx.tenant.baseCurrency}${foreignNote}`,
      payload: {
        customerId: info.customerId,
        amountBase: r!.amountBase,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        ...(foreign.length ? { foreignReceipts: foreign.slice(0, 20) } : {}),
      },
      branchId: info.branchId,
    });
    await this.audit.record({ action: 'refund.requested', entityType: 'refund', entityId: r!.id, summary: `${number}: ${r!.amountBase}`, after: r });
    return r!;
  }

  private async lock(ctx: TenantContext, id: string): Promise<RefundRow> {
    const [r] = await this.dbs.db.select().from(refunds).where(eq(refunds.id, id)).for('update');
    if (!r) throw notFound('Refund');
    assertBranchAccess(ctx, r.branchId);
    return r;
  }

  async approve(ctx: TenantContext, id: string, note?: string | null) {
    assertPermission(ctx, 'refunds.approve');
    const r = await this.lock(ctx, id);
    if (r.status !== 'requested') throw conflict('refund_not_pending', 'This refund is not awaiting approval');
    await this.approvals.assertNotSelfApproval(ctx, { type: 'refund', entityType: 'refund', entityId: id, makers: [r.requestedBy] });
    // Re-check availability: other refunds or receipt voids may have changed it since the request.
    const info = await this.source(r.sourceType as RefundSourceType).describe(r.sourceId, true);
    const others = d(info.refundableBase).plus(r.amountBase); // this request is already counted as committed
    if (d(r.amountBase).gt(others)) throw conflict('refund_exceeds_available', 'The refund now exceeds what can be refunded', { refundable: others.toFixed(2) });
    const [after] = await this.dbs.db
      .update(refunds)
      .set({ status: 'approved', decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: note ?? null })
      .where(eq(refunds.id, id))
      .returning();
    await this.approvals.resolve(ctx, { type: 'refund', entityType: 'refund', entityId: id, status: 'approved', note });
    await this.audit.record({ action: 'refund.approved', entityType: 'refund', entityId: id, before: { status: r.status }, after: { status: 'approved', note: note ?? null } });
    return after!;
  }

  async reject(ctx: TenantContext, id: string, reason: string) {
    assertPermission(ctx, 'refunds.approve');
    const r = await this.lock(ctx, id);
    if (r.status !== 'requested') throw conflict('refund_not_pending', 'This refund is not awaiting approval');
    const [after] = await this.dbs.db
      .update(refunds)
      .set({ status: 'rejected', decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: reason })
      .where(eq(refunds.id, id))
      .returning();
    await this.approvals.resolve(ctx, { type: 'refund', entityType: 'refund', entityId: id, status: 'rejected', note: reason });
    await this.audit.record({ action: 'refund.rejected', entityType: 'refund', entityId: id, before: { status: r.status }, after: { status: 'rejected', reason } });
    return after!;
  }

  /** The requester (or an approver) can withdraw a refund that has not been paid. */
  async cancel(ctx: TenantContext, id: string, reason: string) {
    const r = await this.lock(ctx, id);
    if (!['requested', 'approved'].includes(r.status)) throw conflict('refund_closed', 'Only unpaid refunds can be cancelled');
    if (r.requestedBy !== ctx.userId && !hasPermission(ctx, 'refunds.approve')) throw forbidden('Only the requester or an approver can cancel this refund');
    const [after] = await this.dbs.db
      .update(refunds)
      .set({ status: 'cancelled', decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: reason })
      .where(eq(refunds.id, id))
      .returning();
    await this.approvals.resolve(ctx, { type: 'refund', entityType: 'refund', entityId: id, status: 'cancelled', note: reason });
    await this.audit.record({ action: 'refund.cancelled', entityType: 'refund', entityId: id, before: { status: r.status }, after: { status: 'cancelled', reason } });
    return after!;
  }

  /** Pays an approved refund from a base-currency cash or bank account (Dr 2100 / Cr 1100). */
  async pay(ctx: TenantContext, id: string, input: { cashAccountId: string; method: string; reference?: string | null; paidAt?: string | null }) {
    assertPermission(ctx, 'payments.receive');
    const r = await this.lock(ctx, id);
    if (r.status !== 'approved') throw conflict('refund_not_approved', 'Only approved refunds can be paid');
    const acct = await this.cash.lockAccount(ctx, input.cashAccountId);
    if (acct.currency !== ctx.tenant.baseCurrency) throw unprocessable('refund_base_currency', 'Refunds are paid from an account in the company base currency');
    const paidAt = input.paidAt ?? todayInZone(ctx.tenant.settings.timezone);
    await this.cash.move(ctx, {
      cashAccountId: acct.id,
      direction: 'out',
      amount: r.amountBase,
      kind: 'customer_refund',
      sourceType: 'refund',
      sourceId: r.id,
      event: 'refund.paid',
      businessDate: paidAt,
      description: `Refund ${r.number}`,
      reference: input.reference ?? null,
      branchId: r.branchId,
      // A sale's credit is tracked on the sale dimension (D-028); refunding it clears that too.
      counterLines: [
        { account: ACCOUNTS.CUSTOMER_ADVANCES, debit: r.amountBase, customerId: r.customerId, ...(r.sourceType === 'sale' ? { saleId: r.sourceId } : {}), memo: `refund:${r.sourceType}` },
      ],
    });
    const [after] = await this.dbs.db
      .update(refunds)
      .set({ status: 'paid', cashAccountId: acct.id, method: input.method, reference: input.reference ?? null, paidAt, paidBy: ctx.userId })
      .where(eq(refunds.id, id))
      .returning();
    await this.audit.record({ action: 'refund.paid', entityType: 'refund', entityId: id, before: { status: 'approved' }, after: { status: 'paid', cashAccountId: acct.id, amountBase: r.amountBase } });
    return after!;
  }

  async list(ctx: TenantContext, f: { status?: string; customerId?: string; sourceType?: string; sourceId?: string; page: number; pageSize: number }) {
    const conds: SQL[] = [];
    if (f.status) conds.push(eq(refunds.status, f.status));
    if (f.customerId) conds.push(eq(refunds.customerId, f.customerId));
    if (f.sourceType) conds.push(eq(refunds.sourceType, f.sourceType));
    if (f.sourceId) conds.push(eq(refunds.sourceId, f.sourceId));
    if (!ctx.allBranches) conds.push(ctx.branchIds.length ? or(isNull(refunds.branchId), inArray(refunds.branchId, ctx.branchIds))! : isNull(refunds.branchId));
    const where = conds.length ? and(...conds) : undefined;
    const items = await this.dbs.db
      .select({ refund: refunds, customerName: customers.fullName })
      .from(refunds)
      .innerJoin(customers, eq(customers.id, refunds.customerId))
      .where(where)
      .orderBy(desc(refunds.requestedAt))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    const [c] = await this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(refunds).where(where);
    return { items: items.map((i) => ({ ...i.refund, customerName: i.customerName })), total: c?.n ?? 0, page: f.page, pageSize: f.pageSize };
  }

  async get(ctx: TenantContext, id: string) {
    const [r] = await this.dbs.db.select().from(refunds).where(eq(refunds.id, id));
    if (!r) throw notFound('Refund');
    assertBranchAccess(ctx, r.branchId);
    return { ...r, sourceFunds: await this.sourceFunds(ctx, r.sourceType, r.sourceId) };
  }
}
