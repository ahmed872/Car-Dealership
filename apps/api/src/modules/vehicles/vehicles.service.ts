import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, gte, ilike, inArray, isNull, lte, ne, notInArray, or, SQL, sql } from 'drizzle-orm';
import {
  checkTransition,
  d,
  todayInZone,
  UNSOLD_STATUSES,
  validateVin,
  VehicleCreateInput,
  VehicleListQuery,
  VehicleStatus,
  VehicleUpdateInput,
} from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { AppError, conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import {
  branches,
  features,
  odometerReadings,
  users,
  vehicleDocuments,
  vehicleFeatureLinks,
  vehicleInspections,
  vehicleMakes,
  vehicleMedia,
  vehicleModels,
  vehiclePriceHistory,
  vehicles,
  vehicleStatusHistory,
  vehicleTransfers,
} from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingService } from '../ledger/posting.service';
import { NumberingService } from '../numbering/numbering.service';
import { SubscriptionService } from '../tenancy/subscription.service';

registerUniqueConstraint('vehicles_active_vin_uq', 'vin_in_stock', 'A vehicle with this VIN is already in stock');
registerUniqueConstraint('vehicles_stock_number_uq', 'stock_number_taken', 'Stock number already exists');

export type VehicleRow = typeof vehicles.$inferSelect;
export type StatusSource = 'manual' | 'acquisition' | 'reservation' | 'sale' | 'delivery' | 'return' | 'transfer' | 'stock_count' | 'system';

