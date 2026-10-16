import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql, SQL } from 'drizzle-orm';
import { CurrencyCode, d, money, SupplierPaymentInput, sum, todayInZone } from '@autohub/shared';
import { assertBranchAccess, assertPermission, TenantContext } from '../../common/context';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { cashAccounts, supplierPaymentAllocations, supplierPayments, suppliers } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { ACCOUNTS } from '../ledger/chart';
import { NumberingService } from '../numbering/numbering.service';
import { CashService } from './cash.service';
import { resolveFx } from './fx';
import { PayablesService } from './payables.service';

/**
 * Pays suppliers (or direct cash purchases) against approved payable documents. A payment can
 * never exceed what is outstanding on each document, and the supplier on the payment must match
 * the supplier on every document it settles.
 */
@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly dbs: DbService,
    private readonly cash: CashService,
    private readonly payables: PayablesService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  async pay(ctx: TenantContext, input: SupplierPaymentInput) {
    assertPermission(ctx, 'supplier_payments.create');
    const db = this.dbs.db;
    if (input.supplierId) {
      const [s] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId));
      if (!s) throw notFound('Supplier');
    }
    const acct = await this.cash.lockAccount(ctx, input.cashAccountId);
    const fx = resolveFx(ctx, acct.currency as CurrencyCode, acct.currency === ctx.tenant.baseCurrency ? null : input.exchangeRate);
    const amount = money(input.amount, acct.currency as CurrencyCode);
    const amountBase = fx.toBase(amount);
    const allocated = sum(input.allocations.map((a) => a.amountBase));
    if (!allocated.eq(d(amountBase))) {
      throw unprocessable('allocation_mismatch', 'Allocations must add up exactly to the payment amount (in base currency)', {
        paymentBase: amountBase,
        allocated: allocated.toFixed(2),
      });
    }
    const seen = new Set<string>();
    for (const a of input.allocations) {
      const key = `${a.targetType}:${a.targetId}`;
      if (seen.has(key)) throw unprocessable('duplicate_allocation', 'Each document can appear only once in a payment');
      seen.add(key);
      const info = await this.payables.describe(a.targetType, a.targetId, true);
      if (!info.payable) throw conflict('not_payable', `${info.label} is not approved for payment`, { target: key });
      if ((info.supplierId ?? null) !== (input.supplierId ?? null)) {
        throw unprocessable('supplier_mismatch', `${info.label} belongs to a different supplier`, { target: key });
      }
      if (d(a.amountBase).gt(info.outstandingBase)) {
        throw conflict('overpayment', `Payment exceeds the outstanding balance of ${info.label}`, {
          target: key,
          outstanding: info.outstandingBase,
        });
      }
      if (info.branchId && !ctx.allBranches && !ctx.branchIds.includes(info.branchId)) {
        throw unprocessable('branch_forbidden', `${info.label} belongs to a branch you cannot access`);
      }
    }

    const number = await this.numbering.next('supplier_payment');
    const [p] = await db
      .insert(supplierPayments)
      .values({
        tenantId: ctx.tenant.id,
        number,
        supplierId: input.supplierId ?? null,
        cashAccountId: acct.id,
        amount,
        currency: acct.currency,
        exchangeRate: fx.rate,
        amountBase,
        paidAt: input.paidAt,
        method: input.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await db.insert(supplierPaymentAllocations).values(
      input.allocations.map((a) => ({
        tenantId: ctx.tenant.id,
        paymentId: p!.id,
        targetType: a.targetType,
        targetId: a.targetId,
        amountBase: d(a.amountBase).toFixed(2),
      })),
    );
    await this.cash.move(ctx, {
      cashAccountId: acct.id,
      direction: 'out',
      amount,
      exchangeRate: fx.rate,
      kind: 'supplier_payment',
      sourceType: 'supplier_payment',
      sourceId: p!.id,
      event: 'supplier_payment.posted',
      businessDate: input.paidAt,
      description: `Supplier payment ${number}`,
      reference: input.reference ?? null,
      counterLines: [{ account: ACCOUNTS.PAYABLES, debit: amountBase, supplierId: input.supplierId ?? null }],
    });
    await this.audit.record({
      action: 'supplier_payment.posted',
      entityType: 'supplier_payment',
      entityId: p!.id,
      summary: `${number}: ${amount} ${acct.currency}`,
      after: { ...p, allocations: input.allocations },
    });
    return { ...p!, allocations: input.allocations };
  }

  /** Voids a payment: the cash returns to the account and the documents become payable again. */
  async void(ctx: TenantContext, id: string, reason: string) {
    assertPermission(ctx, 'payments.void');
    const [p] = await this.dbs.db.select().from(supplierPayments).where(eq(supplierPayments.id, id)).for('update');
    if (!p) throw notFound('Supplier payment');
    await this.cash.lockAccount(ctx, p.cashAccountId); // branch check + serialise with other movements
    if (p.status !== 'posted') throw conflict('already_voided', 'This payment is already voided');
    await this.cash.reverse(ctx, { sourceType: 'supplier_payment', sourceId: id, event: 'supplier_payment.posted' }, todayInZone(ctx.tenant.settings.timezone), reason);
    const [after] = await this.dbs.db
      .update(supplierPayments)
      .set({ status: 'voided', voidedAt: new Date(), voidReason: reason })
      .where(eq(supplierPayments.id, id))
      .returning();
    await this.audit.record({ action: 'supplier_payment.voided', entityType: 'supplier_payment', entityId: id, before: { status: 'posted' }, after: { status: 'voided', reason } });
    return after;
  }

  async list(ctx: TenantContext, f: { supplierId?: string; cashAccountId?: string; status?: string; page: number; pageSize: number }) {
    const conds: SQL[] = [];
    if (f.supplierId) conds.push(eq(supplierPayments.supplierId, f.supplierId));
    if (f.cashAccountId) conds.push(eq(supplierPayments.cashAccountId, f.cashAccountId));
    if (f.status) conds.push(eq(supplierPayments.status, f.status));
    // Payments from a branch's cash box are visible to that branch; company-level accounts to all.
    if (!ctx.allBranches) {
      // inArray, not `= ANY(${array}::uuid[])`: Drizzle expands a JS array in sql`` into a param list.
      conds.push(ctx.branchIds.length ? or(isNull(cashAccounts.branchId), inArray(cashAccounts.branchId, ctx.branchIds))! : isNull(cashAccounts.branchId));
    }
    const where = conds.length ? and(...conds) : undefined;
    const items = await this.dbs.db
      .select({
        id: supplierPayments.id,
        number: supplierPayments.number,
        supplierId: supplierPayments.supplierId,
        supplierName: suppliers.name,
        cashAccountId: supplierPayments.cashAccountId,
        cashAccountName: cashAccounts.name,
        amount: supplierPayments.amount,
        currency: supplierPayments.currency,
        amountBase: supplierPayments.amountBase,
        paidAt: supplierPayments.paidAt,
        method: supplierPayments.method,
        reference: supplierPayments.reference,
        status: supplierPayments.status,
        voidReason: supplierPayments.voidReason,
      })
      .from(supplierPayments)
      .leftJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId))
      .innerJoin(cashAccounts, eq(cashAccounts.id, supplierPayments.cashAccountId))
      .where(where)
      .orderBy(desc(supplierPayments.paidAt), desc(supplierPayments.createdAt))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    const [c] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(supplierPayments)
      .innerJoin(cashAccounts, eq(cashAccounts.id, supplierPayments.cashAccountId))
      .where(where);
    return { items, total: c?.n ?? 0, page: f.page, pageSize: f.pageSize };
  }

  async get(ctx: TenantContext, id: string) {
    const [p] = await this.dbs.db.select().from(supplierPayments).where(eq(supplierPayments.id, id));
    if (!p) throw notFound('Supplier payment');
    const [acct] = await this.dbs.db.select({ branchId: cashAccounts.branchId }).from(cashAccounts).where(eq(cashAccounts.id, p.cashAccountId));
    assertBranchAccess(ctx, acct?.branchId);
    const allocations = await this.dbs.db.select().from(supplierPaymentAllocations).where(eq(supplierPaymentAllocations.paymentId, id));
    return { ...p, allocations };
  }

  /** Payments allocated to the given documents (for document detail views). */
  async forTargets(targetType: string, targetIds: string[]) {
    if (!targetIds.length) return [];
    return this.dbs.db
      .select({
        paymentId: supplierPayments.id,
        number: supplierPayments.number,
        paidAt: supplierPayments.paidAt,
        status: supplierPayments.status,
        method: supplierPayments.method,
        targetId: supplierPaymentAllocations.targetId,
        amountBase: supplierPaymentAllocations.amountBase,
      })
      .from(supplierPaymentAllocations)
      .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.paymentId))
      .where(and(eq(supplierPaymentAllocations.targetType, targetType), inArray(supplierPaymentAllocations.targetId, targetIds)));
  }
}
