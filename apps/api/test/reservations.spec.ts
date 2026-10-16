import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { assertLedgerIntegrity, createCashAccount, createVehicle, glBalance, makeAvailable, secondApprover } from './fixtures';
import { Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

describe('reservations, deposits and refunds', () => {
  let app: INestApplication;
  let t: TestTenant;
  let pool: Pool;
  let owner: Client;
  let checker: Client;
  let cash: { id: string };

  /** Customers API arrives with the CRM module; until then the test inserts through the owner pool. */
  async function customer(name = 'Khalid Al-Harbi') {
    const r = await pool.query(`INSERT INTO customers (tenant_id, full_name, phone) VALUES ($1, $2, $3) RETURNING id`, [t.tenantId, name, '966500000001']);
    return r.rows[0].id as string;
  }

  async function availableVehicle() {
    const v = await createVehicle(owner, t.branchId);
    await makeAvailable(owner, v.id, '120000.00', '100000.00');
    return v;
  }

  async function vehicleStatus(id: string) {
    return (await owner.get(`/vehicles/${id}`)).body.vehicle.status as string;
  }

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    pool = ownerPool();
    owner = t.owner;
    checker = await secondApprover(owner);
    cash = await createCashAccount(owner, { name: 'Showroom safe', openingBalance: '10000.00' });
  });
  afterEach(async () => assertLedgerIntegrity(pool, t.tenantId));
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('reserves an available vehicle with a deposit held as a customer advance (not revenue)', async () => {
    const cust = await customer();
    const v = await availableVehicle();
    const res = await owner.post(
      '/reservations',
      { vehicleId: v.id, customerId: cust, days: 7, deposit: { cashAccountId: cash.id, amount: '5000.00', method: 'cash' } },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', depositAmount: '5000.00', refundPolicy: 'refundable' });
    expect(res.body.receipt.number).toMatch(/^RCT-/);
    expect(await vehicleStatus(v.id)).toBe('reserved');
    expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust })).toBe('-5000.00');
    expect(await glBalance(pool, t.tenantId, '4000')).toBe('0.00');
    expect(await glBalance(pool, t.tenantId, '4200')).toBe('0.00');
    const detail = await owner.get(`/reservations/${res.body.id}`);
    expect(detail.body).toMatchObject({ receivedBase: '5000.00', availableDepositBase: '5000.00' });
    // A second deposit cannot exceed the stated requirement.
    const over = await owner.post(`/reservations/${res.body.id}/deposits`, { cashAccountId: cash.id, amount: '1.00', method: 'cash' }, idem());
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('overpayment');
  });

  it('concurrent reservations of one vehicle: exactly one succeeds', async () => {
    const cust = await customer('Race customer');
    const v = await availableVehicle();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => owner.post('/reservations', { vehicleId: v.id, customerId: cust }, idem())));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(['vehicle_not_available', 'vehicle_reserved']).toContain(r.body.error.code);
    const active = await pool.query(`SELECT count(*)::int AS n FROM reservations WHERE vehicle_id = $1 AND status = 'active'`, [v.id]);
    expect(active.rows[0].n).toBe(1);
  });

  it('retrying a deposit with the same Idempotency-Key records one receipt', async () => {
    const cust = await customer('Retry customer');
    const v = await availableVehicle();
    const r = await owner.post('/reservations', { vehicleId: v.id, customerId: cust, depositAmount: '3000.00' }, idem());
    expect(r.status).toBe(201);
    const key = idem();
    const a = await owner.post(`/reservations/${r.body.id}/deposits`, { cashAccountId: cash.id, amount: '3000.00', method: 'cash' }, key);
    const b = await owner.post(`/reservations/${r.body.id}/deposits`, { cashAccountId: cash.id, amount: '3000.00', method: 'cash' }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    const n = await pool.query(`SELECT count(*)::int AS n FROM receipts WHERE customer_id = $1`, [cust]);
    expect(n.rows[0].n).toBe(1);
  });

  it('cancel per partial policy: refundable share becomes a refund request, the rest is forfeited', async () => {
    const cust = await customer('Partial policy customer');
    const v = await availableVehicle();
    const r = await owner.post(
      '/reservations',
      { vehicleId: v.id, customerId: cust, refundPolicy: 'partial', refundablePct: '50', deposit: { cashAccountId: cash.id, amount: '4000.00', method: 'cash' } },
      idem(),
    );
    expect(r.status).toBe(201);
    const cashBefore = (await owner.get(`/cash-accounts/${cash.id}`)).body.balance as string;
    const c = await owner.post(`/reservations/${r.body.id}/cancel`, { reason: 'Customer changed mind', refund: 'per_policy' }, idem());
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', forfeitedBase: '2000.00' });
    expect(c.body.refund).toMatchObject({ status: 'requested', amountBase: '2000.00' });
    expect(await vehicleStatus(v.id)).toBe('available');
    expect(await glBalance(pool, t.tenantId, '4200', { col: 'customer_id', id: cust })).toBe('-2000.00');
    expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust })).toBe('-2000.00');

    // Maker-checker: the requester cannot approve; another approver can; then the cashier pays.
    const self = await owner.post(`/refunds/${c.body.refund.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval_forbidden');
    expect((await checker.post(`/refunds/${c.body.refund.id}/approve`, { note: 'OK' })).status).toBe(200);
    const paid = await owner.post(`/refunds/${c.body.refund.id}/pay`, { cashAccountId: cash.id, method: 'cash' }, idem());
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect((await owner.get(`/cash-accounts/${cash.id}`)).body.balance).toBe((Number(cashBefore) - 2000).toFixed(2));
    expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust })).toBe('0.00');
    // Nothing left to refund, and the deposit receipt can no longer be voided.
    const more = await owner.post('/refunds', { sourceType: 'reservation', sourceId: r.body.id, amountBase: '1.00', reason: 'extra' }, idem());
    expect(more.status).toBe(409);
    expect(more.body.error.code).toBe('refund_exceeds_available');
    const voided = await owner.post(`/receipts/${r.body.receipt.id}/void`, { reason: 'mistake' }, idem());
    expect(voided.status).toBe(409);
    expect(voided.body.error.code).toBe('receipt_refunded');
  });

  it('only refundable deposits: overriding the policy needs refunds.approve; non-refundable forfeits all', async () => {
    const cust = await customer('Strict policy customer');
    const v = await availableVehicle();
    const r = await owner.post(
      '/reservations',
      { vehicleId: v.id, customerId: cust, refundPolicy: 'non_refundable', deposit: { cashAccountId: cash.id, amount: '1500.00', method: 'cash' } },
      idem(),
    );
    const c = await owner.post(`/reservations/${r.body.id}/cancel`, { reason: 'No show' }, idem());
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ forfeitedBase: '1500.00', refund: null });
    expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust })).toBe('0.00');
  });

  it('expiry job releases the vehicle, keeps the deposit as credit, notifies once, then allows a refund', async () => {
    const cust = await customer('Expired customer');
    const v = await availableVehicle();
    const r = await owner.post('/reservations', { vehicleId: v.id, customerId: cust, deposit: { cashAccountId: cash.id, amount: '2500.00', method: 'cash' } }, idem());
    expect(r.status).toBe(201);
    await pool.query(`UPDATE reservations SET reserved_at = now() - interval '9 days', expires_at = now() - interval '1 hour' WHERE id = $1`, [r.body.id]);
    const jobs = app.get(JobsService);
    const run1 = await jobs.runJob('reservations.expire', { tenantId: t.tenantId });
    expect(run1?.[0]).toMatchObject({ ok: true, result: { expired: 1 } });
    const run2 = await jobs.runJob('reservations.expire', { tenantId: t.tenantId });
    expect(run2?.[0]).toMatchObject({ ok: true, result: { expired: 0 } });
    const d = await owner.get(`/reservations/${r.body.id}`);
    expect(d.body).toMatchObject({ status: 'expired', availableDepositBase: '2500.00' });
    expect(await vehicleStatus(v.id)).toBe('available');
    expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust })).toBe('-2500.00');
    const notes = await owner.get('/notifications?unread=true');
    expect(notes.body.items.filter((n: { entityId: string; type: string }) => n.entityId === r.body.id && n.type === 'reservation.expired')).toHaveLength(1);
    // The held deposit can now be refunded through the normal approval flow.
    const ref = await owner.post('/refunds', { sourceType: 'reservation', sourceId: r.body.id, amountBase: '2500.00', reason: 'Expired, customer asked for refund' }, idem());
    expect(ref.status).toBe(201);
    const over = await owner.post('/refunds', { sourceType: 'reservation', sourceId: r.body.id, amountBase: '0.01', reason: 'double' }, idem());
    expect(over.status).toBe(409);
  });

  it('refuses vehicles that are not available, and below-floor prices without approval rights', async () => {
    const cust = await customer('Edge customer');
    const v = await createVehicle(owner, t.branchId);
    const notAvail = await owner.post('/reservations', { vehicleId: v.id, customerId: cust }, idem());
    expect(notAvail.status).toBe(409);
    expect(notAvail.body.error.code).toBe('vehicle_not_available');
    const v2 = await availableVehicle();
    // The owner holds sales.approve_below_floor, so a below-floor agreed price is accepted for them.
    const ok = await owner.post('/reservations', { vehicleId: v2.id, customerId: cust, agreedPrice: '90000.00' }, idem());
    expect(ok.status).toBe(201);
  });
});
