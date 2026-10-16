import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomer } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, ownerPool, TestTenant } from './helpers';

describe('customers & interactions', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  let pool: Pool;
  let repA: { client: Client; userId: string };
  let repB: { client: Client; userId: string };
  let manager: { client: Client; userId: string };

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
    pool = ownerPool();
    repA = await addMember(app, t, 'sales_rep');
    repB = await addMember(app, t, 'sales_rep');
    manager = await addMember(app, t, 'sales_manager');
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('normalises Arabic-digit phones, encrypts the national ID and reveals it only with view_sensitive (audited)', async () => {
    const res = await t.owner.post('/customers', { fullName: 'سعد العتيبي', phone: '٠٥٠١٢٣٤٥٦٧', nationalId: '1012345678', email: ' Saad@Example.COM ' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ phone: '966501234567', email: 'saad@example.com', nationalIdMasked: '••••5678', hasNationalId: true });
    expect(res.body.nationalIdEnc).toBeUndefined();
    expect(res.body.nationalIdHash).toBeUndefined();
    const raw = await pool.query(`SELECT national_id_enc, national_id_hash FROM customers WHERE id = $1`, [res.body.id]);
    expect(raw.rows[0].national_id_enc).not.toContain('1012345678');
    expect(raw.rows[0].national_id_hash).toMatch(/^[0-9a-f]{64}$/);

    expect((await repA.client.get(`/customers/${res.body.id}/sensitive`)).status).toBe(403);
    const s = await t.owner.get(`/customers/${res.body.id}/sensitive`);
    expect(s.status).toBe(200);
    expect(s.body.nationalId).toBe('1012345678');
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'customer' AND entity_id = $1 ORDER BY seq`, [res.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['customer.created', 'customer.sensitive_viewed']);
  });

  it('refuses duplicates: phone (forceable by customers.manage), national ID (never)', async () => {
    const first = await createCustomer(t.owner, { nationalId: '2099887766' });
    const dupPhone = await t.owner.post('/customers', { fullName: 'Same phone', phone: `+${first.phone}` });
    expect(dupPhone.status).toBe(409);
    expect(dupPhone.body.error).toMatchObject({ code: 'customer_duplicate', details: { matchedOn: 'phone', forceAllowed: true } });
    const forced = await t.owner.post('/customers', { fullName: 'Same phone (family)', phone: `+${first.phone}`, force: true });
    expect(forced.status).toBe(201);
    const dupNid = await t.owner.post('/customers', { fullName: 'Same ID', nationalId: '2099-887-766', force: true });
    expect(dupNid.status).toBe(409);
    expect(dupNid.body.error.details).toMatchObject({ matchedOn: 'nationalId', forceAllowed: false });
  });

  it('sales reps see only their own customers; duplicate checks never leak hidden names; managers see all', async () => {
    const mine = await createCustomer(repA.client, { fullName: 'Fahad Al Qahtani' });
    expect((await repA.client.get(`/customers/${mine.id}`)).status).toBe(200);
    expect((await repB.client.get(`/customers/${mine.id}`)).status).toBe(404);
    const listB = await repB.client.get('/customers?pageSize=100');
    expect(listB.body.items.map((i: { id: string }) => i.id)).not.toContain(mine.id);
    const check = await repB.client.post('/customers/check-duplicates', { phone: `+${mine.phone}` });
    expect(check.status).toBe(200);
    expect(check.body.candidates[0]).toMatchObject({ id: mine.id, canView: false, fullName: 'F. A. Q.' });
    expect((await manager.client.get(`/customers/${mine.id}`)).status).toBe(200);
  });

  it('assignment is a manager action; the new assignee gets access and a notification', async () => {
    const c = await createCustomer(repA.client);
    const self = await repA.client.post(`/customers/${c.id}/assign`, { assignedUserId: repB.userId });
    expect(self.status).toBe(403);
    const ok = await manager.client.post(`/customers/${c.id}/assign`, { assignedUserId: repB.userId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.assignedUserId).toBe(repB.userId);
    expect((await repB.client.get(`/customers/${c.id}`)).status).toBe(200);
    const notes = await repB.client.get('/notifications?unread=true');
    expect(notes.body.items.some((n: { entityId: string; type: string }) => n.entityId === c.id && n.type === 'customer.assigned')).toBe(true);
    const outsider = await addMember(app, other, 'sales_rep');
    const foreignAssignee = await manager.client.post(`/customers/${c.id}/assign`, { assignedUserId: outsider.userId });
    expect(foreignAssignee.status).toBe(422);
  });

  it('optimistic locking, soft deactivation and the interaction timeline', async () => {
    const c = await createCustomer(t.owner);
    const ok = await t.owner.patch(`/customers/${c.id}`, { version: c.version, city: 'Riyadh' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(c.version + 1);
    const stale = await t.owner.patch(`/customers/${c.id}`, { version: c.version, city: 'Jeddah' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    // A PATCH that omits fields leaves them untouched (patchOf).
    expect(ok.body.phone).toBe(c.phone);

    const call = await repA.client.post('/interactions', { customerId: c.id, type: 'call', direction: 'outbound', summary: 'Asked about Camry 2022' });
    expect(call.status).toBe(404); // not repA's customer
    const logged = await t.owner.post('/interactions', { customerId: c.id, type: 'call', direction: 'outbound', summary: 'Asked about Camry 2022' });
    expect(logged.status, JSON.stringify(logged.body)).toBe(201);
    const future = await t.owner.post('/interactions', { customerId: c.id, type: 'note', summary: 'Later', occurredAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.status).toBe(422);
    const timeline = await t.owner.get(`/customers/${c.id}/interactions`);
    expect(timeline.body.items).toHaveLength(1);
    expect(timeline.body.items[0]).toMatchObject({ type: 'call', summary: 'Asked about Camry 2022' });

    const off = await t.owner.post(`/customers/${c.id}/deactivate`, { reason: 'Moved abroad', version: ok.body.version });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.isActive).toBe(false);
    expect((await pool.query(`SELECT count(*)::int AS n FROM customers WHERE id = $1`, [c.id])).rows[0].n).toBe(1);
  });

  it("another company's customers are invisible (404) and cannot be referenced", async () => {
    const c = await createCustomer(t.owner);
    expect((await other.owner.get(`/customers/${c.id}`)).status).toBe(404);
    expect((await other.owner.patch(`/customers/${c.id}`, { version: 1, city: 'X' })).status).toBe(404);
    expect((await other.owner.post('/interactions', { customerId: c.id, type: 'note', summary: 'probe' })).status).toBe(404);
  });
});
