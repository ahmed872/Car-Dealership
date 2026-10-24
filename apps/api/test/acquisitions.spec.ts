import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { d } from '@autohub/shared';
import {
  addMemberWithPermissions,
  assertLedgerIntegrity,
  catalogIds,
  cashBookBalance,
  costCategory,
  createAcquisition,
  createBranch,
  createCashAccount,
  createSupplier,
  glBalance,
  secondApprover,
  setFxReferences,
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

/**
 * Acquisition (vehicle purchase) lifecycle against a real database: draft → submit → reject →
 * versioned edit → approve (one purchase cost + one balanced GL entry), pay-on-approval, FX
 * conversion and rounding, and the cancel rules. Every test leaves the tenant's books balanced.
 */
describe('acquisitions', () => {
  let app: INestApplication;
  let admin: Client;
  let t: TestTenant;
  let t2: TestTenant;
  let pool: Pool;
  let owner: Client;
  let inventory: Client;
  let accountant: Client;
  /** A second owner: maker-checker forbids the creator approving their own purchase. */
  let checker: Client;
  let supplier: { id: string };
  let cash: { id: string };
  let usdBank: { id: string };
  let ids: { makeId: string; modelId: string };

  const body = (overrides: Record<string, unknown> = {}) => ({
    branchId: t.branchId,
    supplierId: supplier.id,
    sourceType: 'company',
    purchaseDate: '2026-02-01',
    purchasePrice: '80000.00',
    currency: 'SAR',
    submit: false,
    vehicle: { ...ids, modelYear: 2021, odometerValue: 52000, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'Black' },
    ...overrides,
  });

  const entriesFor = async (sourceType: string, sourceId: string) =>
    (await pool.query(`SELECT id, event FROM journal_entries WHERE source_type = $1 AND source_id = $2 ORDER BY entry_no`, [sourceType, sourceId])).rows as Array<{
      id: string;
      event: string;
    }>;
  const entryCount = async (tenantId: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1`, [tenantId])).rows[0].n);
  const purchaseCosts = async (acqId: string) =>
    (await pool.query(`SELECT id, status, amount, currency, amount_base AS "amountBase" FROM vehicle_costs WHERE source_type = 'acquisition' AND source_id = $1`, [acqId]))
      .rows as Array<{ id: string; status: string; amount: string; currency: string; amountBase: string }>;

  beforeAll(async () => {
    app = await getApp();
    admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    t2 = await createTenant(app, admin);
    pool = ownerPool();
    owner = t.owner;
    // The FX specs use 3.6725 against a 3.75 reference (2.07% apart) on purpose: a 3% band.
    await setFxReferences(owner, { USD: '3.75', EUR: '3.7' }, '3');
    inventory = (await addMember(app, t, 'inventory_manager')).client;
    accountant = (await addMember(app, t, 'accountant')).client;
    checker = await secondApprover(owner);
    supplier = await createSupplier(owner, { name: 'Al Majd Motors' });
    cash = await createCashAccount(owner, { name: 'Main safe', openingBalance: '500000.00' });
    usdBank = await createCashAccount(owner, { type: 'bank', name: 'USD bank', currency: 'USD', openingBalance: '10000.00', exchangeRate: '3.75' });
    ids = await catalogIds(owner);
  });

  afterEach(async () => {
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('draft → submit → reject → versioned edit → submit → approve posts one purchase cost and one GL entry', async () => {
    // Draft (submit=false) by the inventory manager: vehicle registered as incoming, nothing posted.
    const before = await entryCount(t.tenantId);
    const created = await inventory.post('/acquisitions', body(), idem());
    expect(created.status).toBe(201);
    const acq = created.body;
    expect(acq.status).toBe('draft');
    expect(acq.number).toMatch(/^[A-Z]+-/);
    expect(acq.purchasePriceBase).toBe('80000.00');
    const veh = (await pool.query(`SELECT status, acquisition_id, supplier_id, branch_id FROM vehicles WHERE id = $1`, [acq.vehicleId])).rows[0];
    expect(veh).toMatchObject({ status: 'incoming', acquisition_id: acq.id, supplier_id: supplier.id, branch_id: t.branchId });
    expect(await entryCount(t.tenantId)).toBe(before);
    expect((await owner.get('/approvals')).body.some((r: { entityId: string }) => r.entityId === acq.id)).toBe(false);

    // Submit: an approval request appears for approvers only.
    const sub = await inventory.post(`/acquisitions/${acq.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('pending_approval');
    expect((await owner.get('/approvals')).body.some((r: { entityId: string; type: string }) => r.entityId === acq.id && r.type === 'acquisition')).toBe(true);
    expect((await inventory.get('/approvals')).body.some((r: { entityId: string }) => r.entityId === acq.id)).toBe(false);
    // Submitting twice is refused.
    expect((await inventory.post(`/acquisitions/${acq.id}/submit`)).body.error.code).toBe('acquisition_not_draft');

    // Neither the inventory manager nor the accountant holds acquisitions.approve.
    const im = await inventory.post(`/acquisitions/${acq.id}/approve`, {}, idem());
    expect(im.status).toBe(403);
    const ac = await accountant.post(`/acquisitions/${acq.id}/approve`, {}, idem());
    expect(ac.status).toBe(403);
    expect((await inventory.post(`/acquisitions/${acq.id}/reject`, { reason: 'Not mine to decide' })).status).toBe(403);

    // Reject → back to draft, approval request resolved as rejected with the note.
    const rej = await owner.post(`/acquisitions/${acq.id}/reject`, { reason: 'Price too high, renegotiate' });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('draft');
    const reqs = (await pool.query(`SELECT status, decision_note FROM approval_requests WHERE entity_id = $1 ORDER BY requested_at`, [acq.id])).rows;
    expect(reqs).toEqual([{ status: 'rejected', decision_note: 'Price too high, renegotiate' }]);
    expect((await owner.get('/approvals')).body.some((r: { entityId: string }) => r.entityId === acq.id)).toBe(false);
    // Rejecting a draft is refused.
    expect((await owner.post(`/acquisitions/${acq.id}/reject`, { reason: 'again' })).body.error.code).toBe('acquisition_not_pending');

    // Optimistic locking on edits.
    const stale = await inventory.patch(`/acquisitions/${acq.id}`, { version: acq.version, purchasePrice: '78000.00' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.details.currentVersion).toBe(rej.body.version);
    const edited = await inventory.patch(`/acquisitions/${acq.id}`, { version: rej.body.version, purchasePrice: '78000.00', notes: 'Renegotiated' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ purchasePrice: '78000.00', purchasePriceBase: '78000.00', version: rej.body.version + 1, notes: 'Renegotiated' });

    // Re-submit and approve.
    expect((await inventory.post(`/acquisitions/${acq.id}/submit`)).status).toBe(200);
    const key = idem();
    const ap = await owner.post(`/acquisitions/${acq.id}/approve`, { note: 'OK' }, key);
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe('approved');
    expect(ap.body.payment).toBeNull();

    const costs = await purchaseCosts(acq.id);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ status: 'posted', amount: '78000.00', currency: 'SAR', amountBase: '78000.00' });
    const entries = await entriesFor('vehicle_cost', costs[0]!.id);
    expect(entries.map((e) => e.event)).toEqual(['cost.posted']);
    const lines = (
      await pool.query(`SELECT account_code, debit, credit, vehicle_id, supplier_id FROM journal_lines WHERE entry_id = $1 ORDER BY line_no`, [entries[0]!.id])
    ).rows;
    expect(lines).toEqual([
      { account_code: '1300', debit: '78000.00', credit: '0.00', vehicle_id: acq.vehicleId, supplier_id: null },
      { account_code: '2000', debit: '0.00', credit: '78000.00', vehicle_id: acq.vehicleId, supplier_id: supplier.id },
    ]);
    expect(await entryCount(t.tenantId)).toBe(before + 1);
    const reqs2 = (await pool.query(`SELECT status FROM approval_requests WHERE entity_id = $1 ORDER BY requested_at`, [acq.id])).rows.map((r) => r.status);
    expect(reqs2).toEqual(['rejected', 'approved']);

    // Replaying the same Idempotency-Key returns the stored response and posts nothing.
    // (The replayed status code is covered by the it.fails test below — known core bug.)
    const replay = await owner.post(`/acquisitions/${acq.id}/approve`, { note: 'OK' }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.status).toBe('approved');
    expect(replay.body.id).toBe(acq.id);
    // A second approval (new key) is a conflict.
    const twice = await owner.post(`/acquisitions/${acq.id}/approve`, {}, idem());
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('acquisition_not_pending');
    expect(await purchaseCosts(acq.id)).toHaveLength(1);
    expect(await entryCount(t.tenantId)).toBe(before + 1);

    // Approved purchases are frozen.
    const late = await inventory.patch(`/acquisitions/${acq.id}`, { version: ap.body.version, purchasePrice: '1.00' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('acquisition_locked');

    const detail = await owner.get(`/acquisitions/${acq.id}`);
    expect(detail.body).toMatchObject({ status: 'approved', paidBase: '0.00', outstandingBase: '78000.00' });
    expect(detail.body.vehicle.status).toBe('incoming');
    const audit = (await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'acquisition' AND entity_id = $1 ORDER BY seq`, [acq.id])).rows.map((r) => r.action);
    expect(audit).toEqual([
      'acquisition.created',
      'acquisition.submitted',
      'acquisition.rejected',
      'acquisition.updated',
      'acquisition.submitted',
      'acquisition.approved',
    ]);
  });

  it('a replayed @HttpCode(200) POST keeps its 200 status', async () => {
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { approve: false });
    const key = idem();
    const first = await checker.post(`/acquisitions/${acq.id}/approve`, {}, key);
    expect(first.status).toBe(200);
    const replay = await checker.post(`/acquisitions/${acq.id}/approve`, {}, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.status).toBe(200);
  });

  it('maker-checker: the creator or the submitter cannot approve their own purchase (B-016)', async () => {
    // Created and submitted by the owner → the owner may not approve, another approver may.
    const own = await createAcquisition(owner, t.branchId, supplier.id, { approve: false });
    const n = await entryCount(t.tenantId);
    const self = await owner.post(`/acquisitions/${own.id}/approve`, {}, idem());
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval_forbidden');
    expect(await entryCount(t.tenantId)).toBe(n);
    expect(await purchaseCosts(own.id)).toHaveLength(0);
    // The inbox still lists it for the owner (they hold the permission) but marks it undecidable.
    const inbox = (await owner.get('/approvals')).body as Array<{ entityId: string; canDecide: boolean }>;
    expect(inbox.find((i) => i.entityId === own.id)?.canDecide).toBe(false);
    expect(((await checker.get('/approvals')).body as Array<{ entityId: string; canDecide: boolean }>).find((i) => i.entityId === own.id)?.canDecide).toBe(true);
    expect((await checker.post(`/acquisitions/${own.id}/approve`, {}, idem())).status).toBe(200);

    // A buyer who holds approval rights creates a draft; the owner submits it. Both are makers.
    const buyer = (
      await addMemberWithPermissions(app, t, ['vehicles.read', 'vehicles.create', 'suppliers.read', 'acquisitions.read', 'acquisitions.create', 'acquisitions.approve'])
    ).client;
    const draft = await buyer.post('/acquisitions', body({ submit: false }), idem());
    expect(draft.status).toBe(201);
    const creatorDraft = await buyer.post(`/acquisitions/${draft.body.id}/approve`, {}, idem());
    expect(creatorDraft.status).toBe(403);
    expect(creatorDraft.body.error.code).toBe('self_approval_forbidden');
    expect((await owner.post(`/acquisitions/${draft.body.id}/submit`)).status).toBe(200);
    for (const maker of [owner, buyer]) {
      const r = await maker.post(`/acquisitions/${draft.body.id}/approve`, {}, idem());
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('self_approval_forbidden');
    }
    expect((await checker.post(`/acquisitions/${draft.body.id}/approve`, {}, idem())).status).toBe(200);
  });

  it('creating with submit=true opens the approval immediately; inactive suppliers are refused', async () => {
    const res = await inventory.post('/acquisitions', body({ submit: true }), idem());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_approval');
    expect((await owner.get('/approvals')).body.some((r: { entityId: string }) => r.entityId === res.body.id)).toBe(true);

    const dormant = await createSupplier(owner, { name: 'Dormant trader' });
    expect((await owner.patch(`/suppliers/${dormant.id}`, { isActive: false })).status).toBe(200);
    const bad = await inventory.post('/acquisitions', body({ supplierId: dormant.id }), idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('supplier_inactive');
  });

  it('pay-on-approval pays in full from a base-currency account; a USD account is refused and nothing is posted', async () => {
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '60000.00', approve: false });
    const cashBefore = await cashBookBalance(pool, cash.id);
    const apBefore = await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id });
    const ap = await checker.post(`/acquisitions/${acq.id}/approve`, { payNow: { cashAccountId: cash.id, method: 'cash', reference: 'RCPT-1' } }, idem());
    expect(ap.status).toBe(200);
    expect(ap.body.payment).toMatchObject({ amount: '60000.00', amountBase: '60000.00', currency: 'SAR', supplierId: supplier.id, cashAccountId: cash.id });
    expect(ap.body.payment.allocations).toEqual([{ targetType: 'acquisition', targetId: acq.id, amountBase: '60000.00', settledBase: '60000.00', amountDoc: '60000.00', currency: 'SAR' }]);
    const detail = await owner.get(`/acquisitions/${acq.id}`);
    expect(detail.body).toMatchObject({ paidBase: '60000.00', outstandingBase: '0.00' });
    expect(detail.body.payments).toHaveLength(1);
    const cashAfter = await cashBookBalance(pool, cash.id);
    expect(cashAfter.amount).toBe(d(cashBefore.amount).minus('60000.00').toFixed(2));
    // Purchase and payment both hit the supplier's AP: net change zero.
    expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).toBe(apBefore);

    // Pay-now from a USD account: refused, and the whole approval rolls back.
    const usd = await createAcquisition(owner, t.branchId, supplier.id, { price: '30000.00', approve: false });
    const n = await entryCount(t.tenantId);
    const bad = await checker.post(`/acquisitions/${usd.id}/approve`, { payNow: { cashAccountId: usdBank.id, method: 'bank_transfer' } }, idem());
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('pay_now_base_currency');
    expect((await owner.get(`/acquisitions/${usd.id}`)).body.status).toBe('pending_approval');
    expect(await purchaseCosts(usd.id)).toHaveLength(0);
    expect(await entryCount(t.tenantId)).toBe(n);

    // Pay-now also needs supplier_payments.create: an approver without it is refused (and nothing sticks)…
    const approver = (await addMemberWithPermissions(app, t, ['acquisitions.read', 'acquisitions.approve', 'cash.read'])).client;
    const denied = await approver.post(`/acquisitions/${usd.id}/approve`, { payNow: { cashAccountId: cash.id, method: 'cash' } }, idem());
    expect(denied.status).toBe(403);
    expect((await owner.get(`/acquisitions/${usd.id}`)).body.status).toBe('pending_approval');
    expect(await entryCount(t.tenantId)).toBe(n);
    // …but can approve without paying.
    const ok = await approver.post(`/acquisitions/${usd.id}/approve`, {}, idem());
    expect(ok.status).toBe(200);
    expect(ok.body.payment).toBeNull();
    expect(await entryCount(t.tenantId)).toBe(n + 1);
  });

  describe('FX', () => {
    it('USD 20,000.00 @ 3.7500 → 75,000.00 base; GL equals the stored base amount', async () => {
      const res = await owner.post('/acquisitions', body({ purchasePrice: '20000.00', currency: 'USD', exchangeRate: '3.7500', submit: true }), idem());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ purchasePrice: '20000.00', currency: 'USD', exchangeRate: '3.75000000', purchasePriceBase: '75000.00' });
      expect((await checker.post(`/acquisitions/${res.body.id}/approve`, {}, idem())).status).toBe(200);
      const [cost] = await purchaseCosts(res.body.id);
      expect(cost).toMatchObject({ amount: '20000.00', currency: 'USD', amountBase: '75000.00' });
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: res.body.vehicleId })).toBe('75000.00');
    });

    it('odd rates round half-up to 2 dp (3.6725 × 12,345.67 = 45,339.473075 → 45,339.47)', async () => {
      const res = await owner.post('/acquisitions', body({ purchasePrice: '12345.67', currency: 'USD', exchangeRate: '3.6725', submit: true }), idem());
      expect(res.status).toBe(201);
      expect(res.body.purchasePriceBase).toBe('45339.47');
      expect((await checker.post(`/acquisitions/${res.body.id}/approve`, {}, idem())).status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: res.body.vehicleId })).toBe('45339.47');

      // Exact half: 100.05 × 3.7 = 370.185 → 370.19 under half_up.
      const half = await owner.post('/acquisitions', body({ purchasePrice: '100.05', currency: 'EUR', exchangeRate: '3.7', submit: true }), idem());
      expect(half.body.purchasePriceBase).toBe('370.19');
      expect((await checker.post(`/acquisitions/${half.body.id}/approve`, {}, idem())).status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: half.body.vehicleId })).toBe('370.19');
    });

    it('uses the tenant rounding mode (half_even: 370.185 → 370.18)', async () => {
      const te = await createTenant(app, admin);
      await setFxReferences(te.owner, { EUR: '3.7' });
      const set = await te.owner.patch('/company', { settings: { rounding: 'half_even' } });
      expect(set.status).toBe(200);
      const sup = await createSupplier(te.owner);
      const res = await te.owner.post(
        '/acquisitions',
        { ...body({ purchasePrice: '100.05', currency: 'EUR', exchangeRate: '3.7', submit: true }), branchId: te.branchId, supplierId: sup.id },
        idem(),
      );
      expect(res.status).toBe(201);
      expect(res.body.purchasePriceBase).toBe('370.18');
      expect((await (await secondApprover(te.owner)).post(`/acquisitions/${res.body.id}/approve`, {}, idem())).status).toBe(200);
      expect(await glBalance(pool, te.tenantId, '1300', { col: 'vehicle_id', id: res.body.vehicleId })).toBe('370.18');
      await assertLedgerIntegrity(pool, te.tenantId);
    });

    it('a foreign currency needs a rate; the base currency only accepts rate 1; edits re-price', async () => {
      const vehiclesBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM vehicles WHERE tenant_id = $1`, [t.tenantId])).rows[0].n);
      const noRate = await owner.post('/acquisitions', body({ currency: 'USD' }), idem());
      expect(noRate.status).toBe(422);
      expect(noRate.body.error.code).toBe('exchange_rate_required');
      const zero = await owner.post('/acquisitions', body({ currency: 'USD', exchangeRate: '0' }), idem());
      expect(zero.status).toBe(422);
      expect(zero.body.error.code).toBe('exchange_rate_required');
      const baseRate = await owner.post('/acquisitions', body({ currency: 'SAR', exchangeRate: '3.75' }), idem());
      expect(baseRate.status).toBe(422);
      expect(baseRate.body.error.code).toBe('fx_rate_invalid');
      expect(Number((await pool.query(`SELECT count(*)::int AS n FROM vehicles WHERE tenant_id = $1`, [t.tenantId])).rows[0].n)).toBe(vehiclesBefore);
      const one = await owner.post('/acquisitions', body({ currency: 'SAR', exchangeRate: '1.0000' }), idem());
      expect(one.status).toBe(201);

      // Switching a draft to USD without a rate is refused; with a rate it re-prices.
      const toUsd = await owner.patch(`/acquisitions/${one.body.id}`, { version: one.body.version, currency: 'USD' });
      expect(toUsd.status).toBe(422);
      expect(toUsd.body.error.code).toBe('exchange_rate_required');
      const repriced = await owner.patch(`/acquisitions/${one.body.id}`, { version: one.body.version, currency: 'USD', purchasePrice: '10000.00', exchangeRate: '3.75' });
      expect(repriced.status).toBe(200);
      expect(repriced.body).toMatchObject({ currency: 'USD', purchasePriceBase: '37500.00' });
      // Price-only edit keeps the stored rate.
      const p2 = await owner.patch(`/acquisitions/${one.body.id}`, { version: repriced.body.version, purchasePrice: '10001.00' });
      expect(p2.body.purchasePriceBase).toBe('37503.75');
      // Back to base currency: the rate resets to 1.
      const back = await owner.patch(`/acquisitions/${one.body.id}`, { version: p2.body.version, currency: 'SAR', purchasePrice: '40000.00' });
      expect(back.body).toMatchObject({ currency: 'SAR', exchangeRate: '1.00000000', purchasePriceBase: '40000.00' });
    });
  });

  describe('cancel', () => {
    it('a draft cancel removes the vehicle and posts nothing', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { submit: false, approve: false });
      const n = await entryCount(t.tenantId);
      // acquisitions.cancel is required.
      expect((await inventory.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Seller withdrew' }, idem())).status).toBe(403);
      const res = await owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Seller withdrew' }, idem());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'Seller withdrew' });
      expect((await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [acq.vehicleId])).rows[0].status).toBe('removed');
      expect(await entryCount(t.tenantId)).toBe(n);
      expect((await pool.query(`SELECT count(*)::int AS n FROM journal_lines WHERE vehicle_id = $1`, [acq.vehicleId])).rows[0].n).toBe(0);
      // Twice → conflict.
      const again = await owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Seller withdrew' }, idem());
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('already_cancelled');
      // A cancelled purchase cannot be approved or submitted.
      expect((await owner.post(`/acquisitions/${acq.id}/approve`, {}, idem())).body.error.code).toBe('acquisition_not_pending');
      expect((await owner.post(`/acquisitions/${acq.id}/submit`)).body.error.code).toBe('acquisition_not_draft');
    });

    it('a pending cancel resolves the approval request', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { approve: false });
      expect((await owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Duplicate entry' }, idem())).status).toBe(200);
      const reqs = (await pool.query(`SELECT status FROM approval_requests WHERE entity_id = $1`, [acq.id])).rows.map((r) => r.status);
      expect(reqs).toEqual(['cancelled']);
    });

    it('approved + unpaid: reverses the purchase (1300 nets to 0) and writes other posted costs off to 6300', async () => {
      const transporter = await createSupplier(owner, { name: 'Fast Towing' });
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '50000.00' });
      const transport = await costCategory(owner, 'transport');
      const cost = await owner.post(
        '/vehicle-costs',
        { vehicleId: acq.vehicleId, categoryId: transport, description: 'Tow from port', amount: '2000.00', currency: 'SAR', costDate: '2026-02-02', supplierId: transporter.id },
        idem(),
      );
      expect(cost.status).toBe(201);
      const supplierGlBefore = await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id });

      const res = await owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Title problem' }, idem());
      expect(res.status).toBe(200);
      const [purchase] = await purchaseCosts(acq.id);
      expect(purchase!.status).toBe('reversed');
      expect((await entriesFor('vehicle_cost', purchase!.id)).map((e) => e.event)).toEqual(['cost.posted', 'cost.reversed']);
      expect((await entriesFor('vehicle', acq.vehicleId)).map((e) => e.event)).toEqual(['vehicle.written_off']);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '6300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('2000.00');
      // The purchase liability is gone; the transporter is still owed.
      expect(d(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).minus(supplierGlBefore).toFixed(2)).toBe('50000.00');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: transporter.id })).toBe('-2000.00');
      const detail = await owner.get(`/acquisitions/${acq.id}`);
      expect(detail.body).toMatchObject({ status: 'cancelled', outstandingBase: '0.00' });
      expect(detail.body.vehicle.status).toBe('removed');
      // The transport invoice remains payable on its own.
      const pay = await owner.post(
        '/supplier-payments',
        { supplierId: transporter.id, cashAccountId: cash.id, paidAt: '2026-02-03', method: 'cash', amount: '2000.00', allocations: [{ targetType: 'vehicle_cost', targetId: cost.body.id, amountBase: '2000.00' }] },
        idem(),
      );
      expect(pay.status).toBe(201);
    });

    it('approved with a posted payment → 409 until the payment is voided', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '40000.00' });
      const pay = await owner.post(
        '/supplier-payments',
        { supplierId: supplier.id, cashAccountId: cash.id, paidAt: '2026-02-03', method: 'cash', amount: '1000.00', allocations: [{ targetType: 'acquisition', targetId: acq.id, amountBase: '1000.00' }] },
        idem(),
      );
      expect(pay.status).toBe(201);
      const blocked = await owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Seller withdrew' }, idem());
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('acquisition_has_payments');
      expect(blocked.body.error.details.paid).toBe('1000.00');
      expect((await owner.get(`/acquisitions/${acq.id}`)).body.status).toBe('approved');
      expect((await owner.post(`/supplier-payments/${pay.body.id}/void`, { reason: 'Refunded by seller' }, idem())).status).toBe(200);
      expect((await owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Seller withdrew' }, idem())).status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
    });

    it('a reserved or sold vehicle blocks cancellation', async () => {
      // No reservation/sale API exists yet (Phase 4/5): the committed status is simulated directly.
      for (const status of ['reserved', 'sale_pending', 'sold', 'delivered']) {
        const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '10000.00' });
        await pool.query(`UPDATE vehicles SET status = $2 WHERE id = $1`, [acq.vehicleId, status]);
        const res = await owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Customer backed out' }, idem());
        expect(res.status, status).toBe(409);
        expect(res.body.error.code).toBe('vehicle_committed');
        expect(res.body.error.details.vehicleStatus).toBe(status);
        expect((await owner.get(`/acquisitions/${acq.id}`)).body.status).toBe('approved');
        // Put the vehicle back so the inventory sub-ledger check stays meaningful.
        await pool.query(`UPDATE vehicles SET status = 'incoming' WHERE id = $1`, [acq.vehicleId]);
      }
    });

    it('cancelling after the vehicle was already removed (written off) leaves 1300 and 6300 at zero', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '30000.00' });
      // Removing the vehicle writes the purchase off (Dr 6300 / Cr 1300).
      const rm = await owner.post(`/vehicles/${acq.vehicleId}/status`, { to: 'removed', reason: 'Flood damage found' });
      expect(rm.status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '6300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('30000.00');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
      // The seller takes the car back: the purchase is cancelled.
      const res = await owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Returned to seller' }, idem());
      expect(res.status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '6300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
      expect((await owner.get(`/acquisitions/${acq.id}`)).body.outstandingBase).toBe('0.00');
    });
  });

  describe('scope', () => {
    it('branch-scoped users cannot see or act on another branch; other tenants get 404', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { approve: false });
      const b2 = await createBranch(owner, 'Dammam');
      const scoped = (await addMember(app, t, 'branch_manager', { allBranches: false, branchIds: [b2.id] })).client;
      expect((await scoped.get(`/acquisitions/${acq.id}`)).status).toBe(403);
      expect((await scoped.post(`/acquisitions/${acq.id}/approve`, {}, idem())).status).toBe(403);
      expect((await scoped.post(`/acquisitions/${acq.id}/cancel`, { reason: 'not mine' }, idem())).status).toBe(403);
      const list = await scoped.get('/acquisitions?pageSize=200');
      expect(list.status).toBe(200);
      expect(list.body.items.some((i: { id: string }) => i.id === acq.id)).toBe(false);
      expect((await scoped.post('/acquisitions', body(), idem())).status).toBe(403);
      // In their own branch they can buy.
      const own = await scoped.post('/acquisitions', body({ branchId: b2.id, submit: true }), idem());
      expect(own.status).toBe(201);
      expect((await scoped.get(`/acquisitions/${own.body.id}`)).status).toBe(200);

      // Another tenant: everything is 404 (RLS), and it cannot use our supplier.
      const other = t2.owner;
      expect((await other.get(`/acquisitions/${acq.id}`)).status).toBe(404);
      expect((await other.patch(`/acquisitions/${acq.id}`, { version: 1, notes: 'x' })).status).toBe(404);
      expect((await other.post(`/acquisitions/${acq.id}/submit`)).status).toBe(404);
      expect((await other.post(`/acquisitions/${acq.id}/approve`, {}, idem())).status).toBe(404);
      expect((await other.post(`/acquisitions/${acq.id}/cancel`, { reason: 'hostile' }, idem())).status).toBe(404);
      const foreignSupplier = await other.post('/acquisitions', { ...body(), branchId: t2.branchId }, idem());
      expect(foreignSupplier.status).toBe(404);
      expect((await other.get('/acquisitions?pageSize=200')).body.items).toEqual([]);
      expect((await owner.get(`/acquisitions/${acq.id}`)).body.status).toBe('pending_approval');
      await assertLedgerIntegrity(pool, t2.tenantId);
    });
  });
});
