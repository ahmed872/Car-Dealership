import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, SQL, sql } from 'drizzle-orm';
import { CurrencyCode, d, money, todayInZone, VehicleStatus } from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { cashAccounts, customers, reservations, users, vehicleMakes, vehicleModels, vehicles } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { resolveFx } from '../finance/fx';
import { ReceiptsService } from '../finance/receipts.service';
import { RefundsService } from '../finance/refunds.service';
import { JobsService } from '../jobs/jobs.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingService } from '../ledger/posting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NumberingService } from '../numbering/numbering.service';
import { VehiclesService } from '../vehicles/vehicles.service';

registerUniqueConstraint('reservations_vehicle_active_uq', 'vehicle_reserved', 'This vehicle already has an active reservation');
registerUniqueConstraint('reservations_number_uq', 'reservation_number_taken', 'Reservation number already exists');

type ReservationRow = typeof reservations.$inferSelect;

export interface DepositInput {
  cashAccountId: string;
  amount: string;
  exchangeRate?: string | null;
  method: string;
  reference?: string | null;
  receivedAt?: string | null;
}

export interface ReservationCreate {
  vehicleId: string;
  customerId: string;
  leadId?: string | null;
  days?: number;
  agreedPrice?: string | null;
  depositAmount?: string;
  refundPolicy?: 'refundable' | 'non_refundable' | 'partial';
  refundablePct?: string;
  notes?: string | null;
  deposit?: DepositInput | null;
}

export interface ReservationListQuery {
  status?: string;
  customerId?: string;
  vehicleId?: string;
  branchId?: string;
  expiringWithinHours?: number;
  q?: string;
  page: number;
  pageSize: number;
}

const HOUR = 3_600_000;

