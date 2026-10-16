import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, lt, ne, SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  APPOINTMENT_MAX_HOURS,
  APPOINTMENT_MAX_WINDOW_DAYS,
  AppointmentCreateInput,
  AppointmentUpdateInput,
  todayInZone,
  zAppointmentListQuery,
  zTestDriveFinish,
  zTestDriveStart,
} from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { assertWorkingMember } from '../../common/members';
import { DbService } from '../../db/db.service';
import { appointments, branches, customers, leads, reservations, users, vehicleMakes, vehicleModels, vehicles } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VehiclesService } from '../vehicles/vehicles.service';

registerUniqueConstraint('appointments_test_drive_overlap', 'vehicle_busy', 'This vehicle already has a test drive booked at that time');

type AppointmentRow = typeof appointments.$inferSelect;
type ListQuery = z.infer<typeof zAppointmentListQuery>;

const ACTIVE = ['scheduled', 'confirmed', 'in_progress'] as const;
const BOOKED = ['scheduled', 'confirmed'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Booking slightly in the past is allowed (walk-ins logged as they arrive). */
const PAST_GRACE_MS = 15 * MINUTE;
/** A test drive may start this long before its booked time. */
const EARLY_START_MS = 30 * MINUTE;
/** Assignees are reminded this long before an appointment. */
const REMINDER_AHEAD_MS = 2 * HOUR;
/** Longest plausible test drive; more is almost certainly a typing error. */
const MAX_TEST_DRIVE_KM = 1000;
const REMINDER_JOB = 'appointments.reminders';

const INTERACTION_TYPE: Record<string, 'visit' | 'test_drive' | 'meeting'> = {
  visit: 'visit',
  test_drive: 'test_drive',
  follow_up: 'meeting',
  delivery: 'visit',
  inspection: 'visit',
  other: 'meeting',
};

/**
 * Appointments and test drives (calendar). Everyone in a branch sees its calendar so slots and
 * vehicles are not double-booked, but appointment details (customer, notes, licence) are shown
 * only to the people involved or to users who may read every customer; others see a busy block.
 */
@Injectable()
export class AppointmentsService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly customersService: CustomersService,
    private readonly vehiclesService: VehiclesService,
    private readonly notifications: NotificationsService,
    jobs: JobsService,
  ) {
    jobs.register({ name: REMINDER_JOB, everyMs: 5 * MINUTE, run: (ctx) => this.remind(ctx) });
  }

  // ── Access ────────────────────────────────────────────────────────────────────────────

  private branchScope(ctx: TenantContext): SQL | undefined {
    if (ctx.allBranches) return undefined;
    return ctx.branchIds.length ? inArray(appointments.branchId, ctx.branchIds) : sql`false`;
  }

  /** SQL: may the caller see this appointment's details? (`customers` must be LEFT JOINed.) */
  private detailVisible(ctx: TenantContext): SQL {
    if (hasPermission(ctx, 'customers.read_all')) return sql`true`;
    const cust = this.customersService.visibleWhere(ctx);
    return sql`(${appointments.assignedUserId} = ${ctx.userId} OR ${appointments.createdBy} = ${ctx.userId} OR ${appointments.customerId} IS NULL${
      cust ? sql` OR (customers.id IS NOT NULL AND ${cust})` : sql``
    })`;
  }

  /** The appointment with details (404 when outside the caller's branches or not theirs to see). */
  private async find(ctx: TenantContext, id: string, lock = false): Promise<AppointmentRow> {
    const q = this.dbs.db
      .select({ a: appointments })
      .from(appointments)
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .where(and(eq(appointments.id, id), this.branchScope(ctx), this.detailVisible(ctx)));
    const [row] = lock ? await q.for('update', { of: appointments }) : await q;
    if (!row) throw notFound('Appointment');
    return row.a;
  }

  private checkVersion(a: AppointmentRow, version: number | undefined): void {
    if (version !== undefined && version !== a.version) {
      throw conflict('version_conflict', 'This appointment was changed by someone else. Reload and try again.', { currentVersion: a.version });
    }
  }

  private assertStatus(a: AppointmentRow, allowed: readonly string[]): void {
    if (!allowed.includes(a.status)) {
      throw conflict('invalid_appointment_status', `This appointment is ${a.status.replace('_', ' ')}`, { status: a.status, allowed });
    }
  }

  // ── Validation ────────────────────────────────────────────────────────────────────────

  private times(startsAtIso: string, endsAtIso: string, checkPast: boolean): { startsAt: Date; endsAt: Date } {
    const startsAt = new Date(startsAtIso);
    const endsAt = new Date(endsAtIso);
    if (endsAt.getTime() <= startsAt.getTime()) throw unprocessable('invalid_time_range', 'The end time must be after the start time', { field: 'endsAt' });
    if (endsAt.getTime() - startsAt.getTime() > APPOINTMENT_MAX_HOURS * HOUR) {
      throw unprocessable('invalid_time_range', `An appointment cannot last more than ${APPOINTMENT_MAX_HOURS} hours`, { field: 'endsAt' });
    }
    if (checkPast && startsAt.getTime() < Date.now() - PAST_GRACE_MS) {
      throw unprocessable('appointment_in_past', 'An appointment cannot be booked in the past', { field: 'startsAt' });
    }
    return { startsAt, endsAt };
  }

  private async branch(ctx: TenantContext, id: string) {
    const [b] = await this.dbs.db.select({ id: branches.id, isActive: branches.isActive }).from(branches).where(eq(branches.id, id));
    if (!b) throw notFound('Branch');
    assertBranchAccess(ctx, b.id);
    if (!b.isActive) throw unprocessable('branch_inactive', 'This branch is inactive');
  }

  /** A lead the caller may work on (sales reps: their own leads only). */
  private async lead(ctx: TenantContext, id: string) {
    const [l] = await this.dbs.db
      .select({ id: leads.id, customerId: leads.customerId, branchId: leads.branchId, assignedUserId: leads.assignedUserId, status: leads.status })
      .from(leads)
      .where(eq(leads.id, id));
    const ownOnly = !hasPermission(ctx, 'leads.assign') && !hasPermission(ctx, 'customers.read_all');
    if (!l || (ownOnly && l.assignedUserId !== ctx.userId)) throw notFound('Lead');
    assertBranchAccess(ctx, l.branchId);
    return l;
  }

  /**
   * A vehicle for an appointment must be in the caller's branches. A test-drive vehicle must also
   * be at the appointment's branch and on sale: available, or reserved for this same customer.
   */
  private async vehicle(ctx: TenantContext, id: string, opts: { testDrive: boolean; branchId: string; customerId: string | null }) {
    const [v] = await this.dbs.db
      .select({ id: vehicles.id, branchId: vehicles.branchId, status: vehicles.status, odometerValue: vehicles.odometerValue, odometerUnit: vehicles.odometerUnit, stockNumber: vehicles.stockNumber })
      .from(vehicles)
      .where(eq(vehicles.id, id));
    if (!v) throw notFound('Vehicle');
    assertBranchAccess(ctx, v.branchId);
    if (!opts.testDrive) return v;
    if (v.branchId !== opts.branchId) {
      throw unprocessable('vehicle_other_branch', 'Test drives are booked at the branch where the vehicle is', { vehicleBranchId: v.branchId });
    }
    if (v.status === 'available') return v;
    if (v.status === 'reserved' && opts.customerId) {
      const [r] = await this.dbs.db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(eq(reservations.vehicleId, v.id), eq(reservations.status, 'active'), eq(reservations.customerId, opts.customerId)));
      if (r) return v;
    }
    throw unprocessable('vehicle_not_available', 'This vehicle is not available for test drives', { vehicleStatus: v.status });
  }

  /** Serialises bookings per staff member and refuses overlapping active appointments. */
  private async assertStaffFree(userId: string, startsAt: Date, endsAt: Date, excludeId?: string): Promise<void> {
    await this.dbs.query(`SELECT pg_advisory_xact_lock(hashtext('appointment:user:' || $1::text))`, [userId]);
    const [clash] = await this.dbs.db
      .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.assignedUserId, userId),
          inArray(appointments.status, [...ACTIVE]),
          lt(appointments.startsAt, endsAt),
          gt(appointments.endsAt, startsAt),
          excludeId ? ne(appointments.id, excludeId) : undefined,
        ),
      )
      .limit(1);
    if (clash) {
      throw conflict('staff_busy', 'The assigned staff member already has an appointment at that time', {
        appointmentId: clash.id,
        startsAt: clash.startsAt,
        endsAt: clash.endsAt,
      });
    }
  }

  private licenseExpiryOk(expiry: string | null | undefined, onDate: string): void {
    if (expiry && expiry < onDate) {
      throw unprocessable('license_expired', "The driver's licence expires before the test drive", { field: 'driverLicenseExpiry' });
    }
  }

  private dateIn(ctx: TenantContext, at: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: ctx.tenant.settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }

  private async notifyAssignee(ctx: TenantContext, a: AppointmentRow): Promise<void> {
    if (!a.assignedUserId || a.assignedUserId === ctx.userId) return;
    await this.notifications.notify(ctx, {
      userIds: [a.assignedUserId],
      type: 'appointment.assigned',
      titleAr: a.type === 'test_drive' ? 'تم إسناد تجربة قيادة إليك' : 'تم إسناد موعد إليك',
      titleEn: a.type === 'test_drive' ? 'A test drive was assigned to you' : 'An appointment was assigned to you',
      bodyAr: a.title ?? null,
      bodyEn: a.title ?? null,
      link: `/app/appointments/${a.id}`,
      entityType: 'appointment',
      entityId: a.id,
      dedupeKey: `appointment.assigned:${a.id}:${a.version}`,
    });
  }

  // ── Queries ───────────────────────────────────────────────────────────────────────────

  private selection(ctx: TenantContext) {
    return {
      a: appointments,
      canView: sql<boolean>`${this.detailVisible(ctx)}`,
      customerName: customers.fullName,
      customerPhone: customers.phone,
      leadNumber: leads.number,
      assigneeName: users.fullName,
      vehicleStockNumber: vehicles.stockNumber,
      vehicleModelYear: vehicles.modelYear,
      vehicleMakeEn: vehicleMakes.nameEn,
      vehicleMakeAr: vehicleMakes.nameAr,
      vehicleModelEn: vehicleModels.nameEn,
      vehicleModelAr: vehicleModels.nameAr,
      branchName: branches.name,
    };
  }

  private base(ctx: TenantContext) {
    return this.dbs.db
      .select(this.selection(ctx))
      .from(appointments)
      .innerJoin(branches, eq(branches.id, appointments.branchId))
      .leftJoin(customers, eq(customers.id, appointments.customerId))
      .leftJoin(leads, eq(leads.id, appointments.leadId))
      .leftJoin(users, eq(users.id, appointments.assignedUserId))
      .leftJoin(vehicles, eq(vehicles.id, appointments.vehicleId))
      .leftJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId));
  }

  private present(r: Awaited<ReturnType<AppointmentsService['base']>>[number]) {
    const a = r.a;
    const vehicle = a.vehicleId
      ? {
          id: a.vehicleId,
          stockNumber: r.vehicleStockNumber,
          modelYear: r.vehicleModelYear,
          makeEn: r.vehicleMakeEn,
          makeAr: r.vehicleMakeAr,
          modelEn: r.vehicleModelEn,
          modelAr: r.vehicleModelAr,
        }
      : null;
    const common = {
      id: a.id,
      type: a.type,
      status: a.status,
      branchId: a.branchId,
      branchName: r.branchName,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      assignedUserId: a.assignedUserId,
      assigneeName: r.assigneeName,
      vehicle,
      version: a.version,
    };
    // Someone else's appointment: a busy block (who and which vehicle), no customer details.
    if (!r.canView) return { ...common, restricted: true as const };
    return {
      ...common,
      restricted: false as const,
      customerId: a.customerId,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      leadId: a.leadId,
      leadNumber: r.leadNumber,
      title: a.title,
      notes: a.notes,
      outcome: a.outcome,
      cancelReason: a.cancelReason,
      driverLicenseNumber: a.driverLicenseNumber,
      driverLicenseExpiry: a.driverLicenseExpiry,
      odometerOut: a.odometerOut,
      odometerIn: a.odometerIn,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      createdBy: a.createdBy,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  async list(ctx: TenantContext, q: ListQuery) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to.getTime() <= from.getTime()) throw unprocessable('invalid_time_range', '"to" must be after "from"', { field: 'to' });
    if (to.getTime() - from.getTime() > APPOINTMENT_MAX_WINDOW_DAYS * 24 * HOUR) {
      throw unprocessable('window_too_large', `Load at most ${APPOINTMENT_MAX_WINDOW_DAYS} days at a time`, { maxDays: APPOINTMENT_MAX_WINDOW_DAYS });
    }
    const conds: Array<SQL | undefined> = [this.branchScope(ctx), lt(appointments.startsAt, to), gt(appointments.endsAt, from)];
    if (q.branchId) conds.push(eq(appointments.branchId, q.branchId));
    if (q.assignedUserId) conds.push(eq(appointments.assignedUserId, q.assignedUserId));
    if (q.mine === 'true') conds.push(eq(appointments.assignedUserId, ctx.userId));
    if (q.vehicleId) conds.push(eq(appointments.vehicleId, q.vehicleId));
    if (q.type) conds.push(eq(appointments.type, q.type));
    if (q.status) conds.push(eq(appointments.status, q.status));
    // Filtering by customer or lead would reveal hidden bookings: those filters only match visible ones.
    if (q.customerId) conds.push(eq(appointments.customerId, q.customerId), this.detailVisible(ctx));
    if (q.leadId) conds.push(eq(appointments.leadId, q.leadId), this.detailVisible(ctx));
    const rows = await this.base(ctx)
      .where(and(...conds))
      .orderBy(asc(appointments.startsAt), asc(appointments.id))
      .limit(2000);
    return { items: rows.map((r) => this.present(r)), truncated: rows.length === 2000 };
  }

  async get(ctx: TenantContext, id: string) {
    const [r] = await this.base(ctx).where(and(eq(appointments.id, id), this.branchScope(ctx), this.detailVisible(ctx)));
    if (!r) throw notFound('Appointment');
    return this.present(r);
  }

  // ── Commands ──────────────────────────────────────────────────────────────────────────

  async create(ctx: TenantContext, input: AppointmentCreateInput) {
    await this.branch(ctx, input.branchId);
    const { startsAt, endsAt } = this.times(input.startsAt, input.endsAt, true);
    const testDrive = input.type === 'test_drive';

    let customerId = input.customerId ?? null;
    let leadId: string | null = null;
    if (input.leadId) {
      const l = await this.lead(ctx, input.leadId);
      if (customerId && customerId !== l.customerId) throw unprocessable('lead_customer_mismatch', 'This lead belongs to a different customer', { field: 'leadId' });
      customerId = l.customerId;
      leadId = l.id;
    }
    if (customerId) {
      const c = await this.customersService.assertVisible(ctx, customerId);
      if (!c.isActive) throw unprocessable('customer_inactive', 'This customer is inactive');
    }
    if (testDrive && !customerId) throw unprocessable('customer_required', 'A test drive needs a customer', { field: 'customerId' });
    if (testDrive && !input.vehicleId) throw unprocessable('vehicle_required', 'A test drive needs a vehicle', { field: 'vehicleId' });
    if (input.vehicleId) await this.vehicle(ctx, input.vehicleId, { testDrive, branchId: input.branchId, customerId });
    this.licenseExpiryOk(input.driverLicenseExpiry, this.dateIn(ctx, startsAt));

    const assignee = input.assignedUserId === undefined ? ctx.userId : input.assignedUserId;
    if (assignee !== ctx.userId) assertPermission(ctx, 'leads.assign');
    if (assignee) {
      await assertWorkingMember(this.dbs, ctx, assignee, input.branchId, 'appointments.manage');
      await this.assertStaffFree(assignee, startsAt, endsAt);
    }

    const [a] = await this.dbs.db
      .insert(appointments)
      .values({
        tenantId: ctx.tenant.id,
        type: input.type,
        branchId: input.branchId,
        customerId,
        leadId,
        vehicleId: input.vehicleId ?? null,
        assignedUserId: assignee,
        startsAt,
        endsAt,
        status: 'scheduled',
        title: input.title ?? null,
        notes: input.notes ?? null,
        driverLicenseNumber: input.driverLicenseNumber ?? null,
        driverLicenseExpiry: input.driverLicenseExpiry ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await this.audit.record({
      action: testDrive ? 'test_drive.booked' : 'appointment.created',
      entityType: 'appointment',
      entityId: a!.id,
      summary: `${input.type} at ${startsAt.toISOString()}`,
      after: a,
    });
    await this.notifyAssignee(ctx, a!);
    return this.get(ctx, a!.id);
  }

  /** Reschedule or change details of a booked appointment; rescheduling clears a confirmation. */
  async update(ctx: TenantContext, id: string, input: AppointmentUpdateInput) {
    const before = await this.find(ctx, id, true);
    this.checkVersion(before, input.version);
    this.assertStatus(before, BOOKED);
    const testDrive = before.type === 'test_drive';

    const timesChanged = input.startsAt !== undefined || input.endsAt !== undefined;
    const { startsAt, endsAt } = this.times(input.startsAt ?? before.startsAt.toISOString(), input.endsAt ?? before.endsAt.toISOString(), timesChanged);

    let customerId = input.customerId === undefined ? before.customerId : input.customerId;
    let leadId = input.leadId === undefined ? before.leadId : input.leadId;
    if (input.leadId) {
      const l = await this.lead(ctx, input.leadId);
      if (input.customerId && input.customerId !== l.customerId) throw unprocessable('lead_customer_mismatch', 'This lead belongs to a different customer', { field: 'leadId' });
      customerId = l.customerId;
      leadId = l.id;
    } else if (leadId && customerId !== before.customerId) {
      // A different customer cannot keep the old customer's lead.
      leadId = null;
    }
    if (customerId && customerId !== before.customerId) {
      const c = await this.customersService.assertVisible(ctx, customerId);
      if (!c.isActive) throw unprocessable('customer_inactive', 'This customer is inactive');
    }
    const vehicleId = input.vehicleId === undefined ? before.vehicleId : input.vehicleId;
    if (testDrive && !customerId) throw unprocessable('customer_required', 'A test drive needs a customer', { field: 'customerId' });
    if (testDrive && !vehicleId) throw unprocessable('vehicle_required', 'A test drive needs a vehicle', { field: 'vehicleId' });
    if (vehicleId && (vehicleId !== before.vehicleId || customerId !== before.customerId)) {
      await this.vehicle(ctx, vehicleId, { testDrive, branchId: before.branchId, customerId });
    }
    const licenseExpiry = input.driverLicenseExpiry === undefined ? before.driverLicenseExpiry : input.driverLicenseExpiry;
    this.licenseExpiryOk(licenseExpiry, this.dateIn(ctx, startsAt));

    const assignee = input.assignedUserId === undefined ? before.assignedUserId : input.assignedUserId;
    const assigneeChanged = assignee !== before.assignedUserId;
    if (assigneeChanged && assignee !== ctx.userId) assertPermission(ctx, 'leads.assign');
    if (assignee && assigneeChanged) await assertWorkingMember(this.dbs, ctx, assignee, before.branchId, 'appointments.manage');
    if (assignee && (assigneeChanged || timesChanged)) await this.assertStaffFree(assignee, startsAt, endsAt, id);

    const rescheduled = startsAt.getTime() !== before.startsAt.getTime() || endsAt.getTime() !== before.endsAt.getTime();
    const [after] = await this.dbs.db
      .update(appointments)
      .set({
        customerId,
        leadId,
        vehicleId,
        assignedUserId: assignee,
        startsAt,
        endsAt,
        status: rescheduled ? 'scheduled' : before.status,
        title: input.title === undefined ? before.title : input.title,
        notes: input.notes === undefined ? before.notes : input.notes,
        driverLicenseNumber: input.driverLicenseNumber === undefined ? before.driverLicenseNumber : input.driverLicenseNumber,
        driverLicenseExpiry: licenseExpiry,
        version: before.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(appointments.id, id), eq(appointments.version, before.version)))
      .returning();
    if (!after) throw conflict('version_conflict', 'This appointment was changed by someone else. Reload and try again.');
    await this.audit.record({
      action: rescheduled ? 'appointment.rescheduled' : 'appointment.updated',
      entityType: 'appointment',
      entityId: id,
      ...diff(before, after),
    });
    if (assigneeChanged) await this.notifyAssignee(ctx, after);
    return this.get(ctx, id);
  }

  private async setStatus(
    ctx: TenantContext,
    before: AppointmentRow,
    status: string,
    set: Partial<typeof appointments.$inferInsert>,
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<AppointmentRow> {
    const [after] = await this.dbs.db
      .update(appointments)
      .set({ ...set, status, version: before.version + 1, updatedAt: new Date() })
      .where(eq(appointments.id, before.id))
      .returning();
    await this.audit.record({
      action,
      entityType: 'appointment',
      entityId: before.id,
      before: { status: before.status },
      after: { status, ...extra },
    });
    return after!;
  }

  async confirm(ctx: TenantContext, id: string, input: { version?: number }) {
    const a = await this.find(ctx, id, true);
    this.checkVersion(a, input.version);
    this.assertStatus(a, ['scheduled']);
    await this.setStatus(ctx, a, 'confirmed', {}, 'appointment.confirmed');
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string, input: { reason: string; version?: number }) {
    const a = await this.find(ctx, id, true);
    this.checkVersion(a, input.version);
    this.assertStatus(a, BOOKED);
    await this.setStatus(ctx, a, 'cancelled', { cancelReason: input.reason }, 'appointment.cancelled', { reason: input.reason });
    return this.get(ctx, id);
  }

  async noShow(ctx: TenantContext, id: string, input: { note?: string | null; version?: number }) {
    const a = await this.find(ctx, id, true);
    this.checkVersion(a, input.version);
    this.assertStatus(a, BOOKED);
    if (a.startsAt.getTime() > Date.now()) throw unprocessable('appointment_not_started', 'A no-show can only be recorded after the start time');
    await this.setStatus(ctx, a, 'no_show', { outcome: input.note ?? null }, 'appointment.no_show');
    if (a.customerId) {
      await this.customersService.appendInteraction(ctx, {
        customerId: a.customerId,
        leadId: a.leadId,
        vehicleId: a.vehicleId,
        type: 'note',
        summary: `No-show: ${a.type.replace('_', ' ')}`,
        outcome: input.note ?? null,
      });
    }
    return this.get(ctx, id);
  }

  /** Completes a non-test-drive appointment and logs it on the customer's timeline. */
  async complete(ctx: TenantContext, id: string, input: { outcome?: string | null; version?: number }) {
    const a = await this.find(ctx, id, true);
    this.checkVersion(a, input.version);
    if (a.type === 'test_drive') throw unprocessable('use_test_drive_flow', 'Start and finish the test drive instead');
    this.assertStatus(a, BOOKED);
    if (a.startsAt.getTime() > Date.now() + PAST_GRACE_MS) throw unprocessable('appointment_not_started', 'This appointment has not started yet');
    await this.setStatus(ctx, a, 'completed', { outcome: input.outcome ?? null, finishedAt: new Date() }, 'appointment.completed');
    if (a.customerId) {
      await this.customersService.appendInteraction(ctx, {
        customerId: a.customerId,
        leadId: a.leadId,
        vehicleId: a.vehicleId,
        type: INTERACTION_TYPE[a.type] ?? 'meeting',
        summary: a.title ?? `${a.type.replace('_', ' ')} completed`,
        outcome: input.outcome ?? null,
      });
    }
    return this.get(ctx, id);
  }

  async startTestDrive(ctx: TenantContext, id: string, input: z.infer<typeof zTestDriveStart>) {
    const a = await this.find(ctx, id, true);
    if (a.type !== 'test_drive') throw unprocessable('not_a_test_drive', 'This appointment is not a test drive');
    this.assertStatus(a, BOOKED);
    if (a.startsAt.getTime() - Date.now() > EARLY_START_MS) {
      throw unprocessable('too_early', 'This test drive is booked for later; reschedule it to start now', { startsAt: a.startsAt });
    }
    this.licenseExpiryOk(input.driverLicenseExpiry, todayInZone(ctx.tenant.settings.timezone));
    // The vehicle lock serialises test-drive starts for one vehicle.
    await this.vehiclesService.lock(a.vehicleId!);
    const v = await this.vehicle(ctx, a.vehicleId!, { testDrive: true, branchId: a.branchId, customerId: a.customerId });
    const [busy] = await this.dbs.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.vehicleId, v.id), eq(appointments.status, 'in_progress'), ne(appointments.id, id)));
    if (busy) throw conflict('vehicle_on_test_drive', 'This vehicle is out on another test drive', { appointmentId: busy.id });
    if (input.odometerOut < v.odometerValue) {
      throw unprocessable('odometer_below_last', `The odometer reading is below the last recorded reading (${v.odometerValue} ${v.odometerUnit})`, {
        field: 'odometerOut',
        lastReading: v.odometerValue,
        unit: v.odometerUnit,
      });
    }
    await this.setStatus(
      ctx,
      a,
      'in_progress',
      { startedAt: new Date(), odometerOut: input.odometerOut, driverLicenseNumber: input.driverLicenseNumber, driverLicenseExpiry: input.driverLicenseExpiry },
      'test_drive.started',
      { odometerOut: input.odometerOut, vehicleId: v.id },
    );
    return this.get(ctx, id);
  }

  async finishTestDrive(ctx: TenantContext, id: string, input: z.infer<typeof zTestDriveFinish>) {
    const a = await this.find(ctx, id, true);
    if (a.type !== 'test_drive') throw unprocessable('not_a_test_drive', 'This appointment is not a test drive');
    this.assertStatus(a, ['in_progress']);
    const out = a.odometerOut ?? 0;
    if (input.odometerIn < out) throw unprocessable('invalid_odometer', 'The return reading cannot be below the departure reading', { field: 'odometerIn', odometerOut: out });
    const distance = input.odometerIn - out;
    if (distance > MAX_TEST_DRIVE_KM) {
      throw unprocessable('implausible_distance', `A test drive of ${distance} is not plausible; check the reading`, { field: 'odometerIn', distance });
    }
    const v = await this.vehiclesService.lock(a.vehicleId!);
    await this.setStatus(ctx, a, 'completed', { odometerIn: input.odometerIn, outcome: input.outcome ?? null, finishedAt: new Date() }, 'test_drive.finished', {
      odometerIn: input.odometerIn,
      distance,
    });
    if (input.odometerIn > v.odometerValue) {
      await this.vehiclesService.addOdometer(ctx, v.id, { value: input.odometerIn, unit: v.odometerUnit as 'km' | 'mi', source: 'test_drive', notes: null });
    }
    await this.customersService.appendInteraction(ctx, {
      customerId: a.customerId!,
      leadId: a.leadId,
      vehicleId: a.vehicleId,
      type: 'test_drive',
      summary: `Test drive ${v.stockNumber} (${distance} ${v.odometerUnit})`,
      outcome: input.outcome ?? null,
    });
    return this.get(ctx, id);
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────────────────

  /** Job: remind each assignee once per booking time, up to two hours ahead. */
  async remind(ctx: TenantContext): Promise<{ notified: number }> {
    const due = await this.dbs.db
      .select({ id: appointments.id, type: appointments.type, title: appointments.title, startsAt: appointments.startsAt, assignedUserId: appointments.assignedUserId })
      .from(appointments)
      .where(
        and(
          inArray(appointments.status, BOOKED),
          isNotNull(appointments.assignedUserId),
          gt(appointments.startsAt, sql`now()`),
          lt(appointments.startsAt, sql`now() + make_interval(secs => ${REMINDER_AHEAD_MS / 1000})`),
        ),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(1000);
    let notified = 0;
    for (const a of due) {
      const time = a.startsAt.toISOString();
      notified += await this.notifications.notify(ctx, {
        userIds: [a.assignedUserId],
        type: 'appointment.reminder',
        titleAr: a.type === 'test_drive' ? 'تذكير: تجربة قيادة قريبًا' : 'تذكير: موعد قريبًا',
        titleEn: a.type === 'test_drive' ? 'Reminder: test drive soon' : 'Reminder: appointment soon',
        bodyAr: a.title ?? null,
        bodyEn: a.title ?? null,
        link: `/app/appointments/${a.id}`,
        entityType: 'appointment',
        entityId: a.id,
        dedupeKey: `appointment.reminder:${a.id}:${time}`,
        severity: 'warning',
      });
    }
    return { notified };
  }
}
