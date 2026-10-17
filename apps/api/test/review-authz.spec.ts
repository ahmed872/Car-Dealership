import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES, SystemRoleKey } from '@autohub/shared';
import {
  addMemberWithPermissions,
  assertLedgerIntegrity,
  catalogIds,
  costCategory,
  createAcquisition,
  createBranch,
  createCashAccount,
  createSupplier,
  createVehicle,
  secondApprover,
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ORIGIN, ownerPool, TestTenant, uniq } from './helpers';

/**
 * Adversarial review of authorization, tenant isolation, branch scope and data exposure for every
 * Phase 3 route (suppliers, payables, acquisitions, vehicle costs, cost categories, supplier
 * payments, cash accounts, cash transfers / cash book, ledger, expenses, work orders, approvals).
 */

// ── Route table ─────────────────────────────────────────────────────────────────────────────
// `perms`: the permissions the route requires (all of them). `null`: any signed-in member.
// `'payables'`: supplier_payments.create OR (suppliers.read AND payments.read) (checked inside the handler).
type Perms = string[] | null | 'payables';
interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  perms: Perms;
}
const r = (method: Route['method'], path: string, perms: Perms): Route => ({ method, path, perms });

const ROUTES: Route[] = [
  r('GET', '/suppliers', ['suppliers.read']),
  r('GET', '/suppliers/check-duplicates', ['suppliers.read']),
  r('POST', '/suppliers', ['suppliers.manage']),
  r('GET', '/suppliers/:id', ['suppliers.read']),
  r('GET', '/suppliers/:id/statement', ['suppliers.read', 'payments.read']),
  r('PATCH', '/suppliers/:id', ['suppliers.manage']),
  r('GET', '/payables/open', 'payables'),
  r('GET', '/payables/summary', ['suppliers.read', 'payments.read']),
  r('GET', '/acquisitions', ['acquisitions.read']),
  r('POST', '/acquisitions', ['acquisitions.create']),
  r('GET', '/acquisitions/:id', ['acquisitions.read']),
  r('PATCH', '/acquisitions/:id', ['acquisitions.create']),
  r('POST', '/acquisitions/:id/submit', ['acquisitions.create']),
  r('POST', '/acquisitions/:id/approve', ['acquisitions.approve']),
  r('POST', '/acquisitions/:id/reject', ['acquisitions.approve']),
  r('POST', '/acquisitions/:id/cancel', ['acquisitions.cancel']),
  r('PUT', '/acquisitions/:id/ownership', ['acquisitions.create']),
  r('GET', '/cost-categories', null),
  r('GET', '/vehicles/:id/costs', ['costs.read']),
  r('POST', '/vehicle-costs', ['costs.create']),
  r('POST', '/vehicle-costs/allocate', ['costs.create']),
  r('GET', '/vehicle-costs/pending', ['costs.approve']),
  r('GET', '/vehicle-costs/:id', ['costs.read']),
  r('POST', '/vehicle-costs/:id/approve', ['costs.approve']),
  r('POST', '/vehicle-costs/:id/reject', ['costs.approve']),
  r('POST', '/vehicle-costs/:id/reverse', ['costs.reverse']),
  r('GET', '/supplier-payments', ['suppliers.read', 'payments.read']),
  r('POST', '/supplier-payments', ['supplier_payments.create']),
  r('GET', '/supplier-payments/:id', ['suppliers.read', 'payments.read']),
  r('POST', '/supplier-payments/:id/void', ['payments.void']),
  r('GET', '/approvals', null),
  r('GET', '/approvals/summary', null),
  r('GET', '/cash-accounts', ['cash.read']),
  r('GET', '/cash-accounts/options', null),
  r('POST', '/cash-accounts', ['cash.manage_accounts']),
  r('GET', '/cash-accounts/:id', ['cash.read']),
  r('PATCH', '/cash-accounts/:id', ['cash.manage_accounts']),
  r('GET', '/cash/transfers', ['cash.read']),
  r('POST', '/cash/transfers', ['cash.transfer']),
  r('GET', '/cash/transfers/:transferId', ['cash.read']),
  r('POST', '/cash/transfers/:transferId/reverse', ['cash.transfer', 'payments.void']),
  r('GET', '/cash/accounts/:id/book', ['cash.read']),
  r('GET', '/ledger/accounts', ['ledger.read']),
  r('GET', '/ledger/accounts/:code/statement', ['ledger.read']),
  r('GET', '/ledger/trial-balance', ['ledger.read']),
  r('GET', '/ledger/entries', ['ledger.read']),
  r('GET', '/ledger/entries/:id', ['ledger.read']),
  r('GET', '/ledger/income-statement', ['ledger.read']),
  r('GET', '/ledger/balance-sheet', ['ledger.read']),
  r('GET', '/ledger/reconciliation', ['ledger.read']),
  r('GET', '/expense-categories', null),
  r('GET', '/expenses', ['expenses.read']),
  r('GET', '/expenses/summary', ['expenses.read']),
  r('GET', '/expenses/:id', ['expenses.read']),
  r('POST', '/expenses', ['expenses.create']),
  r('POST', '/expenses/:id/approve', ['expenses.approve']),
  r('POST', '/expenses/:id/reject', ['expenses.approve']),
  r('POST', '/expenses/:id/reverse', ['expenses.approve']),
  r('GET', '/work-orders', ['work_orders.read']),
  r('POST', '/work-orders', ['work_orders.manage']),
  r('GET', '/vehicles/:id/work-orders', ['work_orders.read']),
  r('GET', '/work-orders/:id', ['work_orders.read']),
  r('PATCH', '/work-orders/:id', ['work_orders.manage']),
  r('POST', '/work-orders/:id/items', ['work_orders.manage']),
  r('PATCH', '/work-orders/:id/items/:itemId', ['work_orders.manage']),
  r('DELETE', '/work-orders/:id/items/:itemId', ['work_orders.manage']),
  r('POST', '/work-orders/:id/start', ['work_orders.manage']),
  r('POST', '/work-orders/:id/complete', ['work_orders.manage']),
  r('POST', '/work-orders/:id/approve', ['work_orders.approve']),
  r('POST', '/work-orders/:id/reject', ['work_orders.approve']),
  r('POST', '/work-orders/:id/cancel', ['work_orders.manage']),
];

const PHASE3_CONTROLLERS = new Set([
  'SuppliersController',
  'PayablesController',
  'AcquisitionsController',
  'CostsController',
  'SupplierPaymentsController',
  'ApprovalsController',
  'CashAccountsController',
  'CashTransfersController',
  'CashBookController',
  'LedgerController',
  'ExpensesController',
  'WorkOrdersController',
]);

/** Every (method, path) declared by the Phase 3 controllers, read from Nest's route metadata. */
function discoverRoutes(app: INestApplication): string[] {
  const out: string[] = [];
  const trim = (s: string | undefined) => (s ?? '').replace(/^\/+|\/+$/g, '');
  for (const mod of app.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...args: unknown[]) => unknown) | null;
      if (!ctrl || !PHASE3_CONTROLLERS.has(ctrl.name)) continue;
      const base = trim(Reflect.getMetadata(PATH_METADATA, ctrl) as string);
      const proto = ctrl.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const fn = proto[name] as object;
        const path = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
        if (path === undefined || method === undefined) continue;
        out.push(`${RequestMethod[method]} /${[base, trim(path)].filter(Boolean).join('/')}`);
      }
    }
  }
  return out;
}

const RANDOM_ID = '00000000-0000-4000-8000-00000000abcd';
const concrete = (path: string) => path.replace(/:(id|itemId|transferId)/g, RANDOM_ID).replace(':code', '1100');

function call(c: Client, route: Route, body: unknown = {}) {
  const path = concrete(route.path);
  switch (route.method) {
    case 'GET':
      return c.get(path);
    case 'POST':
      return c.post(path, body);
    case 'PATCH':
      return c.patch(path, body);
    case 'PUT':
      return c.put(path, body);
    case 'DELETE':
      return c.delete(path);
  }
}

