import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  allocateProportionally,
  computeTax,
  CostAllocationInput,
  d,
  money,
  PayNowInput,
  profitMetrics,
  sum,
  todayInZone,
  VehicleCostCreateInput,
} from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { costCategories, suppliers, users, vehicleCosts, vehicles } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../finance/approvals.service';
import { CashService } from '../finance/cash.service';
import { resolveFx } from '../finance/fx';
import { PayablesService } from '../finance/payables.service';
import { SupplierPaymentsService } from '../finance/supplier-payments.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingService } from '../ledger/posting.service';
import { VehiclesService } from '../vehicles/vehicles.service';

export type CostSource = 'acquisition' | 'manual' | 'work_order_item' | 'allocation' | 'trade_in';
type CostRow = typeof vehicleCosts.$inferSelect;

export interface CreateCostOptions {
  sourceType: CostSource;
  sourceId?: string | null;
  batchId?: string | null;
  allocationMethod?: string | null;
  /** Workflows that are themselves approved (acquisition, work order) post directly. */
  forceStatus?: 'posted' | 'pending_approval';
  /** Credit side override (e.g. trade-in credits customer advances instead of payables). */
  creditOverride?: { account: '2100'; customerId: string; saleId?: string | null };
  skipPayNow?: boolean;
  /**
   * Base amount to book instead of converting `amount` again: the acquisition's stored base
   * (so the payable document and the GL can never differ) or a shared invoice's base split.
   */
  amountBaseOverride?: string;
}

/**
 * Vehicle cost engine. A vehicle's capitalised cost is the sum of its POSTED cost rows; each posted
 * row has exactly one ledger entry (Dr 1300 Inventory, or Dr 5000 COGS after the sale was
 * recognised / Cr 2000 Payables). Corrections are reversals; amounts are immutable once posted.
 */
@Injectable()
export class CostsService {
  constructor(
    private readonly dbs: DbService,
    private readonly vehicles: VehiclesService,
    private readonly posting: PostingService,
    private readonly approvals: ApprovalsService,
    private readonly payments: SupplierPaymentsService,
    private readonly payables: PayablesService,
    private readonly cash: CashService,
    private readonly audit: AuditService,
  ) {}

  async categoryByCode(code: string) {
    const [c] = await this.dbs.db
      .select()
      .from(costCategories)
      .where(eq(costCategories.code, code))
      .orderBy(sql`${costCategories.tenantId} IS NULL`)
      .limit(1);
    if (!c) throw notFound(`Cost category ${code}`);
    return c;
  }

  categories() {
    return this.dbs.db.select().from(costCategories).where(eq(costCategories.isActive, true)).orderBy(asc(costCategories.kind), asc(costCategories.nameEn));
  }