const SORTS: Record<string, SQL> = {
  stockedAt: sql`${vehicles.stockedAt}`,
  askingPrice: sql`${vehicles.askingPrice}`,
  modelYear: sql`${vehicles.modelYear}`,
  odometer: sql`${vehicles.odometerValue}`,
  createdAt: sql`${vehicles.createdAt}`,
  stockNumber: sql`${vehicles.stockNumber}`,
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

@Injectable()
export class VehiclesService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly subscriptions: SubscriptionService,
    private readonly posting: PostingService,
  ) {
    SubscriptionService.vehicleCounter = async (db) => {
      const [r] = await db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(vehicles)
        .where(inArray(vehicles.status, [...UNSOLD_STATUSES]));
      return r?.n ?? 0;
    };
  }

  // ── VIN rules ─────────────────────────────────────────────────────────────────────────
  private checkVin(vin: string | null | undefined, opts: { nonStandard: boolean; modelYear: number; specRegion?: string | null }) {
    if (!vin) return { vin: null, warnings: [] as string[] };
    if (opts.nonStandard) {
      if (!/^[A-Z0-9]{5,17}$/.test(vin)) throw unprocessable('invalid_vin', 'Chassis number must be 5-17 letters or digits');
      return { vin, warnings: ['non_standard_vin'] };
    }
    if (opts.modelYear < 1981) {
      if (!/^[A-Z0-9]{5,17}$/.test(vin)) throw unprocessable('invalid_vin', 'Chassis number must be 5-17 letters or digits');
      return { vin, warnings: [] };
    }
    // North-American-spec vehicles must carry a valid check digit; elsewhere it is advisory.
    const enforce = opts.specRegion === 'american' || opts.specRegion === 'canadian';
    const r = validateVin(vin, { enforceCheckDigit: enforce });
    if (!r.valid) throw unprocessable('invalid_vin', 'VIN is not valid', { errors: r.errors });
    return { vin: r.normalized, warnings: r.warnings as string[] };
  }

  private async assertMakeModel(makeId: string, modelId: string) {
    const [m] = await this.dbs.db
      .select({ id: vehicleModels.id, makeId: vehicleModels.makeId })
      .from(vehicleModels)
      .where(eq(vehicleModels.id, modelId));
    if (!m) throw notFound('Model');
    if (m.makeId !== makeId) throw unprocessable('model_make_mismatch', 'The model does not belong to the selected make');
  }

  private async assertBranchExists(ctx: TenantContext, branchId: string) {
    assertBranchAccess(ctx, branchId);
    const [b] = await this.dbs.db.select({ id: branches.id, isActive: branches.isActive }).from(branches).where(eq(branches.id, branchId));
    if (!b) throw notFound('Branch');
    if (!b.isActive) throw unprocessable('branch_inactive', 'This branch is inactive');
  }

  // ── Create / update ────────────────────────────────────────────────────────────────────
  async create(ctx: TenantContext, input: VehicleCreateInput, opts: { acquisitionId?: string; supplierId?: string; source?: StatusSource } = {}) {
    await this.subscriptions.assertWithinLimit('vehicles');
    await this.assertBranchExists(ctx, input.branchId);
    await this.assertMakeModel(input.makeId, input.modelId);
    const { vin, warnings } = this.checkVin(input.vin, { nonStandard: input.vinNonStandard, modelYear: input.modelYear, specRegion: input.specRegion });
    const stockNumber = await this.numbering.next('vehicle');
    const db = this.dbs.db;
    const { initialStatus, featureIds, vinNonStandard: _ns, odometerValue, odometerUnit, ...rest } = input;
    const [v] = await db
      .insert(vehicles)
      .values({
        ...rest,
        vin,
        tenantId: ctx.tenant.id,
        stockNumber,
        status: initialStatus,
        odometerValue,
        odometerUnit,
        acquiredAt: input.acquiredAt ?? todayInZone(ctx.tenant.settings.timezone),
        acquisitionId: opts.acquisitionId ?? null,
        supplierId: opts.supplierId ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await db.insert(vehicleStatusHistory).values({
      tenantId: ctx.tenant.id,
      vehicleId: v!.id,
      fromStatus: null,
      toStatus: initialStatus,
      source: opts.source ?? 'manual',
      sourceId: opts.acquisitionId ?? null,
      actorUserId: ctx.userId,
      reason: 'created',
    });
    await db.insert(odometerReadings).values({
      tenantId: ctx.tenant.id,
      vehicleId: v!.id,
      value: odometerValue,
      unit: odometerUnit,
      source: 'acquisition',
      recordedBy: ctx.userId,
    });
    if (featureIds.length) await this.setFeatures(ctx, v!.id, featureIds, false);
    await this.audit.record({
      action: 'vehicle.created',
      entityType: 'vehicle',
      entityId: v!.id,
      summary: `Vehicle ${stockNumber} created`,
      after: v,
    });
    return { ...v!, warnings };
  }

  async update(ctx: TenantContext, id: string, input: VehicleUpdateInput) {
    const before = await this.lock(id);
    assertBranchAccess(ctx, before.branchId);
    if (before.version !== input.version) {
      throw conflict('version_conflict', 'This vehicle was changed by someone else. Reload and try again.', { currentVersion: before.version });
    }
    if (['delivered', 'removed'].includes(before.status)) {
      throw conflict('vehicle_closed', 'Delivered or removed vehicles cannot be edited');
    }
    const makeId = input.makeId ?? before.makeId;
    const modelId = input.modelId ?? before.modelId;
    if (input.makeId || input.modelId) await this.assertMakeModel(makeId, modelId);
    const { version: _v, vinNonStandard, ...rest } = input;
    let vin = before.vin;
    let warnings: string[] = [];
    if (input.vin !== undefined) {
      ({ vin, warnings } = this.checkVin(input.vin, {
        nonStandard: !!vinNonStandard,
        modelYear: input.modelYear ?? before.modelYear,
        specRegion: input.specRegion ?? before.specRegion,
      }));
    }
    const [after] = await this.dbs.db
      .update(vehicles)
      .set({ ...rest, vin, version: before.version + 1, updatedAt: new Date() })
      .where(and(eq(vehicles.id, id), eq(vehicles.version, before.version)))
      .returning();
    if (!after) throw conflict('version_conflict', 'This vehicle was changed by someone else. Reload and try again.');
    await this.audit.record({ action: 'vehicle.updated', entityType: 'vehicle', entityId: id, ...diff(before, after) });
    return { ...after, warnings };
  }

  /** SELECT … FOR UPDATE — serialises every change to a vehicle (status, reservation, sale). */
  async lock(id: string): Promise<VehicleRow> {
    const [v] = await this.dbs.db.select().from(vehicles).where(eq(vehicles.id, id)).for('update');
    if (!v) throw notFound('Vehicle');
    return v;
  }

  async get(id: string): Promise<VehicleRow> {
    const [v] = await this.dbs.db.select().from(vehicles).where(eq(vehicles.id, id));
    if (!v) throw notFound('Vehicle');
    return v;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────
  /**
   * The ONLY way a vehicle's status changes. Workflows pass system=true; manual changes are
   * restricted to non-workflow states. The row lock prevents concurrent conflicting changes.
   */
  async transition(
    ctx: TenantContext,
    id: string,
    to: VehicleStatus,
    opts: { system: boolean; source: StatusSource; sourceId?: string | null; reason?: string | null },
  ): Promise<VehicleRow> {
    const v = await this.lock(id);
    assertBranchAccess(ctx, v.branchId);
    const check = checkTransition(v.status as VehicleStatus, to, opts.system);
    if (!check.ok) {
      throw new AppError('invalid_transition', 409, `Cannot change status from ${v.status} to ${to}`, {
        from: v.status,
        to,
        reason: check.reason,
      });
    }
    if (!opts.system) await this.assertManualRules(ctx, v, to, opts.reason ?? null);

    const db = this.dbs.db;
    const [after] = await db
      .update(vehicles)
      .set({
        status: to,
        statusChangedAt: new Date(),
        version: v.version + 1,
        updatedAt: new Date(),
        removedReason: to === 'removed' ? opts.reason ?? null : v.removedReason,
        // A returned vehicle re-enters stock: restart its aging clock.
        stockedAt: v.status === 'returned' && to !== 'removed' ? new Date() : v.stockedAt,
      })
      .where(eq(vehicles.id, id))
      .returning();
    await db.insert(vehicleStatusHistory).values({
      tenantId: ctx.tenant.id,
      vehicleId: id,
      fromStatus: v.status,
      toStatus: to,
      reason: opts.reason ?? null,
      source: opts.source,
      sourceId: opts.sourceId ?? null,
      actorUserId: ctx.userId,
    });
    if (to === 'removed') await this.postWriteOff(ctx, v, opts.reason ?? 'removed from stock');
    await this.audit.record({
      action: 'vehicle.status_changed',
      entityType: 'vehicle',
      entityId: id,
      summary: `${v.stockNumber}: ${v.status} → ${to}`,
      before: { status: v.status },
      after: { status: to, reason: opts.reason ?? null, source: opts.source },
    });
    return after!;
  }

  private async assertManualRules(ctx: TenantContext, v: VehicleRow, to: VehicleStatus, reason: string | null) {
    if (to === 'removed') {
      assertPermission(ctx, 'vehicles.remove');
      if (!reason || reason.trim().length < 3) throw unprocessable('reason_required', 'A reason is required to remove a vehicle from stock');
    }
    if (to === 'available') {
      if (!v.askingPrice || d(v.askingPrice).lte(0)) {
        throw unprocessable('price_required', 'Set an asking price before listing the vehicle for sale');
      }
      if (ctx.tenant.settings.inventory.requireInspectionBeforeListing) {
        const [done] = await this.dbs.db
          .select({ id: vehicleInspections.id })
          .from(vehicleInspections)
          .where(and(eq(vehicleInspections.vehicleId, v.id), eq(vehicleInspections.status, 'completed')))
          .limit(1);
        if (!done) throw unprocessable('inspection_required', 'A completed inspection is required before listing for sale');
      }
    }
    if (await this.inTransit(v.id)) throw conflict('vehicle_in_transit', 'The vehicle is in transit between branches');
  }

  async inTransit(vehicleId: string): Promise<boolean> {
    const [t] = await this.dbs.db
      .select({ id: vehicleTransfers.id })
      .from(vehicleTransfers)
      .where(and(eq(vehicleTransfers.vehicleId, vehicleId), eq(vehicleTransfers.status, 'in_transit')))
      .limit(1);
    return !!t;
  }

  /**
   * Removing a vehicle that carries capitalised cost writes that cost off (Dr 6300 / Cr 1300).
   * The balance up to today is written off today; any future-dated cost is written off on its own
   * date, so the vehicle's inventory is zero from removal onward and never negative on any date.
   */
  private async postWriteOff(ctx: TenantContext, v: VehicleRow, reason: string) {
    const today = todayInZone(ctx.tenant.settings.timezone);
    const rows = await this.dbs.query<{ d: string; amt: string }>(
      `SELECT CASE WHEN je.entry_date <= $2::date THEN $2::date ELSE je.entry_date END::text AS d,
              sum(jl.debit - jl.credit)::numeric(18,2)::text AS amt
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.vehicle_id = $1 AND jl.account_code = '1300'
        GROUP BY 1 ORDER BY 1`,
      [v.id, today],
    );
    for (const r of rows) {
      if (d(r.amt).lte(0)) continue;
      await this.posting.post({
        sourceType: 'vehicle',
        sourceId: v.id,
        event: r.d === today ? 'vehicle.written_off' : `vehicle.written_off:${r.d}`,
        date: r.d,
        description: `Write-off ${v.stockNumber}: ${reason}`,
        branchId: v.branchId,
        lines: [
          { account: ACCOUNTS.INVENTORY_ADJUSTMENTS, debit: r.amt, vehicleId: v.id },
          { account: ACCOUNTS.INVENTORY, credit: r.amt, vehicleId: v.id },
        ],
      });
    }
  }

  // ── Pricing ───────────────────────────────────────────────────────────────────────────
  async setPricing(ctx: TenantContext, id: string, input: { askingPrice: string | null; minPrice: string | null; targetMarginPct?: string | null; reason?: string | null }) {
    const v = await this.lock(id);
    assertBranchAccess(ctx, v.branchId);
    if (['sold', 'delivered', 'removed'].includes(v.status)) throw conflict('vehicle_closed', 'Prices cannot change after sale');
    const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
    const norm = (x: string | null | undefined) => (x === null || x === undefined ? null : d(x).toFixed(2));
    if (norm(input.askingPrice) !== norm(v.askingPrice)) changes.push({ field: 'asking_price', oldValue: v.askingPrice, newValue: norm(input.askingPrice) });
    if (norm(input.minPrice) !== norm(v.minPrice)) {
      assertPermission(ctx, 'pricing.set_floor');
      changes.push({ field: 'min_price', oldValue: v.minPrice, newValue: norm(input.minPrice) });
    }
    if (input.targetMarginPct !== undefined && input.targetMarginPct !== v.targetMarginPct) {
      changes.push({ field: 'target_margin_pct', oldValue: v.targetMarginPct, newValue: input.targetMarginPct ?? null });
    }
    if (!changes.length) return v;
    const [after] = await this.dbs.db
      .update(vehicles)
      .set({
        askingPrice: norm(input.askingPrice),
        minPrice: norm(input.minPrice),
        targetMarginPct: input.targetMarginPct === undefined ? v.targetMarginPct : input.targetMarginPct,
        priceUpdatedAt: new Date(),
        version: v.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(vehicles.id, id))
      .returning();
    await this.dbs.db
      .insert(vehiclePriceHistory)
      .values(changes.map((c) => ({ ...c, tenantId: ctx.tenant.id, vehicleId: id, reason: input.reason ?? null, actorUserId: ctx.userId })));
    await this.audit.record({
      action: 'vehicle.pricing_changed',
      entityType: 'vehicle',
      entityId: id,
      summary: `${v.stockNumber} pricing updated`,
      before: Object.fromEntries(changes.map((c) => [c.field, c.oldValue])),
      after: { ...Object.fromEntries(changes.map((c) => [c.field, c.newValue])), reason: input.reason ?? null },
    });
    return after!;
  }

  // ── Odometer ──────────────────────────────────────────────────────────────────────────
  async addOdometer(ctx: TenantContext, id: string, input: { value: number; unit: 'km' | 'mi'; source: string; notes?: string | null }) {
    const v = await this.lock(id);
    assertBranchAccess(ctx, v.branchId);
    const toKm = (val: number, unit: string) => (unit === 'mi' ? Math.round(val * 1.609344) : val);
    const decreasing = toKm(input.value, input.unit) < toKm(v.odometerValue, v.odometerUnit);
    if (decreasing && (!input.notes || input.notes.trim().length < 3)) {
      throw unprocessable('odometer_decrease_reason', 'A lower reading than the last one needs an explanation');
    }
    await this.dbs.db.insert(odometerReadings).values({
      tenantId: ctx.tenant.id,
      vehicleId: id,
      value: input.value,
      unit: input.unit,
      source: input.source,
      isCorrection: decreasing,
      notes: input.notes ?? null,
      recordedBy: ctx.userId,
    });
    await this.dbs.db
      .update(vehicles)
      .set({ odometerValue: input.value, odometerUnit: input.unit, version: v.version + 1, updatedAt: new Date() })
      .where(eq(vehicles.id, id));
    await this.audit.record({
      action: decreasing ? 'vehicle.odometer_corrected' : 'vehicle.odometer_recorded',
      entityType: 'vehicle',
      entityId: id,
      before: { value: v.odometerValue, unit: v.odometerUnit },
      after: { value: input.value, unit: input.unit, notes: input.notes ?? null },
    });
    return { ok: true, isCorrection: decreasing };
  }

  // ── Features ──────────────────────────────────────────────────────────────────────────
  async updateFeatures(ctx: TenantContext, vehicleId: string, featureIds: string[]) {
    const v = await this.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    return this.setFeatures(ctx, vehicleId, featureIds);
  }

  async setFeatures(ctx: TenantContext, vehicleId: string, featureIds: string[], audit = true) {
    const ids = [...new Set(featureIds)];
    if (ids.length) {
      const found = await this.dbs.db.select({ id: features.id }).from(features).where(inArray(features.id, ids));
      if (found.length !== ids.length) throw notFound('Feature');
    }
    await this.dbs.db.delete(vehicleFeatureLinks).where(eq(vehicleFeatureLinks.vehicleId, vehicleId));
    if (ids.length) {
      await this.dbs.db.insert(vehicleFeatureLinks).values(ids.map((featureId) => ({ tenantId: ctx.tenant.id, vehicleId, featureId })));
    }
    if (audit) await this.audit.record({ action: 'vehicle.features_set', entityType: 'vehicle', entityId: vehicleId, after: { featureIds: ids } });
    return { featureIds: ids };
  }

  // ── Queries ───────────────────────────────────────────────────────────────────────────
  async list(ctx: TenantContext, q: VehicleListQuery) {
    const db = this.dbs.db;
    const conds: SQL[] = [];
    if (!ctx.allBranches) conds.push(inArray(vehicles.branchId, ctx.branchIds.length ? ctx.branchIds : ['00000000-0000-0000-0000-000000000000']));
    if (q.status?.length) conds.push(inArray(vehicles.status, q.status));
    else if (q.scope === 'stock') conds.push(inArray(vehicles.status, [...UNSOLD_STATUSES, 'sold']));
    else if (q.scope === 'sold') conds.push(inArray(vehicles.status, ['sold', 'delivered']));
    if (q.branchId) conds.push(eq(vehicles.branchId, q.branchId));
    if (q.makeId) conds.push(eq(vehicles.makeId, q.makeId));
    if (q.modelId) conds.push(eq(vehicles.modelId, q.modelId));
    if (q.yearFrom) conds.push(gte(vehicles.modelYear, q.yearFrom));
    if (q.yearTo) conds.push(lte(vehicles.modelYear, q.yearTo));
    if (q.priceFrom) conds.push(gte(vehicles.askingPrice, q.priceFrom));
    if (q.priceTo) conds.push(lte(vehicles.askingPrice, q.priceTo));
    if (q.fuelType) conds.push(eq(vehicles.fuelType, q.fuelType));
    if (q.transmission) conds.push(eq(vehicles.transmission, q.transmission));
    if (q.bodyType) conds.push(eq(vehicles.bodyType, q.bodyType));
    if (q.condition) conds.push(eq(vehicles.condition, q.condition));
    if (q.stale) {
      const days = q.stale === 'critical' ? ctx.tenant.settings.inventory.staleDaysCritical : ctx.tenant.settings.inventory.staleDaysWarning;
      conds.push(inArray(vehicles.status, [...UNSOLD_STATUSES]));
      conds.push(sql`${vehicles.stockedAt} < now() - make_interval(days => ${days})`);
    }
    for (const fid of q.featureIds ?? []) {
      conds.push(
        exists(
          db
            .select({ x: sql`1` })
            .from(vehicleFeatureLinks)
            .where(and(eq(vehicleFeatureLinks.vehicleId, vehicles.id), eq(vehicleFeatureLinks.featureId, fid))),
        ),
      );
    }
    if (q.q) {
      const like = `%${escapeLike(q.q.trim().toUpperCase())}%`;
      const likeAny = `%${escapeLike(q.q.trim())}%`;
      conds.push(
        or(
          ilike(vehicles.stockNumber, like),
          ilike(vehicles.vin, like),
          ilike(vehicles.plateNumber, likeAny),
          ilike(vehicleMakes.nameEn, likeAny),
          ilike(vehicleMakes.nameAr, likeAny),
          ilike(vehicleModels.nameEn, likeAny),
          ilike(vehicleModels.nameAr, likeAny),
          ilike(vehicles.trim, likeAny),
        )!,
      );
    }
    const where = conds.length ? and(...conds) : undefined;
    const sortKey = q.sort?.replace(/^-/, '') ?? 'stockedAt';
    const sortExpr = SORTS[sortKey] ?? SORTS.stockedAt!;
    const order = q.sort?.startsWith('-') || !q.sort ? desc(sortExpr) : asc(sortExpr);
    const canSeeCost = hasPermission(ctx, 'vehicles.view_cost');

    const rows = await db
      .select({
        id: vehicles.id,
        stockNumber: vehicles.stockNumber,
        vin: vehicles.vin,
        plateNumber: vehicles.plateNumber,
        status: vehicles.status,
        branchId: vehicles.branchId,
        branchName: branches.name,
        makeNameEn: vehicleMakes.nameEn,
        makeNameAr: vehicleMakes.nameAr,
        modelNameEn: vehicleModels.nameEn,
        modelNameAr: vehicleModels.nameAr,
        trim: vehicles.trim,
        modelYear: vehicles.modelYear,
        condition: vehicles.condition,
        exteriorColor: vehicles.exteriorColor,
        odometerValue: vehicles.odometerValue,
        odometerUnit: vehicles.odometerUnit,
        fuelType: vehicles.fuelType,
        transmission: vehicles.transmission,
        askingPrice: vehicles.askingPrice,
        stockedAt: vehicles.stockedAt,
        statusChangedAt: vehicles.statusChangedAt,
        primaryPhotoId: sql<string | null>`(SELECT vm.file_id FROM vehicle_media vm WHERE vm.vehicle_id = ${vehicles.id} AND vm.kind = 'photo' ORDER BY vm.is_primary DESC, vm.sort_order ASC LIMIT 1)`,
        costTotal: canSeeCost
          ? sql<string | null>`(SELECT coalesce(sum(vc.amount_base), 0)::numeric(18,2)::text FROM vehicle_costs vc WHERE vc.vehicle_id = ${vehicles.id} AND vc.status = 'posted')`
          : sql<null>`NULL`,
      })
      .from(vehicles)
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .innerJoin(branches, eq(branches.id, vehicles.branchId))
      .where(where)
      .orderBy(order, desc(vehicles.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(vehicles)
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .where(where);
    const now = Date.now();
    return {
      items: rows.map((r) => ({
        ...r,
        daysInStock: (UNSOLD_STATUSES as readonly string[]).includes(r.status) ? Math.floor((now - r.stockedAt.getTime()) / 86_400_000) : null,
      })),
      total: count?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** Vehicle 360: everything about one car, filtered by the caller's permissions. */
  async detail(ctx: TenantContext, id: string) {
    const db = this.dbs.db;
    const [row] = await db
      .select({ v: vehicles, make: vehicleMakes, model: vehicleModels, branch: { id: branches.id, name: branches.name } })
      .from(vehicles)
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .innerJoin(branches, eq(branches.id, vehicles.branchId))
      .where(eq(vehicles.id, id));
    if (!row) throw notFound('Vehicle');
    assertBranchAccess(ctx, row.v.branchId);
    const canSensitive = hasPermission(ctx, 'documents.read_sensitive');
    const canCost = hasPermission(ctx, 'vehicles.view_cost');

    const [featureRows, media, docs, inspections, statusHistory, priceHistory, odometer, transfer] = await Promise.all([
      db
        .select({ id: features.id, code: features.code, nameEn: features.nameEn, nameAr: features.nameAr, category: features.category })
        .from(vehicleFeatureLinks)
        .innerJoin(features, eq(features.id, vehicleFeatureLinks.featureId))
        .where(eq(vehicleFeatureLinks.vehicleId, id)),
      db.select().from(vehicleMedia).where(eq(vehicleMedia.vehicleId, id)).orderBy(desc(vehicleMedia.isPrimary), asc(vehicleMedia.sortOrder)),
      db
        .select()
        .from(vehicleDocuments)
        .where(and(eq(vehicleDocuments.vehicleId, id), isNull(vehicleDocuments.deletedAt)))
        .orderBy(asc(vehicleDocuments.expiresAt)),
      db
        .select({
          id: vehicleInspections.id,
          versionNo: vehicleInspections.versionNo,
          type: vehicleInspections.type,
          status: vehicleInspections.status,
          overallResult: vehicleInspections.overallResult,
          startedAt: vehicleInspections.startedAt,
          completedAt: vehicleInspections.completedAt,
          inspectorName: users.fullName,
        })
        .from(vehicleInspections)
        .leftJoin(users, eq(users.id, vehicleInspections.inspectorUserId))
        .where(eq(vehicleInspections.vehicleId, id))
        .orderBy(desc(vehicleInspections.versionNo)),
      db
        .select({
          id: vehicleStatusHistory.id,
          fromStatus: vehicleStatusHistory.fromStatus,
          toStatus: vehicleStatusHistory.toStatus,
          reason: vehicleStatusHistory.reason,
          source: vehicleStatusHistory.source,
          createdAt: vehicleStatusHistory.createdAt,
          actorName: users.fullName,
        })
        .from(vehicleStatusHistory)
        .leftJoin(users, eq(users.id, vehicleStatusHistory.actorUserId))
        .where(eq(vehicleStatusHistory.vehicleId, id))
        .orderBy(desc(vehicleStatusHistory.createdAt)),
      db
        .select({
          id: vehiclePriceHistory.id,
          field: vehiclePriceHistory.field,
          oldValue: vehiclePriceHistory.oldValue,
          newValue: vehiclePriceHistory.newValue,
          reason: vehiclePriceHistory.reason,
          createdAt: vehiclePriceHistory.createdAt,
          actorName: users.fullName,
        })
        .from(vehiclePriceHistory)
        .leftJoin(users, eq(users.id, vehiclePriceHistory.actorUserId))
        .where(eq(vehiclePriceHistory.vehicleId, id))
        .orderBy(desc(vehiclePriceHistory.createdAt)),
      db.select().from(odometerReadings).where(eq(odometerReadings.vehicleId, id)).orderBy(desc(odometerReadings.readAt)),
      db
        .select()
        .from(vehicleTransfers)
        .where(and(eq(vehicleTransfers.vehicleId, id), eq(vehicleTransfers.status, 'in_transit')))
        .limit(1),
    ]);

    const { internalNotes, ...vehicle } = row.v;
    const visibleDocs = docs.map((doc) =>
      doc.isSensitive && !canSensitive ? { ...doc, docNumber: null, fileId: null, notes: null, restricted: true } : { ...doc, restricted: false },
    );
    const visiblePrices = canCost ? priceHistory : priceHistory.filter((p) => p.field === 'asking_price');
    return {
      vehicle: {
        ...vehicle,
        minPrice: canCost ? vehicle.minPrice : null,
        targetMarginPct: canCost ? vehicle.targetMarginPct : null,
        internalNotes: hasPermission(ctx, 'vehicles.update') || canCost ? internalNotes : null,
      },
      make: { id: row.make.id, nameEn: row.make.nameEn, nameAr: row.make.nameAr },
      model: { id: row.model.id, nameEn: row.model.nameEn, nameAr: row.model.nameAr },
      branch: row.branch,
      features: featureRows,
      media,
      documents: visibleDocs,
      inspections,
      statusHistory,
      priceHistory: visiblePrices,
      odometer,
      activeTransfer: transfer[0] ?? null,
      daysInStock: (UNSOLD_STATUSES as readonly string[]).includes(vehicle.status)
        ? Math.floor((Date.now() - vehicle.stockedAt.getTime()) / 86_400_000)
        : null,
    };
  }

  /** Expiring or expired documents for alerting (used by jobs and the dashboard). */
  async expiringDocuments(withinDays: number) {
    return this.dbs.db
      .select({
        id: vehicleDocuments.id,
        vehicleId: vehicleDocuments.vehicleId,
        docType: vehicleDocuments.docType,
        expiresAt: vehicleDocuments.expiresAt,
        stockNumber: vehicles.stockNumber,
      })
      .from(vehicleDocuments)
      .innerJoin(vehicles, eq(vehicles.id, vehicleDocuments.vehicleId))
      .where(
        and(
          isNull(vehicleDocuments.deletedAt),
          sql`${vehicleDocuments.expiresAt} <= current_date + ${withinDays}::int`,
          notInArray(vehicles.status, ['delivered', 'removed']),
          ne(vehicleDocuments.docType, 'purchase'),
        ),
      );
  }
}
