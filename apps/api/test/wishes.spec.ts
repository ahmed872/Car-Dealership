import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { catalogIds, createCustomer, createVehicle, makeAvailable } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, ownerPool, TestTenant } from './helpers';

describe('customer wishes & inventory matching', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  let pool: Pool;
  let rep: { client: Client; userId: string };
  let rep2: { client: Client; userId: string };
  let camry: { makeId: string; modelId: string };

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
    pool = ownerPool();
    rep = await addMember(app, t, 'sales_rep');
    rep2 = await addMember(app, t, 'sales_rep');
    camry = await catalogIds(t.owner);
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('matches current stock on creation and explains mismatches', async () => {
    const v = await createVehicle(t.owner, t.branchId, { exteriorColor: 'Sunset Orange', modelYear: 2023 });
    await makeAvailable(t.owner, v.id, '98000.00', '90000.00');
    const c = await createCustomer(rep.client);
    const none = await rep.client.post('/wishes', { customerId: c.id });
    expect(none.status).toBe(422);
    const w = await rep.client.post('/wishes', { ...camry, customerId: c.id, yearFrom: 2022, maxPrice: '100000', color: 'orange' });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body.matches.map((m: { vehicleId: string }) => m.vehicleId)).toEqual([v.id]);
    expect(w.body.matches[0]).toMatchObject({ onSale: true, stockNumber: v.stockNumber });
    const tighter = await rep.client.patch(`/wishes/${w.body.id}`, { maxPrice: '95000' });
    expect(tighter.status).toBe(200);
    const why = await rep.client.get(`/wishes/${w.body.id}/explain/${v.id}`);
    expect(why.body).toEqual({ matches: false, mismatches: ['maxPrice'] });
    // History is kept: the earlier match remains listed.
    expect(tighter.body.matches).toHaveLength(1);
  });

  it('the matching job records each new match once and notifies the salesperson once', async () => {
    const c = await createCustomer(rep.client);
    const w = await rep.client.post('/wishes', { ...camry, customerId: c.id, color: 'Electric Lime' });
    expect(w.body.matches).toHaveLength(0);
    const v = await createVehicle(t.owner, t.branchId, { exteriorColor: 'Electric Lime' });
    const jobs = app.get(JobsService);
    // Not on sale yet → no match.
    await jobs.runJob('wishes.match', { tenantId: t.tenantId });
    expect((await rep.client.get(`/wishes/${w.body.id}`)).body.matches).toHaveLength(0);
    await makeAvailable(t.owner, v.id);
    const run1 = await jobs.runJob('wishes.match', { tenantId: t.tenantId });
    expect(run1?.[0]).toMatchObject({ ok: true });
    await jobs.runJob('wishes.match', { tenantId: t.tenantId });
    const detail = await rep.client.get(`/wishes/${w.body.id}`);
    expect(detail.body.matches.map((m: { vehicleId: string }) => m.vehicleId)).toEqual([v.id]);
    const n = await pool.query(`SELECT user_id FROM notifications WHERE entity_id = $1 AND type = 'wish.matched'`, [w.body.id]);
    expect(n.rows).toEqual([{ user_id: rep.userId }]);

    const forCar = await rep.client.get(`/wishes/for-vehicle/${v.id}`);
    expect(forCar.body.items.map((i: { wishId: string }) => i.wishId)).toContain(w.body.id);
    // Another rep cannot see this customer's wish, not even through the vehicle.
    const forCar2 = await rep2.client.get(`/wishes/for-vehicle/${v.id}`);
    expect(forCar2.body.items.map((i: { wishId: string }) => i.wishId)).not.toContain(w.body.id);
    expect((await rep2.client.get(`/wishes/${w.body.id}`)).status).toBe(404);

    const dismissed = await rep.client.post(`/wishes/${w.body.id}/matches/${v.id}/dismiss`, {});
    expect(dismissed.status).toBe(200);
    const list = await rep.client.get(`/wishes?customerId=${c.id}`);
    expect(list.body.items[0]).toMatchObject({ id: w.body.id, openMatches: 0 });
  });

  it('wishes expire after their date and closed wishes stop matching', async () => {
    const c = await createCustomer(rep.client);
    const w = await rep.client.post('/wishes', { ...camry, customerId: c.id, color: 'Moss Green', expiresAt: '2099-01-01' });
    const past = await rep.client.post('/wishes', { ...camry, customerId: c.id, expiresAt: '2001-01-01' });
    expect(past.body.error.code).toBe('invalid_expiry');
    await pool.query(`UPDATE customer_wishes SET expires_at = '2001-01-01' WHERE id = $1`, [w.body.id]);
    const run = await app.get(JobsService).runJob('wishes.match', { tenantId: t.tenantId });
    expect((run?.[0]?.result as { expired: number }).expired).toBeGreaterThanOrEqual(1);
    expect((await rep.client.get(`/wishes/${w.body.id}`)).body.status).toBe('expired');
    expect((await rep.client.patch(`/wishes/${w.body.id}`, { color: 'Blue' })).body.error.code).toBe('wish_closed');

    const w2 = await rep.client.post('/wishes', { ...camry, customerId: c.id, color: 'Navy' });
    const done = await rep.client.post(`/wishes/${w2.body.id}/fulfil`, { note: 'Bought elsewhere in town' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('fulfilled');
  });

  it('checks model/make consistency and blocks other companies', async () => {
    const c = await createCustomer(t.owner);
    const patrol = await catalogIds(t.owner, 'Nissan', 'Patrol');
    const bad = await t.owner.post('/wishes', { customerId: c.id, makeId: camry.makeId, modelId: patrol.modelId });
    expect(bad.body.error.code).toBe('model_make_mismatch');
    const w = await t.owner.post('/wishes', { customerId: c.id, bodyType: 'suv', maxPrice: '150000' });
    expect(w.status).toBe(201);
    expect((await other.owner.get(`/wishes/${w.body.id}`)).status).toBe(404);
    expect((await other.owner.post('/wishes', { customerId: c.id, bodyType: 'suv' })).status).toBe(404);
    expect((await rep.client.post('/wishes', { customerId: c.id, bodyType: 'suv' })).status).toBe(404);
  });
});
