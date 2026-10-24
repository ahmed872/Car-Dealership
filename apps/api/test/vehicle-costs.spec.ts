import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { d, sum } from '@autohub/shared';
import {
  addMemberWithPermissions,
  assertLedgerIntegrity,
  cashBookBalance,
  costCategory,
  createAcquisition,
  createBranch,
  createCashAccount,
  createSupplier,
  createVehicle,
  glBalance,
  setFxReferences,
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

/**
 * Vehicle cost engine against a real database: direct posting (Dr 1300 / Cr 2000), the approval
 * path for users without costs.approve, rejection, reversal (and its guards: payments, purchase
 * price, cost lock, removed vehicles), post-sale costs to COGS, the cost summary with expected
 * profit under each tax setting, and shared-invoice allocation. Every test leaves the books
 * balanced (assertLedgerIntegrity after each test).
 */
describe('vehicle costs', () => {
  let app: INestApplication;
  let admin: Client;
  let t: TestTenant;
  let t2: TestTenant;
  let pool: Pool;
  let owner: Client;
  let accountant: Client;
  let accountantId: string;
  let inventory: Client;
  /** costs.create + costs.read + vehicles.read, no costs.approve: every cost it records waits for approval. */
  let clerk: Client;
  let clerkId: string;
  let supplier: { id: string };
  let cash: { id: string };
  let cat: Record<'transport' | 'detailing' | 'maintenance' | 'inspection' | 'purchase' | 'rent', string>;

  const cost = (vehicleId: string, overrides: Record<string, unknown> = {}) => ({
    vehicleId,
    categoryId: cat.transport,
    description: 'Tow from port',
    amount: '1000.00',
    currency: 'SAR',
    costDate: '2026-03-01',
    supplierId: supplier.id,
    ...overrides,
  });

  /** Ledger lines posted for one source document, in entry/line order. */
  const lines = async (sourceType: string, sourceId: string) =>
    (
      await pool.query(
        `SELECT e.event, l.account_code AS account, l.debit, l.credit, l.vehicle_id AS "vehicleId", l.supplier_id AS "supplierId"
           FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
          WHERE e.source_type = $1 AND e.source_id = $2
          ORDER BY e.entry_no, l.line_no`,
        [sourceType, sourceId],
      )
    ).rows as Array<{ event: string; account: string; debit: string; credit: string; vehicleId: string | null; supplierId: string | null }>;
  const events = async (sourceType: string, sourceId: string) =>
    (await pool.query(`SELECT event FROM journal_entries WHERE source_type = $1 AND source_id = $2 ORDER BY entry_no`, [sourceType, sourceId])).rows.map(
      (r) => r.event as string,
    );
  const entryCount = async (tenantId = t.tenantId) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1`, [tenantId])).rows[0].n);
  const approvalRows = async (entityId: string) =>
    (
      await pool.query(
        `SELECT type, status, required_permission AS "requiredPermission", requested_by AS "requestedBy", decided_by AS "decidedBy",
                decision_note AS "decisionNote", branch_id AS "branchId"
           FROM approval_requests WHERE entity_id = $1 ORDER BY requested_at`,
        [entityId],
      )
    ).rows;
  const costAudit = async (vehicleId: string) =>
    (
      await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'vehicle' AND entity_id = $1 AND action LIKE 'vehicle_cost.%' ORDER BY seq`, [vehicleId])
    ).rows.map((r) => r.action as string);
  const costsOf = async (vehicleId: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM vehicle_costs WHERE vehicle_id = $1`, [vehicleId])).rows[0].n as number;
  const purchaseCostId = async (c: Client, vehicleId: string) => {
    const s = await c.get(`/vehicles/${vehicleId}/costs`);
    const item = (s.body.items as Array<{ id: string; sourceType: string }>).find((i) => i.sourceType === 'acquisition');
    if (!item) throw new Error('purchase cost not found');
    return item.id;
  };

  beforeAll(async () => {
    app = await getApp();
    admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    t2 = await createTenant(app, admin);
    pool = ownerPool();
    owner = t.owner;
    await setFxReferences(owner, { USD: '3.75' });
    const acc = await addMember(app, t, 'accountant');
    accountant = acc.client;
    accountantId = acc.userId;
    inventory = (await addMember(app, t, 'inventory_manager')).client;
    const cl = await addMemberWithPermissions(app, t, ['vehicles.read', 'costs.read', 'costs.create']);
    clerk = cl.client;
    clerkId = cl.userId;
    supplier = await createSupplier(owner, { name: 'Gulf Car Carriers' });
    cash = await createCashAccount(owner, { name: 'Costs safe', openingBalance: '200000.00' });
    cat = {
      transport: await costCategory(owner, 'transport'),
      detailing: await costCategory(owner, 'detailing'),
      maintenance: await costCategory(owner, 'maintenance'),
      inspection: await costCategory(owner, 'inspection'),
      purchase: await costCategory(owner, 'purchase'),
      rent: await costCategory(owner, 'rent'),
    };
  });

  afterEach(async () => {
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  describe('posting and approval', () => {
    it('an accountant posts a manual cost directly: Dr 1300 (vehicle) / Cr 2000 (supplier), audited, no approval request', async () => {
      const v = await createVehicle(owner, t.branchId);
      const apBefore = await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id });
      const res = await accountant.post('/vehicle-costs', cost(v.id, { amount: '1750.50', notes: 'Invoice T-88' }), idem());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        vehicleId: v.id,
        categoryId: cat.transport,
        status: 'posted',
        sourceType: 'manual',
        amount: '1750.50',
        currency: 'SAR',
        exchangeRate: '1.00000000',
        amountBase: '1750.50',
        supplierId: supplier.id,
        postSale: false,
        approvedBy: accountantId,
        createdBy: accountantId,
        notes: 'Invoice T-88',
      });
      expect(await lines('vehicle_cost', res.body.id)).toEqual([
        { event: 'cost.posted', account: '1300', debit: '1750.50', credit: '0.00', vehicleId: v.id, supplierId: null },
        { event: 'cost.posted', account: '2000', debit: '0.00', credit: '1750.50', vehicleId: v.id, supplierId: supplier.id },
      ]);
      expect(await approvalRows(res.body.id)).toEqual([]);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('1750.50');
      expect(d(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).minus(apBefore).toFixed(2)).toBe('-1750.50');
      const got = await accountant.get(`/vehicle-costs/${res.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({ id: res.body.id, status: 'posted', amountBase: '1750.50' });
      expect(await costAudit(v.id)).toEqual(['vehicle_cost.posted']);
    });

    it('replaying POST /vehicle-costs with the same Idempotency-Key returns the same cost and posts once', async () => {
      const v = await createVehicle(owner, t.branchId);
      const key = idem();
      const body = cost(v.id, { amount: '640.00', description: 'Flatbed tow' });
      const first = await accountant.post('/vehicle-costs', body, key);
      expect(first.status).toBe(201);
      const replay = await accountant.post('/vehicle-costs', body, key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.id).toBe(first.body.id);
      expect(await costsOf(v.id)).toBe(1);
      expect(await events('vehicle_cost', first.body.id)).toEqual(['cost.posted']);
      const noKey = await accountant.post('/vehicle-costs', body);
      expect(noKey.status).toBe(400);
      expect(noKey.body.error.code).toBe('idempotency_key_required');
      expect(await costsOf(v.id)).toBe(1);
    });

    it('a clerk without costs.approve records a pending cost; it appears in the inbox and posts once when another user approves', async () => {
      const v = await createVehicle(owner, t.branchId);
      const before = await entryCount();
      const res = await clerk.post('/vehicle-costs', cost(v.id, { categoryId: cat.detailing, description: 'Full detailing', amount: '450.00' }), idem());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'pending_approval', approvedBy: null, approvedAt: null, createdBy: clerkId, amountBase: '450.00' });
      expect(await lines('vehicle_cost', res.body.id)).toEqual([]);
      expect(await entryCount()).toBe(before);
      expect(await approvalRows(res.body.id)).toEqual([
        { type: 'vehicle_cost', status: 'pending', requiredPermission: 'costs.approve', requestedBy: clerkId, decidedBy: null, decisionNote: null, branchId: t.branchId },
      ]);

      // Approvers see it in their inbox (decidable); the clerk, lacking costs.approve, does not.
      const inbox = (await accountant.get('/approvals')).body as Array<{ entityId: string; type: string; entityType: string; canDecide: boolean; requestedById: string; summary: string; payload: unknown }>;
      const item = inbox.find((i) => i.entityId === res.body.id);
      expect(item).toMatchObject({ type: 'vehicle_cost', entityType: 'vehicle_cost', canDecide: true, requestedById: clerkId, payload: { vehicleId: v.id, amountBase: '450.00' } });
      expect(item!.summary).toContain(v.stockNumber);
      expect(((await clerk.get('/approvals')).body as Array<{ entityId: string }>).some((i) => i.entityId === res.body.id)).toBe(false);
      const pendingList = await accountant.get('/vehicle-costs/pending');
      expect(pendingList.status).toBe(200);
      expect((pendingList.body as Array<{ cost: { id: string }; stockNumber: string }>).find((r) => r.cost.id === res.body.id)?.stockNumber).toBe(v.stockNumber);
      expect((await clerk.get('/vehicle-costs/pending')).status).toBe(403);
      const summary = await clerk.get(`/vehicles/${v.id}/costs`);
      expect(summary.status).toBe(200);
      expect(summary.body.totals).toMatchObject({ posted: '0.00', pending: '450.00' });

      // The clerk can neither approve nor pay a cost that is still awaiting approval (nothing sticks).
      expect((await clerk.post(`/vehicle-costs/${res.body.id}/approve`, {})).status).toBe(403);
      const payPending = await clerk.post('/vehicle-costs', cost(v.id, { payNow: { cashAccountId: cash.id, method: 'cash' } }), idem());
      expect(payPending.status).toBe(422);
      expect(payPending.body.error.code).toBe('cannot_pay_unapproved');
      expect(await costsOf(v.id)).toBe(1);

      const ap = await accountant.post(`/vehicle-costs/${res.body.id}/approve`, { note: 'Invoice checked' });
      expect(ap.status).toBe(200);
      expect(ap.body).toMatchObject({ id: res.body.id, status: 'posted', approvedBy: accountantId, postSale: false });
      expect(await lines('vehicle_cost', res.body.id)).toEqual([
        { event: 'cost.posted', account: '1300', debit: '450.00', credit: '0.00', vehicleId: v.id, supplierId: null },
        { event: 'cost.posted', account: '2000', debit: '0.00', credit: '450.00', vehicleId: v.id, supplierId: supplier.id },
      ]);
      expect(await approvalRows(res.body.id)).toEqual([
        { type: 'vehicle_cost', status: 'approved', requiredPermission: 'costs.approve', requestedBy: clerkId, decidedBy: accountantId, decisionNote: 'Invoice checked', branchId: t.branchId },
      ]);
      expect(((await accountant.get('/approvals')).body as Array<{ entityId: string }>).some((i) => i.entityId === res.body.id)).toBe(false);

      // Final: approving or rejecting again is a conflict and posts nothing more.
      const again = await owner.post(`/vehicle-costs/${res.body.id}/approve`, {});
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('cost_not_pending');
      const rej = await owner.post(`/vehicle-costs/${res.body.id}/reject`, { reason: 'Too late to reject' });
      expect(rej.status).toBe(409);
      expect(rej.body.error.code).toBe('cost_not_pending');
      expect(await events('vehicle_cost', res.body.id)).toEqual(['cost.posted']);
      expect(await costAudit(v.id)).toEqual(['vehicle_cost.submitted', 'vehicle_cost.approved']);
    });

    it('rejecting a pending cost posts nothing, resolves the inbox item, and is final', async () => {
      const v = await createVehicle(owner, t.branchId);
      const res = await clerk.post('/vehicle-costs', cost(v.id, { amount: '275.00', description: 'Second tow (duplicate)' }), idem());
      expect(res.status).toBe(201);
      expect((await accountant.post(`/vehicle-costs/${res.body.id}/reject`, { reason: 'no' })).status).toBe(422);
      expect((await clerk.post(`/vehicle-costs/${res.body.id}/reject`, { reason: 'Rejecting my own' })).status).toBe(403);
      const rej = await accountant.post(`/vehicle-costs/${res.body.id}/reject`, { reason: 'Duplicate of invoice T-88' });
      expect(rej.status).toBe(200);
      expect(rej.body).toMatchObject({ status: 'rejected', rejectedReason: 'Duplicate of invoice T-88' });
      expect(await lines('vehicle_cost', res.body.id)).toEqual([]);
      expect(await approvalRows(res.body.id)).toMatchObject([{ status: 'rejected', decidedBy: accountantId, decisionNote: 'Duplicate of invoice T-88' }]);
      const ap = await accountant.post(`/vehicle-costs/${res.body.id}/approve`, {});
      expect(ap.status).toBe(409);
      expect(ap.body.error.code).toBe('cost_not_pending');
      const rev = await accountant.post(`/vehicle-costs/${res.body.id}/reverse`, { reason: 'Cleanup' }, idem());
      expect(rev.status).toBe(409);
      expect(rev.body.error.code).toBe('cost_not_posted');
      const summary = await accountant.get(`/vehicles/${v.id}/costs`);
      expect(summary.body.totals).toMatchObject({ posted: '0.00', pending: '0.00' });
      expect(summary.body.items.map((i: { status: string }) => i.status)).toEqual(['rejected']);
    });

    it('concurrent approvals and reversals of one cost post exactly once (row lock)', async () => {
      const v = await createVehicle(owner, t.branchId);
      const res = await clerk.post('/vehicle-costs', cost(v.id, { amount: '120.00', description: 'Jump start' }), idem());
      expect(res.status).toBe(201);
      const approvals = await Promise.all([accountant.post(`/vehicle-costs/${res.body.id}/approve`, {}), owner.post(`/vehicle-costs/${res.body.id}/approve`, {})]);
      expect(approvals.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(approvals.find((r) => r.status === 409)!.body.error.code).toBe('cost_not_pending');
      expect(await events('vehicle_cost', res.body.id)).toEqual(['cost.posted']);
      const reversals = await Promise.all([
        accountant.post(`/vehicle-costs/${res.body.id}/reverse`, { reason: 'Never happened' }, idem()),
        owner.post(`/vehicle-costs/${res.body.id}/reverse`, { reason: 'Never happened' }, idem()),
      ]);
      expect(reversals.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(reversals.find((r) => r.status === 409)!.body.error.code).toBe('cost_not_posted');
      expect(await events('vehicle_cost', res.body.id)).toEqual(['cost.posted', 'cost.reversed']);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('0.00');
    });

    it('validates category, vehicle, supplier and currency; nothing is recorded on failure', async () => {
      const v = await createVehicle(owner, t.branchId);
      const purchase = await accountant.post('/vehicle-costs', cost(v.id, { categoryId: cat.purchase, description: 'Purchase price' }), idem());
      expect(purchase.status).toBe(422);
      expect(purchase.body.error.code).toBe('purchase_via_acquisition');
      const operating = await accountant.post('/vehicle-costs', cost(v.id, { categoryId: cat.rent, description: 'Showroom rent' }), idem());
      expect(operating.status).toBe(422);
      expect(operating.body.error.code).toBe('category_not_vehicle');
      expect((await accountant.post('/vehicle-costs', cost(v.id, { categoryId: '00000000-0000-4000-8000-000000000001' }), idem())).status).toBe(404);
      expect((await accountant.post('/vehicle-costs', cost('00000000-0000-4000-8000-000000000002'), idem())).status).toBe(404);
      expect((await accountant.post('/vehicle-costs', cost(v.id, { supplierId: '00000000-0000-4000-8000-000000000003' }), idem())).status).toBe(404);
      const dormant = await createSupplier(owner, { name: 'Dormant workshop' });
      expect((await owner.patch(`/suppliers/${dormant.id}`, { isActive: false })).status).toBe(200);
      const inactive = await accountant.post('/vehicle-costs', cost(v.id, { supplierId: dormant.id }), idem());
      expect(inactive.status).toBe(422);
      expect(inactive.body.error.code).toBe('supplier_inactive');
      const noRate = await accountant.post('/vehicle-costs', cost(v.id, { currency: 'USD' }), idem());
      expect(noRate.status).toBe(422);
      expect(noRate.body.error.code).toBe('exchange_rate_required');
      const baseRate = await accountant.post('/vehicle-costs', cost(v.id, { exchangeRate: '3.75' }), idem());
      expect(baseRate.status).toBe(422);
      expect(baseRate.body.error.code).toBe('fx_rate_invalid');
      const zero = await accountant.post('/vehicle-costs', cost(v.id, { amount: '0.00' }), idem());
      expect(zero.status).toBe(422);
      expect(zero.body.error.code).toBe('validation_failed');
      expect(await costsOf(v.id)).toBe(0);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('0.00');

      // A USD invoice with its rate is converted exactly: 1234.57 × 3.75 = 4629.6375 → 4629.64.
      const usd = await accountant.post('/vehicle-costs', cost(v.id, { amount: '1234.57', currency: 'USD', exchangeRate: '3.75', description: 'Port handling (USD)' }), idem());
      expect(usd.status).toBe(201);
      expect(usd.body).toMatchObject({ amount: '1234.57', currency: 'USD', exchangeRate: '3.75000000', amountBase: '4629.64' });
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('4629.64');
    });

    it('permissions: inventory managers record pending costs, sales reps cannot read or record, only costs.reverse may reverse', async () => {
      const v = await createVehicle(owner, t.branchId);
      // The inventory manager holds costs.create but not costs.approve.
      const im = await inventory.post('/vehicle-costs', cost(v.id, { amount: '90.00', description: 'Car wash' }), idem());
      expect(im.status).toBe(201);
      expect(im.body.status).toBe('pending_approval');
      const rep = (await addMember(app, t, 'sales_rep')).client;
      expect((await rep.get(`/vehicles/${v.id}/costs`)).status).toBe(403);
      expect((await rep.get(`/vehicle-costs/${im.body.id}`)).status).toBe(403);
      expect((await rep.post('/vehicle-costs', cost(v.id), idem())).status).toBe(403);
      expect((await rep.post(`/vehicle-costs/${im.body.id}/approve`, {})).status).toBe(403);
      const posted = await accountant.post('/vehicle-costs', cost(v.id, { amount: '95.00', description: 'Wax' }), idem());
      expect(posted.status).toBe(201);
      expect((await inventory.post(`/vehicle-costs/${posted.body.id}/reverse`, { reason: 'Not needed' }, idem())).status).toBe(403);
      expect((await clerk.post(`/vehicle-costs/${posted.body.id}/reverse`, { reason: 'Not needed' }, idem())).status).toBe(403);
      expect(await events('vehicle_cost', posted.body.id)).toEqual(['cost.posted']);
      expect((await accountant.post(`/vehicle-costs/${im.body.id}/reject`, { reason: 'Included in detailing' })).status).toBe(200);
    });
  });

  describe('reversal', () => {
    it('reversing a posted cost mirrors its entry: the cost nets to zero on the GL and drops out of the summary', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '50000.00' });
      const c1 = await accountant.post('/vehicle-costs', cost(acq.vehicleId, { amount: '1200.00', description: 'Tow (wrong car)' }), idem());
      const c2 = await accountant.post('/vehicle-costs', cost(acq.vehicleId, { categoryId: cat.detailing, amount: '300.00', description: 'Polish' }), idem());
      expect([c1.status, c2.status]).toEqual([201, 201]);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('51500.00');
      const apBefore = await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id });

      expect((await accountant.post(`/vehicle-costs/${c1.body.id}/reverse`, { reason: 'x' }, idem())).status).toBe(422);
      const rev = await accountant.post(`/vehicle-costs/${c1.body.id}/reverse`, { reason: 'Invoice booked on the wrong car' }, idem());
      expect(rev.status).toBe(200);
      expect(rev.body).toMatchObject({ id: c1.body.id, status: 'reversed', reversalReason: 'Invoice booked on the wrong car' });
      expect(rev.body.reversedAt).toBeTruthy();
      expect(await lines('vehicle_cost', c1.body.id)).toEqual([
        { event: 'cost.posted', account: '1300', debit: '1200.00', credit: '0.00', vehicleId: acq.vehicleId, supplierId: null },
        { event: 'cost.posted', account: '2000', debit: '0.00', credit: '1200.00', vehicleId: acq.vehicleId, supplierId: supplier.id },
        { event: 'cost.reversed', account: '1300', debit: '0.00', credit: '1200.00', vehicleId: acq.vehicleId, supplierId: null },
        { event: 'cost.reversed', account: '2000', debit: '1200.00', credit: '0.00', vehicleId: acq.vehicleId, supplierId: supplier.id },
      ]);
      const link = await pool.query(
        `SELECT r.reversal_of_id = o.id AS linked FROM journal_entries r JOIN journal_entries o ON o.source_id = r.source_id AND o.event = 'cost.posted'
          WHERE r.source_type = 'vehicle_cost' AND r.source_id = $1 AND r.event = 'cost.reversed'`,
        [c1.body.id],
      );
      expect(link.rows).toEqual([{ linked: true }]);
      const net = await pool.query(
        `SELECT account_code, sum(debit - credit)::numeric(18,2)::text AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.source_type = 'vehicle_cost' AND e.source_id = $1 GROUP BY 1 ORDER BY 1`,
        [c1.body.id],
      );
      expect(net.rows).toEqual([
        { account_code: '1300', b: '0.00' },
        { account_code: '2000', b: '0.00' },
      ]);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('50300.00');
      expect(d(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).minus(apBefore).toFixed(2)).toBe('1200.00');

      const s = await accountant.get(`/vehicles/${acq.vehicleId}/costs`);
      expect(s.body.totals).toEqual({ posted: '50300.00', pending: '0.00', purchase: '50000.00', additional: '300.00', postSale: '0.00' });
      expect((s.body.byCategory as Array<{ code: string }>).map((b) => b.code).sort()).toEqual(['detailing', 'purchase']);
      expect((s.body.items as Array<{ id: string; status: string }>).find((i) => i.id === c1.body.id)?.status).toBe('reversed');

      const twice = await accountant.post(`/vehicle-costs/${c1.body.id}/reverse`, { reason: 'Invoice booked on the wrong car' }, idem());
      expect(twice.status).toBe(409);
      expect(twice.body.error.code).toBe('cost_not_posted');
      expect(await events('vehicle_cost', c1.body.id)).toEqual(['cost.posted', 'cost.reversed']);
      expect(await costAudit(acq.vehicleId)).toEqual(['vehicle_cost.posted', 'vehicle_cost.posted', 'vehicle_cost.posted', 'vehicle_cost.reversed']);
    });

    it('a paid cost cannot be reversed (409 cost_has_payments) until its payment is voided', async () => {
      const v = await createVehicle(owner, t.branchId);
      const cashBefore = await cashBookBalance(pool, cash.id);
      // Paid in full on creation.
      const full = await accountant.post('/vehicle-costs', cost(v.id, { amount: '800.00', payNow: { cashAccountId: cash.id, method: 'cash', reference: 'R-800' } }), idem());
      expect(full.status).toBe(201);
      // Paid in part afterwards.
      const part = await accountant.post('/vehicle-costs', cost(v.id, { categoryId: cat.inspection, amount: '500.00', description: 'Pre-purchase inspection' }), idem());
      expect(part.status).toBe(201);
      const partPay = await accountant.post(
        '/supplier-payments',
        { supplierId: supplier.id, cashAccountId: cash.id, paidAt: '2026-03-02', method: 'cash', amount: '1.00', allocations: [{ targetType: 'vehicle_cost', targetId: part.body.id, amountBase: '1.00' }] },
        idem(),
      );
      expect(partPay.status).toBe(201);
      expect((await cashBookBalance(pool, cash.id)).amount).toBe(d(cashBefore.amount).minus('801.00').toFixed(2));

      const items = (await accountant.get(`/vehicles/${v.id}/costs`)).body.items as Array<{ id: string; paidBase: string | null }>;
      expect(items.find((i) => i.id === full.body.id)?.paidBase).toBe('800.00');
      expect(items.find((i) => i.id === part.body.id)?.paidBase).toBe('1.00');

      for (const c of [full.body, part.body]) {
        const blocked = await accountant.post(`/vehicle-costs/${c.id}/reverse`, { reason: 'Supplier refunded' }, idem());
        expect(blocked.status).toBe(409);
        expect(blocked.body.error.code).toBe('cost_has_payments');
        expect(await events('vehicle_cost', c.id)).toEqual(['cost.posted']);
      }
      expect((await accountant.get(`/vehicle-costs/${full.body.id}`)).body.status).toBe('posted');

      const payments = (
        await pool.query(`SELECT DISTINCT payment_id FROM supplier_payment_allocations WHERE target_type = 'vehicle_cost' AND target_id = ANY($1::uuid[])`, [
          [full.body.id, part.body.id],
        ])
      ).rows.map((r) => r.payment_id as string);
      expect(payments).toHaveLength(2);
      for (const p of payments) expect((await accountant.post(`/supplier-payments/${p}/void`, { reason: 'Supplier refunded' }, idem())).status).toBe(200);
      for (const c of [full.body, part.body]) {
        const ok = await accountant.post(`/vehicle-costs/${c.id}/reverse`, { reason: 'Supplier refunded' }, idem());
        expect(ok.status).toBe(200);
      }
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('0.00');
      expect(await cashBookBalance(pool, cash.id)).toEqual(cashBefore);
    });

    it('the purchase price is reversed only by cancelling the acquisition (409 reverse_via_acquisition)', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '42000.00' });
      const purchaseId = await purchaseCostId(owner, acq.vehicleId);
      const res = await owner.post(`/vehicle-costs/${purchaseId}/reverse`, { reason: 'Wrong price' }, idem());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('reverse_via_acquisition');
      expect((await owner.get(`/vehicle-costs/${purchaseId}`)).body.status).toBe('posted');
      expect(await events('vehicle_cost', purchaseId)).toEqual(['cost.posted']);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('42000.00');
    });

    it('a removed vehicle takes no new costs or approvals (409 vehicle_removed); reversing a written-off cost keeps 1300 at zero', async () => {
      const v = await createVehicle(owner, t.branchId);
      const posted = await accountant.post('/vehicle-costs', cost(v.id, { amount: '2500.00', description: 'Engine diagnosis' }), idem());
      expect(posted.status).toBe(201);
      const pending = await clerk.post('/vehicle-costs', cost(v.id, { amount: '400.00', description: 'Second opinion' }), idem());
      expect(pending.status).toBe(201);
      const rm = await owner.post(`/vehicles/${v.id}/status`, { to: 'removed', reason: 'Total loss after flood' });
      expect(rm.status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '6300', { col: 'vehicle_id', id: v.id })).toBe('2500.00');

      const n = await entryCount();
      const add = await accountant.post('/vehicle-costs', cost(v.id, { amount: '100.00', description: 'Towing to scrapyard' }), idem());
      expect(add.status).toBe(409);
      expect(add.body.error.code).toBe('vehicle_removed');
      const ap = await accountant.post(`/vehicle-costs/${pending.body.id}/approve`, {});
      expect(ap.status).toBe(409);
      expect(ap.body.error.code).toBe('vehicle_removed');
      expect((await accountant.get(`/vehicle-costs/${pending.body.id}`)).body.status).toBe('pending_approval');
      expect(await entryCount()).toBe(n);
      expect((await accountant.post(`/vehicle-costs/${pending.body.id}/reject`, { reason: 'Vehicle was written off' })).status).toBe(200);

      // The write-off already took the cost out of inventory; the reversal undoes that part of it.
      const rev = await accountant.post(`/vehicle-costs/${posted.body.id}/reverse`, { reason: 'Diagnosis was under warranty' }, idem());
      expect(rev.status).toBe(200);
      expect(await events('vehicle_cost', posted.body.id)).toEqual(['cost.posted', 'cost.reversed', 'cost.write_off_reversed']);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '6300', { col: 'vehicle_id', id: v.id })).toBe('0.00');
    });

    it('after the sale is recognised, new costs need costs.post_after_sale and hit 5000 COGS; pre-sale costs are locked', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '60000.00' });
      const pre = await accountant.post('/vehicle-costs', cost(acq.vehicleId, { amount: '1000.00' }), idem());
      expect(pre.status).toBe(201);
      // Recorded before the sale, still waiting for approval when the sale is recognised.
      const waiting = await clerk.post('/vehicle-costs', cost(acq.vehicleId, { categoryId: cat.detailing, amount: '200.00', description: 'Delivery detailing' }), idem());
      expect(waiting.status).toBe(201);
      expect(waiting.body.status).toBe('pending_approval');

      // The sale flow (revenue recognition, Phase 5) does not exist yet: simulate the moment the
      // sale is recognised by setting vehicles.cost_locked_at directly through the owner pool.
      await pool.query(`UPDATE vehicles SET cost_locked_at = now() WHERE id = $1`, [acq.vehicleId]);
      const afterSale = cost(acq.vehicleId, { categoryId: cat.maintenance, amount: '700.00', description: 'Warranty repair after sale' });

      // The accountant holds costs.create/approve but not costs.post_after_sale.
      const n = await entryCount();
      const denied = await accountant.post('/vehicle-costs', afterSale, idem());
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.permission).toBe('costs.post_after_sale');
      expect((await clerk.post('/vehicle-costs', afterSale, idem())).status).toBe(403);
      expect(await entryCount()).toBe(n);

      const ok = await owner.post('/vehicle-costs', afterSale, idem());
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ status: 'posted', postSale: true, amountBase: '700.00' });
      expect(await lines('vehicle_cost', ok.body.id)).toEqual([
        { event: 'cost.posted', account: '5000', debit: '700.00', credit: '0.00', vehicleId: acq.vehicleId, supplierId: null },
        { event: 'cost.posted', account: '2000', debit: '0.00', credit: '700.00', vehicleId: acq.vehicleId, supplierId: supplier.id },
      ]);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('61000.00');

      // A cost approved after the lock also goes to COGS and needs the same permission.
      const apDenied = await accountant.post(`/vehicle-costs/${waiting.body.id}/approve`, {});
      expect(apDenied.status).toBe(403);
      expect(apDenied.body.error.details.permission).toBe('costs.post_after_sale');
      expect((await accountant.get(`/vehicle-costs/${waiting.body.id}`)).body.status).toBe('pending_approval');
      const ap = await owner.post(`/vehicle-costs/${waiting.body.id}/approve`, {});
      expect(ap.status).toBe(200);
      expect(ap.body).toMatchObject({ status: 'posted', postSale: true });
      expect((await lines('vehicle_cost', waiting.body.id)).map((l) => [l.account, l.debit, l.credit])).toEqual([
        ['5000', '200.00', '0.00'],
        ['2000', '0.00', '200.00'],
      ]);
      expect(await glBalance(pool, t.tenantId, '5000', { col: 'vehicle_id', id: acq.vehicleId })).toBe('900.00');

      const s = await owner.get(`/vehicles/${acq.vehicleId}/costs`);
      expect(s.body.costLockedAt).toBeTruthy();
      expect(s.body.totals).toEqual({ posted: '61900.00', pending: '0.00', purchase: '60000.00', additional: '1900.00', postSale: '900.00' });

      // Pre-sale costs are part of the recognised sale: locked. The purchase price keeps its own rule.
      const locked = await owner.post(`/vehicle-costs/${pre.body.id}/reverse`, { reason: 'Late correction' }, idem());
      expect(locked.status).toBe(409);
      expect(locked.body.error.code).toBe('cost_locked');
      const purchase = await owner.post(`/vehicle-costs/${await purchaseCostId(owner, acq.vehicleId)}/reverse`, { reason: 'Late correction' }, idem());
      expect(purchase.status).toBe(409);
      expect(purchase.body.error.code).toBe('reverse_via_acquisition');
      // A post-sale cost can still be reversed (it only touched COGS).
      const rev = await accountant.post(`/vehicle-costs/${ok.body.id}/reverse`, { reason: 'Repair covered by manufacturer' }, idem());
      expect(rev.status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '5000', { col: 'vehicle_id', id: acq.vehicleId })).toBe('200.00');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('61000.00');
    });
  });

  describe('summary', () => {
    it('totals by kind and category, payment status, and expected profit at the asking price under each tax setting', async () => {
      // Own tenant: the test changes company tax settings.
      const te = await createTenant(app, admin);
      const sup = await createSupplier(te.owner, { name: 'Riyadh Logistics' });
      const teClerk = (await addMemberWithPermissions(app, te, ['vehicles.read', 'costs.read', 'costs.create'])).client;
      const teCash = await createCashAccount(te.owner, { openingBalance: '10000.00' });
      const c = async (code: string) => costCategory(te.owner, code);
      const acq = await createAcquisition(te.owner, te.branchId, sup.id, { price: '80000.00' });
      const vid = acq.vehicleId;
      const body = (overrides: Record<string, unknown>) => ({ vehicleId: vid, description: 'Cost', currency: 'SAR', costDate: '2026-03-03', supplierId: sup.id, ...overrides });

      const transport = await te.owner.post('/vehicle-costs', body({ categoryId: await c('transport'), amount: '1500.00', description: 'Transport' }), idem());
      const reversed = await te.owner.post('/vehicle-costs', body({ categoryId: await c('inspection'), amount: '300.00', description: 'Inspection' }), idem());
      expect((await te.owner.post(`/vehicle-costs/${reversed.body.id}/reverse`, { reason: 'Booked twice' }, idem())).status).toBe(200);
      const pending = await teClerk.post('/vehicle-costs', body({ categoryId: await c('detailing'), amount: '500.00', description: 'Detailing' }), idem());
      const rejected = await teClerk.post('/vehicle-costs', body({ categoryId: await c('parts'), amount: '250.00', description: 'Floor mats' }), idem());
      expect((await te.owner.post(`/vehicle-costs/${rejected.body.id}/reject`, { reason: 'Not ordered' })).status).toBe(200);
      expect([transport.status, pending.status, pending.body.status]).toEqual([201, 201, 'pending_approval']);
      const pay = await te.owner.post(
        '/supplier-payments',
        { supplierId: sup.id, cashAccountId: teCash.id, paidAt: '2026-03-04', method: 'cash', amount: '600.00', allocations: [{ targetType: 'vehicle_cost', targetId: transport.body.id, amountBase: '600.00' }] },
        idem(),
      );
      expect(pay.status).toBe(201);

      const s0 = await teClerk.get(`/vehicles/${vid}/costs`);
      expect(s0.status).toBe(200);
      expect(s0.body).toMatchObject({ vehicleId: vid, currency: 'SAR', costLockedAt: null, expectedAtAskingPrice: null });
      expect(s0.body.totals).toEqual({ posted: '81500.00', pending: '500.00', purchase: '80000.00', additional: '1500.00', postSale: '0.00' });
      const byCat = (s0.body.byCategory as Array<{ code: string; total: string }>).map((b) => [b.code, b.total]).sort();
      expect(byCat).toEqual([
        ['purchase', '80000.00'],
        ['transport', '1500.00'],
      ]);
      const items = s0.body.items as Array<{ id: string; status: string; sourceType: string; categoryCode: string; supplierName: string | null; paidBase: string | null }>;
      expect(items).toHaveLength(5);
      expect(items.find((i) => i.sourceType === 'acquisition')).toMatchObject({ categoryCode: 'purchase', status: 'posted', paidBase: null });
      expect(items.find((i) => i.id === transport.body.id)).toMatchObject({ categoryCode: 'transport', supplierName: 'Riyadh Logistics', paidBase: '600.00' });
      expect(items.find((i) => i.id === pending.body.id)).toMatchObject({ status: 'pending_approval', paidBase: '0.00' });
      expect(items.map((i) => i.status).sort()).toEqual(['pending_approval', 'posted', 'posted', 'rejected', 'reversed']);

      const price = await te.owner.put(`/vehicles/${vid}/pricing`, { askingPrice: '115000.00', minPrice: '100000.00' });
      expect(price.status).toBe(200);
      const expected = async () => (await teClerk.get(`/vehicles/${vid}/costs`)).body.expectedAtAskingPrice;
      // SA default: standard VAT 15 %, prices include tax → 115,000 = 100,000 net + 15,000 tax.
      expect(await expected()).toEqual({ price: '115000.00', net: '100000.00', tax: '15000.00', grossProfit: '18500.00', marginPct: '18.50' });

      const setTax = async (tax: Record<string, unknown>) => {
        const r = await te.owner.patch('/company', { settings: { tax: { mode: 'standard', ratePct: '15', pricesIncludeTax: true, labelEn: 'VAT', labelAr: 'ضريبة القيمة المضافة', ...tax } } });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      };
      // Prices exclusive of tax: the asking price is the net price.
      await setTax({ pricesIncludeTax: false });
      expect(await expected()).toEqual({ price: '115000.00', net: '115000.00', tax: '17250.00', grossProfit: '33500.00', marginPct: '29.13' });
      // Margin scheme, tax-inclusive: tax only on the 33,500 margin → 33,500 × 15/115 = 4,369.57.
      await setTax({ mode: 'margin' });
      expect(await expected()).toEqual({ price: '115000.00', net: '110630.43', tax: '4369.57', grossProfit: '29130.43', marginPct: '26.33' });
      // No tax.
      await setTax({ mode: 'none' });
      expect(await expected()).toEqual({ price: '115000.00', net: '115000.00', tax: '0.00', grossProfit: '33500.00', marginPct: '29.13' });
      await assertLedgerIntegrity(pool, te.tenantId);
    });
  });

  describe('allocation of a shared invoice', () => {
    const allocate = (c: Client, body: Record<string, unknown>) =>
      c.post(
        '/vehicle-costs/allocate',
        { method: 'equal', categoryId: cat.transport, description: 'Car carrier Jeddah → Riyadh', totalAmount: '1000.00', currency: 'SAR', costDate: '2026-03-05', supplierId: supplier.id, ...body },
        idem(),
      );
    const vehicles = async (n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push((await createVehicle(owner, t.branchId)).id);
      return ids;
    };

    it('equal split of 1,000.00 over 3 vehicles → 333.34 / 333.33 / 333.33, exactly 1,000.00, one entry per vehicle', async () => {
      const ids = await vehicles(3);
      const apBefore = await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id });
      const n = await entryCount();
      const res = await allocate(accountant, { vehicleIds: ids });
      expect(res.status).toBe(201);
      expect(res.body.allocated).toEqual(['333.34', '333.33', '333.33']);
      const costs = res.body.costs as Array<{ id: string; vehicleId: string; amount: string; amountBase: string; status: string; sourceType: string; batchId: string; allocationMethod: string }>;
      expect(costs.map((c) => [c.vehicleId, c.amount, c.amountBase, c.status])).toEqual([
        [ids[0], '333.34', '333.34', 'posted'],
        [ids[1], '333.33', '333.33', 'posted'],
        [ids[2], '333.33', '333.33', 'posted'],
      ]);
      expect(new Set(costs.map((c) => c.batchId))).toEqual(new Set([res.body.batchId]));
      expect(costs.every((c) => c.sourceType === 'allocation' && c.allocationMethod === 'equal')).toBe(true);
      expect(sum(costs.map((c) => c.amountBase)).toFixed(2)).toBe('1000.00');
      for (const [i, id] of ids.entries()) expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id })).toBe(costs[i]!.amountBase);
      expect(d(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).minus(apBefore).toFixed(2)).toBe('-1000.00');
      expect(await entryCount()).toBe(n + 3);
    });

    it('by purchase price: proportional to posted purchase prices, remainder cents to the largest fractions; vehicles without one get nothing', async () => {
      const a = await createAcquisition(owner, t.branchId, supplier.id, { price: '70000.00' });
      const b = await createAcquisition(owner, t.branchId, supplier.id, { price: '20000.00' });
      const c = await createAcquisition(owner, t.branchId, supplier.id, { price: '10000.00' });
      // 999.99 × 0.7 / 0.2 / 0.1 = 699.993 / 199.998 / 99.999 → floors 699.99 / 199.99 / 99.99 + 2 cents.
      const res = await allocate(accountant, { method: 'by_purchase_price', vehicleIds: [a.vehicleId, b.vehicleId, c.vehicleId], totalAmount: '999.99' });
      expect(res.status).toBe(201);
      expect(res.body.allocated).toEqual(['699.99', '200.00', '100.00']);
      expect(sum(res.body.costs.map((x: { amountBase: string }) => x.amountBase)).toFixed(2)).toBe('999.99');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: a.vehicleId })).toBe('70699.99');

      // A vehicle with no posted purchase price weighs zero: no cost row is created for it.
      const [plain] = await vehicles(1);
      const mixed = await allocate(accountant, { method: 'by_purchase_price', vehicleIds: [a.vehicleId, plain], totalAmount: '500.00' });
      expect(mixed.status).toBe(201);
      expect(mixed.body.allocated).toEqual(['500.00', '0.00']);
      expect(mixed.body.costs.map((x: { vehicleId: string }) => x.vehicleId)).toEqual([a.vehicleId]);
      expect(await costsOf(plain!)).toBe(0);
      // None has a purchase price → refused.
      const none = await allocate(accountant, { method: 'by_purchase_price', vehicleIds: await vehicles(2) });
      expect(none.status).toBe(422);
      expect(none.body.error.code).toBe('no_purchase_prices');
    });

    it('manual amounts must add up exactly; duplicate or single vehicles and missing amounts are rejected; nothing is recorded', async () => {
      const ids = await vehicles(2);
      const n = await entryCount();
      const off = await allocate(accountant, { method: 'manual', vehicleIds: ids, manualAmounts: ['400.00', '599.99'] });
      expect(off.status).toBe(422);
      expect(off.body.error.code).toBe('manual_total_mismatch');
      expect(off.body.error.details.total).toBe('999.99');
      const missing = await allocate(accountant, { method: 'manual', vehicleIds: ids });
      expect(missing.status).toBe(422);
      expect(missing.body.error.code).toBe('validation_failed');
      expect(missing.body.error.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'manualAmounts', message: 'manual_amounts_required' })]));
      const shortList = await allocate(accountant, { method: 'manual', vehicleIds: ids, manualAmounts: ['1000.00'] });
      expect(shortList.status).toBe(422);
      expect(shortList.body.error.code).toBe('validation_failed');
      // Duplicate vehicle ids are a validation error (the API reports every schema violation as 422 validation_failed).
      const dup = await allocate(accountant, { vehicleIds: [ids[0], ids[0], ids[1]] });
      expect(dup.status).toBe(422);
      expect(dup.body.error.code).toBe('validation_failed');
      expect(dup.body.error.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'vehicleIds', message: 'duplicate_vehicle' })]));
      const single = await allocate(accountant, { vehicleIds: [ids[0]] });
      expect(single.status).toBe(422);
      expect(single.body.error.code).toBe('validation_failed');
      const purchase = await allocate(accountant, { vehicleIds: ids, categoryId: cat.purchase });
      expect(purchase.status).toBe(422);
      expect(purchase.body.error.code).toBe('purchase_via_acquisition');
      expect(await entryCount()).toBe(n);
      for (const id of ids) expect(await costsOf(id)).toBe(0);

      const ok = await allocate(accountant, { method: 'manual', vehicleIds: ids, manualAmounts: ['250.00', '750.00'] });
      expect(ok.status).toBe(201);
      expect(ok.body.allocated).toEqual(['250.00', '750.00']);
      expect(ok.body.costs.map((c: { amountBase: string; allocationMethod: string }) => [c.amountBase, c.allocationMethod])).toEqual([
        ['250.00', 'manual'],
        ['750.00', 'manual'],
      ]);
    });

    it('payNow on a batch creates ONE supplier payment allocated to each cost', async () => {
      const ids = await vehicles(3);
      const cashBefore = await cashBookBalance(pool, cash.id);
      const res = await allocate(accountant, { vehicleIds: ids, totalAmount: '900.00', payNow: { cashAccountId: cash.id, method: 'cash', reference: 'CARRIER-77' } });
      expect(res.status).toBe(201);
      const costIds = (res.body.costs as Array<{ id: string }>).map((c) => c.id);
      const allocs = (
        await pool.query(`SELECT payment_id, target_type, target_id, amount_base FROM supplier_payment_allocations WHERE target_id = ANY($1::uuid[]) ORDER BY amount_base, target_id`, [costIds])
      ).rows;
      expect(allocs).toHaveLength(3);
      const paymentIds = new Set(allocs.map((a) => a.payment_id as string));
      expect(paymentIds.size).toBe(1);
      expect(allocs.every((a) => a.target_type === 'vehicle_cost' && a.amount_base === '300.00')).toBe(true);
      expect(allocs.map((a) => a.target_id).sort()).toEqual([...costIds].sort());
      const [paymentId] = [...paymentIds];
      const p = await accountant.get(`/supplier-payments/${paymentId}`);
      expect(p.body).toMatchObject({ supplierId: supplier.id, cashAccountId: cash.id, amount: '900.00', amountBase: '900.00', status: 'posted', reference: 'CARRIER-77' });
      const cashRows = await pool.query(`SELECT count(*)::int AS n FROM cash_transactions WHERE source_type = 'supplier_payment' AND source_id = $1`, [paymentId]);
      expect(cashRows.rows[0].n).toBe(1);
      expect((await cashBookBalance(pool, cash.id)).amount).toBe(d(cashBefore.amount).minus('900.00').toFixed(2));
      for (const id of ids) {
        const item = (await accountant.get(`/vehicles/${id}/costs`)).body.items[0];
        expect(item).toMatchObject({ amountBase: '300.00', paidBase: '300.00' });
      }
    });

    it('is atomic: a batch with unapproved costs cannot be paid, and a removed vehicle fails the whole batch', async () => {
      const ids = await vehicles(3);
      const n = await entryCount();
      const unapproved = await allocate(clerk, { vehicleIds: ids, payNow: { cashAccountId: cash.id, method: 'cash' } });
      expect(unapproved.status).toBe(422);
      expect(unapproved.body.error.code).toBe('cannot_pay_unapproved');
      for (const id of ids) expect(await costsOf(id)).toBe(0);
      const requests = await pool.query(`SELECT count(*)::int AS n FROM approval_requests WHERE payload->>'vehicleId' = ANY($1::text[])`, [ids]);
      expect(requests.rows[0].n).toBe(0);

      expect((await owner.post(`/vehicles/${ids[2]}/status`, { to: 'removed', reason: 'Sold for parts' })).status).toBe(200);
      const removed = await allocate(accountant, { vehicleIds: ids });
      expect(removed.status).toBe(409);
      expect(removed.body.error.code).toBe('vehicle_removed');
      for (const id of ids) expect(await costsOf(id)).toBe(0);
      expect(await entryCount()).toBe(n);

      // Without payNow the clerk's batch is recorded as pending costs, one approval request each.
      const pending = await allocate(clerk, { vehicleIds: ids.slice(0, 2) });
      expect(pending.status).toBe(201);
      expect(pending.body.costs.map((c: { status: string }) => c.status)).toEqual(['pending_approval', 'pending_approval']);
      for (const c of pending.body.costs) expect(await approvalRows(c.id)).toMatchObject([{ status: 'pending', type: 'vehicle_cost' }]);
      expect(await entryCount()).toBe(n);
    });

    it('allocates a USD invoice in USD and converts each part at the stated rate (900.00 USD @ 3.75)', async () => {
      const ids = await vehicles(3);
      const noRate = await allocate(accountant, { vehicleIds: ids, totalAmount: '900.00', currency: 'USD' });
      expect(noRate.status).toBe(422);
      expect(noRate.body.error.code).toBe('exchange_rate_required');
      const res = await allocate(accountant, { vehicleIds: ids, totalAmount: '900.00', currency: 'USD', exchangeRate: '3.75' });
      expect(res.status).toBe(201);
      expect(res.body.allocated).toEqual(['300.00', '300.00', '300.00']);
      expect(res.body.costs.map((c: { amount: string; currency: string; exchangeRate: string; amountBase: string }) => [c.amount, c.currency, c.exchangeRate, c.amountBase])).toEqual([
        ['300.00', 'USD', '3.75000000', '1125.00'],
        ['300.00', 'USD', '3.75000000', '1125.00'],
        ['300.00', 'USD', '3.75000000', '1125.00'],
      ]);
      for (const id of ids) expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id })).toBe('1125.00');
      // Paying a foreign-currency batch immediately needs a base-currency account (SAR here): fine.
      const paid = await allocate(accountant, { vehicleIds: ids.slice(0, 2), totalAmount: '200.00', currency: 'USD', exchangeRate: '3.75', payNow: { cashAccountId: cash.id, method: 'cash' } });
      expect(paid.status).toBe(201);
      const pid = (await pool.query(`SELECT DISTINCT payment_id FROM supplier_payment_allocations WHERE target_id = $1`, [paid.body.costs[0].id])).rows[0].payment_id;
      expect((await accountant.get(`/supplier-payments/${pid}`)).body).toMatchObject({ amount: '750.00', currency: 'SAR', amountBase: '750.00' });
    });

    // BUG: Foreign-currency allocation converts each part separately, so the batch's base total drifts from the invoice's base amount
    it('the base amounts of a USD allocation add up to the converted invoice (1,000.00 USD @ 3.75 = 3,750.00)', async () => {
      const ids = await vehicles(3);
      const apBefore = await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id });
      const res = await allocate(accountant, { vehicleIds: ids, totalAmount: '1000.00', currency: 'USD', exchangeRate: '3.75' });
      expect(res.status).toBe(201);
      expect(res.body.allocated).toEqual(['333.34', '333.33', '333.33']);
      // One supplier invoice of USD 1,000.00 at 3.75 is a SAR 3,750.00 liability — not 3,750.01.
      expect(sum(res.body.costs.map((c: { amountBase: string }) => c.amountBase)).toFixed(2)).toBe('3750.00');
      expect(d(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).minus(apBefore).toFixed(2)).toBe('-3750.00');
    });
  });

  describe('scope', () => {
    it('branch-scoped users cannot read, record, decide or reverse costs of another branch', async () => {
      const b2 = await createBranch(owner, 'Dammam');
      const scoped = (await addMember(app, t, 'branch_manager', { allBranches: false, branchIds: [b2.id] })).client;
      const v = await createVehicle(owner, t.branchId);
      const posted = await accountant.post('/vehicle-costs', cost(v.id, { amount: '310.00' }), idem());
      const pending = await clerk.post('/vehicle-costs', cost(v.id, { amount: '320.00' }), idem());
      expect([posted.status, pending.status]).toEqual([201, 201]);
      const n = await entryCount();
      expect((await scoped.get(`/vehicles/${v.id}/costs`)).status).toBe(403);
      expect((await scoped.get(`/vehicle-costs/${posted.body.id}`)).status).toBe(403);
      expect((await scoped.post('/vehicle-costs', cost(v.id), idem())).status).toBe(403);
      expect((await scoped.post(`/vehicle-costs/${pending.body.id}/approve`, {})).status).toBe(403);
      expect((await scoped.post(`/vehicle-costs/${pending.body.id}/reject`, { reason: 'Not my branch' })).status).toBe(403);
      expect((await scoped.post(`/vehicle-costs/${posted.body.id}/reverse`, { reason: 'Not my branch' }, idem())).status).toBe(403);
      const own = await createVehicle(owner, b2.id);
      const mixed = await scoped.post(
        '/vehicle-costs/allocate',
        { vehicleIds: [own.id, v.id], method: 'equal', categoryId: cat.transport, description: 'Shared carrier', totalAmount: '100.00', currency: 'SAR', costDate: '2026-03-05' },
        idem(),
      );
      expect(mixed.status).toBe(403);
      expect(await costsOf(own.id)).toBe(0);
      const pend = (await scoped.get('/vehicle-costs/pending')).body as Array<{ cost: { id: string } }>;
      expect(pend.some((r) => r.cost.id === pending.body.id)).toBe(false);
      expect(((await scoped.get('/approvals')).body as Array<{ entityId: string }>).some((i) => i.entityId === pending.body.id)).toBe(false);
      expect(await entryCount()).toBe(n);
      // In their own branch they record (and, holding costs.approve, post) costs.
      const mine = await scoped.post('/vehicle-costs', cost(own.id, { amount: '150.00' }), idem());
      expect(mine.status).toBe(201);
      expect(mine.body.status).toBe('posted');
      expect((await accountant.post(`/vehicle-costs/${pending.body.id}/reject`, { reason: 'Cleanup after scope test' })).status).toBe(200);
    });

    it("another company gets 404 for every cost route and cannot cost our vehicles", async () => {
      const v = await createVehicle(owner, t.branchId);
      const posted = await accountant.post('/vehicle-costs', cost(v.id, { amount: '330.00' }), idem());
      const pending = await clerk.post('/vehicle-costs', cost(v.id, { amount: '340.00' }), idem());
      const other = t2.owner;
      const otherCat = await costCategory(other, 'transport');
      expect((await other.get(`/vehicle-costs/${posted.body.id}`)).status).toBe(404);
      expect((await other.get(`/vehicles/${v.id}/costs`)).status).toBe(404);
      expect((await other.post(`/vehicle-costs/${pending.body.id}/approve`, {})).status).toBe(404);
      expect((await other.post(`/vehicle-costs/${pending.body.id}/reject`, { reason: 'hostile' })).status).toBe(404);
      expect((await other.post(`/vehicle-costs/${posted.body.id}/reverse`, { reason: 'hostile' }, idem())).status).toBe(404);
      const create = await other.post('/vehicle-costs', { ...cost(v.id), categoryId: otherCat, supplierId: null }, idem());
      expect(create.status).toBe(404);
      const own = await createVehicle(other, t2.branchId);
      const alloc = await other.post(
        '/vehicle-costs/allocate',
        { vehicleIds: [own.id, v.id], method: 'equal', categoryId: otherCat, description: 'hostile', totalAmount: '100.00', currency: 'SAR', costDate: '2026-03-05' },
        idem(),
      );
      expect(alloc.status).toBe(404);
      expect(((await other.get('/vehicle-costs/pending')).body as unknown[]).length).toBe(0);
      expect((await accountant.get(`/vehicle-costs/${pending.body.id}`)).body.status).toBe('pending_approval');
      expect(await events('vehicle_cost', posted.body.id)).toEqual(['cost.posted']);
      expect((await accountant.post(`/vehicle-costs/${pending.body.id}/reject`, { reason: 'Cleanup after isolation test' })).status).toBe(200);
      await assertLedgerIntegrity(pool, t2.tenantId);
    });
  });
});
