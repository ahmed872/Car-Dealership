import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { createCustomer, createVehicle, makeAvailable } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** ISO time `days` from now at a fixed offset of minutes (distinct slots keep tests independent). */
const at = (days: number, minutes = 0) => new Date(Date.now() + days * DAY + minutes * MIN).toISOString();

describe('appointments & test drives', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  let pool: Pool;
  let rep: { client: Client; userId: string };
  let rep2: { client: Client; userId: string };
  let manager: { client: Client; userId: string };
  let accountant: { client: Client; userId: string };

  async function availableVehicle() {
    const v = await createVehicle(t.owner, t.branchId);
    await makeAvailable(t.owner, v.id);
    return v as { id: string };
  }

  async function book(client: Client, body: Record<string, unknown>) {
    return client.post('/appointments', { branchId: t.branchId, ...body });
  }

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
    pool = ownerPool();
    rep = await addMember(app, t, 'sales_rep');
    rep2 = await addMember(app, t, 'sales_rep');
    manager = await addMember(app, t, 'sales_manager');
    accountant = await addMember(app, t, 'accountant');
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('validates bookings: customer and vehicle for test drives, time range, past times', async () => {
    const v = await availableVehicle();
    const c = await createCustomer(rep.client);
    const noCust = await book(rep.client, { type: 'test_drive', vehicleId: v.id, startsAt: at(1), endsAt: at(1, 30) });
    expect(noCust.body.error.code).toBe('customer_required');
    const noCar = await book(rep.client, { type: 'test_drive', customerId: c.id, startsAt: at(1), endsAt: at(1, 30) });
    expect(noCar.body.error.code).toBe('vehicle_required');
    const backwards = await book(rep.client, { type: 'visit', customerId: c.id, startsAt: at(1, 30), endsAt: at(1) });
    expect(backwards.body.error.code).toBe('invalid_time_range');
    const tooLong = await book(rep.client, { type: 'visit', customerId: c.id, startsAt: at(1), endsAt: at(1, 13 * 60) });
    expect(tooLong.body.error.code).toBe('invalid_time_range');
    const past = await book(rep.client, { type: 'visit', customerId: c.id, startsAt: at(-1), endsAt: at(-1, 30) });
    expect(past.body.error.code).toBe('appointment_in_past');
    const expired = await book(rep.client, { type: 'test_drive', customerId: c.id, vehicleId: v.id, startsAt: at(3), endsAt: at(3, 30), driverLicenseExpiry: '2020-01-01' });
    expect(expired.body.error.code).toBe('license_expired');
    const ok = await book(rep.client, { type: 'test_drive', customerId: c.id, vehicleId: v.id, startsAt: at(1), endsAt: at(1, 30), title: 'Camry test drive' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ status: 'scheduled', assignedUserId: rep.userId, customerId: c.id, restricted: false });
  });

  it('never double-books a vehicle (database exclusion) or a salesperson', async () => {
    const v = await availableVehicle();
    const c1 = await createCustomer(t.owner);
    const c2 = await createCustomer(t.owner);
    const first = await book(rep.client, { type: 'test_drive', customerId: (await createCustomer(rep.client)).id, vehicleId: v.id, startsAt: at(2), endsAt: at(2, 60) });
    expect(first.status).toBe(201);
    // Another salesperson, same vehicle, overlapping time.
    const clash = await book(manager.client, { type: 'test_drive', customerId: c1.id, vehicleId: v.id, startsAt: at(2, 30), endsAt: at(2, 90) });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('vehicle_busy');
    // Back-to-back is fine (half-open ranges).
    const next = await book(manager.client, { type: 'test_drive', customerId: c1.id, vehicleId: v.id, startsAt: at(2, 60), endsAt: at(2, 90) });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    // The rep is busy 0–60: a visit for them at 30 is refused, even when a manager books it.
    const staff = await book(manager.client, { type: 'visit', customerId: c2.id, assignedUserId: rep.userId, startsAt: at(2, 30), endsAt: at(2, 45) });
    expect(staff.status).toBe(409);
    expect(staff.body.error.code).toBe('staff_busy');
    // Concurrent bookings of one slot: exactly one wins.
    const v2 = await availableVehicle();
    const custs = await Promise.all([1, 2, 3, 4].map(() => createCustomer(t.owner)));
    const results = await Promise.all(
      custs.map((c) => book(manager.client, { type: 'test_drive', customerId: c.id, vehicleId: v2.id, assignedUserId: null, startsAt: at(4), endsAt: at(4, 45) })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    // A cancelled booking frees the slot.
    const winner = results.find((r) => r.status === 201)!;
    expect((await manager.client.post(`/appointments/${winner.body.id}/cancel`, { reason: 'Customer postponed' })).status).toBe(200);
    expect((await book(manager.client, { type: 'test_drive', customerId: custs[0]!.id, vehicleId: v2.id, assignedUserId: null, startsAt: at(4), endsAt: at(4, 45) })).status).toBe(201);
  });

  it('only managers assign appointments to others, and only to staff who can take them', async () => {
    const c = await createCustomer(rep.client);
    const self = await book(rep.client, { type: 'visit', customerId: c.id, assignedUserId: rep2.userId, startsAt: at(5), endsAt: at(5, 30) });
    expect(self.status).toBe(403);
    const toAccountant = await book(manager.client, { type: 'visit', customerId: c.id, assignedUserId: accountant.userId, startsAt: at(5), endsAt: at(5, 30) });
    expect(toAccountant.status).toBe(422);
    expect(toAccountant.body.error).toMatchObject({ code: 'invalid_assignee', details: { reason: 'missing_permission' } });
    const ok = await book(manager.client, { type: 'visit', customerId: c.id, assignedUserId: rep2.userId, startsAt: at(5), endsAt: at(5, 30) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const notes = await rep2.client.get('/notifications?unread=true');
    expect(notes.body.items.some((n: { entityId: string; type: string }) => n.entityId === ok.body.id && n.type === 'appointment.assigned')).toBe(true);
  });

  it("shows colleagues' bookings as busy blocks without customer details", async () => {
    const c = await createCustomer(rep.client, { fullName: 'Private Person' });
    const a = await book(rep.client, { type: 'visit', customerId: c.id, title: 'Trade-in talk', startsAt: at(6), endsAt: at(6, 30) });
    expect(a.status).toBe(201);
    const window = `from=${encodeURIComponent(at(5, 23 * 60))}&to=${encodeURIComponent(at(6, 60))}`;
    const seen = (await rep2.client.get(`/appointments?${window}`)).body.items.find((i: { id: string }) => i.id === a.body.id);
    expect(seen).toMatchObject({ id: a.body.id, restricted: true, assignedUserId: rep.userId });
    expect(seen.customerName).toBeUndefined();
    expect(seen.title).toBeUndefined();
    expect((await rep2.client.get(`/appointments/${a.body.id}`)).status).toBe(404);
    expect((await rep2.client.post(`/appointments/${a.body.id}/cancel`, { reason: 'not mine' })).status).toBe(404);
    // Filtering by customer only matches visible bookings (no probing who visits when).
    const probe = await rep2.client.get(`/appointments?${window}&customerId=${c.id}`);
    expect(probe.body.items).toHaveLength(0);
    const mgr = (await manager.client.get(`/appointments?${window}`)).body.items.find((i: { id: string }) => i.id === a.body.id);
    expect(mgr).toMatchObject({ restricted: false, customerName: 'Private Person', title: 'Trade-in talk' });
    const wide = await manager.client.get(`/appointments?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(90))}`);
    expect(wide.body.error.code).toBe('window_too_large');
  });

  it('runs a test drive: start checks, odometer, licence, then the timeline and vehicle reading', async () => {
    const v = await availableVehicle();
    const km: number = (await t.owner.get(`/vehicles/${v.id}`)).body.vehicle.odometerValue;
    const c = await createCustomer(rep.client);
    const leadRes = await rep.client.post('/leads', { customerId: c.id, branchId: t.branchId, source: 'showroom', vehicleId: v.id });
    expect(leadRes.status).toBe(201);
    const later = await book(rep.client, { type: 'test_drive', leadId: leadRes.body.id, vehicleId: v.id, startsAt: at(7), endsAt: at(7, 30) });
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    expect(later.body.customerId).toBe(c.id);
    const licence = { driverLicenseNumber: 'DL-778899', driverLicenseExpiry: '2030-12-31' };
    expect((await rep.client.post(`/appointments/${later.body.id}/start-test-drive`, { odometerOut: km + 10, ...licence })).body.error.code).toBe('too_early');

    const a = await book(rep.client, { type: 'test_drive', leadId: leadRes.body.id, vehicleId: v.id, startsAt: at(0, -5), endsAt: at(0, 25) });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await book(manager.client, { type: 'test_drive', customerId: (await createCustomer(manager.client)).id, vehicleId: v.id, startsAt: at(0, 25), endsAt: at(0, 55) });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const expiredLicence = await rep.client.post(`/appointments/${a.body.id}/start-test-drive`, { odometerOut: km + 10, driverLicenseNumber: 'DL-1', driverLicenseExpiry: '2021-01-01' });
    expect(expiredLicence.body.error.code).toBe('license_expired');
    const rollback = await rep.client.post(`/appointments/${a.body.id}/start-test-drive`, { odometerOut: km - 100, ...licence });
    expect(rollback.body.error.code).toBe('odometer_below_last');
    const started = await rep.client.post(`/appointments/${a.body.id}/start-test-drive`, { odometerOut: km + 10, ...licence });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ status: 'in_progress', odometerOut: km + 10, driverLicenseNumber: 'DL-778899' });
    // The car is out: the next booking cannot start until it returns.
    const second = await manager.client.post(`/appointments/${b.body.id}/start-test-drive`, { odometerOut: km + 10, ...licence });
    expect(second.body.error.code).toBe('vehicle_on_test_drive');

    expect((await rep.client.post(`/appointments/${a.body.id}/finish-test-drive`, { odometerIn: km })).body.error.code).toBe('invalid_odometer');
    expect((await rep.client.post(`/appointments/${a.body.id}/finish-test-drive`, { odometerIn: km + 5000 })).body.error.code).toBe('implausible_distance');
    const done = await rep.client.post(`/appointments/${a.body.id}/finish-test-drive`, { odometerIn: km + 42, outcome: 'Liked it; wants a price' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', odometerIn: km + 42, outcome: 'Liked it; wants a price' });
    const vehicle = await t.owner.get(`/vehicles/${v.id}`);
    expect(vehicle.body.vehicle.odometerValue).toBe(km + 42);
    const timeline = await rep.client.get(`/customers/${c.id}/interactions`);
    expect(timeline.body.items[0]).toMatchObject({ type: 'test_drive', outcome: 'Liked it; wants a price' });
    expect(timeline.body.items[0].summary).toContain('32 km');
    const reading = await pool.query(`SELECT source, value FROM odometer_readings WHERE vehicle_id = $1 ORDER BY created_at DESC LIMIT 1`, [v.id]);
    expect(reading.rows[0]).toEqual({ source: 'test_drive', value: km + 42 });
    // Now the second booking can start.
    expect((await manager.client.post(`/appointments/${b.body.id}/start-test-drive`, { odometerOut: km + 42, ...licence })).status).toBe(200);
  });

  it('reserved vehicles are test-driven only by the customer holding the reservation', async () => {
    const v = await availableVehicle();
    const holder = await createCustomer(t.owner);
    const stranger = await createCustomer(t.owner);
    const r = await t.owner.post('/reservations', { vehicleId: v.id, customerId: holder.id }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const denied = await book(t.owner, { type: 'test_drive', customerId: stranger.id, vehicleId: v.id, startsAt: at(8), endsAt: at(8, 30) });
    expect(denied.body.error.code).toBe('vehicle_not_available');
    const ok = await book(t.owner, { type: 'test_drive', customerId: holder.id, vehicleId: v.id, startsAt: at(8), endsAt: at(8, 30) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('confirm, reschedule (clears confirmation), no-show and completion', async () => {
    const c = await createCustomer(rep.client);
    const a = await book(rep.client, { type: 'visit', customerId: c.id, startsAt: at(9), endsAt: at(9, 30) });
    const conf = await rep.client.post(`/appointments/${a.body.id}/confirm`, { version: a.body.version });
    expect(conf.body.status).toBe('confirmed');
    const stale = await rep.client.patch(`/appointments/${a.body.id}`, { version: a.body.version, notes: 'x' });
    expect(stale.body.error.code).toBe('version_conflict');
    const moved = await rep.client.patch(`/appointments/${a.body.id}`, { version: conf.body.version, startsAt: at(9, 60), endsAt: at(9, 90) });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.status).toBe('scheduled');
    const early = await rep.client.post(`/appointments/${a.body.id}/no-show`, {});
    expect(early.body.error.code).toBe('appointment_not_started');

    const now = await book(rep.client, { type: 'visit', customerId: c.id, title: 'Showroom visit', startsAt: at(0, 60), endsAt: at(0, 90) });
    expect(now.status, JSON.stringify(now.body)).toBe(201);
    await pool.query(`UPDATE appointments SET starts_at = now() - interval '20 minutes', ends_at = now() + interval '10 minutes' WHERE id = $1`, [now.body.id]);
    const td = await rep.client.post(`/appointments/${now.body.id}/start-test-drive`, { odometerOut: 1, driverLicenseNumber: 'DL-1', driverLicenseExpiry: '2030-01-01' });
    expect(td.body.error.code).toBe('not_a_test_drive');
    const completed = await rep.client.post(`/appointments/${now.body.id}/complete`, { outcome: 'Wants SUVs under 150k' });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('completed');
    const again = await rep.client.post(`/appointments/${now.body.id}/cancel`, { reason: 'too late' });
    expect(again.body.error.code).toBe('invalid_appointment_status');
    const timeline = await rep.client.get(`/customers/${c.id}/interactions`);
    expect(timeline.body.items[0]).toMatchObject({ type: 'visit', summary: 'Showroom visit', outcome: 'Wants SUVs under 150k' });
  });

  it('reminds the assignee once before the appointment', async () => {
    const c = await createCustomer(rep2.client);
    const a = await book(rep2.client, { type: 'visit', customerId: c.id, startsAt: at(0, 70), endsAt: at(0, 100) });
    expect(a.status).toBe(201);
    const jobs = app.get(JobsService);
    const run = await jobs.runJob('appointments.reminders', { tenantId: t.tenantId });
    expect(run?.[0]?.ok).toBe(true);
    await jobs.runJob('appointments.reminders', { tenantId: t.tenantId });
    const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE entity_id = $1 AND type = 'appointment.reminder'`, [a.body.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("another company's appointments are invisible and its customers cannot be booked", async () => {
    const c = await createCustomer(t.owner);
    const a = await book(t.owner, { type: 'visit', customerId: c.id, startsAt: at(10), endsAt: at(10, 30) });
    expect((await other.owner.get(`/appointments/${a.body.id}`)).status).toBe(404);
    expect((await other.owner.post(`/appointments/${a.body.id}/cancel`, { reason: 'probe' })).status).toBe(404);
    const theirBranch = (await other.owner.get('/branches')).body[0].id;
    const cross = await other.owner.post('/appointments', { type: 'visit', branchId: theirBranch, customerId: c.id, startsAt: at(10), endsAt: at(10, 30) });
    expect(cross.status).toBe(404);
    const list = await other.owner.get(`/appointments?from=${encodeURIComponent(at(9))}&to=${encodeURIComponent(at(11))}`);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(a.body.id);
  });
});
