import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { matchesWish, money, todayInZone, WishCreateInput, WishUpdateInput, wishMismatches, zWishListQuery } from '@autohub/shared';
import { assertBranchAccess, TenantContext } from '../../common/context';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { customers, customerWishes, leads, vehicleMakes, vehicleModels, vehicles, wishMatches } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';

type WishRow = typeof customerWishes.$inferSelect;
type ListQuery = z.infer<typeof zWishListQuery>;

const MATCH_JOB = 'wishes.match';
/** Upper bound of on-sale vehicles scanned per run (one query, matched in memory). */
const MAX_SCAN = 20_000;

const vehicleColumns = {
  id: vehicles.id,
  makeId: vehicles.makeId,
  modelId: vehicles.modelId,
  modelYear: vehicles.modelYear,
  askingPrice: vehicles.askingPrice,
  odometerValue: vehicles.odometerValue,
  odometerUnit: vehicles.odometerUnit,
  bodyType: vehicles.bodyType,
  fuelType: vehicles.fuelType,
  transmission: vehicles.transmission,
  exteriorColor: vehicles.exteriorColor,
  stockNumber: vehicles.stockNumber,
  branchId: vehicles.branchId,
  status: vehicles.status,
};

/**
 * Customer wishes ("call me when a 2020+ Land Cruiser under 250k arrives"). Matching uses the pure
 * `matchesWish` from @autohub/shared against vehicles on sale; each (wish, vehicle) pair is
 * recorded once in wish_matches, so the salesperson is notified exactly once per new match.
 */
