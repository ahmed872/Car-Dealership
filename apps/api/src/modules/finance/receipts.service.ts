import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql, SQL } from 'drizzle-orm';
import { CurrencyCode, d, money, sum, todayInZone } from '@autohub/shared';
import { assertBranchAccess, assertPermission, TenantContext } from '../../common/context';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { cashAccounts, customers, receiptAllocations, receipts } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingLine, PostingService } from '../ledger/posting.service';
import { NumberingService } from '../numbering/numbering.service';
import { CashService } from './cash.service';
import { resolveFx } from './fx';

export type ReceiptTargetType = 'reservation' | 'sale' | 'installment' | 'customer_credit';

export interface ReceiptTargetInfo {
  customerId: string;
  branchId: string | null;
  label: string;
  /** Whether money can be allocated to the target right now. */
  acceptsPayment: boolean;
  /** Maximum base amount still receivable; null = unbounded (customer credit). */
  outstandingBase: string | null;
}

/**
 * A kind of document a customer receipt can pay. Modules register a handler (reservations in
 * Phase 4, sales and installments in Phase 5) so receipts stay one generic, audited flow.
 */
export interface ReceiptTargetHandler {
  describe(targetId: string, lock: boolean): Promise<ReceiptTargetInfo>;
  /** Credit line(s) in base currency for `amountBase` received against the target. */
  creditLines(targetId: string, amountBase: string, customerId: string): Promise<PostingLine[]> | PostingLine[];
  /** Called before a receipt allocated to the target is voided; throw to refuse. */
  beforeVoid?(ctx: TenantContext, targetId: string, amountBase: string): Promise<void>;
}

export interface ReceiveInput {
  customerId: string;
  cashAccountId: string;
  /** Amount received, in the cash account's currency. */
  amount: string;
  exchangeRate?: string | null;
  method: string;
  reference?: string | null;
  notes?: string | null;
  receivedAt?: string | null;
  branchId?: string | null;
  /** Base-currency split across documents. Omitted → the whole amount goes to `allocateTo`. */
  allocations?: Array<{ targetType: ReceiptTargetType; targetId: string; amountBase: string }>;
  allocateTo?: { targetType: ReceiptTargetType; targetId: string };
}

/**
 * Money received from customers. Every receipt is one cash-book inflow (Dr 1100) whose credit
 * side comes from what it pays: deposits and advances are liabilities (Cr 2100 customer
 * advances) — never revenue. Receipts are immutable; corrections are voids (mirrored entries).
 */
@Injectable()
export class ReceiptsService {
  private static readonly handlers = new Map<ReceiptTargetType, ReceiptTargetHandler>();

  static register(type: ReceiptTargetType, handler: ReceiptTargetHandler): void {
    ReceiptsService.handlers.set(type, handler);
  }