type Item = { entityId: string; canDecide: boolean; branchId: string | null; type: string };

describe('review: authorization, isolation, branch scope and data exposure (Phase 3)', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let o: TestTenant;
  let owner: Client;
  let checker: Client;
  let b2: { id: string };
  let supplier: { id: string; name: string };
  let companyBank: { id: string };
  let mainBox: { id: string };
  let b2Box: { id: string };
  let cats: { transport: string; parts: string; rent: string };
  let clerk: Client;

  const cost = (vehicleId: string, extra: Record<string, unknown> = {}) => ({
    vehicleId,
    categoryId: cats.transport,
    description: 'Transport to showroom',
    amount: '500.00',
    currency: 'SAR',
    costDate: '2026-02-01',
    supplierId: supplier.id,
    ...extra,
  });
  const expense = (branchId: string, extra: Record<string, unknown> = {}) => ({
    branchId,
    categoryId: cats.rent,
    description: 'Showroom rent',
    amount: '1000.00',
    currency: 'SAR',
    expenseDate: '2026-02-01',
    supplierId: supplier.id,
    ...extra,
  });
  const item = (extra: Record<string, unknown> = {}) => ({ kind: 'part', description: 'Brake pads', quantity: '1', unitCost: '400.00', categoryId: cats.parts, ...extra });

  /** A work order on `vehicleId` with one item, started and completed (awaiting approval). */
  async function workOrderAwaiting(c: Client, vehicleId: string, unitCost = '400.00') {
    const wo = await c.post('/work-orders', { vehicleId, type: 'repair', title: 'Brake service' });
    expect(wo.status, JSON.stringify(wo.body)).toBe(201);
    const it1 = await c.post(`/work-orders/${wo.body.id}/items`, item({ unitCost }));
    expect(it1.status, JSON.stringify(it1.body)).toBe(201);
    expect((await c.post(`/work-orders/${wo.body.id}/start`)).status).toBe(200);
    const done = await c.post(`/work-orders/${wo.body.id}/complete`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { id: wo.body.id as string, itemId: it1.body.id as string };
  }

  async function pay(c: Client, cashAccountId: string, allocations: Array<{ targetType: string; targetId: string; amountBase: string }>, extra: Record<string, unknown> = {}) {
    const amount = allocations.reduce((s, a) => s + Number(a.amountBase), 0).toFixed(2);
    return c.post('/supplier-payments', { supplierId: supplier.id, cashAccountId, paidAt: '2026-03-01', method: 'bank_transfer', amount, allocations, ...extra }, idem());
  }

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    o = await createTenant(app, admin);
    pool = ownerPool();
    owner = t.owner;
    checker = await secondApprover(owner);
    b2 = await createBranch(owner, 'Khobar');
    supplier = await createSupplier(owner, { taxNumber: '300012345600003', nationalId: '1012345678' });
    companyBank = await createCashAccount(owner, { type: 'bank', name: `Company bank ${uniq()}`, openingBalance: '500000.00' });
    mainBox = await createCashAccount(owner, { name: `Main box ${uniq()}`, branchId: t.branchId, openingBalance: '50000.00' });
    b2Box = await createCashAccount(owner, { name: `Khobar box ${uniq()}`, branchId: b2.id, openingBalance: '50000.00' });
    const expenseCats = (await owner.get('/expense-categories')).body as Array<{ id: string; code: string }>;
    cats = { transport: await costCategory(owner, 'transport'), parts: await costCategory(owner, 'parts'), rent: expenseCats.find((c) => c.code === 'rent')!.id };
    clerk = (await addMemberWithPermissions(app, t, ['vehicles.read', 'costs.read', 'costs.create', 'expenses.read', 'expenses.create'])).client;
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  // ── (a) permissions ───────────────────────────────────────────────────────────────────────
  describe('(a) permission decorators', () => {
    it('the route table covers exactly the routes the Phase 3 controllers declare', () => {
      const discovered = discoverRoutes(app).sort();
      expect(discovered.length).toBeGreaterThan(60);
      expect(discovered).toEqual(ROUTES.map((x) => `${x.method} ${x.path}`).sort());
    });

    it('a member without any Phase 3 permission gets 403 naming exactly the missing permissions; open routes stay open', async () => {
      const nobody = (await addMemberWithPermissions(app, t, ['dashboard.view'])).client;
      for (const route of ROUTES) {
        const res = await call(nobody, route);
        const label = `${route.method} ${route.path}`;
        if (route.perms === null) {
          expect(res.status, label).toBe(200);
        } else if (route.perms === 'payables') {
          expect([res.status, res.body.error?.code], label).toEqual([403, 'forbidden']);
        } else {
          expect(res.status, label).toBe(403);
          expect(res.body.error.code, label).toBe('forbidden');
          expect([...res.body.error.details.missing].sort(), label).toEqual([...route.perms].sort());
        }
      }
      // Open routes return nothing they should not: no inbox items, no balances in the picker.
      expect((await nobody.get('/approvals')).body).toEqual([]);
      expect((await nobody.get('/approvals/summary')).body.total).toBe(0);
      const opts = (await nobody.get('/cash-accounts/options')).body as Array<Record<string, unknown>>;
      for (const a of opts) expect(Object.keys(a).sort()).toEqual(['branchId', 'currency', 'id', 'name', 'type']);
    });

    it('every system role is admitted or refused by the guard exactly as its role template says, and nothing answers 5xx', async () => {
      const keys = Object.keys(SYSTEM_ROLES) as SystemRoleKey[];
      const clients: Record<string, Client> = { owner };
      for (const k of keys) if (k !== 'owner') clients[k] = (await addMember(app, t, k)).client;
      for (const k of keys) {
        const perms = new Set<string>(SYSTEM_ROLES[k].permissions);
        for (const route of ROUTES) {
          const res = await call(clients[k]!, route);
          const label = `${k}: ${route.method} ${route.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`;
          expect(res.status, label).toBeLessThan(500);
          const guardDenied = res.status === 403 && Array.isArray(res.body?.error?.details?.missing);
          if (route.perms === null) expect(res.status, label).toBe(200);
          else if (route.perms === 'payables') {
            const allowed = perms.has('supplier_payments.create') || (perms.has('suppliers.read') && perms.has('payments.read'));
            expect(res.status === 403, label).toBe(!allowed);
          } else {
            const missing = route.perms.filter((p) => !perms.has(p));
            expect(guardDenied, label).toBe(missing.length > 0);
            if (missing.length) expect([...res.body.error.details.missing].sort(), label).toEqual(missing.sort());
          }
        }
      }
    });

    it('anonymous requests are refused on every route (401, or 403 from the CSRF check on mutations)', async () => {
      for (const route of ROUTES) {
        const path = `/api/v1${concrete(route.path)}`;
        const agent = request(app.getHttpServer());
        const req =
          route.method === 'GET'
            ? agent.get(path)
            : route.method === 'POST'
              ? agent.post(path)
              : route.method === 'PATCH'
                ? agent.patch(path)
                : route.method === 'PUT'
                  ? agent.put(path)
                  : agent.delete(path);
        const res = await req.set('Origin', ORIGIN).send({});
        if (route.method === 'GET') expect(res.status, route.path).toBe(401);
        else expect([401, 403], `${route.method} ${route.path}`).toContain(res.status);
      }
    });
  });

  // ── (b) tenant isolation ────────────────────────────────────────────────────────────────
  describe('(b) another company', () => {
    it("gets 404 (never 403, never data) for every id route of ours and every reference to our records", async () => {
      // A full set of our records in every state the routes act on.
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '20000.00' });
      const acqPending = await createAcquisition(owner, t.branchId, supplier.id, { price: '21000.00', approve: false });
      const posted = await owner.post('/vehicle-costs', cost(acq.vehicleId), idem());
      expect(posted.status).toBe(201);
      const pendingCost = await clerk.post('/vehicle-costs', cost(acq.vehicleId), idem());
      expect(pendingCost.body.status).toBe('pending_approval');
      const exp = await owner.post('/expenses', expense(t.branchId), idem());
      expect(exp.status).toBe(201);
      const expPending = await clerk.post('/expenses', expense(t.branchId), idem());
      expect(expPending.body.status).toBe('pending_approval');
      const wo = await workOrderAwaiting(owner, acq.vehicleId);
      const woOpen = await owner.post('/work-orders', { vehicleId: acq.vehicleId, type: 'detailing', title: 'Polish' });
      const woOpenItem = await owner.post(`/work-orders/${woOpen.body.id}/items`, item());
      const payment = await pay(owner, mainBox.id, [{ targetType: 'acquisition', targetId: acq.id, amountBase: '1000.00' }]);
      expect(payment.status).toBe(201);
      const tr = await owner.post('/cash/transfers', { fromAccountId: mainBox.id, toAccountId: companyBank.id, amount: '10.00', date: '2026-03-02' }, idem());
      expect(tr.status).toBe(201);
      const entry = (await pool.query(`SELECT id FROM journal_entries WHERE tenant_id = $1 LIMIT 1`, [t.tenantId])).rows[0].id as string;

      const x = o.owner;
      const before = {
        entries: (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1`, [t.tenantId])).rows[0].n,
        audit: (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1`, [t.tenantId])).rows[0].n,
      };
      const reason = { reason: 'Hostile company' };
      const attempts: Array<[string, () => ReturnType<Client['get']>]> = [
        ['GET supplier', () => x.get(`/suppliers/${supplier.id}`)],
        ['GET statement', () => x.get(`/suppliers/${supplier.id}/statement`)],
        ['PATCH supplier', () => x.patch(`/suppliers/${supplier.id}`, { name: 'Hijacked' })],
        ['GET acquisition', () => x.get(`/acquisitions/${acq.id}`)],
        ['PATCH acquisition', () => x.patch(`/acquisitions/${acqPending.id}`, { version: 1, notes: 'x' })],
        ['submit acquisition', () => x.post(`/acquisitions/${acqPending.id}/submit`)],
        ['approve acquisition', () => x.post(`/acquisitions/${acqPending.id}/approve`, {}, idem())],
        ['reject acquisition', () => x.post(`/acquisitions/${acqPending.id}/reject`, reason)],
        ['cancel acquisition', () => x.post(`/acquisitions/${acq.id}/cancel`, reason, idem())],
        ['ownership', () => x.put(`/acquisitions/${acq.id}/ownership`, { status: 'completed' })],
        ['vehicle costs', () => x.get(`/vehicles/${acq.vehicleId}/costs`)],
        ['GET cost', () => x.get(`/vehicle-costs/${posted.body.id}`)],
        ['approve cost', () => x.post(`/vehicle-costs/${pendingCost.body.id}/approve`, {})],
        ['reject cost', () => x.post(`/vehicle-costs/${pendingCost.body.id}/reject`, reason)],
        ['reverse cost', () => x.post(`/vehicle-costs/${posted.body.id}/reverse`, reason, idem())],
        ['GET payment', () => x.get(`/supplier-payments/${payment.body.id}`)],
        ['void payment', () => x.post(`/supplier-payments/${payment.body.id}/void`, reason, idem())],
        ['GET cash account', () => x.get(`/cash-accounts/${mainBox.id}`)],
        ['PATCH cash account', () => x.patch(`/cash-accounts/${mainBox.id}`, { name: 'Hijacked' })],
        ['cash book', () => x.get(`/cash/accounts/${mainBox.id}/book`)],
        ['GET transfer', () => x.get(`/cash/transfers/${tr.body.transferId}`)],
        ['reverse transfer', () => x.post(`/cash/transfers/${tr.body.transferId}/reverse`, reason, idem())],
        ['ledger entry', () => x.get(`/ledger/entries/${entry}`)],
        ['ledger branch filter', () => x.get(`/ledger/trial-balance?branchId=${t.branchId}`)],
        ['GET expense', () => x.get(`/expenses/${exp.body.id}`)],
        ['approve expense', () => x.post(`/expenses/${expPending.body.id}/approve`, {})],
        ['reject expense', () => x.post(`/expenses/${expPending.body.id}/reject`, reason)],
        ['reverse expense', () => x.post(`/expenses/${exp.body.id}/reverse`, reason, idem())],
        ['vehicle work orders', () => x.get(`/vehicles/${acq.vehicleId}/work-orders`)],
        ['GET work order', () => x.get(`/work-orders/${wo.id}`)],
        ['PATCH work order', () => x.patch(`/work-orders/${woOpen.body.id}`, { title: 'Hijacked' })],
        ['add item', () => x.post(`/work-orders/${woOpen.body.id}/items`, item())],
        ['edit item', () => x.patch(`/work-orders/${woOpen.body.id}/items/${woOpenItem.body.id}`, { unitCost: '1.00' })],
        ['delete item', () => x.delete(`/work-orders/${woOpen.body.id}/items/${woOpenItem.body.id}`)],
        ['start work order', () => x.post(`/work-orders/${woOpen.body.id}/start`)],
        ['complete work order', () => x.post(`/work-orders/${wo.id}/complete`)],
        ['approve work order', () => x.post(`/work-orders/${wo.id}/approve`, {}, idem())],
        ['reject work order', () => x.post(`/work-orders/${wo.id}/reject`, reason)],
        ['cancel work order', () => x.post(`/work-orders/${wo.id}/cancel`, reason)],
      ];
      for (const [label, attempt] of attempts) {
        const res = await attempt();
        expect([res.status, res.body?.error?.code], label).toEqual([404, 'not_found']);
      }

      // Their own documents may not reference our records either.
      const theirVehicle = await createVehicle(x, o.branchId);
      const theirSupplier = await createSupplier(x);
      const theirBox = await createCashAccount(x, { openingBalance: '10000.00' });
      const theirCatalog = await catalogIds(x);
      const theirCar = { ...theirCatalog, modelYear: 2022, odometerValue: 10, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'Blue' };
      const refs: Array<[string, () => ReturnType<Client['get']>]> = [
        ['work order on our vehicle', () => x.post('/work-orders', { vehicleId: acq.vehicleId, type: 'repair', title: 'Steal' })],
        ['work order with our supplier', () => x.post('/work-orders', { vehicleId: theirVehicle.id, type: 'repair', title: 'Steal', supplierId: supplier.id })],
        ['cost with our supplier', () => x.post('/vehicle-costs', { ...cost(theirVehicle.id), supplierId: supplier.id }, idem())],
        ['cost paid from our account', () => x.post('/vehicle-costs', { ...cost(theirVehicle.id), supplierId: theirSupplier.id, payNow: { cashAccountId: mainBox.id } }, idem())],
        ['allocation over our vehicles', () => x.post('/vehicle-costs/allocate', { vehicleIds: [theirVehicle.id, acq.vehicleId], method: 'equal', categoryId: cats.transport, description: 'Truck', totalAmount: '100.00', currency: 'SAR', costDate: '2026-02-01' }, idem())],
        ['expense in our branch', () => x.post('/expenses', { ...expense(t.branchId), supplierId: theirSupplier.id }, idem())],
        ['expense paid from our account', () => x.post('/expenses', { ...expense(o.branchId), supplierId: theirSupplier.id, payNow: { cashAccountId: mainBox.id } }, idem())],
        ['acquisition from our supplier', () => x.post('/acquisitions', { branchId: o.branchId, supplierId: supplier.id, sourceType: 'company', purchaseDate: '2026-01-15', purchasePrice: '100.00', currency: 'SAR', vehicle: theirCar }, idem())],
        ['acquisition in our branch', () => x.post('/acquisitions', { branchId: t.branchId, supplierId: theirSupplier.id, sourceType: 'company', purchaseDate: '2026-01-15', purchasePrice: '100.00', currency: 'SAR', vehicle: theirCar }, idem())],
        ['payment of our acquisition', () => x.post('/supplier-payments', { supplierId: theirSupplier.id, cashAccountId: theirBox.id, paidAt: '2026-03-01', method: 'cash', amount: '10.00', allocations: [{ targetType: 'acquisition', targetId: acq.id, amountBase: '10.00' }] }, idem())],
        ['transfer into our account', () => x.post('/cash/transfers', { fromAccountId: theirBox.id, toAccountId: mainBox.id, amount: '10.00', date: '2026-03-02' }, idem())],
        ['cash account in our branch', () => x.post('/cash-accounts', { type: 'cashbox', name: `Ours ${uniq()}`, currency: 'SAR', branchId: t.branchId }, idem())],
      ];
      for (const [label, attempt] of refs) {
        const res = await attempt();
        expect([res.status, res.body?.error?.code], `${label}: ${JSON.stringify(res.body)}`).toEqual([404, 'not_found']);
      }
      const assignee = await x.post('/work-orders', { vehicleId: theirVehicle.id, type: 'repair', title: 'Assign', assignedUserId: (await pool.query(`SELECT user_id FROM memberships WHERE tenant_id = $1 LIMIT 1`, [t.tenantId])).rows[0].user_id });
      expect([assignee.status, assignee.body.error.code]).toEqual([422, 'assignee_not_member']);

      // Lists and reports never contain our rows, whatever filter is supplied.
      const ourIds = new Set<string>([acq.id, acqPending.id, posted.body.id, pendingCost.body.id, exp.body.id, expPending.body.id, wo.id, woOpen.body.id, payment.body.id, supplier.id, mainBox.id, companyBank.id]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are untyped JSON
      const lists: Array<[string, (b: any) => Array<{ id?: string; entityId?: string; targetId?: string; transferId?: string; supplierId?: string | null }>]> = [
        [`/suppliers?pageSize=200`, (b) => b.items],
        [`/acquisitions?supplierId=${supplier.id}&pageSize=200`, (b) => b.items],
        [`/vehicle-costs/pending`, (b) => b.map((x: { cost: { id: string } }) => ({ id: x.cost.id }))],
        [`/supplier-payments?supplierId=${supplier.id}&pageSize=200`, (b) => b.items],
        [`/payables/open?supplierId=${supplier.id}`, (b) => b.items],
        [`/payables/summary`, (b) => b.rows],
        [`/approvals`, (b) => b],
        [`/cash-accounts?includeInactive=true`, (b) => b],
        [`/cash-accounts/options`, (b) => b],
        [`/cash/transfers?cashAccountId=${mainBox.id}`, (b) => b.items],
        [`/expenses?supplierId=${supplier.id}&pageSize=200`, (b) => b.items],
        [`/work-orders?vehicleId=${acq.vehicleId}&pageSize=200`, (b) => b.items],
      ];
      for (const [path, rows] of lists) {
        const res = await x.get(path);
        expect(res.status, path).toBe(200);
        for (const row of rows(res.body)) {
          for (const v of [row.id, row.entityId, row.targetId, row.supplierId]) expect(v && ourIds.has(v), `${path} leaked ${v}`).toBeFalsy();
        }
      }
      const st = await x.get(`/ledger/accounts/2000/statement?supplierId=${supplier.id}`);
      expect(st.status).toBe(200);
      expect(st.body).toMatchObject({ opening: '0.00', closing: '0.00', totalDebit: '0.00', totalCredit: '0.00', rows: [] });
      expect(((await x.get('/ledger/entries?pageSize=200')).body.items as Array<{ id: string }>).some((e) => e.id === entry)).toBe(false);

      // Nothing of ours changed.
      expect((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1`, [t.tenantId])).rows[0].n).toBe(before.entries);
      expect((await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1`, [t.tenantId])).rows[0].n).toBe(before.audit);
      expect((await owner.get(`/work-orders/${wo.id}`)).body.status).toBe('awaiting_approval');
      expect((await owner.get(`/acquisitions/${acqPending.id}`)).body.status).toBe('pending_approval');
      await assertLedgerIntegrity(pool, t.tenantId);
      await assertLedgerIntegrity(pool, o.tenantId);
    });
  });

  // ── (c) branch scope ─────────────────────────────────────────────────────────────────────
  describe('(c) branch-restricted members', () => {
    let scoped: Client;
    let mainScoped: Client;
    let acqMain: { id: string; vehicleId: string };
    let draftMain: { id: string };
    let costPendingMain: string;
    let expMain: string;
    let woMain: { id: string; itemId: string };
    let vB2: string;

    beforeAll(async () => {
      scoped = (await addMember(app, t, 'branch_manager', { allBranches: false, branchIds: [b2.id] })).client;
      mainScoped = (await addMember(app, t, 'accountant', { allBranches: false, branchIds: [t.branchId] })).client;
      acqMain = await createAcquisition(owner, t.branchId, supplier.id, { price: '30000.00' });
      draftMain = await createAcquisition(owner, t.branchId, supplier.id, { price: '31000.00', submit: false, approve: false });
      const pc = await clerk.post('/vehicle-costs', cost(acqMain.vehicleId), idem());
      expect(pc.body.status).toBe('pending_approval');
      costPendingMain = pc.body.id;
      expMain = (await owner.post('/expenses', expense(t.branchId, { amount: '777.00' }), idem())).body.id;
      woMain = await workOrderAwaiting(owner, acqMain.vehicleId);
      vB2 = (await createAcquisition(owner, b2.id, supplier.id, { price: '15000.00' })).vehicleId;
      expect((await owner.post('/expenses', expense(b2.id, { amount: '333.00' }), idem())).status).toBe(201);
    });

    it("refuses direct access and mutations on another branch's records (403) and leaves them untouched", async () => {
      const reason = { reason: 'Not my branch' };
      const attempts: Array<[string, () => ReturnType<Client['get']>]> = [
        ['GET acquisition', () => scoped.get(`/acquisitions/${acqMain.id}`)],
        ['PATCH draft', () => scoped.patch(`/acquisitions/${draftMain.id}`, { version: 1, notes: 'x' })],
        ['submit draft', () => scoped.post(`/acquisitions/${draftMain.id}/submit`)],
        ['approve draft', () => scoped.post(`/acquisitions/${draftMain.id}/approve`, {}, idem())],
        ['ownership', () => scoped.put(`/acquisitions/${acqMain.id}/ownership`, { status: 'completed' })],
        ['vehicle costs', () => scoped.get(`/vehicles/${acqMain.vehicleId}/costs`)],
        ['approve cost', () => scoped.post(`/vehicle-costs/${costPendingMain}/approve`, {})],
        ['GET expense', () => scoped.get(`/expenses/${expMain}`)],
        ['GET work order', () => scoped.get(`/work-orders/${woMain.id}`)],
        ['edit item', () => scoped.patch(`/work-orders/${woMain.id}/items/${woMain.itemId}`, { unitCost: '1.00' })],
        ['delete item', () => scoped.delete(`/work-orders/${woMain.id}/items/${woMain.itemId}`)],
        ['complete', () => scoped.post(`/work-orders/${woMain.id}/complete`)],
        ['reject work order', () => scoped.post(`/work-orders/${woMain.id}/reject`, reason)],
        ['GET main box', () => scoped.get(`/cash-accounts/${mainBox.id}`)],
        ['main box book', () => scoped.get(`/cash/accounts/${mainBox.id}/book`)],
        ['transfer company → main box', () => scoped.post('/cash/transfers', { fromAccountId: companyBank.id, toAccountId: mainBox.id, amount: '5.00', date: '2026-03-03' }, idem())],
        ['transfer main box → b2 box', () => scoped.post('/cash/transfers', { fromAccountId: mainBox.id, toAccountId: b2Box.id, amount: '5.00', date: '2026-03-03' }, idem())],
      ];
      for (const [label, attempt] of attempts) {
        const res = await attempt();
        expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(403);
      }
      for (const path of ['/ledger/trial-balance', '/ledger/entries', '/ledger/balance-sheet', '/ledger/reconciliation', '/ledger/accounts']) {
        const res = await scoped.get(path);
        expect([res.status, res.body.error.code], path).toEqual([403, 'company_scope_required']);
      }
      const st = await scoped.get(`/suppliers/${supplier.id}/statement`);
      expect([st.status, st.body.error.code]).toEqual([403, 'all_branches_required']);
      expect((await owner.get(`/acquisitions/${draftMain.id}`)).body).toMatchObject({ status: 'draft', version: 1 });
      expect((await owner.get(`/work-orders/${woMain.id}`)).body).toMatchObject({ status: 'awaiting_approval' });
    });

    it("cannot reach another branch's cash box indirectly through pay-now on its own approvals, costs, expenses and work orders", async () => {
      const entries = async () => (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1`, [t.tenantId])).rows[0].n as number;
      const n0 = await entries();
      const pendingB2 = await createAcquisition(owner, b2.id, supplier.id, { price: '4000.00', approve: false });
      const n1 = await entries();
      const boxRefused = (res: { status: number; body: { error?: { message?: string } } }, label: string) =>
        expect([res.status, res.body.error?.message], label).toEqual([403, 'This cash account belongs to a branch you cannot access']);
      const viaApproval = await scoped.post(`/acquisitions/${pendingB2.id}/approve`, { payNow: { cashAccountId: mainBox.id, method: 'cash' } }, idem());
      boxRefused(viaApproval, 'approve with pay-now');
      expect((await owner.get(`/acquisitions/${pendingB2.id}`)).body.status).toBe('pending_approval');
      const viaCost = await scoped.post('/vehicle-costs', cost(vB2, { payNow: { cashAccountId: mainBox.id } }), idem());
      boxRefused(viaCost, 'cost with pay-now');
      const viaExpense = await scoped.post('/expenses', expense(b2.id, { payNow: { cashAccountId: mainBox.id } }), idem());
      boxRefused(viaExpense, 'expense with pay-now');
      const viaAlloc = await scoped.post('/vehicle-costs/allocate', { vehicleIds: [vB2, (await createVehicle(owner, b2.id)).id], method: 'equal', categoryId: cats.transport, description: 'Truck', totalAmount: '100.00', currency: 'SAR', costDate: '2026-02-01', supplierId: null, payNow: { cashAccountId: mainBox.id } }, idem());
      boxRefused(viaAlloc, 'allocation with pay-now');
      // A work order of their branch with a direct-purchase item, approved with pay-now from the main box.
      const wo = await owner.post('/work-orders', { vehicleId: vB2, type: 'parts', title: 'Battery' });
      await owner.post(`/work-orders/${wo.body.id}/items`, item({ description: 'Battery', unitCost: '350.00' }));
      await owner.post(`/work-orders/${wo.body.id}/start`);
      await owner.post(`/work-orders/${wo.body.id}/complete`);
      const viaWo = await scoped.post(`/work-orders/${wo.body.id}/approve`, { payNow: { cashAccountId: mainBox.id, method: 'cash' } }, idem());
      boxRefused(viaWo, 'work order approval with pay-now');
      expect((await owner.get(`/work-orders/${wo.body.id}`)).body.status).toBe('awaiting_approval');
      expect(await entries()).toBe(n1);
      expect(n1).toBeGreaterThanOrEqual(n0);
      // The same flows from their own box work.
      const ok = await scoped.post(`/acquisitions/${pendingB2.id}/approve`, { payNow: { cashAccountId: b2Box.id, method: 'cash' } }, idem());
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.payment.cashAccountId).toBe(b2Box.id);
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    it("lists, inbox and reports show only their branch's documents (plus company-level accounts)", async () => {
      const acqs = (await scoped.get('/acquisitions?pageSize=200')).body.items as Array<{ id: string; branchId: string }>;
      expect(acqs.length).toBeGreaterThan(0);
      expect(acqs.every((a) => a.branchId === b2.id)).toBe(true);
      expect((await scoped.get(`/acquisitions?branchId=${t.branchId}&pageSize=200`)).body).toMatchObject({ items: [], total: 0 });
      expect(((await scoped.get('/vehicle-costs/pending')).body as Array<{ cost: { id: string } }>).some((c) => c.cost.id === costPendingMain)).toBe(false);
      const exps = (await scoped.get('/expenses?pageSize=200')).body.items as Array<{ branchId: string }>;
      expect(exps.length).toBeGreaterThan(0);
      expect(exps.every((e) => e.branchId === b2.id)).toBe(true);
      const wos = (await scoped.get('/work-orders?pageSize=200')).body.items as Array<{ branchId: string }>;
      expect(wos.length).toBeGreaterThan(0);
      expect(wos.every((w) => w.branchId === b2.id)).toBe(true);
      const accts = (await scoped.get('/cash-accounts')).body as Array<{ id: string; branchId: string | null }>;
      expect(accts.every((a) => a.branchId === null || a.branchId === b2.id)).toBe(true);
      expect(accts.some((a) => a.id === mainBox.id)).toBe(false);

      const inbox = (await scoped.get('/approvals')).body as Item[];
      expect(inbox.length).toBeGreaterThan(0);
      expect(inbox.every((i) => i.branchId === null || i.branchId === b2.id)).toBe(true);
      expect(inbox.some((i) => i.entityId === woMain.id || i.entityId === costPendingMain)).toBe(false);
      expect((await scoped.get('/approvals/summary')).body.total).toBe(inbox.length);

      const open = (await scoped.get('/payables/open')).body as { items: Array<{ branchId: string; targetId: string }> };
      expect(open.items.length).toBeGreaterThan(0);
      expect(open.items.every((i) => i.branchId === b2.id)).toBe(true);
      expect(open.items.some((i) => i.targetId === acqMain.id || i.targetId === expMain)).toBe(false);

      // AP aging and the supplier 360 only add up their branch's documents; no GL reconciliation.
      const mine = (await owner.get(`/payables/open?supplierId=${supplier.id}`)).body as { items: Array<{ branchId: string; outstandingBase: string }> };
      const b2Outstanding = mine.items.filter((i) => i.branchId === b2.id).reduce((s, i) => s + Number(i.outstandingBase), 0).toFixed(2);
      const summary = (await scoped.get('/payables/summary')).body;
      expect(summary).toMatchObject({ scope: 'branches', reconciliation: null });
      const row = (summary.rows as Array<{ supplierId: string; outstandingBase: string }>).find((x) => x.supplierId === supplier.id);
      expect(row?.outstandingBase).toBe(b2Outstanding);
      const s360 = (await scoped.get(`/suppliers/${supplier.id}`)).body.summary;
      expect(s360.outstandingBase).toBe(b2Outstanding);
      const expSummary = (await scoped.get('/expenses/summary')).body;
      const ownerB2 = (await owner.get(`/expenses/summary?branchId=${b2.id}`)).body;
      expect(expSummary.totalBase).toBe(ownerB2.totalBase);
      expect((await scoped.get(`/expenses/summary?branchId=${t.branchId}`)).status).toBe(403);

      // Payments from the main box never appear, even when filtered by it.
      const mainPay = await pay(owner, mainBox.id, [{ targetType: 'expense', targetId: expMain, amountBase: '7.00' }]);
      expect(mainPay.status).toBe(201);
      expect(((await scoped.get('/supplier-payments?pageSize=200')).body.items as Array<{ id: string }>).some((p) => p.id === mainPay.body.id)).toBe(false);
      expect((await scoped.get(`/supplier-payments?cashAccountId=${mainBox.id}`)).body.items).toEqual([]);
      expect((await mainScoped.get(`/supplier-payments/${mainPay.body.id}`)).status).toBe(200);
    });

    // BUG: A branch-restricted user can void a company-account payment that settled another branch's documents
    it("a branch-restricted user cannot void a company-account payment that settled another branch's purchase", async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '6000.00' });
      const p = await pay(owner, companyBank.id, [{ targetType: 'acquisition', targetId: acq.id, amountBase: '6000.00' }]);
      expect(p.status).toBe(201);
      // Paying that document from the same account is refused to them (branch_forbidden) ...
      const payAttempt = await pay(scoped, companyBank.id, [{ targetType: 'acquisition', targetId: acq.id, amountBase: '1.00' }]);
      expect(payAttempt.body.error.code).toBe('branch_forbidden');
      // ... so un-paying it must be refused as well.
      const v = await scoped.post(`/supplier-payments/${p.body.id}/void`, { reason: 'Not my branch' }, idem());
      const after = (await owner.get(`/acquisitions/${acq.id}`)).body;
      expect({ status: v.status, paymentStatus: (await owner.get(`/supplier-payments/${p.body.id}`)).body.status, outstanding: after.outstandingBase }).toEqual({
        status: 403,
        paymentStatus: 'posted',
        outstanding: '0.00',
      });
    });

    // BUG: A branch-restricted cash manager can take over a company-level bank account (move it into their branch / change its IBAN)
    it('a branch-restricted cash manager cannot move a company-level account into their branch or change its bank details', async () => {
      const acct = await owner.post('/cash-accounts', { type: 'bank', name: `Company payroll ${uniq()}`, currency: 'SAR', bankName: 'Riyad Bank', iban: 'SA0380000000608010167519' }, idem());
      expect(acct.status).toBe(201);
      expect((await mainScoped.get(`/cash-accounts/${acct.body.id}`)).status).toBe(200);
      const moved = await scoped.patch(`/cash-accounts/${acct.body.id}`, { branchId: b2.id });
      const mainView = await mainScoped.get(`/cash-accounts/${acct.body.id}`);
      expect({ moved: moved.status, mainBranchCanStillSeeIt: mainView.status }).toEqual({ moved: 403, mainBranchCanStillSeeIt: 200 });
      const iban = await scoped.patch(`/cash-accounts/${acct.body.id}`, { iban: 'SA4420000001234567891234' });
      expect(iban.status).toBe(403);
    });
  });

  // ── (d) sensitive fields ───────────────────────────────────────────────────────────────
  describe('(d) cost, AP and supplier data', () => {
    let rep: Client;
    let acq: { id: string; vehicleId: string };
    let paymentId: string;

    beforeAll(async () => {
      rep = (await addMember(app, t, 'sales_rep')).client;
      acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '87654.00' });
      const p = await pay(owner, companyBank.id, [{ targetType: 'acquisition', targetId: acq.id, amountBase: '87654.00' }]);
      expect(p.status).toBe(201);
      paymentId = p.body.id;
      expect((await owner.post('/vehicle-costs', cost(acq.vehicleId, { amount: '1234.00' }), idem())).status).toBe(201);
    });

    it('a sales rep sees no cost, margin or purchasing data on vehicles or Phase 3 routes', async () => {
      const list = (await rep.get(`/vehicles?q=${encodeURIComponent((await owner.get(`/acquisitions/${acq.id}`)).body.vehicle.stockNumber)}`)).body.items as Array<{ id: string; costTotal: string | null }>;
      expect(list.find((v) => v.id === acq.vehicleId)?.costTotal).toBeNull();
      const detail = (await rep.get(`/vehicles/${acq.vehicleId}`)).body;
      expect(detail.vehicle.minPrice).toBeNull();
      expect(JSON.stringify(detail)).not.toContain('87654');
      for (const path of [`/vehicles/${acq.vehicleId}/costs`, `/acquisitions/${acq.id}`, '/acquisitions', `/suppliers/${supplier.id}`, '/vehicle-costs/pending', `/vehicles/${acq.vehicleId}/work-orders`, '/expenses', '/cash-accounts', '/ledger/trial-balance']) {
        expect((await rep.get(path)).status, path).toBe(403);
      }
    });

    // BUG: payments.read (held by every sales rep) exposes the company-wide accounts-payable aging, supplier balances and the GL 2000 reconciliation
    it('a sales rep cannot read the company accounts-payable aging or supplier balances', async () => {
      const res = await rep.get('/payables/summary');
      expect(res.status, `sales rep received: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(403);
    });

    // BUG: payments.read exposes every vehicle's purchase price (cost) to sales reps through open payables and supplier-payment allocations
    it('a sales rep (no vehicles.view_cost) cannot read vehicle purchase prices through payables or supplier payments', async () => {
      const acq2 = await createAcquisition(owner, t.branchId, supplier.id, { price: '45678.00' });
      const open = await rep.get(`/payables/open?supplierId=${supplier.id}`);
      const leakedOpen = open.status === 200 ? (open.body.items as Array<{ targetId: string; totalBase: string; vehicleStockNumber: string }>).find((i) => i.targetId === acq2.id) : undefined;
      const payment = await rep.get(`/supplier-payments/${paymentId}`);
      const leakedPayment = payment.status === 200 ? (payment.body.allocations as Array<{ targetId: string; amountBase: string }>).find((a) => a.targetId === acq.id) : undefined;
      expect({ openPayables: open.status, purchasePrice: leakedOpen?.totalBase, payment: payment.status, paidPurchasePrice: leakedPayment?.amountBase }).toEqual({
        openPayables: 403,
        purchasePrice: undefined,
        payment: 403,
        paidPurchasePrice: undefined,
      });
    });

    // BUG: GET /acquisitions/:id returns the full supplier row (national id, tax number, phone, address) to callers without suppliers.read
    it("a member who may read acquisitions but not suppliers does not receive the supplier's national id and tax number", async () => {
      const reader = (await addMemberWithPermissions(app, t, ['vehicles.read', 'vehicles.view_cost', 'acquisitions.read'])).client;
      expect((await reader.get(`/suppliers/${supplier.id}`)).status).toBe(403);
      const res = await reader.get(`/acquisitions/${acq.id}`);
      expect(res.status).toBe(200);
      expect(res.body.supplier?.name).toBe(supplier.name);
      expect({ nationalId: res.body.supplier?.nationalId ?? null, taxNumber: res.body.supplier?.taxNumber ?? null }).toEqual({ nationalId: null, taxNumber: null });
    });

    it('supplier money summaries and statements are withheld from members without payments.read', async () => {
      const inv = (await addMember(app, t, 'inventory_manager')).client;
      const one = await inv.get(`/suppliers/${supplier.id}`);
      expect(one.status).toBe(200);
      expect(one.body.summary).toBeNull();
      expect((await inv.get(`/suppliers/${supplier.id}/statement`)).status).toBe(403);
      expect((await inv.get('/payables/summary')).status).toBe(403);
      expect((await inv.get('/supplier-payments')).status).toBe(403);
    });
  });

  // ── (e) maker-checker ─────────────────────────────────────────────────────────────────
  describe('(e) maker-checker', () => {
    // BUG: Whoever enters or changes a work order's item amounts can approve them (only creator/submitter are makers)
    it("the approver who entered a work order's amounts cannot approve them", async () => {
      const im = (await addMember(app, t, 'inventory_manager')).client;
      const v = await createVehicle(owner, t.branchId);
      const wo = await im.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'Engine overhaul' });
      expect(wo.status).toBe(201);
      expect((await im.post(`/work-orders/${wo.body.id}/start`)).status).toBe(200);
      // The approver enters the money figure on someone else's work order ...
      const big = await checker.post(`/work-orders/${wo.body.id}/items`, item({ description: 'Engine', unitCost: '48000.00' }));
      expect(big.status).toBe(201);
      // ... the creator submits it ...
      expect((await im.post(`/work-orders/${wo.body.id}/complete`)).status).toBe(200);
      // ... and the approver must not be able to approve their own figure.
      const self = await checker.post(`/work-orders/${wo.body.id}/approve`, {}, idem());
      expect([self.status, self.body.error?.code]).toEqual([403, 'self_approval_forbidden']);
    });

    it('acquisitions: creator, submitter and editors are all makers, whatever route they used; a third approver decides', async () => {
      const third = (await addMember(app, t, 'owner')).client;
      // Draft by the owner, submitted by someone else.
      const a = await createAcquisition(owner, t.branchId, supplier.id, { price: '12000.00', submit: false, approve: false });
      expect((await checker.post(`/acquisitions/${a.id}/submit`)).status).toBe(200);
      for (const c of [owner, checker]) {
        const res = await c.post(`/acquisitions/${a.id}/approve`, {}, idem());
        expect([res.status, res.body.error.code]).toEqual([403, 'self_approval_forbidden']);
      }
      // Reject → resubmit by the rejecter: the rejecter became a submitter (maker).
      expect((await third.post(`/acquisitions/${a.id}/reject`, { reason: 'Wrong price' })).status).toBe(200);
      expect((await third.post(`/acquisitions/${a.id}/submit`)).status).toBe(200);
      expect((await third.post(`/acquisitions/${a.id}/approve`, {}, idem())).status).toBe(403);
      // Creator, first submitter and the rejecter-turned-submitter are all makers: a fourth approver decides.
      const fourth = (await addMember(app, t, 'owner')).client;
      const ok = await fourth.post(`/acquisitions/${a.id}/approve`, {}, idem());
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      // Approving a draft directly skips submission but not the maker check.
      const d = await createAcquisition(checker, t.branchId, supplier.id, { price: '1000.00', submit: false, approve: false });
      expect((await checker.post(`/acquisitions/${d.id}/approve`, {}, idem())).status).toBe(403);
      // The approval inbox has no decision endpoint of its own.
      const inboxItem = ((await owner.get('/approvals')).body as Array<{ id: string }>)[0];
      if (inboxItem) {
        expect((await owner.post(`/approvals/${inboxItem.id}/approve`, {})).status).toBe(404);
      }
    });

    it('work orders: reject → re-complete by the creator keeps the creator locked out; rejected costs and expenses cannot be approved later', async () => {
      const inspector = (await addMember(app, t, 'inspector')).client;
      const v = await createVehicle(owner, t.branchId);
      const wo = await owner.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'Gearbox' });
      await owner.post(`/work-orders/${wo.body.id}/items`, item({ unitCost: '900.00' }));
      expect((await inspector.post(`/work-orders/${wo.body.id}/start`)).status).toBe(200);
      expect((await inspector.post(`/work-orders/${wo.body.id}/complete`)).status).toBe(200);
      expect((await inspector.post(`/work-orders/${wo.body.id}/approve`, {}, idem())).status).toBe(403);
      expect((await checker.post(`/work-orders/${wo.body.id}/reject`, { reason: 'Need invoice' })).status).toBe(200);
      expect((await owner.post(`/work-orders/${wo.body.id}/complete`)).status).toBe(200);
      const self = await owner.post(`/work-orders/${wo.body.id}/approve`, {}, idem());
      expect([self.status, self.body.error.code]).toEqual([403, 'self_approval_forbidden']);
      expect((await checker.post(`/work-orders/${wo.body.id}/approve`, {}, idem())).status).toBe(200);
      // Completed work orders are final.
      expect((await owner.post(`/work-orders/${wo.body.id}/cancel`, { reason: 'Undo' })).status).toBe(409);
      expect((await owner.post(`/work-orders/${wo.body.id}/items`, item())).status).toBe(409);

      const c = await clerk.post('/vehicle-costs', cost(v.id), idem());
      expect((await owner.post(`/vehicle-costs/${c.body.id}/reject`, { reason: 'No invoice' })).status).toBe(200);
      const late = await checker.post(`/vehicle-costs/${c.body.id}/approve`, {});
      expect([late.status, late.body.error.code]).toEqual([409, 'cost_not_pending']);
      const e = await clerk.post('/expenses', expense(t.branchId), idem());
      expect((await owner.post(`/expenses/${e.body.id}/reject`, { reason: 'No invoice' })).status).toBe(200);
      const lateE = await checker.post(`/expenses/${e.body.id}/approve`, {});
      expect([lateE.status, lateE.body.error.code]).toEqual([409, 'expense_not_pending']);
    });
  });

  // ── (f) mass assignment ─────────────────────────────────────────────────────────────────
  describe('(f) mass assignment', () => {
    const forged = () => ({
      id: '00000000-0000-4000-8000-0000000000aa',
      tenantId: o.tenantId,
      createdBy: '00000000-0000-4000-8000-0000000000bb',
      approvedBy: '00000000-0000-4000-8000-0000000000bb',
      status: 'posted',
      number: 'HACK-1',
    });

    it('server-owned fields in create bodies are ignored', async () => {
      const s = await owner.post('/suppliers', { ...forged(), type: 'company', name: `Forged ${uniq()}`, customerId: '00000000-0000-4000-8000-0000000000cc' });
      expect(s.status).toBe(201);
      expect(s.body).toMatchObject({ tenantId: t.tenantId, customerId: null });
      expect(s.body.id).not.toBe(forged().id);
      expect(s.body.createdBy).not.toBe(forged().createdBy);

      const v = await createVehicle(owner, t.branchId);
      const c = await clerk.post('/vehicle-costs', { ...forged(), ...cost(v.id, { amount: '250.00' }), amountBase: '1.00', postSale: true, sourceType: 'acquisition', approvedAt: new Date().toISOString() }, idem());
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ tenantId: t.tenantId, status: 'pending_approval', amountBase: '250.00', postSale: false, sourceType: 'manual', approvedBy: null });

      const e = await clerk.post('/expenses', { ...forged(), ...expense(t.branchId, { amount: '300.00' }), amountBase: '1.00' }, idem());
      expect(e.status).toBe(201);
      expect(e.body).toMatchObject({ tenantId: t.tenantId, status: 'pending_approval', amountBase: '300.00', approvedBy: null });
      expect(e.body.number).not.toBe('HACK-1');

      const ids = (await owner.get('/catalog/makes')).body as Array<{ id: string; nameEn: string }>;
      const makeId = ids.find((m) => m.nameEn === 'Toyota')!.id;
      const models = (await owner.get(`/catalog/models?makeId=${makeId}`)).body as Array<{ id: string }>;
      const a = await owner.post(
        '/acquisitions',
        {
          ...forged(),
          status: 'approved',
          purchasePriceBase: '1.00',
          vehicleId: v.id,
          branchId: t.branchId,
          supplierId: supplier.id,
          sourceType: 'company',
          purchaseDate: '2026-01-15',
          purchasePrice: '9000.00',
          currency: 'SAR',
          vehicle: { makeId, modelId: models[0]!.id, modelYear: 2022, odometerValue: 1, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'Red', status: 'available', branchId: b2.id },
        },
        idem(),
      );
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      expect(a.body).toMatchObject({ tenantId: t.tenantId, status: 'draft', purchasePriceBase: '9000.00', approvedBy: null, branchId: t.branchId });
      expect(a.body.vehicleId).not.toBe(v.id);
      const veh = (await owner.get(`/vehicles/${a.body.vehicleId}`)).body.vehicle;
      expect(veh).toMatchObject({ status: 'incoming', branchId: t.branchId });
      // An edit cannot approve it, move it or re-price its base amount.
      const ed = await owner.patch(`/acquisitions/${a.body.id}`, { version: 1, status: 'approved', branchId: b2.id, purchasePriceBase: '1.00', approvedBy: forged().approvedBy, notes: 'edited' });
      expect(ed.status).toBe(200);
      expect(ed.body).toMatchObject({ status: 'draft', branchId: t.branchId, purchasePriceBase: '9000.00', notes: 'edited' });
      expect(await pool.query(`SELECT 1 FROM journal_entries WHERE source_id = $1`, [a.body.id]).then((x) => x.rowCount)).toBe(0);

      const wo = await owner.post('/work-orders', { ...forged(), status: 'completed', vehicleId: v.id, type: 'repair', title: 'Forged', costId: forged().id });
      expect(wo.status).toBe(201);
      expect(wo.body).toMatchObject({ tenantId: t.tenantId, status: 'open', approvedBy: null });
      const wi = await owner.post(`/work-orders/${wo.body.id}/items`, { ...item({ quantity: '2', unitCost: '10.00' }), total: '99999.00', costId: forged().id, tenantId: o.tenantId, workOrderId: forged().id });
      expect(wi.status).toBe(201);
      expect(wi.body).toMatchObject({ total: '20.00', costId: null, workOrderId: wo.body.id, tenantId: t.tenantId });
      const wp = await owner.patch(`/work-orders/${wo.body.id}`, { status: 'completed', vehicleId: forged().id, title: 'Renamed' });
      expect(wp.body).toMatchObject({ status: 'open', vehicleId: v.id, title: 'Renamed' });
      const wip = await owner.patch(`/work-orders/${wo.body.id}/items/${wi.body.id}`, { total: '1.00', costId: forged().id, quantity: '3' });
      expect(wip.body).toMatchObject({ total: '30.00', costId: null });

      const box = await owner.post('/cash-accounts', { ...forged(), type: 'cashbox', name: `Forged box ${uniq()}`, currency: 'SAR', balance: '1000000.00', isActive: false }, idem());
      expect(box.status).toBe(201);
      expect(box.body).toMatchObject({ tenantId: t.tenantId, balance: '0.00', isActive: true });

      const acqP = await createAcquisition(owner, t.branchId, supplier.id, { price: '500.00' });
      const p = await owner.post('/supplier-payments', { ...forged(), status: 'voided', amountBase: '1.00', supplierId: supplier.id, cashAccountId: companyBank.id, paidAt: '2026-03-01', method: 'cash', amount: '500.00', allocations: [{ targetType: 'acquisition', targetId: acqP.id, amountBase: '500.00', paymentId: forged().id }] }, idem());
      expect(p.status).toBe(201);
      expect(p.body).toMatchObject({ tenantId: t.tenantId, status: 'posted', amountBase: '500.00' });
      expect(p.body.number).not.toBe('HACK-1');

      const tr = await owner.post('/cash/transfers', { ...forged(), fromAccountId: companyBank.id, toAccountId: box.body.id, amount: '50.00', amountBase: '1.00', date: '2026-03-05' }, idem());
      expect(tr.status).toBe(201);
      expect(tr.body).toMatchObject({ amountBase: '50.00', status: 'posted' });
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    // BUG: PATCH /cash-accounts/:id with no recognised field crashes with 500 instead of being ignored or rejected
    it('a cash-account PATCH carrying only server-owned fields (currency, tenantId, balance) is ignored or rejected, never a 500', async () => {
      const box = await createCashAccount(owner, { name: `Patch box ${uniq()}` });
      const res = await owner.patch(`/cash-accounts/${box.id}`, { currency: 'USD', tenantId: o.tenantId, balance: '1000000.00', type: 'bank' });
      expect([200, 422], JSON.stringify(res.body)).toContain(res.status);
      expect((await owner.get(`/cash-accounts/${box.id}`)).body).toMatchObject({ currency: 'SAR', type: 'cashbox', tenantId: t.tenantId, balance: '0.00' });
    });
  });

  // ── (g) approval inbox ──────────────────────────────────────────────────────────────────
  describe('(g) approval inbox', () => {
    it('members without any approval permission (even with approvals.read) see an empty inbox', async () => {
      await createAcquisition(owner, t.branchId, supplier.id, { price: '2000.00', approve: false });
      for (const role of ['sales_manager', 'sales_rep', 'inspector', 'auditor']) {
        const c = (await addMember(app, t, role)).client;
        expect((await c.get('/approvals')).body, role).toEqual([]);
        expect((await c.get('/approvals/summary')).body.total, role).toBe(0);
      }
      // An inventory manager may create but not approve purchases: none of them in their inbox.
      const im = (await addMember(app, t, 'inventory_manager')).client;
      expect(((await im.get('/approvals')).body as Item[]).some((i) => i.type === 'acquisition')).toBe(false);
    });

    // BUG: The inbox offers canDecide=true to the creator of a request someone else submitted, although approving it is refused
    it('the inbox never marks as decidable an item the caller is forbidden to approve (creator ≠ submitter)', async () => {
      const a = await createAcquisition(owner, t.branchId, supplier.id, { price: '3300.00', submit: false, approve: false });
      expect((await checker.post(`/acquisitions/${a.id}/submit`)).status).toBe(200);
      const inspector = (await addMember(app, t, 'inspector')).client;
      const v = await createVehicle(owner, t.branchId);
      const wo = await owner.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'Clutch' });
      await owner.post(`/work-orders/${wo.body.id}/items`, item());
      await inspector.post(`/work-orders/${wo.body.id}/start`);
      expect((await inspector.post(`/work-orders/${wo.body.id}/complete`)).status).toBe(200);

      const inbox = (await owner.get('/approvals')).body as Item[];
      const acqItem = inbox.find((i) => i.entityId === a.id);
      const woItem = inbox.find((i) => i.entityId === wo.body.id);
      const acqApprove = await owner.post(`/acquisitions/${a.id}/approve`, {}, idem());
      const woApprove = await owner.post(`/work-orders/${wo.body.id}/approve`, {}, idem());
      expect({ acqApprove: acqApprove.status, woApprove: woApprove.status }).toEqual({ acqApprove: 403, woApprove: 403 });
      expect({ acquisition: acqItem?.canDecide, workOrder: woItem?.canDecide }).toEqual({ acquisition: false, workOrder: false });
    });

    // BUG: Approval requests keep the branch they were raised in; after a vehicle transfer the old branch's approvers see an item they cannot decide and the new branch's approvers never see it
    it('a pending cost follows its vehicle to the new branch: shown to (and decidable by) the new branch only', async () => {
      const mainApprover = (await addMember(app, t, 'accountant', { allBranches: false, branchIds: [t.branchId] })).client;
      const b2Approver = (await addMember(app, t, 'accountant', { allBranches: false, branchIds: [b2.id] })).client;
      const v = await createVehicle(owner, t.branchId);
      const c = await clerk.post('/vehicle-costs', cost(v.id, { amount: '640.00' }), idem());
      expect(c.body.status).toBe('pending_approval');
      const tr = await owner.post(`/vehicles/${v.id}/transfers`, { toBranchId: b2.id });
      expect(tr.status, JSON.stringify(tr.body)).toBe(201);
      expect((await owner.post(`/inventory/transfers/${tr.body.id}/receive`)).status).toBe(200);

      const mainSees = ((await mainApprover.get('/approvals')).body as Item[]).some((i) => i.entityId === c.body.id);
      const b2Sees = ((await b2Approver.get('/approvals')).body as Item[]).some((i) => i.entityId === c.body.id);
      const mainDecides = (await mainApprover.post(`/vehicle-costs/${c.body.id}/approve`, {})).status;
      expect(mainDecides).toBe(403);
      expect({ mainSees, b2Sees }).toEqual({ mainSees: false, b2Sees: true });
    });
  });
});