@Injectable()
export class WishesService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly customersService: CustomersService,
    private readonly notifications: NotificationsService,
    jobs: JobsService,
  ) {
    jobs.register({ name: MATCH_JOB, everyMs: 15 * 60_000, run: (ctx) => this.runMatching(ctx) });
  }

  // ── Access ────────────────────────────────────────────────────────────────────────────

  /** A wish whose customer the caller may see (404 otherwise, also across tenants). */
  private async find(ctx: TenantContext, id: string, lock = false): Promise<WishRow> {
    const q = this.dbs.db
      .select({ w: customerWishes })
      .from(customerWishes)
      .innerJoin(customers, eq(customers.id, customerWishes.customerId))
      .where(and(eq(customerWishes.id, id), this.customersService.visibleWhere(ctx)));
    const [row] = lock ? await q.for('update', { of: customerWishes }) : await q;
    if (!row) throw notFound('Wish');
    return row.w;
  }

  private assertActive(w: WishRow): void {
    if (w.status !== 'active') throw conflict('wish_closed', `This wish is ${w.status}`, { status: w.status });
  }

  private async validate(ctx: TenantContext, input: Partial<WishCreateInput>, customerId: string): Promise<void> {
    if (input.modelId) {
      const [m] = await this.dbs.db.select({ id: vehicleModels.id, makeId: vehicleModels.makeId }).from(vehicleModels).where(eq(vehicleModels.id, input.modelId));
      if (!m) throw notFound('Vehicle model');
      if (input.makeId && input.makeId !== m.makeId) throw unprocessable('model_make_mismatch', 'This model belongs to a different make', { field: 'modelId' });
    }
    if (input.makeId) {
      const [mk] = await this.dbs.db.select({ id: vehicleMakes.id }).from(vehicleMakes).where(eq(vehicleMakes.id, input.makeId));
      if (!mk) throw notFound('Vehicle make');
    }
    if (input.leadId) {
      const [l] = await this.dbs.db.select({ customerId: leads.customerId }).from(leads).where(eq(leads.id, input.leadId));
      if (!l) throw notFound('Lead');
      if (l.customerId !== customerId) throw unprocessable('lead_customer_mismatch', 'This lead belongs to a different customer', { field: 'leadId' });
    }
    if (input.expiresAt && input.expiresAt < todayInZone(ctx.tenant.settings.timezone)) {
      throw unprocessable('invalid_expiry', 'The expiry date cannot be in the past', { field: 'expiresAt' });
    }
  }

  // ── Matching ──────────────────────────────────────────────────────────────────────────

  private async onSale(vehicleIds?: string[]) {
    return this.dbs.db
      .select(vehicleColumns)
      .from(vehicles)
      .where(and(eq(vehicles.status, 'available'), vehicleIds ? inArray(vehicles.id, vehicleIds) : undefined))
      .orderBy(asc(vehicles.stockedAt))
      .limit(MAX_SCAN);
  }

  /** Records new matches for the given active wishes; returns the newly inserted pairs. */
  private async match(ctx: TenantContext, wishes: WishRow[], stock: Awaited<ReturnType<WishesService['onSale']>>) {
    const pairs: Array<{ wishId: string; vehicleId: string }> = [];
    for (const w of wishes) for (const v of stock) if (matchesWish(w, v)) pairs.push({ wishId: w.id, vehicleId: v.id });
    if (!pairs.length) return [];
    const inserted: Array<{ wishId: string; vehicleId: string }> = [];
    for (let i = 0; i < pairs.length; i += 1000) {
      const rows = await this.dbs.db
        .insert(wishMatches)
        .values(pairs.slice(i, i + 1000).map((p) => ({ ...p, tenantId: ctx.tenant.id })))
        .onConflictDoNothing({ target: [wishMatches.wishId, wishMatches.vehicleId] })
        .returning({ wishId: wishMatches.wishId, vehicleId: wishMatches.vehicleId });
      inserted.push(...rows);
    }
    return inserted;
  }

  /** Tells the customer's salesperson (or the wish's author) about new matches, once each. */
  private async notifyMatches(ctx: TenantContext, found: Array<{ wishId: string; vehicleId: string }>): Promise<number> {
    if (!found.length) return 0;
    const wishIds = [...new Set(found.map((f) => f.wishId))];
    const info = await this.dbs.db
      .select({ id: customerWishes.id, createdBy: customerWishes.createdBy, assignedUserId: customers.assignedUserId, customerName: customers.fullName })
      .from(customerWishes)
      .innerJoin(customers, eq(customers.id, customerWishes.customerId))
      .where(inArray(customerWishes.id, wishIds));
    const byWish = new Map(info.map((i) => [i.id, i]));
    const stock = new Map((await this.dbs.db.select({ id: vehicles.id, stockNumber: vehicles.stockNumber }).from(vehicles).where(inArray(vehicles.id, [...new Set(found.map((f) => f.vehicleId))]))).map((v) => [v.id, v.stockNumber]));
    let n = 0;
    for (const f of found) {
      const w = byWish.get(f.wishId);
      const to = w?.assignedUserId ?? w?.createdBy;
      if (!w || !to) continue;
      n += await this.notifications.notify(ctx, {
        userIds: [to],
        type: 'wish.matched',
        titleAr: `سيارة مطابقة لطلب العميل ${w.customerName}`,
        titleEn: `A vehicle matches ${w.customerName}'s wish`,
        bodyAr: stock.get(f.vehicleId) ?? null,
        bodyEn: stock.get(f.vehicleId) ?? null,
        link: `/app/vehicles/${f.vehicleId}`,
        entityType: 'customer_wish',
        entityId: f.wishId,
        dedupeKey: `wish.matched:${f.wishId}:${f.vehicleId}`,
      });
    }
    return n;
  }

  /** Job: expire lapsed wishes, then match active wishes against vehicles on sale. */
  async runMatching(ctx: TenantContext): Promise<{ expired: number; matched: number; notified: number }> {
    const today = todayInZone(ctx.tenant.settings.timezone);
    const expired = await this.dbs.db
      .update(customerWishes)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(customerWishes.status, 'active'), lt(customerWishes.expiresAt, today)))
      .returning({ id: customerWishes.id });
    for (const e of expired) {
      await this.audit.record({ action: 'wish.expired', entityType: 'customer_wish', entityId: e.id, before: { status: 'active' }, after: { status: 'expired' } });
    }
    const wishes = await this.dbs.db.select().from(customerWishes).where(eq(customerWishes.status, 'active'));
    if (!wishes.length) return { expired: expired.length, matched: 0, notified: 0 };
    const found = await this.match(ctx, wishes, await this.onSale());
    return { expired: expired.length, matched: found.length, notified: await this.notifyMatches(ctx, found) };
  }

  // ── Queries ───────────────────────────────────────────────────────────────────────────

  async list(ctx: TenantContext, q: ListQuery) {
    const conds: Array<SQL | undefined> = [this.customersService.visibleWhere(ctx)];
    if (q.customerId) conds.push(eq(customerWishes.customerId, q.customerId));
    if (q.status) conds.push(eq(customerWishes.status, q.status));
    if (q.mine === 'true') conds.push(eq(customers.assignedUserId, ctx.userId));
    const where = and(...conds);
    const openMatches = sql<number>`(SELECT count(*)::int FROM wish_matches m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.wish_id = customer_wishes.id AND m.dismissed_at IS NULL AND v.status = 'available')`;
    const [items, [total]] = await Promise.all([
      this.dbs.db
        .select({
          w: customerWishes,
          customerName: customers.fullName,
          customerPhone: customers.phone,
          makeEn: vehicleMakes.nameEn,
          makeAr: vehicleMakes.nameAr,
          modelEn: vehicleModels.nameEn,
          modelAr: vehicleModels.nameAr,
          openMatches,
        })
        .from(customerWishes)
        .innerJoin(customers, eq(customers.id, customerWishes.customerId))
        .leftJoin(vehicleMakes, eq(vehicleMakes.id, customerWishes.makeId))
        .leftJoin(vehicleModels, eq(vehicleModels.id, customerWishes.modelId))
        .where(where)
        .orderBy(desc(customerWishes.createdAt), desc(customerWishes.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(customerWishes).innerJoin(customers, eq(customers.id, customerWishes.customerId)).where(where),
    ]);
    return {
      items: items.map((r) => ({ ...r.w, customerName: r.customerName, customerPhone: r.customerPhone, makeEn: r.makeEn, makeAr: r.makeAr, modelEn: r.modelEn, modelAr: r.modelAr, openMatches: r.openMatches })),
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** The wish with its matches; vehicles no longer on sale are flagged, not hidden. */
  async get(ctx: TenantContext, id: string) {
    const w = await this.find(ctx, id);
    const matches = await this.dbs.db
      .select({
        vehicleId: wishMatches.vehicleId,
        matchedAt: wishMatches.matchedAt,
        dismissedAt: wishMatches.dismissedAt,
        stockNumber: vehicles.stockNumber,
        status: vehicles.status,
        modelYear: vehicles.modelYear,
        askingPrice: vehicles.askingPrice,
        odometerValue: vehicles.odometerValue,
        odometerUnit: vehicles.odometerUnit,
        exteriorColor: vehicles.exteriorColor,
        makeEn: vehicleMakes.nameEn,
        makeAr: vehicleMakes.nameAr,
        modelEn: vehicleModels.nameEn,
        modelAr: vehicleModels.nameAr,
      })
      .from(wishMatches)
      .innerJoin(vehicles, eq(vehicles.id, wishMatches.vehicleId))
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .where(eq(wishMatches.wishId, id))
      .orderBy(desc(wishMatches.matchedAt));
    return { ...w, matches: matches.map((m) => ({ ...m, onSale: m.status === 'available' })) };
  }

  /** Active wishes (of customers the caller may see) that a vehicle satisfies, with who to call. */
  async forVehicle(ctx: TenantContext, vehicleId: string) {
    const [v] = await this.dbs.db.select(vehicleColumns).from(vehicles).where(eq(vehicles.id, vehicleId));
    if (!v) throw notFound('Vehicle');
    assertBranchAccess(ctx, v.branchId);
    const rows = await this.dbs.db
      .select({ w: customerWishes, customerName: customers.fullName, customerPhone: customers.phone, assignedUserId: customers.assignedUserId })
      .from(customerWishes)
      .innerJoin(customers, eq(customers.id, customerWishes.customerId))
      .where(and(eq(customerWishes.status, 'active'), this.customersService.visibleWhere(ctx)))
      .limit(MAX_SCAN);
    return {
      items: rows
        .filter((r) => matchesWish(r.w, v))
        .map((r) => ({ wishId: r.w.id, customerId: r.w.customerId, customerName: r.customerName, customerPhone: r.customerPhone, assignedUserId: r.assignedUserId, maxPrice: r.w.maxPrice, notes: r.w.notes })),
    };
  }

  // ── Commands ──────────────────────────────────────────────────────────────────────────

  async create(ctx: TenantContext, input: WishCreateInput) {
    const c = await this.customersService.assertVisible(ctx, input.customerId);
    if (!c.isActive) throw unprocessable('customer_inactive', 'This customer is inactive');
    await this.validate(ctx, input, c.id);
    const [w] = await this.dbs.db
      .insert(customerWishes)
      .values({
        tenantId: ctx.tenant.id,
        customerId: c.id,
        leadId: input.leadId ?? null,
        makeId: input.makeId ?? null,
        modelId: input.modelId ?? null,
        yearFrom: input.yearFrom ?? null,
        yearTo: input.yearTo ?? null,
        maxPrice: input.maxPrice ? money(input.maxPrice, ctx.tenant.baseCurrency) : null,
        maxOdometerKm: input.maxOdometerKm ?? null,
        bodyType: input.bodyType ?? null,
        fuelType: input.fuelType ?? null,
        transmission: input.transmission ?? null,
        color: input.color ?? null,
        notes: input.notes ?? null,
        expiresAt: input.expiresAt ?? null,
        status: 'active',
        createdBy: ctx.userId,
      })
      .returning();
    await this.audit.record({ action: 'wish.created', entityType: 'customer_wish', entityId: w!.id, summary: c.fullName, after: w });
    // Match the current stock right away; the creator sees results in the response.
    await this.match(ctx, [w!], await this.onSale());
    return this.get(ctx, w!.id);
  }

  async update(ctx: TenantContext, id: string, input: WishUpdateInput) {
    const before = await this.find(ctx, id, true);
    this.assertActive(before);
    const next = { ...before, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as WishRow;
    if (next.yearFrom != null && next.yearTo != null && next.yearFrom > next.yearTo) {
      throw unprocessable('invalid_year_range', '"Year from" cannot be after "year to"', { field: 'yearTo' });
    }
    await this.validate(ctx, { leadId: input.leadId, expiresAt: input.expiresAt, makeId: next.makeId, modelId: next.modelId }, before.customerId);
    const [after] = await this.dbs.db
      .update(customerWishes)
      .set({
        ...input,
        maxPrice: input.maxPrice === undefined ? undefined : input.maxPrice === null ? null : money(input.maxPrice, ctx.tenant.baseCurrency),
        updatedAt: new Date(),
      })
      .where(eq(customerWishes.id, id))
      .returning();
    await this.audit.record({ action: 'wish.updated', entityType: 'customer_wish', entityId: id, ...diff(before, after!) });
    // Matches that no longer fit stay as history; new fits are recorded now.
    await this.match(ctx, [after!], await this.onSale());
    return this.get(ctx, id);
  }

  async close(ctx: TenantContext, id: string, status: 'fulfilled' | 'cancelled', input: { note?: string | null; vehicleId?: string | null }) {
    const before = await this.find(ctx, id, true);
    this.assertActive(before);
    if (input.vehicleId) {
      const [v] = await this.dbs.db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.id, input.vehicleId));
      if (!v) throw notFound('Vehicle');
    }
    const [after] = await this.dbs.db
      .update(customerWishes)
      .set({ status, notes: input.note ? [before.notes, input.note].filter(Boolean).join('\n') : before.notes, updatedAt: new Date() })
      .where(eq(customerWishes.id, id))
      .returning();
    await this.audit.record({
      action: `wish.${status}`,
      entityType: 'customer_wish',
      entityId: id,
      before: { status: before.status },
      after: { status, note: input.note ?? null, vehicleId: input.vehicleId ?? null },
    });
    return after!;
  }

  async dismissMatch(ctx: TenantContext, id: string, vehicleId: string) {
    await this.find(ctx, id);
    const [m] = await this.dbs.db
      .update(wishMatches)
      .set({ dismissedAt: new Date() })
      .where(and(eq(wishMatches.wishId, id), eq(wishMatches.vehicleId, vehicleId), isNull(wishMatches.dismissedAt)))
      .returning();
    if (!m) throw notFound('Match');
    await this.audit.record({ action: 'wish.match_dismissed', entityType: 'customer_wish', entityId: id, after: { vehicleId } });
    return { ok: true };
  }

  /** Explains why a vehicle does or does not fit a wish (for the UI). */
  async explain(ctx: TenantContext, id: string, vehicleId: string) {
    const w = await this.find(ctx, id);
    const [v] = await this.dbs.db.select(vehicleColumns).from(vehicles).where(eq(vehicles.id, vehicleId));
    if (!v) throw notFound('Vehicle');
    const mismatches = wishMismatches(w, v);
    return { matches: mismatches.length === 0, mismatches };
  }
}