  constructor(
    private readonly dbs: DbService,
    private readonly cash: CashService,
    private readonly posting: PostingService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {
    ReceiptsService.register('customer_credit', {
      describe: async (customerId) => {
        const [c] = await this.dbs.db.select({ id: customers.id, isActive: customers.isActive, branchId: customers.branchId, name: customers.fullName }).from(customers).where(eq(customers.id, customerId));
        if (!c) throw notFound('Customer');
        return { customerId: c.id, branchId: null, label: c.name, acceptsPayment: c.isActive, outstandingBase: null };
      },
      creditLines: (_id, amountBase, customerId) => [{ account: ACCOUNTS.CUSTOMER_ADVANCES, credit: amountBase, customerId, memo: 'customer_credit' }],
    });
  }

  private handler(type: ReceiptTargetType): ReceiptTargetHandler {
    const h = ReceiptsService.handlers.get(type);
    if (!h) throw unprocessable('unsupported_target', `Receipts cannot be allocated to ${type} yet`);
    return h;
  }

  /** Base amount received against a document (posted receipts only). */
  async receivedBase(targetType: ReceiptTargetType, targetId: string): Promise<string> {
    const [row] = await this.dbs.db
      .select({ v: sql<string>`coalesce(sum(${receiptAllocations.amountBase}), 0)::numeric(18,2)::text` })
      .from(receiptAllocations)
      .innerJoin(receipts, eq(receipts.id, receiptAllocations.receiptId))
      .where(and(eq(receiptAllocations.targetType, targetType), eq(receiptAllocations.targetId, targetId), eq(receipts.status, 'posted')));
    return row?.v ?? '0.00';
  }

  /** Customer's advance balance (credit-positive GL 2100 for the customer). */
  async customerAdvanceBalance(customerId: string): Promise<string> {
    const bal = await this.posting.balance(ACCOUNTS.CUSTOMER_ADVANCES, { customerId });
    return d(bal).negated().toFixed(2);
  }

  async receive(ctx: TenantContext, input: ReceiveInput) {
    assertPermission(ctx, 'payments.receive');
    const db = this.dbs.db;
    const [cust] = await db.select({ id: customers.id, isActive: customers.isActive, name: customers.fullName }).from(customers).where(eq(customers.id, input.customerId));
    if (!cust) throw notFound('Customer');
    if (!cust.isActive) throw unprocessable('customer_inactive', 'This customer is inactive');

    const acct = await this.cash.lockAccount(ctx, input.cashAccountId);
    const fx = resolveFx(ctx, acct.currency as CurrencyCode, acct.currency === ctx.tenant.baseCurrency ? null : input.exchangeRate);
    const amount = money(input.amount, acct.currency as CurrencyCode);
    const amountBase = fx.toBase(amount);
    const allocations =
      input.allocations && input.allocations.length
        ? input.allocations.map((a) => ({ ...a, amountBase: d(a.amountBase).toFixed(2) }))
        : [{ ...(input.allocateTo ?? { targetType: 'customer_credit' as const, targetId: input.customerId }), amountBase }];
    const allocated = sum(allocations.map((a) => a.amountBase));
    if (!allocated.eq(d(amountBase))) {
      throw unprocessable('allocation_mismatch', 'Allocations must add up exactly to the amount received (in base currency)', {
        receiptBase: amountBase,
        allocated: allocated.toFixed(2),
      });
    }

    const seen = new Set<string>();
    const credit: PostingLine[] = [];
    let branchId: string | null = input.branchId ?? acct.branchId ?? null;
    for (const a of allocations) {
      if (d(a.amountBase).lte(0)) throw unprocessable('invalid_amount', 'Allocation amounts must be positive');
      const key = `${a.targetType}:${a.targetId}`;
      if (seen.has(key)) throw unprocessable('duplicate_allocation', 'Each document can appear only once in a receipt');
      seen.add(key);
      const h = this.handler(a.targetType);
      const info = await h.describe(a.targetId, true);
      if (info.customerId !== input.customerId) throw unprocessable('customer_mismatch', `${info.label} belongs to a different customer`, { target: key });
      if (!info.acceptsPayment) throw conflict('not_receivable', `${info.label} cannot receive payments now`, { target: key });
      if (info.outstandingBase !== null && d(a.amountBase).gt(info.outstandingBase)) {
        throw conflict('overpayment', `The amount exceeds what is due on ${info.label}`, { target: key, outstanding: info.outstandingBase });
      }
      assertBranchAccess(ctx, info.branchId);
      branchId ??= info.branchId;
      credit.push(...(await h.creditLines(a.targetId, a.amountBase, input.customerId)));
    }

    const receivedAt = input.receivedAt ?? todayInZone(ctx.tenant.settings.timezone);
    const number = await this.numbering.next('receipt');
    const [r] = await db
      .insert(receipts)
      .values({
        tenantId: ctx.tenant.id,
        number,
        customerId: input.customerId,
        cashAccountId: acct.id,
        branchId,
        amount,
        currency: acct.currency,
        exchangeRate: fx.rate,
        amountBase,
        receivedAt,
        method: input.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await db.insert(receiptAllocations).values(
      allocations.map((a) => ({ tenantId: ctx.tenant.id, receiptId: r!.id, targetType: a.targetType, targetId: a.targetId, amountBase: a.amountBase })),
    );
    await this.cash.move(ctx, {
      cashAccountId: acct.id,
      direction: 'in',
      amount,
      exchangeRate: fx.rate,
      kind: 'customer_receipt',
      sourceType: 'receipt',
      sourceId: r!.id,
      event: 'receipt.posted',
      businessDate: receivedAt,
      description: `Receipt ${number} — ${cust.name}`,
      reference: input.reference ?? null,
      branchId,
      counterLines: credit,
    });
    await this.audit.record({
      action: 'receipt.posted',
      entityType: 'receipt',
      entityId: r!.id,
      summary: `${number}: ${amount} ${acct.currency} from ${cust.name}`,
      after: { ...r, allocations },
    });
    return { ...r!, allocations };
  }

  /** Voids a receipt: cash leaves the account again and the documents become unpaid. */
  async void(ctx: TenantContext, id: string, reason: string) {
    assertPermission(ctx, 'payments.void');
    const [r] = await this.dbs.db.select().from(receipts).where(eq(receipts.id, id)).for('update');
    if (!r) throw notFound('Receipt');
    await this.cash.lockAccount(ctx, r.cashAccountId);
    if (r.status !== 'posted') throw conflict('already_voided', 'This receipt is already voided');
    const allocations = await this.dbs.db.select().from(receiptAllocations).where(eq(receiptAllocations.receiptId, id));
    for (const a of allocations) {
      const h = ReceiptsService.handlers.get(a.targetType as ReceiptTargetType);
      await h?.beforeVoid?.(ctx, a.targetId, a.amountBase);
    }
    if (allocations.some((a) => a.targetType === 'customer_credit')) {
      // Voiding money the customer has already used or been refunded would push 2100 negative.
      const credit = sum(allocations.filter((a) => a.targetType === 'customer_credit').map((a) => a.amountBase));
      const bal = await this.customerAdvanceBalance(r.customerId);
      if (d(bal).lt(credit)) throw conflict('receipt_applied', 'This receipt was already applied or refunded; reverse that first');
    }
    await this.cash.reverse(ctx, { sourceType: 'receipt', sourceId: id, event: 'receipt.posted' }, todayInZone(ctx.tenant.settings.timezone), reason);
    const [after] = await this.dbs.db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: ctx.userId, voidReason: reason })
      .where(eq(receipts.id, id))
      .returning();
    await this.audit.record({ action: 'receipt.voided', entityType: 'receipt', entityId: id, before: { status: 'posted' }, after: { status: 'voided', reason } });
    return after!;
  }

  async list(ctx: TenantContext, f: { customerId?: string; cashAccountId?: string; status?: string; targetType?: string; targetId?: string; page: number; pageSize: number }) {
    const conds: SQL[] = [];
    if (f.customerId) conds.push(eq(receipts.customerId, f.customerId));
    if (f.cashAccountId) conds.push(eq(receipts.cashAccountId, f.cashAccountId));
    if (f.status) conds.push(eq(receipts.status, f.status));
    if (f.targetType && f.targetId) {
      conds.push(sql`EXISTS (SELECT 1 FROM receipt_allocations ra WHERE ra.receipt_id = receipts.id AND ra.target_type = ${f.targetType} AND ra.target_id = ${f.targetId})`);
    }
    if (!ctx.allBranches) {
      conds.push(ctx.branchIds.length ? or(isNull(receipts.branchId), inArray(receipts.branchId, ctx.branchIds))! : isNull(receipts.branchId));
    }
    const where = conds.length ? and(...conds) : undefined;
    const items = await this.dbs.db
      .select({
        id: receipts.id,
        number: receipts.number,
        customerId: receipts.customerId,
        customerName: customers.fullName,
        cashAccountId: receipts.cashAccountId,
        cashAccountName: cashAccounts.name,
        amount: receipts.amount,
        currency: receipts.currency,
        amountBase: receipts.amountBase,
        receivedAt: receipts.receivedAt,
        method: receipts.method,
        reference: receipts.reference,
        status: receipts.status,
        voidReason: receipts.voidReason,
      })
      .from(receipts)
      .innerJoin(customers, eq(customers.id, receipts.customerId))
      .innerJoin(cashAccounts, eq(cashAccounts.id, receipts.cashAccountId))
      .where(where)
      .orderBy(desc(receipts.receivedAt), desc(receipts.createdAt))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    const [c] = await this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(receipts).where(where);
    return { items, total: c?.n ?? 0, page: f.page, pageSize: f.pageSize };
  }

  async get(ctx: TenantContext, id: string) {
    const [r] = await this.dbs.db.select().from(receipts).where(eq(receipts.id, id));
    if (!r) throw notFound('Receipt');
    assertBranchAccess(ctx, r.branchId);
    const allocations = await this.dbs.db.select().from(receiptAllocations).where(eq(receiptAllocations.receiptId, id));
    const [cust] = await this.dbs.db.select({ fullName: customers.fullName }).from(customers).where(eq(customers.id, r.customerId));
    return { ...r, customerName: cust?.fullName ?? null, allocations };
  }

  /** Receipts allocated to the given documents (for document detail views). */
  forTargets(targetType: ReceiptTargetType, targetIds: string[]) {
    if (!targetIds.length) return Promise.resolve([]);
    return this.dbs.db
      .select({
        receiptId: receipts.id,
        number: receipts.number,
        receivedAt: receipts.receivedAt,
        status: receipts.status,
        method: receipts.method,
        amount: receipts.amount,
        currency: receipts.currency,
        targetId: receiptAllocations.targetId,
        amountBase: receiptAllocations.amountBase,
      })
      .from(receiptAllocations)
      .innerJoin(receipts, eq(receipts.id, receiptAllocations.receiptId))
      .where(and(eq(receiptAllocations.targetType, targetType), inArray(receiptAllocations.targetId, targetIds)))
      .orderBy(desc(receipts.receivedAt));
  }
}