  async create(ctx: TenantContext, input: VehicleCostCreateInput, opts: CreateCostOptions): Promise<CostRow> {
    const db = this.dbs.db;
    const v = await this.vehicles.lock(input.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (v.status === 'removed') throw conflict('vehicle_removed', 'Costs cannot be added to a removed vehicle');
    const postSale = !!v.costLockedAt;
    if (postSale) assertPermission(ctx, 'costs.post_after_sale');

    const [cat] = await db.select().from(costCategories).where(eq(costCategories.id, input.categoryId));
    if (!cat || !cat.isActive) throw notFound('Cost category');
    if (cat.kind !== 'vehicle') throw unprocessable('category_not_vehicle', 'Use a vehicle cost category');
    if (cat.code === 'purchase' && opts.sourceType !== 'acquisition' && opts.sourceType !== 'trade_in') {
      throw unprocessable('purchase_via_acquisition', 'The purchase price is recorded through the acquisition');
    }
    if (input.supplierId) {
      const [s] = await db.select({ id: suppliers.id, isActive: suppliers.isActive }).from(suppliers).where(eq(suppliers.id, input.supplierId));
      if (!s) throw notFound('Supplier');
      if (!s.isActive) throw unprocessable('supplier_inactive', 'This supplier is inactive');
    }
    // With an override the base amount was fixed upstream (an approved acquisition's stored base, or
    // a shared invoice split after its rate was band-checked): the stored rate is not re-checked
    // against today's reference, or a purchase recorded before a reference change could not be approved.
    const fx = resolveFx(ctx, input.currency, input.exchangeRate, { recorded: opts.amountBaseOverride !== undefined });
    const amount = money(input.amount, input.currency);
    const amountBase = opts.amountBaseOverride ? money(opts.amountBaseOverride, ctx.tenant.baseCurrency) : fx.toBase(amount);
    if (d(amountBase).lte(0)) throw unprocessable('invalid_amount', 'The cost amount in base currency must be positive');
    const status = opts.forceStatus ?? (hasPermission(ctx, 'costs.approve') ? 'posted' : 'pending_approval');
    if (input.payNow && status !== 'posted' && !opts.skipPayNow) {
      throw unprocessable('cannot_pay_unapproved', 'A cost awaiting approval cannot be paid yet');
    }

    const [row] = await db
      .insert(vehicleCosts)
      .values({
        tenantId: ctx.tenant.id,
        vehicleId: v.id,
        categoryId: cat.id,
        description: input.description,
        amount,
        currency: input.currency,
        exchangeRate: fx.rate,
        amountBase,
        costDate: input.costDate,
        supplierId: input.supplierId ?? null,
        status,
        sourceType: opts.sourceType,
        sourceId: opts.sourceId ?? null,
        batchId: opts.batchId ?? null,
        allocationMethod: opts.allocationMethod ?? null,
        postSale,
        approvedBy: status === 'posted' ? ctx.userId : null,
        approvedAt: status === 'posted' ? new Date() : null,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    if (status === 'posted') {
      await this.postEntry(ctx, row!, v.branchId, v.stockNumber, opts.creditOverride);
    } else {
      await this.approvals.open(ctx, {
        type: 'vehicle_cost',
        entityType: 'vehicle_cost',
        entityId: row!.id,
        requiredPermission: 'costs.approve',
        summary: `${v.stockNumber}: ${cat.nameEn} ${amount} ${input.currency}`,
        payload: { vehicleId: v.id, amountBase },
        branchId: v.branchId,
      });
    }
    await this.audit.record({
      action: status === 'posted' ? 'vehicle_cost.posted' : 'vehicle_cost.submitted',
      entityType: 'vehicle',
      entityId: v.id,
      summary: `${cat.code} ${amount} ${input.currency} (${opts.sourceType})`,
      after: row,
    });
    if (input.payNow && !opts.skipPayNow) await this.payNow(ctx, [row!], input.payNow, input.costDate);
    return row!;
  }

  /** The vehicle's recognised, still-live sale: a cost posted after the sale is a cost of that sale. */
  private async currentSaleOf(vehicleId: string): Promise<string | null> {
    const [s] = await this.dbs.query<{ id: string }>(
      `SELECT id FROM sales WHERE vehicle_id = $1 AND recognized_at IS NOT NULL AND status IN ('confirmed', 'delivered') LIMIT 1`,
      [vehicleId],
    );
    return s?.id ?? null;
  }

  private async postEntry(ctx: TenantContext, row: CostRow, branchId: string, stockNumber: string, creditOverride?: CreateCostOptions['creditOverride']) {
    const saleId = row.postSale ? await this.currentSaleOf(row.vehicleId) : null;
    await this.posting.post({
      sourceType: 'vehicle_cost',
      sourceId: row.id,
      event: 'cost.posted',
      date: row.costDate,
      description: `${stockNumber}: ${row.description}`,
      branchId,
      lines: [
        { account: row.postSale ? ACCOUNTS.COGS : ACCOUNTS.INVENTORY, debit: row.amountBase, vehicleId: row.vehicleId, saleId },
        creditOverride
          ? { account: ACCOUNTS.CUSTOMER_ADVANCES, credit: row.amountBase, customerId: creditOverride.customerId, saleId: creditOverride.saleId ?? null, vehicleId: row.vehicleId }
          : { account: ACCOUNTS.PAYABLES, credit: row.amountBase, supplierId: row.supplierId, vehicleId: row.vehicleId },
      ],
    });
  }

  /** Pays the given posted costs immediately (single supplier payment allocated to each). */
  async payNow(ctx: TenantContext, rows: CostRow[], pay: PayNowInput, date: string) {
    const supplierIds = new Set(rows.map((r) => r.supplierId ?? null));
    if (supplierIds.size > 1) throw unprocessable('supplier_mismatch', 'Costs paid together must have the same supplier');
    const totalBase = sum(rows.map((r) => r.amountBase));
    const acct = await this.cash.lockAccount(ctx, pay.cashAccountId);
    if (acct.currency !== ctx.tenant.baseCurrency) {
      throw unprocessable('pay_now_base_currency', 'Immediate payment requires an account in the company base currency');
    }
    return this.payments.pay(ctx, {
      supplierId: rows[0]!.supplierId ?? null,
      cashAccountId: pay.cashAccountId,
      paidAt: date,
      method: pay.method,
      reference: pay.reference ?? null,
      notes: null,
      amount: totalBase.toFixed(2),
      allocations: rows.map((r) => ({ targetType: 'vehicle_cost' as const, targetId: r.id, amountBase: r.amountBase })),
    });
  }

  findBySource(sourceType: CostSource, sourceId: string): Promise<CostRow[]> {
    return this.dbs.db
      .select()
      .from(vehicleCosts)
      .where(and(eq(vehicleCosts.sourceType, sourceType), eq(vehicleCosts.sourceId, sourceId)))
      .orderBy(desc(vehicleCosts.createdAt));
  }

  async get(ctx: TenantContext, id: string): Promise<CostRow> {
    const [c] = await this.dbs.db.select().from(vehicleCosts).where(eq(vehicleCosts.id, id));
    if (!c) throw notFound('Vehicle cost');
    const v = await this.vehicles.get(c.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    return c;
  }

  private async lockCost(id: string): Promise<CostRow> {
    const [c] = await this.dbs.db.select().from(vehicleCosts).where(eq(vehicleCosts.id, id)).for('update');
    if (!c) throw notFound('Vehicle cost');
    return c;
  }

  async approve(ctx: TenantContext, id: string, note?: string | null) {
    const c = await this.lockCost(id);
    const v = await this.vehicles.lock(c.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (c.status !== 'pending_approval') throw conflict('cost_not_pending', 'This cost is not awaiting approval');
    await this.approvals.assertNotSelfApproval(ctx, { type: 'vehicle_cost', entityType: 'vehicle_cost', entityId: id, makers: [c.createdBy] });
    if (v.status === 'removed') throw conflict('vehicle_removed', 'The vehicle was removed from stock');
    // If the sale was recognised while the cost waited for approval, it now hits COGS.
    const postSale = !!v.costLockedAt;
    if (postSale) assertPermission(ctx, 'costs.post_after_sale');
    const [after] = await this.dbs.db
      .update(vehicleCosts)
      .set({ status: 'posted', postSale, approvedBy: ctx.userId, approvedAt: new Date() })
      .where(eq(vehicleCosts.id, id))
      .returning();
    await this.postEntry(ctx, after!, v.branchId, v.stockNumber);
    await this.approvals.resolve(ctx, { type: 'vehicle_cost', entityType: 'vehicle_cost', entityId: id, status: 'approved', note });
    await this.audit.record({ action: 'vehicle_cost.approved', entityType: 'vehicle', entityId: c.vehicleId, before: { status: c.status }, after: { costId: id, status: 'posted', note: note ?? null } });
    return after!;
  }

  async reject(ctx: TenantContext, id: string, reason: string) {
    const c = await this.lockCost(id);
    const v = await this.vehicles.get(c.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (c.status !== 'pending_approval') throw conflict('cost_not_pending', 'This cost is not awaiting approval');
    const [after] = await this.dbs.db.update(vehicleCosts).set({ status: 'rejected', rejectedReason: reason }).where(eq(vehicleCosts.id, id)).returning();
    await this.approvals.resolve(ctx, { type: 'vehicle_cost', entityType: 'vehicle_cost', entityId: id, status: 'rejected', note: reason });
    await this.audit.record({ action: 'vehicle_cost.rejected', entityType: 'vehicle', entityId: c.vehicleId, after: { costId: id, reason } });
    return after!;
  }

  /**
   * Reverses a posted cost with a mirrored ledger entry. Paid costs must have their payments voided
   * first; purchase costs are only reversed by cancelling the acquisition (internal = true).
   */
  async reverse(ctx: TenantContext, id: string, reason: string, opts: { internal?: boolean } = {}) {
    const c = await this.lockCost(id);
    const v = await this.vehicles.lock(c.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (c.status !== 'posted') throw conflict('cost_not_posted', 'Only posted costs can be reversed');
    if (c.sourceType === 'acquisition' && !opts.internal) {
      throw conflict('reverse_via_acquisition', 'Cancel the acquisition to reverse its purchase price');
    }
    if (v.costLockedAt && !c.postSale) {
      // Inventory cost was already moved to COGS at sale; reversing it now would misstate inventory.
      throw conflict('cost_locked', 'This cost is part of a recognised sale and cannot be reversed');
    }
    const paid = await this.payables.paidBase('vehicle_cost', id);
    if (d(paid).gt(0)) throw conflict('cost_has_payments', 'Void the supplier payments for this cost before reversing it');
    const [after] = await this.dbs.db
      .update(vehicleCosts)
      .set({ status: 'reversed', reversedAt: new Date(), reversalReason: reason })
      .where(eq(vehicleCosts.id, id))
      .returning();
    const today = todayInZone(ctx.tenant.settings.timezone);
    const date = c.costDate > today ? c.costDate : today;
    await this.posting.reverse({ sourceType: 'vehicle_cost', sourceId: id, event: 'cost.posted' }, 'cost.reversed', date, `Reversal: ${reason}`);
    if (v.status === 'removed' && !c.postSale) {
      // Removing the vehicle already wrote this cost off (Dr 6300 / Cr 1300), so the mirrored
      // reversal just pushed the vehicle's inventory below zero. Undo that part of the write-off:
      // inventory of a removed vehicle stays at zero and 6300 shrinks by the reversed amount.
      const bal = await this.posting.balance(ACCOUNTS.INVENTORY, { vehicleId: v.id });
      if (d(bal).isNegative()) {
        const amount = d(bal).negated().gt(c.amountBase) ? c.amountBase : d(bal).negated().toFixed(2);
        await this.posting.post({
          sourceType: 'vehicle_cost',
          sourceId: id,
          event: 'cost.write_off_reversed',
          date,
          description: `${v.stockNumber}: write-off of reversed cost undone`,
          branchId: v.branchId,
          lines: [
            { account: ACCOUNTS.INVENTORY, debit: amount, vehicleId: v.id },
            { account: ACCOUNTS.INVENTORY_ADJUSTMENTS, credit: amount, vehicleId: v.id },
          ],
        });
      }
    }
    await this.audit.record({ action: 'vehicle_cost.reversed', entityType: 'vehicle', entityId: c.vehicleId, before: { status: 'posted', amountBase: c.amountBase }, after: { costId: id, reason } });
    return after!;
  }

  /** Splits one shared invoice (e.g. transport of several cars) across vehicles, exactly to the cent. */
  async allocate(ctx: TenantContext, input: CostAllocationInput) {
    const db = this.dbs.db;
    const rows = await db.select({ id: vehicles.id }).from(vehicles).where(inArray(vehicles.id, input.vehicleIds));
    if (rows.length !== input.vehicleIds.length) throw notFound('Vehicle');
    let parts: string[];
    if (input.method === 'manual') {
      const total = sum(input.manualAmounts!);
      if (!total.eq(d(input.totalAmount))) {
        throw unprocessable('manual_total_mismatch', 'Manual amounts must add up exactly to the total', { total: total.toFixed(2) });
      }
      parts = input.manualAmounts!.map((a) => money(a, input.currency));
    } else if (input.method === 'equal') {
      parts = allocateProportionally(input.totalAmount, input.vehicleIds.map(() => 1), input.currency);
    } else {
      const weights = [];
      for (const vid of input.vehicleIds) weights.push(await this.purchaseCostBase(vid));
      if (weights.every((w) => d(w).isZero())) throw unprocessable('no_purchase_prices', 'None of the vehicles has a posted purchase price');
      parts = allocateProportionally(input.totalAmount, weights, input.currency);
    }
    // Convert the invoice ONCE and split its base amount with the same weights, so the parts add
    // up to the converted invoice to the cent (per-part conversion can drift by a cent or more).
    const fx = resolveFx(ctx, input.currency, input.exchangeRate);
    const totalBase = fx.toBase(money(input.totalAmount, input.currency));
    const baseParts = input.currency === ctx.tenant.baseCurrency ? parts : allocateProportionally(totalBase, parts, ctx.tenant.baseCurrency);
    const batchId = randomUUID();
    const created: CostRow[] = [];
    for (const [i, vid] of input.vehicleIds.entries()) {
      if (d(parts[i]!).isZero()) continue;
      created.push(
        await this.create(
          ctx,
          {
            vehicleId: vid,
            categoryId: input.categoryId,
            description: input.description,
            amount: parts[i]!,
            currency: input.currency,
            exchangeRate: input.exchangeRate,
            costDate: input.costDate,
            supplierId: input.supplierId ?? null,
            notes: `allocation ${input.method} (${i + 1}/${input.vehicleIds.length})`,
          },
          { sourceType: 'allocation', batchId, allocationMethod: input.method, amountBaseOverride: baseParts[i]! },
        ),
      );
    }
    if (input.payNow) {
      if (created.some((c) => c.status !== 'posted')) throw unprocessable('cannot_pay_unapproved', 'Some costs await approval and cannot be paid yet');
      await this.payNow(ctx, created, input.payNow, input.costDate);
    }
    return { batchId, costs: created, allocated: parts };
  }

  private async purchaseCostBase(vehicleId: string): Promise<string> {
    const [row] = await this.dbs.db
      .select({ total: sql<string>`coalesce(sum(${vehicleCosts.amountBase}), 0)::numeric(18,2)::text` })
      .from(vehicleCosts)
      .innerJoin(costCategories, eq(costCategories.id, vehicleCosts.categoryId))
      .where(and(eq(vehicleCosts.vehicleId, vehicleId), eq(vehicleCosts.status, 'posted'), eq(costCategories.code, 'purchase')));
    return row?.total ?? '0.00';
  }

  /** Total posted capitalised cost of a vehicle (base currency). */
  async postedTotal(vehicleId: string): Promise<string> {
    const [row] = await this.dbs.db
      .select({ total: sql<string>`coalesce(sum(${vehicleCosts.amountBase}), 0)::numeric(18,2)::text` })
      .from(vehicleCosts)
      .where(and(eq(vehicleCosts.vehicleId, vehicleId), eq(vehicleCosts.status, 'posted')));
    return row?.total ?? '0.00';
  }

  /** Cost breakdown, payment status and expected profit at the asking price (requires costs.read). */
  async vehicleSummary(ctx: TenantContext, vehicleId: string) {
    const v = await this.vehicles.get(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    const cur = ctx.tenant.baseCurrency;
    const rows = await this.dbs.db
      .select({
        cost: vehicleCosts,
        categoryCode: costCategories.code,
        categoryEn: costCategories.nameEn,
        categoryAr: costCategories.nameAr,
        supplierName: suppliers.name,
        createdByName: users.fullName,
      })
      .from(vehicleCosts)
      .innerJoin(costCategories, eq(costCategories.id, vehicleCosts.categoryId))
      .leftJoin(suppliers, eq(suppliers.id, vehicleCosts.supplierId))
      .leftJoin(users, eq(users.id, vehicleCosts.createdBy))
      .where(eq(vehicleCosts.vehicleId, vehicleId))
      .orderBy(desc(vehicleCosts.costDate), desc(vehicleCosts.createdAt));
    const posted = rows.filter((r) => r.cost.status === 'posted');
    const pending = rows.filter((r) => r.cost.status === 'pending_approval');
    const byCategory = new Map<string, { code: string; nameEn: string; nameAr: string; total: string }>();
    for (const r of posted) {
      const cur0 = byCategory.get(r.categoryCode);
      byCategory.set(r.categoryCode, {
        code: r.categoryCode,
        nameEn: r.categoryEn,
        nameAr: r.categoryAr,
        total: d(cur0?.total ?? 0).plus(r.cost.amountBase).toFixed(2),
      });
    }
    const items = [];
    for (const r of rows) {
      const paid = r.cost.sourceType === 'acquisition' ? null : await this.payables.paidBase('vehicle_cost', r.cost.id);
      items.push({ ...r.cost, categoryCode: r.categoryCode, categoryEn: r.categoryEn, categoryAr: r.categoryAr, supplierName: r.supplierName, createdByName: r.createdByName, paidBase: paid });
    }
    const totalPosted = sum(posted.map((r) => r.cost.amountBase));
    let expected: null | { price: string; net: string; tax: string; grossProfit: string; marginPct: string | null } = null;
    if (v.askingPrice) {
      const tax = computeTax({
        amount: v.askingPrice,
        amountIncludesTax: ctx.tenant.settings.tax.pricesIncludeTax,
        mode: ctx.tenant.settings.tax.mode,
        ratePct: ctx.tenant.settings.tax.ratePct,
        cost: totalPosted.toFixed(2),
        currency: cur,
        rounding: ctx.tenant.settings.rounding,
      });
      const pm = profitMetrics(tax.net, totalPosted.toFixed(2), cur);
      expected = { price: v.askingPrice, net: tax.net, tax: tax.tax, grossProfit: pm.grossProfit, marginPct: pm.marginPct };
    }
    return {
      vehicleId,
      currency: cur,
      totals: {
        posted: money(totalPosted, cur),
        pending: money(sum(pending.map((r) => r.cost.amountBase)), cur),
        purchase: money(sum(posted.filter((r) => r.categoryCode === 'purchase').map((r) => r.cost.amountBase)), cur),
        additional: money(sum(posted.filter((r) => r.categoryCode !== 'purchase').map((r) => r.cost.amountBase)), cur),
        postSale: money(sum(posted.filter((r) => r.cost.postSale).map((r) => r.cost.amountBase)), cur),
      },
      costLockedAt: v.costLockedAt,
      byCategory: [...byCategory.values()],
      expectedAtAskingPrice: expected,
      items,
    };
  }

  async listPending(ctx: TenantContext) {
    const rows = await this.dbs.db
      .select({ cost: vehicleCosts, stockNumber: vehicles.stockNumber, branchId: vehicles.branchId, categoryEn: costCategories.nameEn, categoryAr: costCategories.nameAr })
      .from(vehicleCosts)
      .innerJoin(vehicles, eq(vehicles.id, vehicleCosts.vehicleId))
      .innerJoin(costCategories, eq(costCategories.id, vehicleCosts.categoryId))
      .where(eq(vehicleCosts.status, 'pending_approval'))
      .orderBy(asc(vehicleCosts.createdAt));
    return rows.filter((r) => ctx.allBranches || ctx.branchIds.includes(r.branchId));
  }
}
