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
    await this.approvals.open(ctx, {
      type: 'refund',
      entityType: 'refund',
      entityId: r!.id,
      requiredPermission: 'refunds.approve',
      summary: `${number} · ${info.label}: ${r!.amountBase} ${ctx.tenant.baseCurrency}`,
      payload: { customerId: info.customerId, amountBase: r!.amountBase, sourceType: input.sourceType, sourceId: input.sourceId },
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
      counterLines: [{ account: ACCOUNTS.CUSTOMER_ADVANCES, debit: r.amountBase, customerId: r.customerId, memo: `refund:${r.sourceType}` }],
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
    return r;
  }
}