/**
 * Vehicle reservations with deposits. The vehicle row lock plus the partial unique index on
 * (vehicle) WHERE status = 'active' guarantee one active reservation per vehicle under any
 * concurrency. Deposits are customer advances (Cr 2100) — never revenue. Cancelling applies the
 * refund policy: the refundable part becomes a refund request (approval required), the rest is
 * forfeited to other income (Dr 2100 / Cr 4200). Expiry releases the vehicle and keeps the
 * deposit as customer credit for a manager to refund or apply (B-021).
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly dbs: DbService,
    private readonly vehicles: VehiclesService,
    private readonly receipts: ReceiptsService,
    private readonly refunds: RefundsService,
    private readonly posting: PostingService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    jobs: JobsService,
  ) {
    ReceiptsService.register('reservation', {
      describe: async (id, lock) => {
        const r = await this.find(id, lock);
        const received = await this.receipts.receivedBase('reservation', id);
        const outstanding = d(r.depositAmount).minus(received);
        return {
          customerId: r.customerId,
          branchId: r.branchId,
          label: r.number,
          acceptsPayment: r.status === 'active',
          outstandingBase: (outstanding.isNegative() ? d(0) : outstanding).toFixed(2),
        };
      },
      creditLines: (id, amountBase, customerId) => [{ account: ACCOUNTS.CUSTOMER_ADVANCES, credit: amountBase, customerId, memo: `reservation:${id}` }],
      beforeVoid: async (_ctx, id, amountBase) => {
        const r = await this.find(id, true);
        if (r.status === 'converted') throw conflict('receipt_applied', 'This deposit was applied to a sale; reverse the sale payment instead');
        const available = await this.availableDepositBase(r);
        if (d(available).lt(amountBase)) throw conflict('receipt_refunded', 'Part of this deposit was refunded or forfeited; that must be reversed first');
      },
    });
    RefundsService.register('reservation', {
      describe: async (id, lock) => {
        const r = await this.find(id, lock);
        if (r.status === 'active' || r.status === 'converted') {
          // Active deposits are refunded by cancelling; converted ones belong to the sale.
          return { customerId: r.customerId, branchId: r.branchId, label: r.number, refundableBase: '0.00' };
        }
        return { customerId: r.customerId, branchId: r.branchId, label: r.number, refundableBase: await this.availableDepositBase(r) };
      },
    });
    jobs.register({ name: 'reservations.expire', everyMs: 5 * 60_000, run: (ctx) => this.expireDue(ctx) });
    jobs.register({ name: 'reservations.remind', everyMs: 60 * 60_000, run: (ctx) => this.remindExpiring(ctx) });
  }

  private async find(id: string, lock = false): Promise<ReservationRow> {
    const q = this.dbs.db.select().from(reservations).where(eq(reservations.id, id));
    const [r] = lock ? await q.for('update') : await q;
    if (!r) throw notFound('Reservation');
    return r;
  }

  /** Deposit still held for the customer: received − forfeited − refunds requested/approved/paid. */
  async availableDepositBase(r: ReservationRow): Promise<string> {
    const received = await this.receipts.receivedBase('reservation', r.id);
    const committed = await this.refunds.committedBase('reservation', r.id);
    const v = d(received).minus(r.forfeitedBase).minus(committed);
    return (v.isNegative() ? d(0) : v).toFixed(2);
  }

  /** Base-currency value of a deposit about to be received (no side effects). */
  private async depositBase(ctx: TenantContext, dep: DepositInput): Promise<string> {
    const [a] = await this.dbs.db.select({ currency: cashAccounts.currency }).from(cashAccounts).where(eq(cashAccounts.id, dep.cashAccountId));
    if (!a) throw notFound('Cash account');
    const currency = a.currency as CurrencyCode;
    const fx = resolveFx(ctx, currency, currency === ctx.tenant.baseCurrency ? null : dep.exchangeRate);
    return fx.toBase(money(dep.amount, currency));
  }

  async create(ctx: TenantContext, input: ReservationCreate) {
    const db = this.dbs.db;
    const v = await this.vehicles.lock(input.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (v.status !== 'available') throw conflict('vehicle_not_available', 'Only vehicles listed as available can be reserved', { vehicleStatus: v.status });
    const [cust] = await db.select({ id: customers.id, isActive: customers.isActive, name: customers.fullName }).from(customers).where(eq(customers.id, input.customerId));
    if (!cust) throw notFound('Customer');
    if (!cust.isActive) throw unprocessable('customer_inactive', 'This customer is inactive');

    const settings = ctx.tenant.settings.reservation;
    const days = input.days ?? settings.defaultDays;
    const policy = input.refundPolicy ?? settings.defaultRefundPolicy;
    const pct = policy === 'refundable' ? '100' : policy === 'non_refundable' ? '0' : (input.refundablePct ?? settings.defaultRefundablePct);
    if (input.agreedPrice && v.minPrice && d(input.agreedPrice).lt(v.minPrice) && !hasPermission(ctx, 'sales.approve_below_floor')) {
      throw unprocessable('below_floor', 'The agreed price is below the vehicle minimum price; a manager must approve it');
    }
    // A deposit taken without a stated requirement becomes the requirement.
    let depositAmount = money(input.depositAmount ?? '0', ctx.tenant.baseCurrency);
    if (input.deposit && d(depositAmount).isZero()) depositAmount = await this.depositBase(ctx, input.deposit);

    const number = await this.numbering.next('reservation');
    const now = Date.now();
    const [r] = await db
      .insert(reservations)
      .values({
        tenantId: ctx.tenant.id,
        number,
        vehicleId: v.id,
        customerId: cust.id,
        branchId: v.branchId,
        leadId: input.leadId ?? null,
        salesUserId: ctx.userId,
        priorVehicleStatus: v.status,
        reservedAt: new Date(now),
        expiresAt: new Date(now + days * 24 * HOUR),
        agreedPrice: input.agreedPrice ? money(input.agreedPrice, ctx.tenant.baseCurrency) : null,
        depositAmount,
        refundPolicy: policy,
        refundablePct: pct,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await this.vehicles.transition(ctx, v.id, 'reserved', { system: true, source: 'reservation', sourceId: r!.id, reason: `Reservation ${number}` });
    await this.audit.record({
      action: 'reservation.created',
      entityType: 'reservation',
      entityId: r!.id,
      summary: `${number}: ${v.stockNumber} for ${cust.name} (${days} days)`,
      after: r,
    });
    let receipt = null;
    if (input.deposit) {
      receipt = await this.receipts.receive(ctx, {
        customerId: cust.id,
        cashAccountId: input.deposit.cashAccountId,
        amount: input.deposit.amount,
        exchangeRate: input.deposit.exchangeRate ?? null,
        method: input.deposit.method,
        reference: input.deposit.reference ?? null,
        receivedAt: input.deposit.receivedAt ?? null,
        branchId: r!.branchId,
        allocateTo: { targetType: 'reservation', targetId: r!.id },
      });
    }
    return { ...(await this.find(r!.id)), receipt };
  }

  /** Records (part of) the deposit later, e.g. a second instalment of the deposit. */
  async addDeposit(ctx: TenantContext, id: string, dep: DepositInput) {
    const r = await this.find(id);
    assertBranchAccess(ctx, r.branchId);
    return this.receipts.receive(ctx, {
      customerId: r.customerId,
      cashAccountId: dep.cashAccountId,
      amount: dep.amount,
      exchangeRate: dep.exchangeRate ?? null,
      method: dep.method,
      reference: dep.reference ?? null,
      receivedAt: dep.receivedAt ?? null,
      branchId: r.branchId,
      allocateTo: { targetType: 'reservation', targetId: r.id },
    });
  }

  async extend(ctx: TenantContext, id: string, input: { days: number; reason: string }) {
    const r = await this.find(id, true);
    assertBranchAccess(ctx, r.branchId);
    if (r.status !== 'active') throw conflict('reservation_not_active', 'Only active reservations can be extended');
    const from = Math.max(r.expiresAt.getTime(), Date.now());
    const expiresAt = new Date(from + input.days * 24 * HOUR);
    if (expiresAt.getTime() - r.reservedAt.getTime() > 180 * 24 * HOUR) {
      throw unprocessable('reservation_too_long', 'A reservation cannot run longer than 180 days in total');
    }
    const [after] = await this.dbs.db
      .update(reservations)
      .set({ expiresAt, extendedCount: r.extendedCount + 1, version: r.version + 1, updatedAt: new Date() })
      .where(eq(reservations.id, id))
      .returning();
    await this.audit.record({
      action: 'reservation.extended',
      entityType: 'reservation',
      entityId: id,
      before: { expiresAt: r.expiresAt },
      after: { expiresAt, days: input.days, reason: input.reason },
    });
    return after!;
  }

  /**
   * Cancels an active reservation and settles its deposit:
   *  per_policy → refundable share (policy %) becomes a refund request, the rest is forfeited;
   *  full       → everything becomes a refund request (overrides a stricter policy: refunds.approve);
   *  none       → everything is forfeited (overrides a refundable policy: refunds.approve).
   */
  async cancel(ctx: TenantContext, id: string, input: { reason: string; refund: 'per_policy' | 'full' | 'none' }) {
    const r = await this.find(id, true);
    assertBranchAccess(ctx, r.branchId);
    if (r.status !== 'active') throw conflict('reservation_not_active', 'Only active reservations can be cancelled');
    const v = await this.vehicles.lock(r.vehicleId);
    const available = d(await this.availableDepositBase(r));
    let refundAmt = d(0);
    if (input.refund === 'full') {
      if (r.refundPolicy !== 'refundable') assertPermission(ctx, 'refunds.approve');
      refundAmt = available;
    } else if (input.refund === 'none') {
      if (r.refundPolicy !== 'non_refundable' && available.gt(0)) assertPermission(ctx, 'refunds.approve');
    } else {
      refundAmt = d(money(available.times(r.refundablePct).dividedBy(100), ctx.tenant.baseCurrency, ctx.tenant.settings.rounding));
    }
    const forfeit = available.minus(refundAmt);
    const today = todayInZone(ctx.tenant.settings.timezone);

    if (forfeit.gt(0)) {
      await this.posting.post({
        sourceType: 'reservation',
        sourceId: r.id,
        event: 'reservation.forfeited',
        date: today,
        description: `Forfeited deposit — reservation ${r.number}`,
        branchId: r.branchId,
        lines: [
          { account: ACCOUNTS.CUSTOMER_ADVANCES, debit: forfeit.toFixed(2), customerId: r.customerId },
          { account: ACCOUNTS.OTHER_INCOME, credit: forfeit.toFixed(2), customerId: r.customerId, vehicleId: r.vehicleId },
        ],
      });
    }
    const [after] = await this.dbs.db
      .update(reservations)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: ctx.userId,
        cancelReason: input.reason,
        forfeitedBase: d(r.forfeitedBase).plus(forfeit).toFixed(2),
        version: r.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(reservations.id, id))
      .returning();
    let refund = null;
    if (refundAmt.gt(0)) {
      refund = await this.refunds.request(
        ctx,
        { sourceType: 'reservation', sourceId: r.id, amountBase: refundAmt.toFixed(2), reason: `Reservation ${r.number} cancelled: ${input.reason}` },
        { internal: true },
      );
    }
    await this.releaseVehicle(ctx, r, v.status as VehicleStatus, `Reservation ${r.number} cancelled`);
    await this.audit.record({
      action: 'reservation.cancelled',
      entityType: 'reservation',
      entityId: id,
      before: { status: 'active' },
      after: { status: 'cancelled', reason: input.reason, refundMode: input.refund, refundBase: refundAmt.toFixed(2), forfeitedBase: forfeit.toFixed(2) },
    });
    return { ...after!, refund };
  }

  private async releaseVehicle(ctx: TenantContext, r: ReservationRow, current: VehicleStatus, reason: string) {
    // Only 'available' vehicles can be reserved, so release returns them there. If the sale
    // workflow already moved the vehicle on, leave it alone.
    if (current !== 'reserved') return;
    await this.vehicles.transition(ctx, r.vehicleId, 'available', { system: true, source: 'reservation', sourceId: r.id, reason });
  }

  /** Job: expire overdue reservations (vehicle released; deposit kept as customer credit). */
  async expireDue(ctx: TenantContext): Promise<{ expired: number }> {
    const due = await this.dbs.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.status, 'active'), lte(reservations.expiresAt, new Date())))
      .orderBy(asc(reservations.expiresAt))
      .limit(500)
      .for('update', { skipLocked: true });
    for (const r of due) {
      const v = await this.vehicles.lock(r.vehicleId);
      await this.dbs.db.update(reservations).set({ status: 'expired', expiredAt: new Date(), version: r.version + 1, updatedAt: new Date() }).where(eq(reservations.id, r.id));
      await this.releaseVehicle(ctx, r, v.status as VehicleStatus, `Reservation ${r.number} expired`);
      const held = await this.availableDepositBase(r);
      await this.audit.record({ action: 'reservation.expired', entityType: 'reservation', entityId: r.id, before: { status: 'active' }, after: { status: 'expired', depositHeldBase: held } });
      await this.notifications.notify(ctx, {
        userIds: [r.salesUserId, r.createdBy],
        type: 'reservation.expired',
        titleAr: `انتهى الحجز ${r.number}`,
        titleEn: `Reservation ${r.number} expired`,
        bodyAr: d(held).gt(0) ? `العربون المحتجز ${held} — يلزم رده أو تطبيقه` : null,
        bodyEn: d(held).gt(0) ? `Deposit held ${held} — refund or apply it` : null,
        link: `/app/reservations/${r.id}`,
        entityType: 'reservation',
        entityId: r.id,
        dedupeKey: `reservation.expired:${r.id}`,
        severity: 'warning',
      });
    }
    return { expired: due.length };
  }

  /** Job: warn the salesperson 24 hours before a reservation expires (once per reservation). */
  async remindExpiring(ctx: TenantContext): Promise<{ reminded: number }> {
    const soon = await this.dbs.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.status, 'active'), lte(reservations.expiresAt, new Date(Date.now() + 24 * HOUR))));
    let n = 0;
    for (const r of soon) {
      n += await this.notifications.notify(ctx, {
        userIds: [r.salesUserId, r.createdBy],
        type: 'reservation.expiring',
        titleAr: `الحجز ${r.number} ينتهي خلال 24 ساعة`,
        titleEn: `Reservation ${r.number} expires within 24 hours`,
        link: `/app/reservations/${r.id}`,
        entityType: 'reservation',
        entityId: r.id,
        dedupeKey: `reservation.expiring:${r.id}:${r.expiresAt.toISOString()}`,
        severity: 'warning',
      });
    }
    return { reminded: n };
  }

  /** Called by the sales workflow (Phase 5) when a sale is created from the reservation. */
  async markConverted(ctx: TenantContext, id: string, saleId: string) {
    const r = await this.find(id, true);
    if (r.status !== 'active') throw conflict('reservation_not_active', 'Only active reservations can be converted');
    const [after] = await this.dbs.db
      .update(reservations)
      .set({ status: 'converted', convertedAt: new Date(), saleId, version: r.version + 1, updatedAt: new Date() })
      .where(eq(reservations.id, id))
      .returning();
    await this.audit.record({ action: 'reservation.converted', entityType: 'reservation', entityId: id, before: { status: 'active' }, after: { status: 'converted', saleId } });
    return after!;
  }

  async list(ctx: TenantContext, q: ReservationListQuery) {
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(reservations.status, q.status));
    if (q.customerId) conds.push(eq(reservations.customerId, q.customerId));
    if (q.vehicleId) conds.push(eq(reservations.vehicleId, q.vehicleId));
    if (q.branchId) conds.push(eq(reservations.branchId, q.branchId));
    if (q.expiringWithinHours) {
      conds.push(eq(reservations.status, 'active'), lte(reservations.expiresAt, new Date(Date.now() + q.expiringWithinHours * HOUR)));
    }
    if (!ctx.allBranches) conds.push(ctx.branchIds.length ? inArray(reservations.branchId, ctx.branchIds) : sql`false`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(sql`(${reservations.number} ILIKE ${like} OR ${vehicles.stockNumber} ILIKE ${like} OR ${customers.fullName} ILIKE ${like} OR ${customers.phone} ILIKE ${like})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const received = sql<string>`(SELECT coalesce(sum(ra.amount_base), 0) FROM receipt_allocations ra JOIN receipts rc ON rc.id = ra.receipt_id WHERE ra.target_type = 'reservation' AND ra.target_id = reservations.id AND rc.status = 'posted')::numeric(18,2)::text`;
    const items = await this.dbs.db
      .select({
        id: reservations.id,
        number: reservations.number,
        status: reservations.status,
        reservedAt: reservations.reservedAt,
        expiresAt: reservations.expiresAt,
        agreedPrice: reservations.agreedPrice,
        depositAmount: reservations.depositAmount,
        receivedBase: received,
        forfeitedBase: reservations.forfeitedBase,
        refundPolicy: reservations.refundPolicy,
        refundablePct: reservations.refundablePct,
        extendedCount: reservations.extendedCount,
        branchId: reservations.branchId,
        customerId: reservations.customerId,
        customerName: customers.fullName,
        customerPhone: customers.phone,
        vehicleId: reservations.vehicleId,
        stockNumber: vehicles.stockNumber,
        modelYear: vehicles.modelYear,
        makeEn: vehicleMakes.nameEn,
        makeAr: vehicleMakes.nameAr,
        modelEn: vehicleModels.nameEn,
        modelAr: vehicleModels.nameAr,
        salesUserName: users.fullName,
      })
      .from(reservations)
      .innerJoin(customers, eq(customers.id, reservations.customerId))
      .innerJoin(vehicles, eq(vehicles.id, reservations.vehicleId))
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .leftJoin(users, eq(users.id, reservations.salesUserId))
      .where(where)
      .orderBy(desc(reservations.reservedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [c] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(reservations)
      .innerJoin(customers, eq(customers.id, reservations.customerId))
      .innerJoin(vehicles, eq(vehicles.id, reservations.vehicleId))
      .where(where);
    return { items, total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(ctx: TenantContext, id: string) {
    const r = await this.find(id);
    assertBranchAccess(ctx, r.branchId);
    const [cust] = await this.dbs.db.select({ id: customers.id, fullName: customers.fullName, phone: customers.phone }).from(customers).where(eq(customers.id, r.customerId));
    const [veh] = await this.dbs.db
      .select({ id: vehicles.id, stockNumber: vehicles.stockNumber, status: vehicles.status, askingPrice: vehicles.askingPrice, modelYear: vehicles.modelYear, makeEn: vehicleMakes.nameEn, makeAr: vehicleMakes.nameAr, modelEn: vehicleModels.nameEn, modelAr: vehicleModels.nameAr })
      .from(vehicles)
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .where(eq(vehicles.id, r.vehicleId));
    const receipts = await this.receipts.forTargets('reservation', [r.id]);
    const refundList = await this.refunds.list(ctx, { sourceType: 'reservation', sourceId: r.id, page: 1, pageSize: 50 });
    return {
      ...r,
      customer: cust ?? null,
      vehicle: veh ?? null,
      receivedBase: await this.receipts.receivedBase('reservation', r.id),
      availableDepositBase: await this.availableDepositBase(r),
      receipts,
      refunds: refundList.items,
    };
  }
}
