import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sum } from '@autohub/shared';
import {
  addMemberWithPermissions,
  assertLedgerIntegrity,
  costCategory,
  createAcquisition,
  createCashAccount,
  createSupplier,
  createVehicle,
  glBalance,
  secondApprover,
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant, uniq } from './helpers';

/**
 * Adversarial review of Phase 3 money endpoints under concurrency: every money-creating or
 * state-changing route is hit with 5–10 simultaneous conflicting requests (distinct
 * Idempotency-Keys unless the test is about the key itself) and must behave exactly-once — one
 * winner, stable error codes for the losers, no duplicate journal entries, no overpayment, no cash
 * box below zero on any date, and balanced books after every test (assertLedgerIntegrity).
 *
 * Tests marked `// BUG:` assert the CORRECT behaviour and fail today; see the comment above each.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are untyped JSON
type Res = { status: number; body: any; headers: Record<string, string> };
type Alloc = { targetType: 'acquisition' | 'vehicle_cost' | 'expense'; targetId: string; amountBase: string };

const show = (rs: Res[]) => JSON.stringify(rs.map((r) => [r.status, r.body?.error?.code ?? null]));
/** Status (and error code) histogram, e.g. { '200': 1, '409:already_voided': 5 }. */
const tally = (rs: Res[]) => {
  const m: Record<string, number> = {};
  for (const r of rs) {
    const k = r.body?.error?.code ? `${r.status}:${r.body.error.code}` : String(r.status);
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
};
const times = (n: number, fn: (i: number) => PromiseLike<Res>): Promise<Res[]> => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

describe('review: concurrency, locking, double posting and idempotency of Phase 3 money endpoints', () => {
  let app: INestApplication;
  let t: TestTenant;
  let t2: TestTenant;
  let pool: Pool;
  let owner: Client;
  let approver: Client;
  let accountant: Client;
  let clerk: Client;
  let supplier: { id: string };
  let transport: string;
  let parts: string;
  let maintenance: string;
  let rent: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are untyped JSON
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
  const events = async (sourceType: string, sourceId: string) =>
    (await q<{ event: string }>(`SELECT event FROM journal_entries WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3 ORDER BY entry_no`, [t.tenantId, sourceType, sourceId])).map((r) => r.event);
  const balance = async (accountId: string) => (await owner.get(`/cash-accounts/${accountId}`)).body.balance as string;
  /** Posted payments allocated to one document (count and base amount relieved). */
  const settled = async (targetId: string) =>
    (
      await q<{ n: number; base: string }>(
        `SELECT count(DISTINCT sp.id)::int AS n, coalesce(sum(spa.amount_base), 0)::numeric(18,2)::text AS base
           FROM supplier_payment_allocations spa JOIN supplier_payments sp ON sp.id = spa.payment_id
          WHERE spa.tenant_id = $1 AND spa.target_id = $2 AND sp.status = 'posted'`,
        [t.tenantId, targetId],
      )
    )[0]!;
  const expenseBody = (amount: string, extra: Record<string, unknown> = {}) => ({
    branchId: t.branchId,
    categoryId: rent,
    description: 'Yard rent',
    amount,
    currency: 'SAR',
    expenseDate: '2026-03-01',
    supplierId: supplier.id,
    ...extra,
  });
  const postExpense = async (amount: string) => {
    const r = await owner.post('/expenses', expenseBody(amount), idem());
    if (r.status !== 201 || r.body.status !== 'posted') throw new Error(`expense failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { id: string; number: string };
  };
  const payBody = (cashAccountId: string, allocations: Alloc[], extra: Record<string, unknown> = {}) => ({
    supplierId: supplier.id,
    cashAccountId,
    paidAt: '2026-03-02',
    method: 'cash',
    amount: sum(allocations.map((a) => a.amountBase)).toFixed(2),
    allocations,
    ...extra,
  });
  const costBody = (vehicleId: string, amount: string, extra: Record<string, unknown> = {}) => ({
    vehicleId,
    categoryId: transport,
    description: 'Flatbed transport',
    amount,
    currency: 'SAR',
    costDate: '2026-03-01',
    supplierId: supplier.id,
    ...extra,
  });
  const allocBody = (vehicleIds: string[], totalAmount = '1000.00') => ({
    vehicleIds,
    method: 'equal',
    categoryId: transport,
    description: 'Car carrier Jeddah to Riyadh',
    totalAmount,
    currency: 'SAR',
    costDate: '2026-03-01',
    supplierId: supplier.id,
  });
  const transfer = (c: Client, fromAccountId: string, toAccountId: string, amount: string, key = idem(), date = '2026-03-05') =>
    c.post('/cash/transfers', { fromAccountId, toAccountId, amount, date }, key);

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    t2 = await createTenant(app, admin);
    pool = ownerPool();
    owner = t.owner;
    approver = await secondApprover(owner);
    accountant = (await addMember(app, t, 'accountant')).client;
    clerk = (await addMemberWithPermissions(app, t, ['vehicles.read', 'costs.read', 'costs.create', 'expenses.read', 'expenses.create'])).client;
    supplier = await createSupplier(owner, { name: 'Race Condition Motors' });
    transport = await costCategory(owner, 'transport');
    parts = await costCategory(owner, 'parts');
    maintenance = await costCategory(owner, 'maintenance');
    rent = ((await owner.get('/expense-categories')).body as Array<{ id: string; code: string }>).find((c) => c.code === 'rent')!.id;
  });

  afterEach(async () => {
    await assertLedgerIntegrity(pool, t.tenantId);
    // (source_type, source_id, event) is unique by index; assert it anyway — the review's core claim.
    const dupes = await q(
      `SELECT source_type, source_id, event, count(*)::int AS n FROM journal_entries WHERE tenant_id = $1 GROUP BY 1, 2, 3 HAVING count(*) > 1`,
      [t.tenantId],
    );
    expect(dupes, 'duplicate journal entries').toEqual([]);
    // No cash box may be below zero at the end of ANY business day.
    const negative = await q(
      `WITH daily AS (
          SELECT ct.cash_account_id AS a, ct.business_date AS d, sum(CASE WHEN ct.direction = 'in' THEN ct.amount ELSE -ct.amount END) AS s
            FROM cash_transactions ct JOIN cash_accounts ca ON ca.id = ct.cash_account_id
           WHERE ct.tenant_id = $1 AND ca.type = 'cashbox' GROUP BY 1, 2),
        running AS (SELECT a, d, sum(s) OVER (PARTITION BY a ORDER BY d) AS bal FROM daily)
       SELECT a, d::text, bal::text FROM running WHERE bal < 0`,
      [t.tenantId],
    );
    expect(negative, 'cash box below zero on some date').toEqual([]);
  });

  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  // ── Acquisitions ────────────────────────────────────────────────────────────────────────
  describe('acquisitions', () => {
    it('approve ×6 at once: one approval, one purchase cost with one GL entry, one resolved inbox item', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '42000.00', approve: false });
      const rs = await times(6, () => approver.post(`/acquisitions/${acq.id}/approve`, {}, idem()));
      expect(tally(rs), show(rs)).toEqual({ '200': 1, '409:acquisition_not_pending': 5 });
      const costs = await q<{ id: string; status: string; amount_base: string }>(
        `SELECT id, status, amount_base FROM vehicle_costs WHERE tenant_id = $1 AND source_type = 'acquisition' AND source_id = $2`,
        [t.tenantId, acq.id],
      );
      expect(costs).toMatchObject([{ status: 'posted', amount_base: '42000.00' }]);
      expect(await events('vehicle_cost', costs[0]!.id)).toEqual(['cost.posted']);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('42000.00');
      const inbox = await q<{ status: string }>(`SELECT status FROM approval_requests WHERE tenant_id = $1 AND entity_id = $2`, [t.tenantId, acq.id]);
      expect(inbox.map((r) => r.status)).toEqual(['approved']);
    });

    it('approve with payNow ×6 at once: the purchase is paid exactly once and the cash leaves the box once', async () => {
      const box = await createCashAccount(owner, { name: uniq('Approval box '), openingBalance: '50000.00' });
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '20000.00', approve: false });
      const rs = await times(6, () => approver.post(`/acquisitions/${acq.id}/approve`, { payNow: { cashAccountId: box.id, method: 'cash' } }, idem()));
      expect(tally(rs), show(rs)).toEqual({ '200': 1, '409:acquisition_not_pending': 5 });
      expect(rs.find((r) => r.status === 200)!.body.payment).toMatchObject({ amountBase: '20000.00', cashAccountId: box.id });
      expect(await settled(acq.id)).toEqual({ n: 1, base: '20000.00' });
      expect(await balance(box.id)).toBe('30000.00');
      const out = await q(`SELECT id FROM cash_transactions WHERE cash_account_id = $1 AND direction = 'out'`, [box.id]);
      expect(out).toHaveLength(1);
      expect((await owner.get(`/acquisitions/${acq.id}`)).body.outstandingBase).toBe('0.00');
    });

    it('cancel ×6 at once: one cancellation, one purchase reversal, the vehicle leaves stock once', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '31000.00' });
      const rs = await times(6, (i) => (i % 2 ? approver : owner).post(`/acquisitions/${acq.id}/cancel`, { reason: `Deal fell through ${i}` }, idem()));
      expect(tally(rs), show(rs)).toEqual({ '200': 1, '409:already_cancelled': 5 });
      const [cost] = await q<{ id: string; status: string }>(`SELECT id, status FROM vehicle_costs WHERE tenant_id = $1 AND source_type = 'acquisition' AND source_id = $2`, [t.tenantId, acq.id]);
      expect(cost!.status).toBe('reversed');
      expect(await events('vehicle_cost', cost!.id)).toEqual(['cost.posted', 'cost.reversed']);
      const removed = await q(`SELECT id FROM vehicle_status_history WHERE vehicle_id = $1 AND to_status = 'removed'`, [acq.vehicleId]);
      expect(removed).toHaveLength(1);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
      expect(await events('vehicle', acq.vehicleId)).toEqual([]); // nothing left to write off
    });

    it('approve racing cancel on a pending purchase: whichever wins, the purchase ends cancelled with nothing on the books', async () => {
      for (let round = 0; round < 3; round++) {
        const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '15000.00', approve: false });
        const [ap, ca] = (await Promise.all([
          approver.post(`/acquisitions/${acq.id}/approve`, {}, idem()),
          owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Supplier withdrew' }, idem()),
        ])) as Res[];
        expect(ca!.status, show([ap!, ca!])).toBe(200);
        const costs = await q<{ id: string }>(`SELECT id FROM vehicle_costs WHERE tenant_id = $1 AND source_type = 'acquisition' AND source_id = $2`, [t.tenantId, acq.id]);
        if (ap!.status === 200) {
          expect(await events('vehicle_cost', costs[0]!.id)).toEqual(['cost.posted', 'cost.reversed']);
        } else {
          expect([ap!.status, ap!.body.error.code]).toEqual([409, 'acquisition_not_pending']);
          expect(costs).toEqual([]);
        }
        expect((await owner.get(`/acquisitions/${acq.id}`)).body.status).toBe('cancelled');
        expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
      }
    });

    it('cancel racing a payment of the same purchase: exactly one of them wins', async () => {
      const box = await createCashAccount(owner, { name: uniq('Cancel race box '), openingBalance: '50000.00' });
      for (let round = 0; round < 3; round++) {
        const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '10000.00' });
        const [ca, pay] = (await Promise.all([
          owner.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Title problem' }, idem()),
          accountant.post('/supplier-payments', payBody(box.id, [{ targetType: 'acquisition', targetId: acq.id, amountBase: '4000.00' }]), idem()),
        ])) as Res[];
        const detail = (await owner.get(`/acquisitions/${acq.id}`)).body;
        if (ca!.status === 200) {
          expect([pay!.status, pay!.body.error?.code], show([ca!, pay!])).toEqual([409, 'not_payable']);
          expect(detail.status).toBe('cancelled');
          expect(await settled(acq.id)).toEqual({ n: 0, base: '0.00' });
        } else {
          expect([ca!.status, ca!.body.error?.code], show([ca!, pay!])).toEqual([409, 'acquisition_has_payments']);
          expect(pay!.status).toBe(201);
          expect([detail.status, detail.outstandingBase]).toEqual(['approved', '6000.00']);
        }
      }
    });
  });

  // ── Vehicle costs ───────────────────────────────────────────────────────────────────────
  describe('vehicle costs', () => {
    it('approve ×6 then reverse ×6 of one cost (three different approvers): posted once, reversed once', async () => {
      const v = await createVehicle(owner, t.branchId);
      const c = await clerk.post('/vehicle-costs', costBody(v.id, '750.00'), idem());
      expect([c.status, c.body.status]).toEqual([201, 'pending_approval']);
      const deciders = [owner, accountant, approver];
      const ap = await times(6, (i) => deciders[i % 3]!.post(`/vehicle-costs/${c.body.id}/approve`, {}));
      expect(tally(ap), show(ap)).toEqual({ '200': 1, '409:cost_not_pending': 5 });
      expect(await events('vehicle_cost', c.body.id)).toEqual(['cost.posted']);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('750.00');
      const inbox = await q<{ status: string }>(`SELECT status FROM approval_requests WHERE tenant_id = $1 AND entity_id = $2`, [t.tenantId, c.body.id]);
      expect(inbox.map((r) => r.status)).toEqual(['approved']);

      const rv = await times(6, (i) => deciders[i % 3]!.post(`/vehicle-costs/${c.body.id}/reverse`, { reason: `Duplicate invoice ${i}` }, idem()));
      expect(tally(rv), show(rv)).toEqual({ '200': 1, '409:cost_not_posted': 5 });
      expect(await events('vehicle_cost', c.body.id)).toEqual(['cost.posted', 'cost.reversed']);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('0.00');
    });

    it('cost with payNow sent 6× with the SAME Idempotency-Key at once: one cost, one payment, the rest replay it', async () => {
      const box = await createCashAccount(owner, { name: uniq('Cost box '), openingBalance: '10000.00' });
      const v = await createVehicle(owner, t.branchId);
      const key = idem();
      const body = costBody(v.id, '1200.00', { payNow: { cashAccountId: box.id, method: 'cash' } });
      const rs = await times(6, () => owner.post('/vehicle-costs', body, key));
      for (const r of rs) {
        if (r.status !== 201) expect([r.status, r.body.error?.code], show(rs)).toEqual([409, 'idempotency_in_progress']);
      }
      const ok = rs.filter((r) => r.status === 201);
      expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
      expect(ok.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(ok.length - 1);
      const costs = await q<{ id: string }>(`SELECT id FROM vehicle_costs WHERE tenant_id = $1 AND vehicle_id = $2`, [t.tenantId, v.id]);
      expect(costs).toHaveLength(1);
      expect(await settled(costs[0]!.id)).toEqual({ n: 1, base: '1200.00' });
      expect(await balance(box.id)).toBe('8800.00');
    });

    it('costs posted while the purchase is being cancelled are either refused or written off with the vehicle', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '25000.00' });
      const rs = (await Promise.all([
        approver.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Rejected at the port' }, idem()),
        ...Array.from({ length: 5 }, () => owner.post('/vehicle-costs', costBody(acq.vehicleId, '300.00'), idem())),
      ])) as Res[];
      expect(rs[0]!.status, show(rs)).toBe(200);
      const costs = rs.slice(1);
      for (const r of costs) {
        if (r.status !== 201) expect([r.status, r.body.error?.code], show(rs)).toEqual([409, 'vehicle_removed']);
      }
      const posted = costs.filter((r) => r.status === 201).length;
      expect((await q<{ status: string }>(`SELECT status FROM vehicles WHERE id = $1`, [acq.vehicleId]))[0]!.status).toBe('removed');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
      // Costs that got in before the cancellation were written off (Dr 6300) when the vehicle left stock.
      expect(await glBalance(pool, t.tenantId, '6300', { col: 'vehicle_id', id: acq.vehicleId })).toBe((posted * 300).toFixed(2));
      const live = await q(`SELECT id FROM vehicle_costs WHERE vehicle_id = $1 AND source_type = 'manual' AND status = 'posted'`, [acq.vehicleId]);
      expect(live).toHaveLength(posted);
    });

    it('allocation sent 5× with the SAME Idempotency-Key at once: one batch split exactly to the cent', async () => {
      const vs = [await createVehicle(owner, t.branchId), await createVehicle(owner, t.branchId), await createVehicle(owner, t.branchId)];
      const key = idem();
      const rs = await times(5, () => owner.post('/vehicle-costs/allocate', allocBody(vs.map((v) => v.id)), key));
      for (const r of rs) {
        if (r.status !== 201) expect([r.status, r.body.error?.code], show(rs)).toEqual([409, 'idempotency_in_progress']);
      }
      const ok = rs.filter((r) => r.status === 201);
      expect(new Set(ok.map((r) => r.body.batchId)).size).toBe(1);
      const rows = await q<{ amount_base: string }>(`SELECT amount_base FROM vehicle_costs WHERE tenant_id = $1 AND batch_id = $2`, [t.tenantId, ok[0]!.body.batchId]);
      expect(rows.map((r) => r.amount_base).sort()).toEqual(['333.33', '333.33', '333.34']);
      const batches = await q(`SELECT DISTINCT batch_id FROM vehicle_costs WHERE tenant_id = $1 AND vehicle_id = ANY($2::uuid[])`, [t.tenantId, vs.map((v) => v.id)]);
      expect(batches).toHaveLength(1);
    });

    // BUG: Cost allocation deadlocks — allocate() locks the vehicles one at a time in request order and
    // posts each part (taking the tenant's journal-number counter lock) before locking the next vehicle.
    it('allocations over the same vehicles in a different order, and a single cost on one of them, all succeed', async () => {
      const all: Res[] = [];
      for (let round = 0; round < 3; round++) {
        const v1 = await createVehicle(owner, t.branchId);
        const v2 = await createVehicle(owner, t.branchId);
        all.push(
          ...((await Promise.all([
            owner.post('/vehicle-costs/allocate', allocBody([v1.id, v2.id]), idem()),
            accountant.post('/vehicle-costs/allocate', allocBody([v2.id, v1.id], '600.00'), idem()),
          ])) as Res[]),
        );
        const v3 = await createVehicle(owner, t.branchId);
        const v4 = await createVehicle(owner, t.branchId);
        all.push(
          ...((await Promise.all([
            owner.post('/vehicle-costs/allocate', allocBody([v3.id, v4.id]), idem()),
            accountant.post('/vehicle-costs', costBody(v4.id, '90.00'), idem()),
          ])) as Res[]),
        );
      }
      expect(all.map((r) => r.status), show(all)).toEqual(Array(12).fill(201));
    }, 90_000);
  });

  // ── Supplier payments ───────────────────────────────────────────────────────────────────
  describe('supplier payments', () => {
    it('10 partial payments at once from a cash box and a bank cannot overpay one purchase', async () => {
      const box = await createCashAccount(owner, { name: uniq('Pay box '), openingBalance: '100000.00' });
      const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Pay bank '), openingBalance: '100000.00' });
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '10000.00' });
      const rs = await times(10, (i) =>
        (i % 2 ? accountant : owner).post(
          '/supplier-payments',
          payBody(i % 2 ? bank.id : box.id, [{ targetType: 'acquisition', targetId: acq.id, amountBase: '1500.00' }], { method: i % 2 ? 'bank_transfer' : 'cash' }),
          idem(),
        ),
      );
      expect(tally(rs), show(rs)).toEqual({ '201': 6, '409:overpayment': 4 });
      expect(await settled(acq.id)).toEqual({ n: 6, base: '9000.00' });
      const detail = (await owner.get(`/acquisitions/${acq.id}`)).body;
      expect([detail.paidBase, detail.outstandingBase]).toEqual(['9000.00', '1000.00']);
      const left = Number(await balance(box.id)) + Number(await balance(bank.id));
      expect(left.toFixed(2)).toBe('191000.00');
    });

    it('10 payments at once from a cash box that holds enough for 3: exactly 3 succeed and the box never goes negative', async () => {
      const box = await createCashAccount(owner, { name: uniq('Small box '), openingBalance: '3500.00' });
      const docs: Array<{ id: string }> = [];
      for (let i = 0; i < 10; i++) docs.push(await postExpense('1000.00'));
      const rs = await times(10, (i) => accountant.post('/supplier-payments', payBody(box.id, [{ targetType: 'expense', targetId: docs[i]!.id, amountBase: '1000.00' }]), idem()));
      expect(tally(rs), show(rs)).toEqual({ '201': 3, '409:insufficient_cash': 7 });
      expect(await balance(box.id)).toBe('500.00');
      const paid = await Promise.all(docs.map((e) => settled(e.id)));
      expect(paid.filter((p) => p.n === 1)).toHaveLength(3);
    });

    it('void ×6 at once: voided once, the cash comes back once, the document is payable again', async () => {
      const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Void bank '), openingBalance: '20000.00' });
      const exp = await postExpense('2000.00');
      const p = await accountant.post('/supplier-payments', payBody(bank.id, [{ targetType: 'expense', targetId: exp.id, amountBase: '2000.00' }]), idem());
      expect(p.status).toBe(201);
      const rs = await times(6, (i) => (i % 2 ? owner : accountant).post(`/supplier-payments/${p.body.id}/void`, { reason: `Paid twice ${i}` }, idem()));
      expect(tally(rs), show(rs)).toEqual({ '200': 1, '409:already_voided': 5 });
      expect(await events('supplier_payment', p.body.id)).toEqual(['supplier_payment.posted', 'supplier_payment.posted.reversed']);
      expect(await q(`SELECT id FROM cash_transactions WHERE source_type = 'supplier_payment' AND source_id = $1`, [p.body.id])).toHaveLength(2);
      expect(await balance(bank.id)).toBe('20000.00');
      expect((await owner.get(`/expenses/${exp.id}`)).body.outstandingBase).toBe('2000.00');
    });

    it('a void racing a new payment that needs the voided amount never overpays the document (same and different account)', async () => {
      const box = await createCashAccount(owner, { name: uniq('Void race box '), openingBalance: '20000.00' });
      const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Void race bank '), openingBalance: '20000.00' });
      for (const second of [box.id, bank.id, box.id, bank.id]) {
        const exp = await postExpense('1000.00');
        const first = await accountant.post('/supplier-payments', payBody(box.id, [{ targetType: 'expense', targetId: exp.id, amountBase: '1000.00' }]), idem());
        expect(first.status).toBe(201);
        const [v, p2] = (await Promise.all([
          accountant.post(`/supplier-payments/${first.body.id}/void`, { reason: 'Wrong cash box' }, idem()),
          owner.post('/supplier-payments', payBody(second, [{ targetType: 'expense', targetId: exp.id, amountBase: '1000.00' }]), idem()),
        ])) as Res[];
        expect(v!.status, show([v!, p2!])).toBe(200);
        if (p2!.status !== 201) expect([p2!.status, p2!.body.error?.code], show([v!, p2!])).toEqual([409, 'overpayment']);
        expect(await settled(exp.id)).toEqual(p2!.status === 201 ? { n: 1, base: '1000.00' } : { n: 0, base: '0.00' });
      }
    });

    // BUG: Supplier payments deadlock — pay() locks the allocated documents in request order, so two
    // payments from different accounts listing the same documents in opposite order deadlock.
    it('two payments settling the same two documents in opposite order (different accounts) both succeed', async () => {
      const box = await createCashAccount(owner, { name: uniq('Order box '), openingBalance: '50000.00' });
      const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Order bank '), openingBalance: '50000.00' });
      const all: Res[] = [];
      for (let round = 0; round < 4; round++) {
        const a1 = await createAcquisition(owner, t.branchId, supplier.id, { price: '1000.00' });
        const a2 = await createAcquisition(owner, t.branchId, supplier.id, { price: '1000.00' });
        const docs = (ids: string[]) => ids.map((id) => ({ targetType: 'acquisition' as const, targetId: id, amountBase: '100.00' }));
        all.push(
          ...((await Promise.all([
            owner.post('/supplier-payments', payBody(box.id, docs([a1.id, a2.id])), idem()),
            accountant.post('/supplier-payments', payBody(bank.id, docs([a2.id, a1.id]), { method: 'bank_transfer' }), idem()),
          ])) as Res[]),
        );
      }
      expect(all.map((r) => r.status), show(all)).toEqual(Array(8).fill(201));
    }, 90_000);
  });

  // ── Expenses ────────────────────────────────────────────────────────────────────────────
  describe('expenses', () => {
    it('expense with payNow sent 6× with the SAME Idempotency-Key at once: one expense, one payment', async () => {
      const box = await createCashAccount(owner, { name: uniq('Expense box '), openingBalance: '5000.00' });
      const key = idem();
      const body = expenseBody('450.00', { description: uniq('Generator diesel '), payNow: { cashAccountId: box.id, method: 'cash' } });
      const rs = await times(6, () => owner.post('/expenses', body, key));
      for (const r of rs) {
        if (r.status !== 201) expect([r.status, r.body.error?.code], show(rs)).toEqual([409, 'idempotency_in_progress']);
      }
      const ok = rs.filter((r) => r.status === 201);
      expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
      expect(await q(`SELECT id FROM expenses WHERE tenant_id = $1 AND description = $2`, [t.tenantId, body.description])).toHaveLength(1);
      expect(await settled(ok[0]!.body.id)).toEqual({ n: 1, base: '450.00' });
      expect(await balance(box.id)).toBe('4550.00');
    });

    it('approve ×6 then reverse ×6 of one expense (three different approvers): posted once, reversed once', async () => {
      const e = await clerk.post('/expenses', expenseBody('640.00', { description: 'Water bill' }), idem());
      expect([e.status, e.body.status]).toEqual([201, 'pending_approval']);
      const deciders = [owner, accountant, approver];
      const ap = await times(6, (i) => deciders[i % 3]!.post(`/expenses/${e.body.id}/approve`, {}));
      expect(tally(ap), show(ap)).toEqual({ '200': 1, '409:expense_not_pending': 5 });
      expect(await events('expense', e.body.id)).toEqual(['expense.posted']);
      const rv = await times(6, (i) => deciders[i % 3]!.post(`/expenses/${e.body.id}/reverse`, { reason: `Entered twice ${i}` }, idem()));
      expect(tally(rv), show(rv)).toEqual({ '200': 1, '409:expense_not_posted': 5 });
      expect(await events('expense', e.body.id)).toEqual(['expense.posted', 'expense.reversed']);
    });

    it('a reversal racing a payment of the same expense: exactly one of them wins', async () => {
      const box = await createCashAccount(owner, { name: uniq('Reverse race box '), openingBalance: '10000.00' });
      for (let round = 0; round < 3; round++) {
        const e = await postExpense('800.00');
        const [rv, p] = (await Promise.all([
          owner.post(`/expenses/${e.id}/reverse`, { reason: 'Landlord cancelled the invoice' }, idem()),
          accountant.post('/supplier-payments', payBody(box.id, [{ targetType: 'expense', targetId: e.id, amountBase: '800.00' }]), idem()),
        ])) as Res[];
        if (rv!.status === 200) {
          expect([p!.status, p!.body.error?.code], show([rv!, p!])).toEqual([409, 'not_payable']);
          expect(await settled(e.id)).toEqual({ n: 0, base: '0.00' });
        } else {
          expect([rv!.status, rv!.body.error?.code], show([rv!, p!])).toEqual([409, 'expense_has_payments']);
          expect(p!.status).toBe(201);
        }
      }
    });
  });

  // ── Work orders ─────────────────────────────────────────────────────────────────────────
  describe('work orders', () => {
    it('approve with payNow ×5 at once: one approval, each item posted once, one payment', async () => {
      const box = await createCashAccount(owner, { name: uniq('Workshop box '), openingBalance: '10000.00' });
      const v = await createVehicle(owner, t.branchId);
      const wo = await owner.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'Pre-sale preparation' });
      expect(wo.status).toBe(201);
      const i1 = await owner.post(`/work-orders/${wo.body.id}/items`, { kind: 'part', description: 'Brake pads', quantity: '2', unitCost: '210.00', categoryId: parts });
      const i2 = await owner.post(`/work-orders/${wo.body.id}/items`, { kind: 'labor', description: 'Fitting', quantity: '1', unitCost: '150.00', categoryId: maintenance });
      expect([i1.status, i2.status]).toEqual([201, 201]);
      expect((await owner.post(`/work-orders/${wo.body.id}/start`)).status).toBe(200);
      expect((await owner.post(`/work-orders/${wo.body.id}/complete`)).status).toBe(200);
      const rs = await times(5, () => approver.post(`/work-orders/${wo.body.id}/approve`, { payNow: { cashAccountId: box.id, method: 'cash' } }, idem()));
      expect(tally(rs), show(rs)).toEqual({ '200': 1, '409:work_order_not_awaiting_approval': 4 });
      const costs = await q<{ id: string }>(`SELECT id FROM vehicle_costs WHERE tenant_id = $1 AND source_type = 'work_order_item' AND source_id = ANY($2::uuid[])`, [
        t.tenantId,
        [i1.body.id, i2.body.id],
      ]);
      expect(costs).toHaveLength(2);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('570.00');
      const payments = await q(`SELECT DISTINCT payment_id FROM supplier_payment_allocations WHERE target_id = ANY($1::uuid[])`, [costs.map((c) => c.id)]);
      expect(payments).toHaveLength(1);
      expect(await balance(box.id)).toBe('9430.00');
    });
  });

  // ── Cash transfers ──────────────────────────────────────────────────────────────────────
  describe('cash transfers', () => {
    it('10 transfers at once out of a cash box that holds enough for 4: exactly 4 succeed, the box ends at zero', async () => {
      const box = await createCashAccount(owner, { name: uniq('Drain box '), openingBalance: '4000.00' });
      const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Drain bank ') });
      const rs = await times(10, (i) => transfer(i % 2 ? owner : accountant, box.id, bank.id, '1000.00'));
      expect(tally(rs), show(rs)).toEqual({ '201': 4, '409:insufficient_cash': 6 });
      expect([await balance(box.id), await balance(bank.id)]).toEqual(['0.00', '4000.00']);
      const ids = await q(`SELECT DISTINCT source_id FROM cash_transactions WHERE source_type = 'cash_transfer' AND cash_account_id = $1`, [box.id]);
      expect(ids).toHaveLength(4);
    });

    it('opposite-direction transfers between the same two accounts fired together: no deadlock, no 500, all succeed', async () => {
      const x = await createCashAccount(owner, { name: uniq('East box '), openingBalance: '5000.00' });
      const y = await createCashAccount(owner, { name: uniq('West box '), openingBalance: '5000.00' });
      for (let round = 0; round < 3; round++) {
        const rs = await times(10, (i) => (i % 2 ? transfer(accountant, y.id, x.id, '250.00') : transfer(owner, x.id, y.id, '250.00')));
        expect(tally(rs), show(rs)).toEqual({ '201': 10 });
      }
      expect([await balance(x.id), await balance(y.id)]).toEqual(['5000.00', '5000.00']);
    });

    it('reverse ×6 at once: reversed once (one mirrored entry, two opposite cash rows)', async () => {
      const x = await createCashAccount(owner, { type: 'bank', name: uniq('Rev bank '), openingBalance: '5000.00' });
      const y = await createCashAccount(owner, { name: uniq('Rev box ') });
      const tr = await transfer(accountant, x.id, y.id, '700.00');
      expect(tr.status).toBe(201);
      const id = tr.body.transferId as string;
      const rs = await times(6, (i) => (i % 2 ? owner : accountant).post(`/cash/transfers/${id}/reverse`, { reason: `Wrong account ${i}` }, idem()));
      expect(tally(rs), show(rs)).toEqual({ '200': 1, '409:already_reversed': 5 });
      expect(await events('cash_transfer', id)).toEqual(['cash_transfer.posted', 'cash_transfer.reversed']);
      expect(await q(`SELECT id FROM cash_transactions WHERE source_type = 'cash_transfer' AND source_id = $1`, [id])).toHaveLength(4);
      expect([await balance(x.id), await balance(y.id)]).toEqual(['5000.00', '0.00']);
    });

    it('a transfer reversal racing a payment that spends the transferred cash: one wins, the box never goes negative', async () => {
      for (let round = 0; round < 3; round++) {
        const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Src bank '), openingBalance: '5000.00' });
        const box = await createCashAccount(owner, { name: uniq('Dst box ') });
        const tr = await transfer(accountant, bank.id, box.id, '1000.00');
        expect(tr.status).toBe(201);
        const e = await postExpense('1000.00');
        const [rv, p] = (await Promise.all([
          owner.post(`/cash/transfers/${tr.body.transferId}/reverse`, { reason: 'Sent to the wrong box' }, idem()),
          accountant.post('/supplier-payments', payBody(box.id, [{ targetType: 'expense', targetId: e.id, amountBase: '1000.00' }], { paidAt: '2026-03-06' }), idem()),
        ])) as Res[];
        const outcome = [rv!.status, rv!.body.error?.code ?? null, p!.status, p!.body.error?.code ?? null];
        expect([
          [200, null, 409, 'insufficient_cash'],
          [409, 'insufficient_cash', 201, null],
        ]).toContainEqual(outcome);
        expect(await balance(box.id)).toBe('0.00');
      }
    });
  });

  // ── Cash accounts ───────────────────────────────────────────────────────────────────────
  describe('cash accounts', () => {
    it('opening balance: same key ×6 creates one account; same name with different keys ×6 creates one, the rest 409', async () => {
      const body = { type: 'cashbox', name: uniq('Vault '), currency: 'SAR', openingBalance: '7500.00', openingDate: '2026-01-01' };
      const key = idem();
      const rs = await times(6, () => owner.post('/cash-accounts', body, key));
      for (const r of rs) {
        if (r.status !== 201) expect([r.status, r.body.error?.code], show(rs)).toEqual([409, 'idempotency_in_progress']);
      }
      const ok = rs.filter((r) => r.status === 201);
      expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
      expect(await q(`SELECT id FROM cash_accounts WHERE tenant_id = $1 AND name = $2`, [t.tenantId, body.name])).toHaveLength(1);
      expect(await events('cash_account', ok[0]!.body.id)).toEqual(['cash_account.opening_balance']);

      const body2 = { ...body, name: uniq('Vault ') };
      const rs2 = await times(6, (i) => (i % 2 ? approver : owner).post('/cash-accounts', body2, idem()));
      expect(tally(rs2), show(rs2)).toEqual({ '201': 1, '409:cash_account_name_taken': 5 });
      const created = rs2.find((r) => r.status === 201)!.body;
      expect(await events('cash_account', created.id)).toEqual(['cash_account.opening_balance']);
      expect(await q(`SELECT id FROM cash_transactions WHERE cash_account_id = $1`, [created.id])).toHaveLength(1);
      expect(await balance(created.id)).toBe('7500.00');
    });
  });

  // ── Idempotency-Key semantics ───────────────────────────────────────────────────────────
  describe('idempotency keys', () => {
    it('same key ×8 at once on a supplier payment: executes once; every response is the original or idempotency_in_progress', async () => {
      const box = await createCashAccount(owner, { name: uniq('Idem box '), openingBalance: '10000.00' });
      const e = await postExpense('900.00');
      const key = idem();
      const body = payBody(box.id, [{ targetType: 'expense', targetId: e.id, amountBase: '900.00' }]);
      const rs = await times(8, () => accountant.post('/supplier-payments', body, key));
      for (const r of rs) {
        if (r.status !== 201) expect([r.status, r.body.error?.code], show(rs)).toEqual([409, 'idempotency_in_progress']);
      }
      const ok = rs.filter((r) => r.status === 201);
      expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
      expect(await settled(e.id)).toEqual({ n: 1, base: '900.00' });
      expect(await balance(box.id)).toBe('9100.00');
    });

    it('same key with different bodies at once: one executes, the others get 422 idempotency_key_reused; the winner replays', async () => {
      const x = await createCashAccount(owner, { type: 'bank', name: uniq('Key bank '), openingBalance: '10000.00' });
      const y = await createCashAccount(owner, { name: uniq('Key box ') });
      const key = idem();
      const amounts = ['100.00', '200.00', '300.00', '400.00', '500.00'];
      const rs = await times(5, (i) => transfer(accountant, x.id, y.id, amounts[i]!, key));
      expect(tally(rs), show(rs)).toEqual({ '201': 1, '422:idempotency_key_reused': 4 });
      const winner = amounts[rs.findIndex((r) => r.status === 201)]!;
      const moved = await q(`SELECT DISTINCT source_id FROM cash_transactions WHERE source_type = 'cash_transfer' AND cash_account_id = $1`, [y.id]);
      expect(moved).toHaveLength(1);
      expect(await balance(y.id)).toBe(winner);
      // Replaying the winning body returns the stored response; any other body stays refused.
      const replay = await transfer(accountant, x.id, y.id, winner, key);
      expect([replay.status, replay.headers['idempotent-replayed'], replay.body.transferId]).toEqual([201, 'true', moved[0].source_id]);
      const other = await transfer(accountant, x.id, y.id, '999.00', key);
      expect([other.status, other.body.error?.code]).toEqual([422, 'idempotency_key_reused']);
    });

    it('same key from two users of one company at once: one executes, the other 422; another company may use the same key', async () => {
      const key = idem();
      const body = expenseBody('300.00', { description: uniq('Cleaning ') });
      const rs = (await Promise.all([accountant.post('/expenses', body, key), owner.post('/expenses', body, key)])) as Res[];
      expect(tally(rs), show(rs)).toEqual({ '201': 1, '422:idempotency_key_reused': 1 });
      expect(await q(`SELECT id FROM expenses WHERE tenant_id = $1 AND description = $2`, [t.tenantId, body.description])).toHaveLength(1);
      // The key is bound to its endpoint too: the winner cannot reuse it for a transfer.
      const winner = rs[0]!.status === 201 ? accountant : owner;
      const box = await createCashAccount(owner, { name: uniq('Cross box '), openingBalance: '100.00' });
      const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Cross bank ') });
      const reused = await transfer(winner, box.id, bank.id, '10.00', key);
      expect([reused.status, reused.body.error?.code]).toEqual([422, 'idempotency_key_reused']);
      // Keys are per company: the same key in another company is a new request.
      const elsewhere = await t2.owner.post('/expenses', { ...body, branchId: t2.branchId, supplierId: null }, key);
      expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201);
      expect(elsewhere.headers['idempotent-replayed']).toBeUndefined();
      await assertLedgerIntegrity(pool, t2.tenantId);
    });

    it('a request that failed releases its key: the retry with the same key executes once, then replays', async () => {
      const box = await createCashAccount(owner, { name: uniq('Empty box ') });
      const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Funding bank '), openingBalance: '3000.00' });
      const e = await postExpense('600.00');
      const key = idem();
      const body = payBody(box.id, [{ targetType: 'expense', targetId: e.id, amountBase: '600.00' }]);
      const first = await accountant.post('/supplier-payments', body, key);
      expect([first.status, first.body.error?.code]).toEqual([409, 'insufficient_cash']);
      expect((await transfer(accountant, bank.id, box.id, '600.00', idem(), '2026-03-01')).status).toBe(201);
      const rs = await times(4, () => accountant.post('/supplier-payments', body, key));
      for (const r of rs) {
        if (r.status !== 201) expect([r.status, r.body.error?.code], show(rs)).toEqual([409, 'idempotency_in_progress']);
      }
      expect(new Set(rs.filter((r) => r.status === 201).map((r) => r.body.id)).size).toBe(1);
      expect(await settled(e.id)).toEqual({ n: 1, base: '600.00' });
      expect(await balance(box.id)).toBe('0.00');
    });
  });

  // ── Lock ordering across flows ──────────────────────────────────────────────────────────
  describe('lock ordering across flows', () => {
    // BUG: Pay-now flows deadlock with concurrent cash movements — expense/cost/acquisition/work-order
    // "payNow" posts its document first (locking the tenant's journal-number counter until commit) and
    // only then locks the cash account and takes the supplier-payment number, while a plain supplier
    // payment or transfer locks the account and the supplier-payment number first and the journal
    // counter last. Opposite lock order → PostgreSQL deadlock (40P01) → one request fails with 409.
    it('a pay-now expense and a supplier payment running at the same time both succeed (same account and different accounts)', async () => {
      const box = await createCashAccount(owner, { name: uniq('Shared box '), openingBalance: '100000.00' });
      const bank = await createCashAccount(owner, { type: 'bank', name: uniq('Shared bank '), openingBalance: '100000.00' });
      const all: Res[] = [];
      for (const payNowAccount of [box.id, box.id, box.id, bank.id, bank.id, bank.id]) {
        const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '1000.00' });
        all.push(
          ...((await Promise.all([
            owner.post('/expenses', expenseBody('100.00', { payNow: { cashAccountId: payNowAccount, method: 'cash' } }), idem()),
            accountant.post('/supplier-payments', payBody(box.id, [{ targetType: 'acquisition', targetId: acq.id, amountBase: '100.00' }]), idem()),
          ])) as Res[]),
        );
      }
      expect(all.map((r) => r.status), show(all)).toEqual(Array(12).fill(201));
    }, 90_000);

    // BUG: Acquisition approve has no concurrency guard — approve() accepts any draft/pending purchase
    // and carries no version, so an approver's decision lands on a price the maker edited after the
    // approver reviewed it (the edit withdraws the request to draft; approving a draft is allowed).
    it('an approval racing a maker’s price edit is refused instead of approving the edited price', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '80000.00', approve: false });
      // The approver opens the pending purchase and reviews 80,000.
      const seen = await approver.get(`/acquisitions/${acq.id}`);
      expect([seen.body.status, seen.body.purchasePrice]).toEqual(['pending_approval', '80000.00']);
      // Meanwhile the maker raises the price (this withdraws the approval request).
      const edit = await owner.patch(`/acquisitions/${acq.id}`, { version: seen.body.version, purchasePrice: '95000.00' });
      expect([edit.status, edit.body.status]).toEqual([200, 'draft']);
      // The approver's click arrives with what they reviewed.
      const ap = await approver.post(`/acquisitions/${acq.id}/approve`, { version: seen.body.version, note: 'OK at 80,000' }, idem());
      expect(ap.status, JSON.stringify(ap.body)).toBe(409);
      expect((await owner.get(`/acquisitions/${acq.id}`)).body.status).toBe('draft');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: acq.vehicleId })).toBe('0.00');
    });
  });
});
