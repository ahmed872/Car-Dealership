import { Injectable } from '@nestjs/common';
import { aliasedTable, and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { ON_HAND_STATUSES } from '@autohub/shared';
import { assertBranchAccess, assertPermission, TenantContext } from '../../common/context';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { branches, stockCountLines, stockCounts, users, vehicleMakes, vehicleModels, vehicles, vehicleTransfers } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../numbering/numbering.service';
import { VehiclesService } from './vehicles.service';

const TRANSFERABLE = ['incoming', 'awaiting_inspection', 'in_inspection', 'in_preparation', 'ready', 'available', 'returned'];

@Injectable()
export class InventoryService {
  constructor(
    private readonly dbs: DbService,
    private readonly vehicles: VehiclesService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
  ) {}

  // ── Transfers ─────────────────────────────────────────────────────────────────────────
  async createTransfer(ctx: TenantContext, vehicleId: string, toBranchId: string, notes: string | null) {
    const v = await this.vehicles.lock(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (!TRANSFERABLE.includes(v.status)) {
      throw conflict('vehicle_not_transferable', 'Reserved, sold or delivered vehicles cannot be transferred');
    }
    if (v.branchId === toBranchId) throw unprocessable('same_branch', 'The vehicle is already in this branch');
    const [dest] = await this.dbs.db.select().from(branches).where(eq(branches.id, toBranchId));
    if (!dest || !dest.isActive) throw notFound('Destination branch');
    if (await this.vehicles.inTransit(vehicleId)) throw conflict('vehicle_in_transit', 'The vehicle is already in transit');
    const number = await this.numbering.next('transfer');
    const [t] = await this.dbs.db
      .insert(vehicleTransfers)
      .values({ tenantId: ctx.tenant.id, number, vehicleId, fromBranchId: v.branchId, toBranchId, notes, requestedBy: ctx.userId })
      .returning();
    await this.audit.record({
      action: 'transfer.created',
      entityType: 'vehicle',
      entityId: vehicleId,
      summary: `${number}: ${v.stockNumber} → ${dest.name}`,
      after: { transferId: t!.id, from: v.branchId, to: toBranchId },
    });
    return t;
  }

  private async lockTransfer(id: string) {
    const [t] = await this.dbs.db.select().from(vehicleTransfers).where(eq(vehicleTransfers.id, id)).for('update');
    if (!t) throw notFound('Transfer');
    if (t.status !== 'in_transit') throw conflict('transfer_closed', 'This transfer is already closed');
    return t;
  }

  /** The receiving branch confirms arrival; only then does the vehicle's branch change. */
  async receiveTransfer(ctx: TenantContext, id: string) {
    const t = await this.lockTransfer(id);
    assertBranchAccess(ctx, t.toBranchId);
    const v = await this.vehicles.lock(t.vehicleId);
    await this.dbs.db.update(vehicleTransfers).set({ status: 'received', receivedAt: new Date(), receivedBy: ctx.userId }).where(eq(vehicleTransfers.id, id));
    await this.dbs.db
      .update(vehicles)
      .set({ branchId: t.toBranchId, locationLabel: null, version: v.version + 1, updatedAt: new Date() })
      .where(eq(vehicles.id, t.vehicleId));
    await this.audit.record({ action: 'transfer.received', entityType: 'vehicle', entityId: t.vehicleId, before: { branchId: t.fromBranchId }, after: { branchId: t.toBranchId, transferId: id } });
    return { ok: true };
  }

  async cancelTransfer(ctx: TenantContext, id: string, reason: string) {
    const t = await this.lockTransfer(id);
    if (!ctx.allBranches && !ctx.branchIds.includes(t.fromBranchId) && !ctx.branchIds.includes(t.toBranchId)) throw forbidden();
    await this.dbs.db.update(vehicleTransfers).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason }).where(eq(vehicleTransfers.id, id));
    await this.audit.record({ action: 'transfer.cancelled', entityType: 'vehicle', entityId: t.vehicleId, after: { transferId: id, reason } });
    return { ok: true };
  }

  async listTransfers(ctx: TenantContext, status?: string) {
    const fromB = aliasedTable(branches, 'from_b');
    const toB = aliasedTable(branches, 'to_b');
    const conds = [];
    if (status) conds.push(eq(vehicleTransfers.status, status));
    if (!ctx.allBranches) {
      const ids = ctx.branchIds.length ? ctx.branchIds : ['00000000-0000-0000-0000-000000000000'];
      conds.push(or(inArray(vehicleTransfers.fromBranchId, ids), inArray(vehicleTransfers.toBranchId, ids))!);
    }
    return this.dbs.db
      .select({
        id: vehicleTransfers.id,
        number: vehicleTransfers.number,
        status: vehicleTransfers.status,
        shippedAt: vehicleTransfers.shippedAt,
        receivedAt: vehicleTransfers.receivedAt,
        notes: vehicleTransfers.notes,
        cancelReason: vehicleTransfers.cancelReason,
        vehicleId: vehicles.id,
        stockNumber: vehicles.stockNumber,
        makeNameEn: vehicleMakes.nameEn,
        makeNameAr: vehicleMakes.nameAr,
        modelNameEn: vehicleModels.nameEn,
        modelNameAr: vehicleModels.nameAr,
        modelYear: vehicles.modelYear,
        fromBranchId: vehicleTransfers.fromBranchId,
        fromBranch: fromB.name,
        toBranchId: vehicleTransfers.toBranchId,
        toBranch: toB.name,
        requestedBy: users.fullName,
      })
      .from(vehicleTransfers)
      .innerJoin(vehicles, eq(vehicles.id, vehicleTransfers.vehicleId))
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .innerJoin(fromB, eq(fromB.id, vehicleTransfers.fromBranchId))
      .innerJoin(toB, eq(toB.id, vehicleTransfers.toBranchId))
      .leftJoin(users, eq(users.id, vehicleTransfers.requestedBy))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(vehicleTransfers.shippedAt))
      .limit(500);
  }

  // ── Stock counts ──────────────────────────────────────────────────────────────────────
  /** Opens a physical count: snapshot of every vehicle the system believes is in the branch. */
  async openCount(ctx: TenantContext, branchId: string, notes: string | null) {
    assertBranchAccess(ctx, branchId);
    const number = await this.numbering.next('stock_count');
    const [c] = await this.dbs.db
      .insert(stockCounts)
      .values({ tenantId: ctx.tenant.id, number, branchId, notes, startedBy: ctx.userId })
      .returning();
    const expected = await this.dbs.db
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(and(eq(vehicles.branchId, branchId), inArray(vehicles.status, [...ON_HAND_STATUSES])));
    if (expected.length) {
      await this.dbs.db
        .insert(stockCountLines)
        .values(expected.map((v) => ({ tenantId: ctx.tenant.id, stockCountId: c!.id, vehicleId: v.id, expected: true })));
    }
    await this.audit.record({ action: 'stock_count.opened', entityType: 'stock_count', entityId: c!.id, after: { number, branchId, expected: expected.length } });
    return { ...c!, expectedCount: expected.length };
  }

  private async lockCount(ctx: TenantContext, id: string, statuses: string[]) {
    const [c] = await this.dbs.db.select().from(stockCounts).where(eq(stockCounts.id, id)).for('update');
    if (!c) throw notFound('Stock count');
    assertBranchAccess(ctx, c.branchId);
    if (!statuses.includes(c.status)) throw conflict('stock_count_state', `Stock count is ${c.status}`);
    return c;
  }

  /** Records a scanned/typed VIN, plate or stock number. Unknown codes become "unexpected" lines. */
  async scan(ctx: TenantContext, id: string, code: string, location: string | null, notes: string | null) {
    const c = await this.lockCount(ctx, id, ['open']);
    const norm = code.trim().toUpperCase().replace(/\s+/g, '');
    const [v] = await this.dbs.db
      .select({ id: vehicles.id, branchId: vehicles.branchId })
      .from(vehicles)
      .where(
        and(
          or(eq(vehicles.vin, norm), eq(vehicles.stockNumber, norm), sql`upper(replace(${vehicles.plateNumber}, ' ', '')) = ${norm}`),
          inArray(vehicles.status, [...ON_HAND_STATUSES]),
        ),
      )
      .limit(1);
    const db = this.dbs.db;
    if (v) {
      const [line] = await db
        .select()
        .from(stockCountLines)
        .where(and(eq(stockCountLines.stockCountId, id), eq(stockCountLines.vehicleId, v.id)));
      if (line) {
        await db
          .update(stockCountLines)
          .set({ found: true, scannedCode: norm, scannedAt: new Date(), locationFound: location, notes })
          .where(eq(stockCountLines.id, line.id));
        return { result: 'matched', vehicleId: v.id };
      }
      // Present here but recorded in another branch.
      await db.insert(stockCountLines).values({
        tenantId: ctx.tenant.id,
        stockCountId: c.id,
        vehicleId: v.id,
        expected: false,
        found: true,
        scannedCode: norm,
        scannedAt: new Date(),
        locationFound: location,
        notes: notes ?? 'recorded in another branch',
      });
      return { result: 'other_branch', vehicleId: v.id };
    }
    await db.insert(stockCountLines).values({
      tenantId: ctx.tenant.id,
      stockCountId: c.id,
      expected: false,
      found: true,
      scannedCode: norm,
      scannedAt: new Date(),
      locationFound: location,
      notes,
    });
    return { result: 'unknown' };
  }

  async submitCount(ctx: TenantContext, id: string) {
    const c = await this.lockCount(ctx, id, ['open']);
    await this.dbs.db.update(stockCountLines).set({ found: false }).where(and(eq(stockCountLines.stockCountId, id), sql`${stockCountLines.found} IS NULL`));
    await this.dbs.db.update(stockCounts).set({ status: 'submitted', submittedAt: new Date() }).where(eq(stockCounts.id, c.id));
    const summary = await this.countSummary(id);
    await this.audit.record({ action: 'stock_count.submitted', entityType: 'stock_count', entityId: id, after: summary });
    return summary;
  }

  /**
   * Reconciliation requires inventory.reconcile. Missing vehicles can be written off (status →
   * removed, posting the write-off) only with vehicles.remove; every decision is audited.
   */
  async reconcile(ctx: TenantContext, id: string, lines: Array<{ lineId: string; resolution: string; notes?: string | null }>) {
    const c = await this.lockCount(ctx, id, ['submitted']);
    const db = this.dbs.db;
    const all = await db.select().from(stockCountLines).where(eq(stockCountLines.stockCountId, id));
    const byId = new Map(all.map((l) => [l.id, l]));
    for (const r of lines) {
      const line = byId.get(r.lineId);
      if (!line) throw notFound('Stock count line');
      if (r.resolution === 'written_off') {
        if (!line.vehicleId || line.found) throw unprocessable('invalid_resolution', 'Only missing vehicles can be written off');
        assertPermission(ctx, 'vehicles.remove');
        if (!r.notes || r.notes.trim().length < 3) throw unprocessable('reason_required', 'A reason is required to write off a vehicle');
        await this.vehicles.transition(ctx, line.vehicleId, 'removed', { system: false, source: 'stock_count', sourceId: id, reason: r.notes });
      }
      if (r.resolution === 'location_updated' && line.vehicleId && line.locationFound) {
        await db.update(vehicles).set({ locationLabel: line.locationFound, updatedAt: new Date() }).where(eq(vehicles.id, line.vehicleId));
      }
      await db.update(stockCountLines).set({ resolution: r.resolution, resolutionNotes: r.notes ?? null }).where(eq(stockCountLines.id, line.id));
    }
    const unresolved = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(stockCountLines)
      .where(and(eq(stockCountLines.stockCountId, id), eq(stockCountLines.resolution, 'none'), sql`(${stockCountLines.found} = false OR ${stockCountLines.expected} = false)`));
    if ((unresolved[0]?.n ?? 0) > 0) {
      await this.audit.record({ action: 'stock_count.partially_reconciled', entityType: 'stock_count', entityId: id, after: { remaining: unresolved[0]!.n } });
      return { status: 'submitted', remaining: unresolved[0]!.n };
    }
    await db.update(stockCounts).set({ status: 'reconciled', reconciledAt: new Date(), reconciledBy: ctx.userId }).where(eq(stockCounts.id, c.id));
    await this.audit.record({ action: 'stock_count.reconciled', entityType: 'stock_count', entityId: id, after: await this.countSummary(id) });
    return { status: 'reconciled', remaining: 0 };
  }

  async countSummary(id: string) {
    const [s] = await this.dbs.db
      .select({
        expected: sql<number>`count(*) FILTER (WHERE ${stockCountLines.expected})::int`,
        found: sql<number>`count(*) FILTER (WHERE ${stockCountLines.expected} AND ${stockCountLines.found})::int`,
        missing: sql<number>`count(*) FILTER (WHERE ${stockCountLines.expected} AND ${stockCountLines.found} = false)::int`,
        unexpected: sql<number>`count(*) FILTER (WHERE NOT ${stockCountLines.expected})::int`,
        pending: sql<number>`count(*) FILTER (WHERE ${stockCountLines.found} IS NULL)::int`,
      })
      .from(stockCountLines)
      .where(eq(stockCountLines.stockCountId, id));
    return s!;
  }

  async getCount(ctx: TenantContext, id: string) {
    const [c] = await this.dbs.db.select().from(stockCounts).where(eq(stockCounts.id, id));
    if (!c) throw notFound('Stock count');
    assertBranchAccess(ctx, c.branchId);
    const lines = await this.dbs.db
      .select({
        id: stockCountLines.id,
        vehicleId: stockCountLines.vehicleId,
        expected: stockCountLines.expected,
        found: stockCountLines.found,
        scannedCode: stockCountLines.scannedCode,
        scannedAt: stockCountLines.scannedAt,
        locationFound: stockCountLines.locationFound,
        notes: stockCountLines.notes,
        resolution: stockCountLines.resolution,
        resolutionNotes: stockCountLines.resolutionNotes,
        stockNumber: vehicles.stockNumber,
        vin: vehicles.vin,
        plateNumber: vehicles.plateNumber,
        status: vehicles.status,
        locationLabel: vehicles.locationLabel,
        makeNameEn: vehicleMakes.nameEn,
        makeNameAr: vehicleMakes.nameAr,
        modelNameEn: vehicleModels.nameEn,
        modelNameAr: vehicleModels.nameAr,
        modelYear: vehicles.modelYear,
      })
      .from(stockCountLines)
      .leftJoin(vehicles, eq(vehicles.id, stockCountLines.vehicleId))
      .leftJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .where(eq(stockCountLines.stockCountId, id));
    return { ...c, summary: await this.countSummary(id), lines };
  }

  async listCounts(ctx: TenantContext) {
    const conds = ctx.allBranches ? undefined : inArray(stockCounts.branchId, ctx.branchIds.length ? ctx.branchIds : ['00000000-0000-0000-0000-000000000000']);
    return this.dbs.db
      .select({
        id: stockCounts.id,
        number: stockCounts.number,
        status: stockCounts.status,
        branchId: stockCounts.branchId,
        branchName: branches.name,
        startedAt: stockCounts.startedAt,
        submittedAt: stockCounts.submittedAt,
        reconciledAt: stockCounts.reconciledAt,
        startedBy: users.fullName,
      })
      .from(stockCounts)
      .innerJoin(branches, eq(branches.id, stockCounts.branchId))
      .leftJoin(users, eq(users.id, stockCounts.startedBy))
      .where(conds)
      .orderBy(desc(stockCounts.startedAt))
      .limit(200);
  }
}
