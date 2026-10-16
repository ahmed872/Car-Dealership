import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costCategory, createAcquisition, createCashAccount, createSupplier } from './fixtures';
import { closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

/** GL balance (debit − credit) for one account, optionally filtered by a dimension column. */
async function gl(pool: Pool, tenantId: string, account: string, dim?: { col: string; id: string }) {
  const r = await pool.query(
    `SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines WHERE tenant_id = $1 AND account_code = $2 ${dim ? `AND ${dim.col} = $3` : ''}`,
    dim ? [tenantId, account, dim.id] : [tenantId, account],
  );
  return r.rows[0].b as string;
}

describe('purchasing core money flow', () => {
  let app: INestApplication;
  let t: TestTenant;
  let pool: Pool;

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    pool = ownerPool();
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('purchase → partial payment → extra cost → void → cancel keeps cash book and GL consistent', async () => {
    const c = t.owner;
    const supplier = await createSupplier(c);
    const cash = await createCashAccount(c, { openingBalance: '100000.00' });
    expect(cash.balance).toBe('100000.00');
    expect(await gl(pool, t.tenantId, '3000')).toBe('-100000.00');

    const acq = await createAcquisition(c, t.branchId, supplier.id, { price: '80000.00' });
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('80000.00');
    expect(await gl(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).toBe('-80000.00');

    // Pay 50,000 now.
    const pay = await c.post(
      '/supplier-payments',
      { supplierId: supplier.id, cashAccountId: cash.id, paidAt: '2026-01-16', method: 'cash', amount: '50000.00', allocations: [{ targetType: 'acquisition', targetId: acq.id, amountBase: '50000.00' }] },
      idem(),
    );
    expect(pay.status).toBe(201);
    expect(pay.body.number).toMatch(/^SPY-/);
    let detail = await c.get(`/acquisitions/${acq.id}`);
    expect(detail.body.outstandingBase).toBe('30000.00');

    // Overpayment is refused.
    const over = await c.post(
      '/supplier-payments',
      { supplierId: supplier.id, cashAccountId: cash.id, paidAt: '2026-01-16', method: 'cash', amount: '40000.00', allocations: [{ targetType: 'acquisition', targetId: acq.id, amountBase: '40000.00' }] },
      idem(),
    );
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('overpayment');

    // Transport cost paid immediately from the cash box.
    const transport = await costCategory(c, 'transport');
    const cost = await c.post(
      '/vehicle-costs',
      { vehicleId: acq.vehicleId, categoryId: transport, description: 'Transport from Jeddah', amount: '1500.00', currency: 'SAR', costDate: '2026-01-17', payNow: { cashAccountId: cash.id, method: 'cash' } },
      idem(),
    );
    expect(cost.status).toBe(201);
    expect(cost.body.status).toBe('posted');
    const summary = await c.get(`/vehicles/${acq.vehicleId}/costs`);
    expect(summary.body.totals).toMatchObject({ posted: '81500.00', purchase: '80000.00', additional: '1500.00' });
    const acct = await c.get(`/cash-accounts/${cash.id}`);
    expect(acct.body.balance).toBe('48500.00');
    expect(await gl(pool, t.tenantId, '1100', { col: 'cash_account_id', id: cash.id })).toBe('48500.00');

    // Cancelling is blocked while payments exist.
    const blocked = await c.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Seller withdrew' }, idem());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('acquisition_has_payments');

    // Void the payment, then cancel: purchase reversed, transport written off, vehicle removed.
    const v = await c.post(`/supplier-payments/${pay.body.id}/void`, { reason: 'Deal cancelled' }, idem());
    expect(v.status).toBe(200);
    const cancel = await c.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Seller withdrew' }, idem());
    expect(cancel.status).toBe(200);
    detail = await c.get(`/acquisitions/${acq.id}`);
    expect(detail.body.status).toBe('cancelled');
    expect(detail.body.vehicle.status).toBe('removed');
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
    expect(await gl(pool, t.tenantId, '6300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('1500.00');
    expect(await gl(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).toBe('0.00');
    expect((await c.get(`/cash-accounts/${cash.id}`)).body.balance).toBe('98500.00');

    // Whole tenant ledger balances and the cash book reconciles to GL 1100.
    const tb = await pool.query(`SELECT sum(debit) AS dr, sum(credit) AS cr FROM journal_lines WHERE tenant_id = $1`, [t.tenantId]);
    expect(tb.rows[0].dr).toBe(tb.rows[0].cr);
    const book = await pool.query(
      `SELECT coalesce(sum(CASE WHEN direction='in' THEN amount_base ELSE -amount_base END),0)::numeric(18,2)::text AS b FROM cash_transactions WHERE tenant_id = $1`,
      [t.tenantId],
    );
    expect(book.rows[0].b).toBe(await gl(pool, t.tenantId, '1100'));
  });
});
