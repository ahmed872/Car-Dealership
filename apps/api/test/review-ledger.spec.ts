/**
 * Adversarial review: ledger correctness, sub-ledger reconciliation and every reversal / void /
 * cancel path of Phase 3 (purchasing & finance).
 *
 * Tests marked `// BUG:` assert the CORRECT behaviour and fail today because of the named defect.
 * Every other test is a hardening check that passes. Each scenario that can break books runs in its
 * own tenant so a defect in one test cannot contaminate another tenant-wide check.
 */
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sum, todayInZone } from '@autohub/shared';
import { CashService } from '../src/modules/finance/cash.service';
import {
  addMemberWithPermissions,
  assertLedgerIntegrity,
  costCategory,
  createAcquisition,
  createSupplier,
  createVehicle,
  glBalance,
  secondApprover,
} from './fixtures';
import { Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant, uniq } from './helpers';

const TODAY = todayInZone('Asia/Riyadh'); // SA tenants

function addDays(iso: string, n: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Cash or bank account; an opening balance is dated 1 Jan 2026 so back-dated movements stay in order. */
async function account(
  c: Client,
  o: { type?: 'cashbox' | 'bank'; currency?: string; openingBalance?: string; exchangeRate?: string; openingDate?: string } = {},
) {
  const res = await c.post(
    '/cash-accounts',
    { type: 'cashbox', name: uniq('Acct '), currency: 'SAR', ...(o.openingBalance ? { openingDate: o.openingDate ?? '2026-01-01' } : {}), ...o },
    idem(),
  );
  if (res.status !== 201) throw new Error(`create cash account failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; currency: string; balance: string; balanceBase: string };
}

type Alloc = { targetType: 'acquisition' | 'vehicle_cost' | 'expense'; targetId: string; amountBase: string; amountDoc?: string };
function pay(
  c: Client,
  o: { supplierId: string | null; cashAccountId: string; paidAt: string; amount: string; exchangeRate?: string; allocations: Alloc[] },
  key = idem(),
) {
  return c.post('/supplier-payments', { method: 'bank_transfer', ...o }, key);
}

async function addCost(c: Client, body: Record<string, unknown>) {
  const res = await c.post('/vehicle-costs', { currency: 'SAR', description: 'Cost line', ...body }, idem());
  if (res.status !== 201) throw new Error(`create cost failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; status: string; amountBase: string };
}

async function addExpense(c: Client, branchId: string, body: Record<string, unknown>) {
  const res = await c.post('/expenses', { branchId, currency: 'SAR', description: 'Expense line', ...body }, idem());
  if (res.status !== 201) throw new Error(`create expense failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; number: string; status: string; amountBase: string };
}

async function entries(pool: Pool, tenantId: string, sourceType: string, sourceId: string) {
  const r = await pool.query(
    `SELECT entry_date::text AS date, event FROM journal_entries WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3 ORDER BY entry_no`,
    [tenantId, sourceType, sourceId],
  );
  return r.rows as Array<{ date: string; event: string }>;
}

/** GET /ledger/reconciliation must be clean: every section ok, no mismatches, TB balanced. */
async function expectReconciled(c: Client, asOf?: string) {
  const r = await c.get(`/ledger/reconciliation${asOf ? `?asOf=${asOf}` : ''}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  for (const s of r.body.sections as Array<{ name: string; ok: boolean; difference: string; mismatches: unknown[] }>) {
    expect({ name: s.name, ok: s.ok, difference: s.difference, mismatches: s.mismatches }, `reconciliation ${s.name} as of ${asOf ?? 'today'}`).toEqual({
      name: s.name,
      ok: true,
      difference: '0.00',
      mismatches: [],
    });
  }
  expect(r.body.trialBalance.isBalanced).toBe(true);
  expect(r.body.ok).toBe(true);
}

/** GET /payables/summary must reconcile to GL 2000 as of the date. */
async function expectPayablesReconciled(c: Client, asOf?: string) {
  const r = await c.get(`/payables/summary${asOf ? `?asOf=${asOf}` : ''}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.reconciliation, `payables aging vs GL 2000 as of ${asOf ?? 'today'}`).toMatchObject({ difference: '0.00', mismatches: [] });
}

describe('review: ledger, sub-ledgers, reversals', () => {
  let app: INestApplication;
  let admin: Client;
  let pool: Pool;

  beforeAll(async () => {
    app = await getApp();
    admin = await createPlatformAdmin(app);
    pool = ownerPool();
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  // ── Reversal / void / cancel paths (hardening: all must pass) ─────────────────────────────

  describe('removal write-off and later corrections', () => {
    it('reversing a cost after manual removal undoes exactly that part of the write-off; cancelling the purchase undoes the rest', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const bank = await account(c, { type: 'bank', openingBalance: '100000.00' });
      const seller = await createSupplier(c);
      const tower = await createSupplier(c);
      const garage = await createSupplier(c);
      const transport = await costCategory(c, 'transport');
      const parts = await costCategory(c, 'parts');
      const acq = await createAcquisition(c, t.branchId, seller.id, { price: '30000.00' });
      const T = await addCost(c, { vehicleId: acq.vehicleId, categoryId: transport, amount: '2000.00', costDate: '2026-01-20', supplierId: tower.id });
      await addCost(c, { vehicleId: acq.vehicleId, categoryId: parts, amount: '500.00', costDate: '2026-01-25', supplierId: garage.id });
      const p = await pay(c, { supplierId: tower.id, cashAccountId: bank.id, paidAt: '2026-01-26', amount: '2000.00', allocations: [{ targetType: 'vehicle_cost', targetId: T.id, amountBase: '2000.00' }] });
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      // The stock list's cost column (correlated subquery) is the vehicle's own posted total.
      const listed = (await c.get(`/vehicles?q=${acq.vehicle.stockNumber}&scope=all`)).body.items as Array<{ id: string; costTotal: string }>;
      expect(listed.find((i) => i.id === acq.vehicleId)?.costTotal).toBe('32500.00');

      const rm = await c.post(`/vehicles/${acq.vehicleId}/status`, { to: 'removed', reason: 'Flood damage found' });
      expect(rm.status, JSON.stringify(rm.body)).toBe(200);
      const veh = { col: 'vehicle_id' as const, id: acq.vehicleId };
      expect(await glBalance(pool, t.tenantId, '6300', veh)).toBe('32500.00');
      expect(await glBalance(pool, t.tenantId, '1300', veh)).toBe('0.00');

      // A paid cost cannot be reversed; after the void it can, and only its own share of the write-off is undone.
      const blocked = await c.post(`/vehicle-costs/${T.id}/reverse`, { reason: 'Billed to the wrong car' }, idem());
      expect([blocked.status, blocked.body.error?.code]).toEqual([409, 'cost_has_payments']);
      expect((await c.post(`/supplier-payments/${p.body.id}/void`, { reason: 'Towing was free' }, idem())).status).toBe(200);
      const rev = await c.post(`/vehicle-costs/${T.id}/reverse`, { reason: 'Billed to the wrong car' }, idem());
      expect(rev.status, JSON.stringify(rev.body)).toBe(200);
      expect((await entries(pool, t.tenantId, 'vehicle_cost', T.id)).map((e) => e.event)).toEqual(['cost.posted', 'cost.reversed', 'cost.write_off_reversed']);
      expect(await glBalance(pool, t.tenantId, '1300', veh)).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '6300', veh)).toBe('30500.00');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: tower.id })).toBe('0.00');
      // Reversing again is refused (no second correction).
      const again = await c.post(`/vehicle-costs/${T.id}/reverse`, { reason: 'Billed to the wrong car' }, idem());
      expect([again.status, again.body.error?.code]).toEqual([409, 'cost_not_posted']);

      // The seller takes the car back: purchase reversed, its write-off undone; only the repair stays written off.
      const cancel = await c.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Returned to seller' }, idem());
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      expect(await glBalance(pool, t.tenantId, '1300', veh)).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '6300', veh)).toBe('500.00');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: seller.id })).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: garage.id })).toBe('-500.00');
      expect((await c.get(`/cash-accounts/${bank.id}`)).body.balance).toBe('100000.00');

      await expectReconciled(c);
      await expectReconciled(c, '2026-01-31');
      await expectPayablesReconciled(c);
      await expectPayablesReconciled(c, '2026-01-31');
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    it('cancelling a purchase while a cost awaits approval and a work order awaits approval posts nothing to the removed car', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const seller = await createSupplier(c);
      const garage = await createSupplier(c);
      const parts = await costCategory(c, 'parts');
      const clerk = await addMemberWithPermissions(app, t, ['vehicles.read', 'costs.read', 'costs.create']);
      const acq = await createAcquisition(c, t.branchId, seller.id, { price: '20000.00' });
      const pending = await addCost(clerk.client, { vehicleId: acq.vehicleId, categoryId: parts, amount: '700.00', costDate: '2026-02-01', supplierId: garage.id });
      expect(pending.status).toBe('pending_approval');

      const wo = await c.post('/work-orders', { vehicleId: acq.vehicleId, type: 'repair', title: 'Paint job' });
      expect(wo.status, JSON.stringify(wo.body)).toBe(201);
      expect((await c.post(`/work-orders/${wo.body.id}/items`, { kind: 'labor', description: 'Paint', quantity: '1', unitCost: '1500.00', categoryId: parts })).status).toBe(201);
      expect((await c.post(`/work-orders/${wo.body.id}/start`)).status).toBe(200);
      expect((await c.post(`/work-orders/${wo.body.id}/complete`)).status).toBe(200);

      const cancel = await c.post(`/acquisitions/${acq.id}/cancel`, { reason: 'Seller withdrew' }, idem());
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

      const approveCost = await c.post(`/vehicle-costs/${pending.id}/approve`, {});
      expect([approveCost.status, approveCost.body.error?.code]).toEqual([409, 'vehicle_removed']);
      const approver = await secondApprover(c);
      const approveWo = await approver.post(`/work-orders/${wo.body.id}/approve`, {}, idem());
      expect([approveWo.status, approveWo.body.error?.code]).toEqual([409, 'vehicle_removed']);

      const veh = { col: 'vehicle_id' as const, id: acq.vehicleId };
      expect(await glBalance(pool, t.tenantId, '1300', veh)).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '6300', veh)).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: garage.id })).toBe('0.00');
      const posted = await pool.query(`SELECT count(*)::int AS n FROM vehicle_costs WHERE tenant_id = $1 AND status = 'posted'`, [t.tenantId]);
      expect(posted.rows[0].n).toBe(0);

      // The leftovers can still be closed without touching the books.
      expect((await c.post(`/vehicle-costs/${pending.id}/reject`, { reason: 'Car returned to seller' })).status).toBe(200);
      expect((await c.post(`/work-orders/${wo.body.id}/cancel`, { reason: 'Car returned to seller' })).status).toBe(200);
      await expectReconciled(c);
      await assertLedgerIntegrity(pool, t.tenantId);
    });
  });

  describe('one company book: multi-document payment void, partial-payment void, statements', () => {
    let t: TestTenant;
    let c: Client;
    let bank: { id: string };

    beforeAll(async () => {
      t = await createTenant(app, admin);
      c = t.owner;
      bank = await account(c, { type: 'bank', openingBalance: '100000.00' });
    });

    it('voiding a payment that settled an acquisition, a cost and an expense restores every document and the cash', async () => {
      const S = await createSupplier(c);
      const transport = await costCategory(c, 'transport');
      const rent = await costCategory(c, 'rent');
      const A = await createAcquisition(c, t.branchId, S.id, { price: '10000.00' });
      const C = await addCost(c, { vehicleId: A.vehicleId, categoryId: transport, amount: '1500.00', costDate: '2026-01-20', supplierId: S.id });
      const E = await addExpense(c, t.branchId, { categoryId: rent, amount: '700.00', expenseDate: '2026-01-31', supplierId: S.id });
      const P = await pay(c, {
        supplierId: S.id,
        cashAccountId: bank.id,
        paidAt: '2026-02-01',
        amount: '5000.00',
        allocations: [
          { targetType: 'acquisition', targetId: A.id, amountBase: '2800.00' },
          { targetType: 'vehicle_cost', targetId: C.id, amountBase: '1500.00' },
          { targetType: 'expense', targetId: E.id, amountBase: '700.00' },
        ],
      });
      expect(P.status, JSON.stringify(P.body)).toBe(201);
      const sup = { col: 'supplier_id' as const, id: S.id };
      expect(await glBalance(pool, t.tenantId, '2000', sup)).toBe('-7200.00');
      expect((await c.get(`/acquisitions/${A.id}`)).body.outstandingBase).toBe('7200.00');
      expect((await c.get(`/expenses/${E.id}`)).body.outstandingBase).toBe('0.00');

      // None of the paid documents can be undone while the payment stands.
      const a1 = await c.post(`/acquisitions/${A.id}/cancel`, { reason: 'Seller withdrew' }, idem());
      expect([a1.status, a1.body.error?.code]).toEqual([409, 'acquisition_has_payments']);
      const c1 = await c.post(`/vehicle-costs/${C.id}/reverse`, { reason: 'Wrong car' }, idem());
      expect([c1.status, c1.body.error?.code]).toEqual([409, 'cost_has_payments']);
      const e1 = await c.post(`/expenses/${E.id}/reverse`, { reason: 'Duplicate bill' }, idem());
      expect([e1.status, e1.body.error?.code]).toEqual([409, 'expense_has_payments']);

      const v = await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Bounced transfer' }, idem());
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(v.body.status).toBe('voided');
      const v2 = await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Bounced transfer' }, idem());
      expect([v2.status, v2.body.error?.code]).toEqual([409, 'already_voided']);
      expect(await glBalance(pool, t.tenantId, '2000', sup)).toBe('-12200.00');
      expect((await c.get(`/cash-accounts/${bank.id}`)).body.balance).toBe('100000.00');
      const open = await c.get(`/payables/open?supplierId=${S.id}`);
      expect(open.body.totals).toEqual({ totalBase: '12200.00', paidBase: '0.00', outstandingBase: '12200.00' });
      // One mirrored entry and one opposite cash row; allocations are kept (append-only).
      expect((await entries(pool, t.tenantId, 'supplier_payment', P.body.id)).map((e) => e.event)).toEqual(['supplier_payment.posted', 'supplier_payment.posted.reversed']);
      const allocs = await pool.query(`SELECT count(*)::int AS n FROM supplier_payment_allocations WHERE payment_id = $1`, [P.body.id]);
      expect(allocs.rows[0].n).toBe(3);

      // As of a date between payment and void, the payment is still effective in every report.
      await expectReconciled(c, '2026-02-15');
      await expectPayablesReconciled(c, '2026-02-15');

      expect((await c.post(`/vehicle-costs/${C.id}/reverse`, { reason: 'Wrong car' }, idem())).status).toBe(200);
      expect((await c.post(`/expenses/${E.id}/reverse`, { reason: 'Duplicate bill' }, idem())).status).toBe(200);
      expect((await c.post(`/acquisitions/${A.id}/cancel`, { reason: 'Seller withdrew' }, idem())).status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '2000', sup)).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: A.vehicleId })).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '6300', { col: 'vehicle_id', id: A.vehicleId })).toBe('0.00');
      await expectReconciled(c);
      await expectPayablesReconciled(c);
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    it('expense partially paid → reversal refused → payment voided → reversal; every as-of report reconciles', async () => {
      const S = await createSupplier(c);
      const utilities = await costCategory(c, 'utilities');
      const E = await addExpense(c, t.branchId, { categoryId: utilities, amount: '1000.00', expenseDate: '2026-03-01', supplierId: S.id });
      const P = await pay(c, { supplierId: S.id, cashAccountId: bank.id, paidAt: '2026-03-05', amount: '400.00', allocations: [{ targetType: 'expense', targetId: E.id, amountBase: '400.00' }] });
      expect(P.status).toBe(201);
      const detail = (await c.get(`/expenses/${E.id}`)).body;
      expect([detail.paidBase, detail.outstandingBase]).toEqual(['400.00', '600.00']);
      const blocked = await c.post(`/expenses/${E.id}/reverse`, { reason: 'Billed twice' }, idem());
      expect([blocked.status, blocked.body.error?.code, blocked.body.error?.details?.paid]).toEqual([409, 'expense_has_payments', '400.00']);
      expect((await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Billed twice' }, idem())).status).toBe(200);
      const rev = await c.post(`/expenses/${E.id}/reverse`, { reason: 'Billed twice' }, idem());
      expect(rev.status, JSON.stringify(rev.body)).toBe(200);
      expect(rev.body).toMatchObject({ status: 'reversed', paidBase: '0.00', outstandingBase: null });
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: S.id })).toBe('0.00');
      expect((await entries(pool, t.tenantId, 'expense', E.id)).map((e) => [e.event, e.date])).toEqual([
        ['expense.posted', '2026-03-01'],
        ['expense.reversed', TODAY],
      ]);
      for (const asOf of ['2026-02-28', '2026-03-03', '2026-03-10', TODAY]) {
        await expectReconciled(c, asOf);
        await expectPayablesReconciled(c, asOf);
      }
      // A reversed document cannot be paid any more.
      const late = await pay(c, { supplierId: S.id, cashAccountId: bank.id, paidAt: TODAY, amount: '1.00', allocations: [{ targetType: 'expense', targetId: E.id, amountBase: '1.00' }] });
      expect([late.status, late.body.error?.code]).toEqual([409, 'not_payable']);
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    it('trial balance, income statement, balance sheet and cash balances agree after all the reversals above', async () => {
      // Add a write-off that stays (manual removal) and a live expense so the statements are not trivially zero.
      const S = await createSupplier(c);
      const A = await createAcquisition(c, t.branchId, S.id, { price: '8000.00' });
      expect((await c.post(`/vehicles/${A.vehicleId}/status`, { to: 'removed', reason: 'Total loss in storm' })).status).toBe(200);
      const office = await costCategory(c, 'office');
      await addExpense(c, t.branchId, { categoryId: office, amount: '250.00', expenseDate: '2026-04-01' });

      const tb = await c.get(`/ledger/trial-balance?to=${TODAY}`);
      expect(tb.status).toBe(200);
      expect(tb.body.isBalanced).toBe(true);
      const closing = (code: string) => (tb.body.rows as Array<{ code: string; closing: string }>).find((r) => r.code === code)!.closing;
      expect(closing('6300')).toBe('8000.00');
      expect(closing('6000')).toBe('250.00');
      expect(closing('3000')).toBe('-100000.00');

      // Cash: TB 1100 = cash book of every account.
      const accts = (await c.get('/cash-accounts')).body as Array<{ balanceBase: string }>;
      expect(sum(accts.map((a) => a.balanceBase)).toFixed(2)).toBe(closing('1100'));

      const is = await c.get(`/ledger/income-statement?from=2026-01-01&to=${TODAY}`);
      expect(is.status).toBe(200);
      expect(is.body.netIncome).toBe('-8250.00');
      const isLine = (code: string) => (is.body.expenses.lines as Array<{ code: string; amount: string }>).find((l) => l.code === code)!.amount;
      expect(isLine('6000')).toBe(closing('6000'));
      expect(isLine('6300')).toBe(closing('6300'));

      const bs = await c.get(`/ledger/balance-sheet?asOf=${TODAY}`);
      expect(bs.status).toBe(200);
      expect(bs.body.check).toEqual({ difference: '0.00', isBalanced: true });
      expect(bs.body.equity.earnings).toBe(is.body.netIncome);
      const assets = sum(['1100', '1200', '1300', '1400'].map(closing)).toFixed(2);
      expect(bs.body.assets.total).toBe(assets);
      await expectReconciled(c);
      await assertLedgerIntegrity(pool, t.tenantId);
    });
  });

  describe('closed cash day hook, idempotent replays, concurrency', () => {
    it('a closed cash day blocks every cash path and rolls the whole business change back', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const bank = await account(c, { type: 'bank', openingBalance: '50000.00' });
      const box = await account(c, { openingBalance: '5000.00' });
      const rent = await costCategory(c, 'rent');
      const E = await addExpense(c, t.branchId, { categoryId: rent, amount: '300.00', expenseDate: '2026-03-03' });

      const closed = new Set<string>([`${box.id}:2026-03-03`]);
      const closedDates = new Set<string>(['2026-03-02']);
      const previous = CashService.closedDateChecker;
      CashService.closedDateChecker = async (_dbs, accountId, date) => closedDates.has(date) || closed.has(`${accountId}:${date}`);
      try {
        const desc = uniq('Closed day ');
        const withPay = await c.post('/expenses', { branchId: t.branchId, categoryId: rent, currency: 'SAR', description: desc, amount: '10.00', expenseDate: '2026-03-03', payNow: { cashAccountId: box.id } }, idem());
        expect([withPay.status, withPay.body.error?.code]).toEqual([409, 'cash_day_closed']);
        const leaked = await pool.query(`SELECT count(*)::int AS n FROM expenses WHERE tenant_id = $1 AND description = $2`, [t.tenantId, desc]);
        expect(leaked.rows[0].n).toBe(0);

        const p1 = await pay(c, { supplierId: null, cashAccountId: box.id, paidAt: '2026-03-03', amount: '300.00', allocations: [{ targetType: 'expense', targetId: E.id, amountBase: '300.00' }] });
        expect([p1.status, p1.body.error?.code]).toEqual([409, 'cash_day_closed']);
        expect((await pool.query(`SELECT count(*)::int AS n FROM supplier_payments WHERE tenant_id = $1`, [t.tenantId])).rows[0].n).toBe(0);
        const P = await pay(c, { supplierId: null, cashAccountId: box.id, paidAt: '2026-03-04', amount: '300.00', allocations: [{ targetType: 'expense', targetId: E.id, amountBase: '300.00' }] });
        expect(P.status, JSON.stringify(P.body)).toBe(201);

        const tr1 = await c.post('/cash/transfers', { fromAccountId: bank.id, toAccountId: box.id, amount: '1000.00', date: '2026-03-03' }, idem());
        expect([tr1.status, tr1.body.error?.code]).toEqual([409, 'cash_day_closed']);
        const TR = await c.post('/cash/transfers', { fromAccountId: bank.id, toAccountId: box.id, amount: '1000.00', date: '2026-03-05' }, idem());
        expect(TR.status, JSON.stringify(TR.body)).toBe(201);

        const opening = await c.post('/cash-accounts', { type: 'bank', name: uniq('Late bank '), currency: 'SAR', openingBalance: '10.00', openingDate: '2026-03-02' }, idem());
        expect([opening.status, opening.body.error?.code]).toEqual([409, 'cash_day_closed']);

        // Today closed for the box: the void and the transfer reversal (both dated today) are refused.
        closed.add(`${box.id}:${TODAY}`);
        const v1 = await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Wrong box' }, idem());
        expect([v1.status, v1.body.error?.code]).toEqual([409, 'cash_day_closed']);
        expect((await c.get(`/supplier-payments/${P.body.id}`)).body.status).toBe('posted');
        const r1 = await c.post(`/cash/transfers/${TR.body.transferId}/reverse`, { reason: 'Wrong box' }, idem());
        expect([r1.status, r1.body.error?.code]).toEqual([409, 'cash_day_closed']);

        // Reopened: both go through.
        closed.delete(`${box.id}:${TODAY}`);
        expect((await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Wrong box' }, idem())).status).toBe(200);
        expect((await c.post(`/cash/transfers/${TR.body.transferId}/reverse`, { reason: 'Wrong box' }, idem())).status).toBe(200);
      } finally {
        CashService.closedDateChecker = previous;
      }
      expect((await c.get(`/cash-accounts/${box.id}`)).body.balance).toBe('5000.00');
      expect((await c.get(`/cash-accounts/${bank.id}`)).body.balance).toBe('50000.00');
      await expectReconciled(c);
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    it('idempotent replays after the state changed return the first response and post nothing', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const bank = await account(c, { type: 'bank', openingBalance: '10000.00' });
      const S = await createSupplier(c);
      const rent = await costCategory(c, 'rent');
      const E = await addExpense(c, t.branchId, { categoryId: rent, amount: '900.00', expenseDate: '2026-02-01', supplierId: S.id });
      const body = { supplierId: S.id, cashAccountId: bank.id, paidAt: '2026-02-02', amount: '900.00', allocations: [{ targetType: 'expense' as const, targetId: E.id, amountBase: '900.00' }] };
      const payKey = idem();
      const P = await pay(c, body, payKey);
      expect(P.status).toBe(201);
      const voidKey = idem();
      const V = await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Supplier refunded' }, voidKey);
      expect(V.status).toBe(200);

      const replayPay = await pay(c, body, payKey);
      expect(replayPay.status).toBe(201);
      expect(replayPay.headers['idempotent-replayed']).toBe('true');
      expect(replayPay.body.id).toBe(P.body.id);
      const replayVoid = await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Supplier refunded' }, voidKey);
      expect([replayVoid.status, replayVoid.headers['idempotent-replayed'], replayVoid.body.status]).toEqual([200, 'true', 'voided']);
      const changed = await pay(c, { ...body, amount: '899.00', allocations: [{ ...body.allocations[0]!, amountBase: '899.00' }] }, payKey);
      expect([changed.status, changed.body.error?.code]).toEqual([422, 'idempotency_key_reused']);

      expect((await entries(pool, t.tenantId, 'supplier_payment', P.body.id)).map((e) => e.event)).toEqual(['supplier_payment.posted', 'supplier_payment.posted.reversed']);
      const rows = await pool.query(`SELECT count(*)::int AS n FROM cash_transactions WHERE tenant_id = $1 AND source_id = $2`, [t.tenantId, P.body.id]);
      expect(rows.rows[0].n).toBe(2);
      const payments = await pool.query(`SELECT count(*)::int AS n FROM supplier_payments WHERE tenant_id = $1`, [t.tenantId]);
      expect(payments.rows[0].n).toBe(1);
      expect((await c.get(`/expenses/${E.id}`)).body.outstandingBase).toBe('900.00');
      expect((await c.get(`/cash-accounts/${bank.id}`)).body.balance).toBe('10000.00');
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    it('concurrent payments cannot overpay one document; concurrent voids reverse once; reverse-vs-pay lets exactly one win', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const bank = await account(c, { type: 'bank', openingBalance: '10000.00' });
      const S = await createSupplier(c);
      const transport = await costCategory(c, 'transport');
      const v = await createVehicle(c, t.branchId);
      const C1 = await addCost(c, { vehicleId: v.id, categoryId: transport, amount: '1000.00', costDate: '2026-02-01', supplierId: S.id });
      const full = { supplierId: S.id, cashAccountId: bank.id, paidAt: '2026-02-02', amount: '1000.00', allocations: [{ targetType: 'vehicle_cost' as const, targetId: C1.id, amountBase: '1000.00' }] };
      const both = await Promise.all([pay(c, full), pay(c, full)]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(both.find((r) => r.status === 409)!.body.error.code).toBe('overpayment');
      const P = both.find((r) => r.status === 201)!.body as { id: string };

      const voids = await Promise.all([
        c.post(`/supplier-payments/${P.id}/void`, { reason: 'Race one' }, idem()),
        c.post(`/supplier-payments/${P.id}/void`, { reason: 'Race two' }, idem()),
      ]);
      expect(voids.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await entries(pool, t.tenantId, 'supplier_payment', P.id)).length).toBe(2);

      const C2 = await addCost(c, { vehicleId: v.id, categoryId: transport, amount: '400.00', costDate: '2026-02-03', supplierId: S.id });
      const race = await Promise.all([
        c.post(`/vehicle-costs/${C2.id}/reverse`, { reason: 'Race reverse' }, idem()),
        pay(c, { ...full, amount: '400.00', allocations: [{ targetType: 'vehicle_cost', targetId: C2.id, amountBase: '400.00' }] }),
      ]);
      const ok = race.filter((r) => r.status === 200 || r.status === 201);
      expect(ok.length, JSON.stringify(race.map((r) => [r.status, r.body.error?.code]))).toBe(1);
      expect(race.filter((r) => r.status === 409).length).toBe(1);
      await expectReconciled(c);
      await assertLedgerIntegrity(pool, t.tenantId);
    });
  });

  describe('foreign currency legs', () => {
    it('USD opening balance, USD payment and its void, SAR↔USD transfers and their reversals keep each leg exact', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const usd = await account(c, { type: 'bank', currency: 'USD', openingBalance: '1000.00', exchangeRate: '3.75' });
      expect([usd.balance, usd.balanceBase]).toEqual(['1000.00', '3750.00']);
      const sar = await account(c, { type: 'bank', openingBalance: '20000.00' });
      expect(await glBalance(pool, t.tenantId, '3000')).toBe('-23750.00');

      const S = await createSupplier(c);
      const A = await createAcquisition(c, t.branchId, S.id, { price: '2000.00', currency: 'USD', exchangeRate: '3.75' });
      const P = await pay(c, { supplierId: S.id, cashAccountId: usd.id, paidAt: '2026-02-01', amount: '100.01', exchangeRate: '3.7501', allocations: [{ targetType: 'acquisition', targetId: A.id, amountBase: '375.05' }] });
      expect(P.status, JSON.stringify(P.body)).toBe(201);
      expect(P.body).toMatchObject({ amount: '100.01', currency: 'USD', exchangeRate: '3.75010000', amountBase: '375.05' });
      expect((await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Wrong rate' }, idem())).status).toBe(200);
      expect((await c.get(`/cash-accounts/${usd.id}`)).body).toMatchObject({ balance: '1000.00', balanceBase: '3750.00' });

      const out = await c.post('/cash/transfers', { fromAccountId: sar.id, toAccountId: usd.id, amount: '1000.00', amountTo: '266.67', date: '2026-02-05' }, idem());
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      expect(out.body).toMatchObject({ amountBase: '1000.00', from: { amount: '1000.00' }, to: { amount: '266.67', exchangeRate: '3.74995313' } });
      const back = await c.post('/cash/transfers', { fromAccountId: usd.id, toAccountId: sar.id, amount: '100.01', exchangeRate: '3.7501', date: '2026-02-06' }, idem());
      expect(back.status, JSON.stringify(back.body)).toBe(201);
      expect(back.body).toMatchObject({ amountBase: '375.05', to: { amount: '375.05' } });
      expect((await c.post(`/cash/transfers/${back.body.transferId}/reverse`, { reason: 'Test' }, idem())).status).toBe(200);
      expect((await c.post(`/cash/transfers/${out.body.transferId}/reverse`, { reason: 'Test' }, idem())).status).toBe(200);
      expect((await c.get(`/cash-accounts/${usd.id}`)).body).toMatchObject({ balance: '1000.00', balanceBase: '3750.00' });
      expect((await c.get(`/cash-accounts/${sar.id}`)).body).toMatchObject({ balance: '20000.00', balanceBase: '20000.00' });
      await expectReconciled(c);
      await assertLedgerIntegrity(pool, t.tenantId);
    });
  });

  // ── Confirmed defects (each fails today) ──────────────────────────────────────────────────

  describe('confirmed defects', () => {
    // BUG: voiding a post-dated supplier payment is dated today, before the payment it reverses
    it('voiding a post-dated payment never dates the reversal before the payment (no phantom cash or AP in between)', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const bank = await account(c, { type: 'bank', openingBalance: '50000.00' });
      const S = await createSupplier(c);
      const rent = await costCategory(c, 'rent');
      const E = await addExpense(c, t.branchId, { categoryId: rent, amount: '1000.00', expenseDate: '2026-01-10', supplierId: S.id });
      const later = addDays(TODAY, 20);
      const P = await pay(c, { supplierId: S.id, cashAccountId: bank.id, paidAt: later, amount: '1000.00', allocations: [{ targetType: 'expense', targetId: E.id, amountBase: '1000.00' }] });
      expect(P.status, JSON.stringify(P.body)).toBe(201);
      expect((await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Cheque cancelled before its date' }, idem())).status).toBe(200);

      // Today the payment never happened: the bank holds 50,000 and the supplier is owed 1,000.
      const book = await c.get(`/cash/accounts/${bank.id}/book?to=${TODAY}`);
      expect(book.status).toBe(200);
      expect(book.body.closing.amount).toBe('50000.00');
      await expectPayablesReconciled(c, TODAY);
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: S.id })).toBe('-1000.00');
      // Like expenses, costs and transfers: a reversal is never dated before what it reverses.
      expect((await entries(pool, t.tenantId, 'supplier_payment', P.body.id)).map((e) => [e.event, e.date])).toEqual([
        ['supplier_payment.posted', later],
        ['supplier_payment.posted.reversed', later],
      ]);
    });

    // BUG: shared-cost allocation in a foreign currency books a different base amount than the invoice
    it('an equal split of a USD invoice books exactly the invoice in base currency, so paying it in full settles it', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const S = await createSupplier(c);
      const shipping = await costCategory(c, 'shipping');
      const vs = [await createVehicle(c, t.branchId), await createVehicle(c, t.branchId), await createVehicle(c, t.branchId)];
      const res = await c.post(
        '/vehicle-costs/allocate',
        { vehicleIds: vs.map((v) => v.id), method: 'equal', categoryId: shipping, description: 'Shared container', totalAmount: '100.00', currency: 'USD', exchangeRate: '3.75', costDate: '2026-02-01', supplierId: S.id },
        idem(),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.allocated).toEqual(['33.34', '33.33', '33.33']);
      const bases = (res.body.costs as Array<{ amountBase: string }>).map((x) => x.amountBase);
      // 100.00 USD × 3.75 = 375.00 SAR is what the supplier invoiced and what a 100 USD payment settles.
      expect(sum(bases).toFixed(2)).toBe('375.00');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: S.id })).toBe('-375.00');
    });

    // BUG: voiding a payment puts money back into a deactivated cash account
    it('a payment from an account that was emptied and deactivated cannot be voided back into it', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const box = await account(c, { openingBalance: '1000.00' });
      const rent = await costCategory(c, 'rent');
      const E = await addExpense(c, t.branchId, { categoryId: rent, amount: '1000.00', expenseDate: '2026-02-01' });
      const P = await pay(c, { supplierId: null, cashAccountId: box.id, paidAt: '2026-02-01', amount: '1000.00', allocations: [{ targetType: 'expense', targetId: E.id, amountBase: '1000.00' }] });
      expect(P.status).toBe(201);
      const off = await c.patch(`/cash-accounts/${box.id}`, { isActive: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      // Inactive accounts must hold nothing (deactivation requires a zero balance; transfers and
      // transfer reversals refuse inactive accounts) — the void must be refused the same way.
      const v = await c.post(`/supplier-payments/${P.body.id}/void`, { reason: 'Closed the box' }, idem());
      expect([v.status, v.body.error?.code]).toEqual([409, 'cash_account_inactive']);
    });

    // BUG: back-dated cash-box payments can make the cash book negative before the money arrived
    it('a cash-box payment dated before the box was funded is refused (the cash book never goes negative)', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const bank = await account(c, { type: 'bank', openingBalance: '50000.00' });
      const box = await account(c);
      const tr = await c.post('/cash/transfers', { fromAccountId: bank.id, toAccountId: box.id, amount: '1000.00', date: '2026-06-01' }, idem());
      expect(tr.status, JSON.stringify(tr.body)).toBe(201);
      const rent = await costCategory(c, 'rent');
      const E = await addExpense(c, t.branchId, { categoryId: rent, amount: '1000.00', expenseDate: '2026-01-20' });
      const P = await pay(c, { supplierId: null, cashAccountId: box.id, paidAt: '2026-02-01', amount: '1000.00', allocations: [{ targetType: 'expense', targetId: E.id, amountBase: '1000.00' }] });
      // On 2026-02-01 the box held nothing; accepting this shows −1,000 in the cash box until June.
      expect([P.status, P.body.error?.code]).toEqual([409, 'insufficient_cash']);
    });

    // BUG: no realized FX difference — an emptied foreign-currency account keeps a base-currency balance
    it('emptying a USD account at a new rate leaves no base-currency balance on it', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const usd = await account(c, { type: 'bank', currency: 'USD', openingBalance: '1000.00', exchangeRate: '3.75' });
      const sar = await account(c, { type: 'bank' });
      const tr = await c.post('/cash/transfers', { fromAccountId: usd.id, toAccountId: sar.id, amount: '1000.00', exchangeRate: '3.80', date: '2026-03-01' }, idem());
      expect(tr.status, JSON.stringify(tr.body)).toBe(201);
      expect((await c.get(`/cash-accounts/${sar.id}`)).body).toMatchObject({ balance: '3800.00', balanceBase: '3800.00' });
      const after = (await c.get(`/cash-accounts/${usd.id}`)).body;
      expect(after.balance).toBe('0.00');
      // 0 USD is worth 0 SAR; the 50.00 difference is a realized FX gain, not cash.
      expect(after.balanceBase).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '1100')).toBe('3800.00');
    });

    // FIXED (F-001): a foreign-currency invoice is settled by stating the document-currency amount
    // (amountDoc); the payable is relieved at its carrying cost and differences go to 4300.
    it('a 10,000 USD purchase can be settled in full with 10,000 USD paid at a later rate', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const S = await createSupplier(c);
      const usd = await account(c, { type: 'bank', currency: 'USD', openingBalance: '10000.00', exchangeRate: '3.75' });
      const A = await createAcquisition(c, t.branchId, S.id, { price: '10000.00', currency: 'USD', exchangeRate: '3.75', vehicle: {} });
      expect((await c.get(`/acquisitions/${A.id}`)).body.outstandingBase).toBe('37500.00');
      const base = { supplierId: S.id, cashAccountId: usd.id, paidAt: '2026-03-01', amount: '10000.00', exchangeRate: '3.80' };
      const paid = await pay(c, { ...base, allocations: [{ targetType: 'acquisition', targetId: A.id, amountBase: '38000.00', amountDoc: '10000.00' }] });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.allocations[0]).toMatchObject({ amountBase: '38000.00', settledBase: '37500.00', amountDoc: '10000.00', currency: 'USD' });
      expect((await c.get(`/acquisitions/${A.id}`)).body.outstandingBase).toBe('0.00');
      // USD bought at 3.75 settled a USD liability booked at 3.75: no realized FX overall.
      expect(await glBalance(pool, t.tenantId, '4300')).toBe('0.00');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: S.id })).toBe('0.00');
      expect((await c.get(`/cash-accounts/${usd.id}`)).body).toMatchObject({ balance: '0.00', balanceBase: '0.00' });

      // Paying a USD invoice from a SAR account at a worse rate realizes a loss.
      const sar = await account(c, { type: 'bank', openingBalance: '50000.00' });
      const B = await createAcquisition(c, t.branchId, S.id, { price: '1000.00', currency: 'USD', exchangeRate: '3.75', vehicle: {} });
      const p2 = await pay(c, { supplierId: S.id, cashAccountId: sar.id, paidAt: '2026-03-02', amount: '3800.00', allocations: [{ targetType: 'acquisition', targetId: B.id, amountBase: '3800.00', amountDoc: '1000.00' }] });
      expect(p2.status, JSON.stringify(p2.body)).toBe(201);
      expect(await glBalance(pool, t.tenantId, '4300')).toBe('50.00');
      expect((await c.get(`/acquisitions/${B.id}`)).body.outstandingBase).toBe('0.00');
      // Without amountDoc a SAR allocation settles at the booking rate: 3,800 SAR would be 1,013.33 USD → overpayment.
      const C = await createAcquisition(c, t.branchId, S.id, { price: '1000.00', currency: 'USD', exchangeRate: '3.75', vehicle: {} });
      const over = await pay(c, { supplierId: S.id, cashAccountId: sar.id, paidAt: '2026-03-02', amount: '3800.00', allocations: [{ targetType: 'acquisition', targetId: C.id, amountBase: '3800.00' }] });
      expect(over.status).toBe(409);
      expect(over.body.error).toMatchObject({ code: 'overpayment', details: { outstanding: '1000.00', currency: 'USD' } });
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    // FIXED (F-009): approval books the stored base, and the rounding rule is locked once any
    // financial document exists (not only journal entries).
    it('the posted purchase cost always equals the acquisition purchase_price_base', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const S = await createSupplier(c);
      // Pending purchase recorded while rounding is half_up: 33.33 × 3.75 = 124.9875 → 124.99.
      const A = await createAcquisition(c, t.branchId, S.id, { price: '33.33', currency: 'USD', exchangeRate: '3.75', approve: false });
      expect((await c.get(`/acquisitions/${A.id}`)).body.purchasePriceBase).toBe('124.99');
      // A stored base amount now exists, so the rounding rule can no longer change.
      const setting = await c.patch('/company', { settings: { rounding: 'down' } });
      expect(setting.status).toBe(409);
      expect(setting.body.error).toMatchObject({ code: 'setting_locked', details: { settings: ['rounding'] } });
      const ap = await (await secondApprover(c)).post(`/acquisitions/${A.id}/approve`, {}, idem());
      expect(ap.status, JSON.stringify(ap.body)).toBe(200);
      const cost = await pool.query(`SELECT amount_base::text AS b FROM vehicle_costs WHERE tenant_id = $1 AND source_type = 'acquisition' AND source_id = $2`, [t.tenantId, A.id]);
      expect(cost.rows[0].b).toBe('124.99');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: S.id })).toBe('-124.99');
    });

    // FIXED (F-008): the balance up to today is written off today, future-dated costs on their own date.
    it('removing a car never leaves negative inventory on any date (future-dated cost)', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const S = await createSupplier(c);
      const transport = await costCategory(c, 'transport');
      const customs = await costCategory(c, 'customs');
      const v = await createVehicle(c, t.branchId);
      await addCost(c, { vehicleId: v.id, categoryId: transport, amount: '1000.00', costDate: '2026-02-01', supplierId: S.id });
      await addCost(c, { vehicleId: v.id, categoryId: customs, amount: '2000.00', costDate: addDays(TODAY, 30), supplierId: S.id });
      expect((await c.post(`/vehicles/${v.id}/status`, { to: 'removed', reason: 'Export cancelled' })).status).toBe(200);
      // As of today the car carried 1,000; writing off 3,000 today leaves −2,000 on 1300 until the customs date.
      const r = await pool.query(
        `SELECT coalesce(sum(jl.debit - jl.credit), 0)::numeric(18,2)::text AS b FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.tenant_id = $1 AND jl.account_code = '1300' AND jl.vehicle_id = $2 AND je.entry_date <= $3::date`,
        [t.tenantId, v.id, TODAY],
      );
      expect(r.rows[0].b).toBe('0.00');
      await expectReconciled(c, TODAY);
    });

    // FIXED (F-010): editing a pending purchase withdraws it to draft; the inbox only ever shows
    // the amount that will be posted, after resubmission.
    it('the approval inbox shows the amount that will actually be posted when a pending purchase is edited', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const S = await createSupplier(c);
      const A = await createAcquisition(c, t.branchId, S.id, { price: '80000.00', approve: false });
      const before = (await c.get(`/acquisitions/${A.id}`)).body;
      const edit = await c.patch(`/acquisitions/${A.id}`, { version: before.version, purchasePrice: '800000.00' });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      expect(edit.body.status).toBe('draft');
      const approver = await secondApprover(c);
      type Item = { entityId: string; summary: string; payload: { amountBase: string } };
      expect(((await approver.get('/approvals')).body as Item[]).some((i) => i.entityId === A.id)).toBe(false);
      expect((await c.post(`/acquisitions/${A.id}/submit`)).status).toBe(200);
      const item = ((await approver.get('/approvals')).body as Item[]).find((i) => i.entityId === A.id)!;
      expect(item.payload.amountBase).toBe('800000.00');
      expect(item.summary).toContain('800000.00');
    });

    // BUG: the user who edits a pending acquisition's price can approve it (maker-checker bypass)
    it('whoever changes the price of a pending purchase cannot approve that price themselves (maker-checker)', async () => {
      const t = await createTenant(app, admin);
      const c = t.owner;
      const S = await createSupplier(c);
      const A = await createAcquisition(c, t.branchId, S.id, { price: '80000.00', approve: false });
      const editor = await secondApprover(c); // an owner: holds acquisitions.create and acquisitions.approve
      const before = (await editor.get(`/acquisitions/${A.id}`)).body;
      const edit = await editor.patch(`/acquisitions/${A.id}`, { version: before.version, purchasePrice: '95000.00' });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      // The editor set the amount that would be posted, so the editor is a maker of this request.
      const ap = await editor.post(`/acquisitions/${A.id}/approve`, {}, idem());
      expect([ap.status, ap.body.error?.code]).toEqual([403, 'self_approval_forbidden']);
    });
  });
});
