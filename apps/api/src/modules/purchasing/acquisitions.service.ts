import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, SQL, sql } from 'drizzle-orm';
import {
  AcquisitionApproveInput,
  AcquisitionCreateInput,
  AcquisitionListQuery,
  AcquisitionUpdateInput,
  d,
  isPreSaleStatus,
  money,
  todayInZone,
  VehicleStatus,
} from '@autohub/shared';
import { assertBranchAccess, assertPermission, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { acquisitions, branches, suppliers, vehicleMakes, vehicleModels, vehicles } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { ApprovalsService } from '../finance/approvals.service';
import { CashService } from '../finance/cash.service';
import { resolveFx } from '../finance/fx';
import { PayablesService } from '../finance/payables.service';
import { SupplierPaymentsService } from '../finance/supplier-payments.service';
import { NumberingService } from '../numbering/numbering.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { CostsService } from './costs.service';

registerUniqueConstraint('acquisitions_vehicle_live_uq', 'acquisition_exists', 'This vehicle already has an active purchase record');
registerUniqueConstraint('vehicle_costs_source_uq', 'already_posted', 'This document has already been posted as a cost');

type AcquisitionRow = typeof acquisitions.$inferSelect;

/**
 * Vehicle purchases. Creating an acquisition registers the vehicle as `incoming`; approving it
 * capitalises the purchase price (Dr 1300 Inventory / Cr 2000 Payables) and makes it payable.
 * Cancelling an approved purchase reverses that entry and removes the vehicle from stock.
 */
@Injectable()
export class AcquisitionsService {
  constructor(
    private readonly dbs: DbService,
    private readonly vehicles: VehiclesService,
    private readonly costs: CostsService,
    private readonly approvals: ApprovalsService,
    private readonly payments: SupplierPaymentsService,
    private readonly payables: PayablesService,
    private readonly cash: CashService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  private async assertSupplier(id: string) {
    const [s] = await this.dbs.db.select({ id: suppliers.id, isActive: suppliers.isActive }).from(suppliers).where(eq(suppliers.id, id));
    if (!s) throw notFound('Supplier');
    if (!s.isActive) throw unprocessable('supplier_inactive', 'This supplier is inactive');
  }

  async create(ctx: TenantContext, input: AcquisitionCreateInput) {
    assertPermission(ctx, 'vehicles.create');
    assertBranchAccess(ctx, input.branchId);
    await this.assertSupplier(input.supplierId);
    const fx = resolveFx(ctx, input.currency, input.exchangeRate);
    const price = money(input.purchasePrice, input.currency);
    const priceBase = fx.toBase(price);

    const vehicle = await this.vehicles.create(
      ctx,
      { ...input.vehicle, branchId: input.branchId, initialStatus: 'incoming', acquiredAt: input.vehicle.acquiredAt ?? input.purchaseDate },
      { supplierId: input.supplierId, source: 'acquisition' },
    );
    const number = await this.numbering.next('acquisition');
    const status = input.submit ? 'pending_approval' : 'draft';
    const [a] = await this.dbs.db
      .insert(acquisitions)
      .values({
        tenantId: ctx.tenant.id,
        number,
        branchId: input.branchId,
        supplierId: input.supplierId,
        vehicleId: vehicle.id,
        sourceType: input.sourceType,
        purchaseDate: input.purchaseDate,
        purchasePrice: price,
        currency: input.currency,
        exchangeRate: fx.rate,
        purchasePriceBase: priceBase,
        paymentMethod: input.paymentMethod ?? null,
        dueDate: input.dueDate ?? null,
        status,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await this.dbs.db.update(vehicles).set({ acquisitionId: a!.id }).where(eq(vehicles.id, vehicle.id));
    if (status === 'pending_approval') await this.openApproval(ctx, a!, vehicle.stockNumber);
    await this.audit.record({
      action: 'acquisition.created',
      entityType: 'acquisition',
      entityId: a!.id,
      summary: `${number}: ${vehicle.stockNumber} ${price} ${input.currency}`,
      after: a,
    });
    return { ...a!, vehicle: { id: vehicle.id, stockNumber: vehicle.stockNumber, warnings: vehicle.warnings } };
  }

  private openApproval(ctx: TenantContext, a: AcquisitionRow, stockNumber: string) {
    return this.approvals.open(ctx, {
      type: 'acquisition',
      entityType: 'acquisition',
      entityId: a.id,
      requiredPermission: 'acquisitions.approve',
      summary: `${a.number} · ${stockNumber}: ${a.purchasePrice} ${a.currency}`,
      payload: { vehicleId: a.vehicleId, amountBase: a.purchasePriceBase },
      branchId: a.branchId,
    });
  }

  async lock(id: string): Promise<AcquisitionRow> {
    const [a] = await this.dbs.db.select().from(acquisitions).where(eq(acquisitions.id, id)).for('update');
    if (!a) throw notFound('Acquisition');
    return a;
  }

  async update(ctx: TenantContext, id: string, input: AcquisitionUpdateInput) {
    const before = await this.lock(id);
    assertBranchAccess(ctx, before.branchId);
    if (before.version !== input.version) {
      throw conflict('version_conflict', 'This purchase was changed by someone else. Reload and try again.', { currentVersion: before.version });
    }
    if (!['draft', 'pending_approval'].includes(before.status)) {
      throw conflict('acquisition_locked', 'Approved or cancelled purchases cannot be edited');
    }
    if (input.supplierId && input.supplierId !== before.supplierId) await this.assertSupplier(input.supplierId);
    const currency = input.currency ?? (before.currency as AcquisitionCreateInput['currency']);
    const priceChanged = input.purchasePrice !== undefined || input.currency !== undefined || input.exchangeRate !== undefined;
    let pricing = {};
    if (priceChanged) {
      const fx = resolveFx(ctx, currency, input.exchangeRate ?? (currency === before.currency ? before.exchangeRate : undefined));
      const price = money(input.purchasePrice ?? before.purchasePrice, currency);
      pricing = { purchasePrice: price, currency, exchangeRate: fx.rate, purchasePriceBase: fx.toBase(price) };
    }
    const { version: _v, purchasePrice: _p, currency: _c, exchangeRate: _r, ...rest } = input;
    const [after] = await this.dbs.db
      .update(acquisitions)
      .set({ ...rest, ...pricing, version: before.version + 1, updatedAt: new Date() })
      .where(and(eq(acquisitions.id, id), eq(acquisitions.version, before.version)))
      .returning();
    if (input.supplierId && input.supplierId !== before.supplierId) {
      await this.dbs.db.update(vehicles).set({ supplierId: input.supplierId }).where(eq(vehicles.id, before.vehicleId));
    }
    await this.audit.record({ action: 'acquisition.updated', entityType: 'acquisition', entityId: id, ...diff(before, after!) });
    return after!;
  }

  async submit(ctx: TenantContext, id: string) {
    const a = await this.lock(id);
    assertBranchAccess(ctx, a.branchId);
    if (a.status !== 'draft') throw conflict('acquisition_not_draft', 'Only draft purchases can be submitted');
    const [after] = await this.dbs.db
      .update(acquisitions)
      .set({ status: 'pending_approval', version: a.version + 1, updatedAt: new Date() })
      .where(eq(acquisitions.id, id))
      .returning();
    const v = await this.vehicles.get(a.vehicleId);
    await this.openApproval(ctx, after!, v.stockNumber);
    await this.audit.record({ action: 'acquisition.submitted', entityType: 'acquisition', entityId: id, before: { status: a.status }, after: { status: 'pending_approval' } });
    return after!;
  }

  /** Approves the purchase: posts the purchase cost and (optionally) pays it in full right away. */
  async approve(ctx: TenantContext, id: string, input: AcquisitionApproveInput) {
    const a = await this.lock(id);
    assertBranchAccess(ctx, a.branchId);
    if (!['draft', 'pending_approval'].includes(a.status)) throw conflict('acquisition_not_pending', 'This purchase is not awaiting approval');
    const v = await this.vehicles.get(a.vehicleId);
    if (v.status === 'removed') throw conflict('vehicle_removed', 'The vehicle was removed from stock');
    const purchase = await this.costs.categoryByCode('purchase');
    const [after] = await this.dbs.db
      .update(acquisitions)
      .set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date(), version: a.version + 1, updatedAt: new Date() })
      .where(eq(acquisitions.id, id))
      .returning();
    await this.costs.create(
      ctx,
      {
        vehicleId: a.vehicleId,
        categoryId: purchase.id,
        description: `Purchase ${a.number}`,
        amount: a.purchasePrice,
        currency: a.currency as AcquisitionCreateInput['currency'],
        exchangeRate: a.exchangeRate,
        costDate: a.purchaseDate,
        supplierId: a.supplierId,
        notes: null,
      },
      { sourceType: 'acquisition', sourceId: a.id, forceStatus: 'posted', skipPayNow: true },
    );
    await this.approvals.resolve(ctx, { type: 'acquisition', entityType: 'acquisition', entityId: id, status: 'approved', note: input.note });
    await this.audit.record({
      action: 'acquisition.approved',
      entityType: 'acquisition',
      entityId: id,
      before: { status: a.status },
      after: { status: 'approved', amountBase: a.purchasePriceBase, note: input.note ?? null },
    });
    let payment = null;
    if (input.payNow) {
      const acct = await this.cash.lockAccount(ctx, input.payNow.cashAccountId);
      if (acct.currency !== ctx.tenant.baseCurrency) {
        throw unprocessable('pay_now_base_currency', 'Immediate payment requires an account in the company base currency');
      }
      payment = await this.payments.pay(ctx, {
        supplierId: a.supplierId,
        cashAccountId: acct.id,
        paidAt: todayInZone(ctx.tenant.settings.timezone) < a.purchaseDate ? a.purchaseDate : todayInZone(ctx.tenant.settings.timezone),
        method: input.payNow.method,
        reference: input.payNow.reference ?? null,
        notes: `Paid on approval of ${a.number}`,
        amount: a.purchasePriceBase,
        allocations: [{ targetType: 'acquisition', targetId: a.id, amountBase: a.purchasePriceBase }],
      });
    }
    return { ...after!, payment };
  }

  /** Sends a submitted purchase back to draft with the approver's note. */
  async reject(ctx: TenantContext, id: string, reason: string) {
    const a = await this.lock(id);
    assertBranchAccess(ctx, a.branchId);
    if (a.status !== 'pending_approval') throw conflict('acquisition_not_pending', 'This purchase is not awaiting approval');
    const [after] = await this.dbs.db
      .update(acquisitions)
      .set({ status: 'draft', version: a.version + 1, updatedAt: new Date() })
      .where(eq(acquisitions.id, id))
      .returning();
    await this.approvals.resolve(ctx, { type: 'acquisition', entityType: 'acquisition', entityId: id, status: 'rejected', note: reason });
    await this.audit.record({ action: 'acquisition.rejected', entityType: 'acquisition', entityId: id, before: { status: a.status }, after: { status: 'draft', reason } });
    return after!;
  }

  /**
   * Cancels a purchase. An approved purchase can only be cancelled while the vehicle is still
   * unsold and no payment is recorded against it; the purchase cost is reversed and any other
   * capitalised costs are written off when the vehicle leaves stock.
   */
  async cancel(ctx: TenantContext, id: string, reason: string) {
    const a = await this.lock(id);
    assertBranchAccess(ctx, a.branchId);
    if (a.status === 'cancelled') throw conflict('already_cancelled', 'This purchase is already cancelled');
    const v = await this.vehicles.lock(a.vehicleId);
    if (v.status !== 'removed' && !isPreSaleStatus(v.status as VehicleStatus)) {
      throw conflict('vehicle_committed', 'The vehicle is reserved or sold; cancel the reservation or sale first', { vehicleStatus: v.status });
    }
    if (await this.vehicles.inTransit(v.id)) throw conflict('vehicle_in_transit', 'The vehicle is in transit between branches');
    if (a.status === 'approved') {
      const paid = await this.payables.paidBase('acquisition', a.id);
      if (d(paid).gt(0)) throw conflict('acquisition_has_payments', 'Void the supplier payments for this purchase before cancelling it', { paid });
      const [cost] = await this.costs.findBySource('acquisition', a.id);
      if (cost && cost.status === 'posted') await this.costs.reverse(ctx, cost.id, `Purchase ${a.number} cancelled: ${reason}`, { internal: true });
    }
    const [after] = await this.dbs.db
      .update(acquisitions)
      .set({ status: 'cancelled', cancelledBy: ctx.userId, cancelledAt: new Date(), cancelReason: reason, version: a.version + 1, updatedAt: new Date() })
      .where(eq(acquisitions.id, id))
      .returning();
    await this.approvals.resolve(ctx, { type: 'acquisition', entityType: 'acquisition', entityId: id, status: 'cancelled', note: reason });
    if (v.status !== 'removed') {
      await this.vehicles.transition(ctx, v.id, 'removed', { system: true, source: 'acquisition', sourceId: a.id, reason: `Purchase ${a.number} cancelled: ${reason}` });
    }
    await this.audit.record({ action: 'acquisition.cancelled', entityType: 'acquisition', entityId: id, before: { status: a.status }, after: { status: 'cancelled', reason } });
    return after!;
  }

  async setOwnershipTransfer(ctx: TenantContext, id: string, status: 'pending' | 'in_progress' | 'completed') {
    const a = await this.lock(id);
    assertBranchAccess(ctx, a.branchId);
    if (a.status === 'cancelled') throw conflict('already_cancelled', 'This purchase is cancelled');
    const [after] = await this.dbs.db
      .update(acquisitions)
      .set({ ownershipTransferStatus: status, version: a.version + 1, updatedAt: new Date() })
      .where(eq(acquisitions.id, id))
      .returning();
    await this.audit.record({
      action: 'acquisition.ownership_updated',
      entityType: 'acquisition',
      entityId: id,
      before: { ownershipTransferStatus: a.ownershipTransferStatus },
      after: { ownershipTransferStatus: status },
    });
    return after!;
  }

  async list(ctx: TenantContext, q: AcquisitionListQuery) {
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(acquisitions.status, q.status));
    if (q.supplierId) conds.push(eq(acquisitions.supplierId, q.supplierId));
    if (q.branchId) conds.push(eq(acquisitions.branchId, q.branchId));
    if (q.from) conds.push(gte(acquisitions.purchaseDate, q.from));
    if (q.to) conds.push(lte(acquisitions.purchaseDate, q.to));
    if (!ctx.allBranches) conds.push(sql`${acquisitions.branchId} = ANY(${ctx.branchIds.length ? ctx.branchIds : ['00000000-0000-0000-0000-000000000000']}::uuid[])`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(sql`(${acquisitions.number} ILIKE ${like} OR ${vehicles.stockNumber} ILIKE ${like} OR ${vehicles.vin} ILIKE ${like} OR ${suppliers.name} ILIKE ${like})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const paidSql = sql<string>`(SELECT coalesce(sum(spa.amount_base), 0) FROM supplier_payment_allocations spa JOIN supplier_payments sp ON sp.id = spa.payment_id WHERE spa.target_type = 'acquisition' AND spa.target_id = acquisitions.id AND sp.status = 'posted')::numeric(18,2)::text`;
    const base = this.dbs.db
      .select({
        id: acquisitions.id,
        number: acquisitions.number,
        status: acquisitions.status,
        purchaseDate: acquisitions.purchaseDate,
        purchasePrice: acquisitions.purchasePrice,
        currency: acquisitions.currency,
        purchasePriceBase: acquisitions.purchasePriceBase,
        dueDate: acquisitions.dueDate,
        sourceType: acquisitions.sourceType,
        ownershipTransferStatus: acquisitions.ownershipTransferStatus,
        branchId: acquisitions.branchId,
        branchName: branches.name,
        supplierId: acquisitions.supplierId,
        supplierName: suppliers.name,
        vehicleId: acquisitions.vehicleId,
        stockNumber: vehicles.stockNumber,
        vin: vehicles.vin,
        vehicleStatus: vehicles.status,
        modelYear: vehicles.modelYear,
        makeEn: vehicleMakes.nameEn,
        makeAr: vehicleMakes.nameAr,
        modelEn: vehicleModels.nameEn,
        modelAr: vehicleModels.nameAr,
        paidBase: paidSql,
      })
      .from(acquisitions)
      .innerJoin(vehicles, eq(vehicles.id, acquisitions.vehicleId))
      .innerJoin(suppliers, eq(suppliers.id, acquisitions.supplierId))
      .innerJoin(branches, eq(branches.id, acquisitions.branchId))
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId));
    const items = await base
      .where(where)
      .orderBy(desc(acquisitions.purchaseDate), desc(acquisitions.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [c] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(acquisitions)
      .innerJoin(vehicles, eq(vehicles.id, acquisitions.vehicleId))
      .innerJoin(suppliers, eq(suppliers.id, acquisitions.supplierId))
      .where(where);
    return {
      items: items.map((i) => ({
        ...i,
        outstandingBase: i.status === 'approved' ? d(i.purchasePriceBase).minus(i.paidBase).toFixed(2) : null,
      })),
      total: c?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async get(ctx: TenantContext, id: string) {
    const [a] = await this.dbs.db.select().from(acquisitions).where(eq(acquisitions.id, id));
    if (!a) throw notFound('Acquisition');
    assertBranchAccess(ctx, a.branchId);
    const [supplier] = await this.dbs.db.select().from(suppliers).where(eq(suppliers.id, a.supplierId));
    const [vehicle] = await this.dbs.db
      .select({
        id: vehicles.id,
        stockNumber: vehicles.stockNumber,
        vin: vehicles.vin,
        status: vehicles.status,
        modelYear: vehicles.modelYear,
        makeEn: vehicleMakes.nameEn,
        makeAr: vehicleMakes.nameAr,
        modelEn: vehicleModels.nameEn,
        modelAr: vehicleModels.nameAr,
      })
      .from(vehicles)
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .where(eq(vehicles.id, a.vehicleId));
    const payable = await this.payables.describe('acquisition', a.id);
    const payments = await this.payments.forTargets('acquisition', [a.id]);
    return { ...a, supplier, vehicle, paidBase: payable.paidBase, outstandingBase: payable.outstandingBase, payments };
  }
}
