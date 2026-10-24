import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalogIds,
  createAcquisition,
  createCashAccount,
  createCustomer,
  createSupplier,
  idOf,
  JPEG,
  listRoutes,
  makeAvailable,
  secondApprover,
  sellVehicle,
} from './fixtures';
import { closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

/**
 * Tenant isolation sweep (Phase 8): every `GET` route that takes one record id is called by the
 * owner of company B with a real id from company A. The answer must be a refusal (403/404) — never
 * the record, never a server error. Routes whose table has no seeded row are called with a random
 * id instead and listed, so the sweep's coverage is visible rather than silently assumed.
 */
const TABLE_BY_ROUTE: Array<[RegExp, string]> = [
  [/^\/api\/v1\/acquisitions\/:id$/, 'acquisitions'],
  [/^\/api\/v1\/appointments\/:id$/, 'appointments'],
  [/^\/api\/v1\/cash-accounts\/:id(\/.*)?$/, 'cash_accounts'],
  [/^\/api\/v1\/cash\/accounts\/:id\/book$/, 'cash_accounts'],
  [/^\/api\/v1\/cash\/transfers\/:transferId$/, "cash_transactions.source_id where source_type = 'cash_transfer'"],
  [/^\/api\/v1\/commissions\/:id$/, 'commissions'],
  [/^\/api\/v1\/customers\/:id(\/.*)?$/, 'customers'],
  [/^\/api\/v1\/employees\/:userId$/, 'memberships.user_id'],
  [/^\/api\/v1\/expenses\/:id$/, 'expenses'],
  [/^\/api\/v1\/files\/:id$/, 'files'],
  [/^\/api\/v1\/inspections\/:id$/, 'vehicle_inspections'],
  [/^\/api\/v1\/installment-plans\/:id(\/.*)?$/, 'installment_plans'],
  [/^\/api\/v1\/inventory\/stock-counts\/:id$/, 'stock_counts'],
  [/^\/api\/v1\/leads\/:id$/, 'leads'],
  [/^\/api\/v1\/ledger\/entries\/:id$/, 'journal_entries'],
  [/^\/api\/v1\/receipts\/:id$/, 'receipts'],
  [/^\/api\/v1\/refunds\/:id$/, 'refunds'],
  [/^\/api\/v1\/reservations\/:id$/, 'reservations'],
  [/^\/api\/v1\/sale-documents\/:id\/pdf$/, 'sale_documents'],
  [/^\/api\/v1\/sales\/:id$/, 'sales'],
  [/^\/api\/v1\/supplier-payments\/:id$/, 'supplier_payments'],
  [/^\/api\/v1\/suppliers\/:id(\/.*)?$/, 'suppliers'],
  [/^\/api\/v1\/vehicle-costs\/:id$/, 'vehicle_costs'],
  [/^\/api\/v1\/vehicles\/:id\/listing\/qr$/, 'vehicle_listings.vehicle_id'],
  [/^\/api\/v1\/vehicles\/:id(\/.*)?$/, 'vehicles'],
  [/^\/api\/v1\/wishes\/:id$/, 'customer_wishes'],
  [/^\/api\/v1\/wishes\/for-vehicle\/:vehicleId$/, 'vehicles'],
  [/^\/api\/v1\/work-orders\/:id$/, 'work_orders'],
];
/** Single-parameter routes whose parameter is not a company record. */
const NOT_A_RECORD = [/\/vin-decode\/:vin$/, /\/ledger\/accounts\/:code\//, /\/reports\/:key\//, /^\/api\/v1\/public\//];

describe('tenant isolation sweep', () => {
  let app: INestApplication;
  let pool: Pool;
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    app = await getApp();
    pool = ownerPool();
    const admin = await createPlatformAdmin(app);
    a = await createTenant(app, admin);
    b = await createTenant(app, admin);
    // Company A gets one of most documents, all through the API.
    const owner = a.owner;
    const checker = await secondApprover(owner);
    const supplier = await createSupplier(owner);
    const cash = await createCashAccount(owner, { name: 'Safe A', openingBalance: '500000.00' });
    const till = await createCashAccount(owner, { name: 'Till A' });
    expect((await owner.post('/cash/transfers', { fromAccountId: cash.id, toAccountId: till.id, amount: '1000.00', date: '2026-02-01' }, idem())).status).toBe(201);
    const sold = await createAcquisition(owner, a.branchId, supplier.id, { price: '60000.00', approver: checker });
    await makeAvailable(owner, sold.vehicleId, '95000.00', '88000.00');
    const stock = await createAcquisition(owner, a.branchId, supplier.id, { price: '50000.00', approver: checker });
    await makeAvailable(owner, stock.vehicleId, '80000.00', '75000.00');
    const customer = await createCustomer(owner, { fullName: 'Isolation customer' });
    await sellVehicle(owner, { vehicleId: sold.vehicleId, customerId: customer.id, cashAccountId: cash.id, agreedPrice: '95000.00' });
    expect((await owner.post('/leads', { customerId: customer.id, branchId: a.branchId, source: 'walk_in', vehicleId: stock.vehicleId })).status).toBe(201);
    const reservation = await owner.post(
      '/reservations',
      { vehicleId: stock.vehicleId, customerId: customer.id, deposit: { cashAccountId: cash.id, amount: '5000.00', method: 'cash' } },
      idem(),
    );
    expect(reservation.status).toBe(201);
    // Cancelling a refundable reservation turns its deposit into a refund request.
    expect((await owner.post(`/reservations/${reservation.body.id}/cancel`, { reason: 'Isolation check', refund: 'per_policy' }, idem())).status).toBe(200);
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    expect((await owner.post('/appointments', { type: 'visit', branchId: a.branchId, customerId: customer.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() })).status).toBe(201);
    expect((await owner.post('/inventory/stock-counts', { branchId: a.branchId })).status).toBe(201);
    const rent = ((await owner.get('/expense-categories')).body as Array<{ id: string; code: string }>).find((x) => x.code === 'rent')!.id;
    const expense = { branchId: a.branchId, categoryId: rent, description: 'Rent', amount: '1200.00', currency: 'SAR', expenseDate: '2026-01-31' };
    expect((await owner.post('/expenses', expense, idem())).status).toBe(201);
    const payment = {
      supplierId: supplier.id,
      cashAccountId: cash.id,
      paidAt: '2026-04-01',
      method: 'cash',
      amount: '1000.00',
      allocations: [{ targetType: 'acquisition', targetId: stock.id, amountBase: '1000.00' }],
    };
    expect((await owner.post('/supplier-payments', payment, idem())).status).toBe(201);
    expect((await owner.post('/work-orders', { vehicleId: stock.vehicleId, type: 'repair', title: 'Isolation check' })).status).toBe(201);
    const { makeId } = await catalogIds(owner);
    expect((await owner.post('/wishes', { customerId: customer.id, makeId })).status).toBe(201);
    expect((await owner.put(`/vehicles/${stock.vehicleId}/listing`, { titleEn: 'Isolation', titleAr: 'عزل' })).status).toBe(200);
    expect((await owner.upload(`/vehicles/${stock.vehicleId}/media`, { buffer: JPEG, name: 'a.jpg' })).status).toBe(201);
  }, 300_000);
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('company B never gets company A records from any single-record GET route', async () => {
    const routes = listRoutes(app).filter((r) => r.method === 'GET' && (r.path.match(/:/g) ?? []).length === 1 && !NOT_A_RECORD.some((re) => re.test(r.path)));
    expect(routes.length).toBeGreaterThan(30);
    const leaks: string[] = [];
    const unmapped: string[] = [];
    const notSeeded: string[] = [];
    const ownerMiss: string[] = [];
    for (const r of routes) {
      const table = TABLE_BY_ROUTE.find(([re]) => re.test(r.path))?.[1];
      if (!table) unmapped.push(r.path);
      const id = table ? await idOf(pool, a.tenantId, table) : null;
      if (table && !id) notSeeded.push(r.path);
      const url = r.path.replace(/^\/api\/v1/, '').replace(/:[A-Za-z]+/, id ?? randomUUID());
      const res = await b.owner.get(url);
      if (![403, 404].includes(res.status)) leaks.push(`${r.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      if (id) {
        const own = await a.owner.get(url);
        if (own.status !== 200) ownerMiss.push(`${r.path} → ${own.status} ${JSON.stringify(own.body).slice(0, 120)}`);
      }
    }
    expect(unmapped).toEqual([]);
    expect(leaks).toEqual([]);
    // Installment plans and commissions need company settings and a commission policy; their
    // cross-company refusal is covered with real records in sales.spec.ts.
    expect(notSeeded).toEqual(['/api/v1/commissions/:id', '/api/v1/installment-plans/:id', '/api/v1/installment-plans/:id/settlement-quote']);
    // The sweep is only meaningful if A's own owner can read the records B was refused.
    expect(ownerMiss).toEqual([]);
  }, 300_000);
});
