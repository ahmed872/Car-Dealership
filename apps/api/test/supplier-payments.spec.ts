import { randomUUID } from 'node:crypto';
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
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

type Alloc = { targetType: 'acquisition' | 'vehicle_cost' | 'expense'; targetId: string; amountBase: string };

/**
 * Supplier payments against a real database: allocation rules (exact sum, same supplier, payable
 * documents only, no duplicates, no overpayment), concurrency and idempotency, voids, cash-box
 * limits, foreign-currency accounts, permissions, branch scope and tenant isolation. Every test
 * leaves the tenant's books balanced (assertLedgerIntegrity after each test).
 */
describe('supplier payments', () => {
  let app: INestApplication;
  let t: TestTenant;
  let t2: TestTenant;
  let pool: Pool;
  let owner: Client;
  let accountant: Client;
  let supplier: { id: string };
  let other: { id: string };
  let cash: { id: string };
  let bank: { id: string };
  let usdBank: { id: string };
  let transport: string;
  let rent: string;

  const alloc = (targetType: Alloc['targetType'], targetId: string, amountBase: string): Alloc => ({ targetType, targetId, amountBase });
  const payBody = (allocations: Alloc[], overrides: Record<string, unknown> = {}) => ({
    supplierId: supplier.id,
    cashAccountId: cash.id,
    paidAt: '2026-04-01',
    method: 'cash',
    amount: sum(allocations.map((a) => a.amountBase)).toFixed(2),
    allocations,
    ...overrides,
  });
  const pay = (c: Client, body: unknown, key: Record<string, string> = idem()) => c.post('/supplier-payments', body, key);
  const voidPayment = (c: Client, id: string, reason = 'Paid in error') => c.post(`/supplier-payments/${id}/void`, { reason }, idem());

  const postCost = async (vehicleId: string, overrides: Record<string, unknown> = {}) => {
    const res = await accountant.post(
      '/vehicle-costs',
      { vehicleId, categoryId: transport, description: 'Transport', amount: '1000.00', currency: 'SAR', costDate: '2026-04-01', supplierId: supplier.id, ...overrides },
      idem(),
    );
    if (res.status !== 201) throw new Error(`cost failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; status: string; amountBase: string };
  };
  const outstanding = async (acqId: string) => {
    const r = await owner.get(`/acquisitions/${acqId}`);
    return { paid: r.body.paidBase as string, outstanding: r.body.outstandingBase as string };
  };
  const costPaid = async (vehicleId: string, costId: string) =>
    ((await owner.get(`/vehicles/${vehicleId}/costs`)).body.items as Array<{ id: string; paidBase: string }>).find((i) => i.id === costId)!.paidBase;
  const paymentCount = async (tenantId = t.tenantId) => Number((await pool.query(`SELECT count(*)::int AS n FROM supplier_payments WHERE tenant_id = $1`, [tenantId])).rows[0].n);
  const entryCount = async (tenantId = t.tenantId) => Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1`, [tenantId])).rows[0].n);
  const paymentsFor = async (targetId: string) =>
    (await pool.query(`SELECT DISTINCT payment_id FROM supplier_payment_allocations WHERE target_id = $1`, [targetId])).rows.map((r) => r.payment_id as string);
  const cashRows = async (paymentId: string) =>
    (
      await pool.query(
        `SELECT id, direction, amount, amount_base AS "amountBase", exchange_rate AS "exchangeRate", kind, cash_account_id AS "cashAccountId",
                reversal_of_id AS "reversalOfId", journal_entry_id AS "journalEntryId"
           FROM cash_transactions WHERE source_type = 'supplier_payment' AND source_id = $1 ORDER BY occurred_at, created_at`,
        [paymentId],
      )
    ).rows;
  const lines = async (paymentId: string) =>
    (
      await pool.query(
        `SELECT e.id AS "entryId", e.event, l.account_code AS account, l.debit, l.credit, l.supplier_id AS "supplierId", l.cash_account_id AS "cashAccountId"
           FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
          WHERE e.source_type = 'supplier_payment' AND e.source_id = $1 ORDER BY e.entry_no, l.line_no`,
        [paymentId],
      )
    ).rows;
  const seq = (number: string) => Number(number.split('-')[2]);

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    t2 = await createTenant(app, admin);
    pool = ownerPool();
    owner = t.owner;
    accountant = (await addMember(app, t, 'accountant')).client;
    supplier = await createSupplier(owner, { name: 'Al Majd Motors' });
    other = await createSupplier(owner, { name: 'Desert Spare Parts' });
    cash = await createCashAccount(owner, { name: 'Main safe', openingBalance: '500000.00' });
    bank = await createCashAccount(owner, { type: 'bank', name: 'Operating bank', openingBalance: '100000.00' });
    usdBank = await createCashAccount(owner, { type: 'bank', name: 'USD bank', currency: 'USD', openingBalance: '10000.00', exchangeRate: '3.75' });
    transport = await costCategory(owner, 'transport');
    const cats = (await owner.get('/expense-categories')).body as Array<{ id: string; code: string }>;
    rent = cats.find((c) => c.code === 'rent')!.id;
  });

  afterEach(async () => {
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('one payment settles an acquisition, a vehicle cost and an expense: Dr 2000 / Cr 1100, one cash row, numbered and audited', async () => {
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '30000.00' });
    const c = await postCost(acq.vehicleId, { amount: '1200.00' });
    const exp = await accountant.post(
      '/expenses',
      { branchId: t.branchId, categoryId: rent, description: 'Yard rent', amount: '5000.00', currency: 'SAR', expenseDate: '2026-04-01', supplierId: supplier.id },
      idem(),
    );
    expect(exp.status).toBe(201);
    expect(exp.body.status).toBe('posted');
    const allocations = [alloc('acquisition', acq.id, '10000.00'), alloc('vehicle_cost', c.id, '1200.00'), alloc('expense', exp.body.id, '2500.00')];
    const cashBefore = await cashBookBalance(pool, cash.id);
    const apBefore = await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id });

    const res = await pay(accountant, payBody(allocations, { reference: 'TRX-1', notes: 'April settlement' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      supplierId: supplier.id,
      cashAccountId: cash.id,
      amount: '13700.00',
      currency: 'SAR',
      exchangeRate: '1.00000000',
      amountBase: '13700.00',
      status: 'posted',
      method: 'cash',
      reference: 'TRX-1',
      notes: 'April settlement',
      paidAt: '2026-04-01',
    });
    expect(res.body.number).toMatch(/^SPY-\d{4}-\d{6}$/);
    // Base-currency documents: settled amount = allocated amount, in the document's own currency.
    expect(res.body.allocations).toEqual(allocations.map((a) => ({ ...a, settledBase: a.amountBase, amountDoc: a.amountBase, currency: 'SAR' })));

    const gl = await lines(res.body.id);
    expect(gl.map(({ entryId: _e, ...l }) => l)).toEqual([
      { event: 'supplier_payment.posted', account: '1100', debit: '0.00', credit: '13700.00', supplierId: null, cashAccountId: cash.id },
      { event: 'supplier_payment.posted', account: '2000', debit: '13700.00', credit: '0.00', supplierId: supplier.id, cashAccountId: null },
    ]);
    const rows = await cashRows(res.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'out', amount: '13700.00', amountBase: '13700.00', kind: 'supplier_payment', cashAccountId: cash.id, reversalOfId: null, journalEntryId: gl[0]!.entryId });
    expect((await cashBookBalance(pool, cash.id)).amount).toBe(d(cashBefore.amount).minus('13700.00').toFixed(2));
    expect(d(await glBalance(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).minus(apBefore).toFixed(2)).toBe('13700.00');

    expect(await outstanding(acq.id)).toEqual({ paid: '10000.00', outstanding: '20000.00' });
    expect(await costPaid(acq.vehicleId, c.id)).toBe('1200.00');
    expect((await owner.get(`/expenses/${exp.body.id}`)).body).toMatchObject({ paidBase: '2500.00', outstandingBase: '2500.00' });

    const got = await owner.get(`/supplier-payments/${res.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.allocations.map((a: Alloc & { paymentId: string }) => [a.paymentId, a.targetType, a.targetId, a.amountBase]).sort()).toEqual(
      allocations.map((a) => [res.body.id, a.targetType, a.targetId, a.amountBase]).sort(),
    );
    const list = await owner.get(`/supplier-payments?supplierId=${supplier.id}&status=posted&pageSize=200`);
    expect(list.status).toBe(200);
    expect(list.body.items.find((i: { id: string }) => i.id === res.body.id)).toMatchObject({ supplierName: 'Al Majd Motors', cashAccountName: 'Main safe', amount: '13700.00' });
    expect((await owner.get(`/supplier-payments?status=voided&pageSize=200`)).body.items.some((i: { id: string }) => i.id === res.body.id)).toBe(false);
    expect((await owner.get(`/supplier-payments?supplierId=${other.id}&pageSize=200`)).body.items.some((i: { id: string }) => i.id === res.body.id)).toBe(false);
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'supplier_payment' AND entity_id = $1`, [res.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['supplier_payment.posted']);
  });

  it('refuses inconsistent payments (mismatch, wrong supplier, duplicates, unpayable or unknown documents) without posting or consuming a number', async () => {
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '20000.00' });
    const draft = await createAcquisition(owner, t.branchId, supplier.id, { submit: false, approve: false });
    const pendingAcq = await createAcquisition(owner, t.branchId, supplier.id, { approve: false });
    const v = await createVehicle(owner, t.branchId);
    const otherCost = await postCost(v.id, { supplierId: other.id, amount: '100.00' });
    const inventory = (await addMember(app, t, 'inventory_manager')).client;
    const pendingCost = await inventory.post(
      '/vehicle-costs',
      { vehicleId: v.id, categoryId: transport, description: 'Pending tow', amount: '100.00', currency: 'SAR', costDate: '2026-04-01', supplierId: supplier.id },
      idem(),
    );
    expect(pendingCost.body.status).toBe('pending_approval');
    const reversedCost = await postCost(v.id, { amount: '100.00' });
    expect((await accountant.post(`/vehicle-costs/${reversedCost.id}/reverse`, { reason: 'Booked twice' }, idem())).status).toBe(200);

    const first = await pay(accountant, payBody([alloc('acquisition', acq.id, '100.00')]));
    expect(first.status).toBe(201);
    const before = { payments: await paymentCount(), entries: await entryCount(), cash: await cashBookBalance(pool, cash.id) };

    const mismatch = await pay(accountant, payBody([alloc('acquisition', acq.id, '1000.00')], { amount: '999.99' }));
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('allocation_mismatch');
    expect(mismatch.body.error.details).toEqual({ paymentBase: '999.99', allocated: '1000.00' });

    const wrongSupplier = await pay(accountant, payBody([alloc('vehicle_cost', otherCost.id, '100.00')]));
    expect(wrongSupplier.status).toBe(422);
    expect(wrongSupplier.body.error.code).toBe('supplier_mismatch');
    expect(wrongSupplier.body.error.details.target).toBe(`vehicle_cost:${otherCost.id}`);
    const noSupplier = await pay(accountant, payBody([alloc('acquisition', acq.id, '100.00')], { supplierId: null }));
    expect(noSupplier.status).toBe(422);
    expect(noSupplier.body.error.code).toBe('supplier_mismatch');
    // One payment cannot mix suppliers either.
    const mixed = await pay(accountant, payBody([alloc('acquisition', acq.id, '100.00'), alloc('vehicle_cost', otherCost.id, '100.00')]));
    expect(mixed.status).toBe(422);
    expect(mixed.body.error.code).toBe('supplier_mismatch');

    for (const [type, id] of [
      ['acquisition', draft.id],
      ['acquisition', pendingAcq.id],
      ['vehicle_cost', pendingCost.body.id],
      ['vehicle_cost', reversedCost.id],
    ] as const) {
      const r = await pay(accountant, payBody([alloc(type, id, '100.00')]));
      expect(r.status, `${type} ${id}`).toBe(409);
      expect(r.body.error.code).toBe('not_payable');
    }

    const dup = await pay(accountant, payBody([alloc('acquisition', acq.id, '100.00'), alloc('acquisition', acq.id, '200.00')]));
    expect(dup.status).toBe(422);
    expect(dup.body.error.code).toBe('duplicate_allocation');
    const over = await pay(accountant, payBody([alloc('acquisition', acq.id, '19900.01')]));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('overpayment');
    expect(over.body.error.details.outstanding).toBe('19900.00');

    expect((await pay(accountant, payBody([alloc('expense', randomUUID(), '100.00')]))).status).toBe(404);
    expect((await pay(accountant, payBody([alloc('vehicle_cost', randomUUID(), '100.00')]))).status).toBe(404);
    expect((await pay(accountant, payBody([alloc('acquisition', acq.id, '100.00')], { supplierId: randomUUID() }))).status).toBe(404);
    expect((await pay(accountant, payBody([alloc('acquisition', acq.id, '100.00')], { cashAccountId: randomUUID() }))).status).toBe(404);
    const empty = await pay(accountant, payBody([], { amount: '100.00' }));
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('validation_failed');
    const negative = await pay(accountant, payBody([alloc('acquisition', acq.id, '-100.00')], { amount: '100.00' }));
    expect(negative.status).toBe(422);
    expect(negative.body.error.code).toBe('validation_failed');

    expect(await paymentCount()).toBe(before.payments);
    expect(await entryCount()).toBe(before.entries);
    expect(await cashBookBalance(pool, cash.id)).toEqual(before.cash);
    expect(await outstanding(acq.id)).toEqual({ paid: '100.00', outstanding: '19900.00' });
    // Numbering is gapless: the failed attempts consumed no number.
    const next = await pay(accountant, payBody([alloc('acquisition', acq.id, '100.00')]));
    expect(next.status).toBe(201);
    expect(seq(next.body.number)).toBe(seq(first.body.number) + 1);
  });

  it('pays supplier-less direct purchases with a supplier-less payment only', async () => {
    const v = await createVehicle(owner, t.branchId);
    const direct = await postCost(v.id, { supplierId: null, amount: '250.00', description: 'Car wash (cash, no invoice)' });
    const withSupplier = await pay(accountant, payBody([alloc('vehicle_cost', direct.id, '250.00')]));
    expect(withSupplier.status).toBe(422);
    expect(withSupplier.body.error.code).toBe('supplier_mismatch');
    const res = await pay(accountant, payBody([alloc('vehicle_cost', direct.id, '250.00')], { supplierId: null }));
    expect(res.status).toBe(201);
    expect(res.body.supplierId).toBeNull();
    expect((await lines(res.body.id)).map((l) => [l.account, l.debit, l.credit, l.supplierId])).toEqual([
      ['1100', '0.00', '250.00', null],
      ['2000', '250.00', '0.00', null],
    ]);
    expect(await costPaid(v.id, direct.id)).toBe('250.00');
  });

  describe('concurrency and idempotency', () => {
    it('two simultaneous payments that together exceed the outstanding: exactly one succeeds (same account, then different accounts)', async () => {
      for (const secondAccount of [cash.id, bank.id]) {
        const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '10000.00' });
        const results = await Promise.all([
          pay(owner, payBody([alloc('acquisition', acq.id, '6000.00')])),
          pay(accountant, payBody([alloc('acquisition', acq.id, '6000.00')], { cashAccountId: secondAccount, method: 'bank_transfer' })),
        ]);
        expect(results.map((r) => r.status).sort(), secondAccount).toEqual([201, 409]);
        const loser = results.find((r) => r.status === 409)!;
        expect(loser.body.error.code).toBe('overpayment');
        expect(loser.body.error.details.outstanding).toBe('4000.00');
        expect(await outstanding(acq.id)).toEqual({ paid: '6000.00', outstanding: '4000.00' });
        const pids = await paymentsFor(acq.id);
        expect(pids).toHaveLength(1);
        expect(await cashRows(pids[0]!)).toHaveLength(1);
      }
    });

    it('retrying with the SAME Idempotency-Key returns the same payment: one cash row, one journal entry (sequential and concurrent)', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '5000.00' });
      const key = idem();
      const body = payBody([alloc('acquisition', acq.id, '2000.00')]);
      const first = await pay(accountant, body, key);
      expect(first.status).toBe(201);
      const replay = await pay(accountant, body, key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toMatchObject({ id: first.body.id, number: first.body.number });
      expect(await cashRows(first.body.id)).toHaveLength(1);
      expect((await lines(first.body.id)).map((l) => l.event)).toEqual(['supplier_payment.posted', 'supplier_payment.posted']);
      expect(await paymentsFor(acq.id)).toEqual([first.body.id]);
      expect(await outstanding(acq.id)).toEqual({ paid: '2000.00', outstanding: '3000.00' });
      // The key is bound to its request and its user.
      const changed = await pay(accountant, { ...body, amount: '2500.00', allocations: [alloc('acquisition', acq.id, '2500.00')] }, key);
      expect(changed.status).toBe(422);
      expect(changed.body.error.code).toBe('idempotency_key_reused');
      const otherUser = await pay(owner, body, key);
      expect(otherUser.status).toBe(422);
      expect(otherUser.body.error.code).toBe('idempotency_key_reused');
      expect((await pay(accountant, body, {})).body.error.code).toBe('idempotency_key_required');

      // Two in-flight duplicates: the second waits for the first and replays it.
      const key2 = idem();
      const body2 = payBody([alloc('acquisition', acq.id, '1000.00')]);
      const [a, b] = await Promise.all([pay(accountant, body2, key2), pay(accountant, body2, key2)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await cashRows(a.body.id)).toHaveLength(1);
      expect((await paymentsFor(acq.id)).sort()).toEqual([first.body.id, a.body.id].sort());
      expect(await outstanding(acq.id)).toEqual({ paid: '3000.00', outstanding: '2000.00' });
    });

    it('a payment racing a reversal of the same cost: exactly one of them wins', async () => {
      const v = await createVehicle(owner, t.branchId);
      const c = await postCost(v.id, { amount: '600.00' });
      const [p, r] = await Promise.all([
        pay(owner, payBody([alloc('vehicle_cost', c.id, '600.00')])),
        accountant.post(`/vehicle-costs/${c.id}/reverse`, { reason: 'Duplicate invoice' }, idem()),
      ]);
      if (p.status === 201) {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('cost_has_payments');
        expect((await owner.get(`/vehicle-costs/${c.id}`)).body.status).toBe('posted');
        expect((await voidPayment(accountant, p.body.id)).status).toBe(200);
      } else {
        expect(p.status).toBe(409);
        expect(p.body.error.code).toBe('not_payable');
        expect(r.status).toBe(200);
        expect(await paymentsFor(c.id)).toEqual([]);
      }
    });
  });

  describe('void', () => {
    it('voiding restores the outstanding and the cash balance with a mirrored entry; a second void is refused', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '9000.00' });
      const cashBefore = await cashBookBalance(pool, cash.id);
      const p = await pay(accountant, payBody([alloc('acquisition', acq.id, '9000.00')]));
      expect(p.status).toBe(201);
      expect(await outstanding(acq.id)).toEqual({ paid: '9000.00', outstanding: '0.00' });

      expect((await accountant.post(`/supplier-payments/${p.body.id}/void`, { reason: 'no' }, idem())).status).toBe(422);
      const v = await voidPayment(accountant, p.body.id, 'Paid to the wrong supplier');
      expect(v.status).toBe(200);
      expect(v.body).toMatchObject({ id: p.body.id, status: 'voided', voidReason: 'Paid to the wrong supplier' });
      expect(v.body.voidedAt).toBeTruthy();
      expect(await outstanding(acq.id)).toEqual({ paid: '0.00', outstanding: '9000.00' });
      expect(await cashBookBalance(pool, cash.id)).toEqual(cashBefore);

      const rows = await cashRows(p.body.id);
      expect(rows.map((r) => [r.direction, r.amount, r.kind])).toEqual([
        ['out', '9000.00', 'supplier_payment'],
        ['in', '9000.00', 'supplier_payment_reversal'],
      ]);
      expect(rows[1]!.reversalOfId).toBe(rows[0]!.id);
      const gl = await lines(p.body.id);
      expect(gl.map((l) => [l.event, l.account, l.debit, l.credit])).toEqual([
        ['supplier_payment.posted', '1100', '0.00', '9000.00'],
        ['supplier_payment.posted', '2000', '9000.00', '0.00'],
        ['supplier_payment.posted.reversed', '1100', '9000.00', '0.00'],
        ['supplier_payment.posted.reversed', '2000', '0.00', '9000.00'],
      ]);
      expect(rows[1]!.journalEntryId).toBe(gl[2]!.entryId);
      // Allocations are never deleted; the voided payment simply no longer counts.
      const got = await owner.get(`/supplier-payments/${p.body.id}`);
      expect(got.body).toMatchObject({ status: 'voided' });
      expect(got.body.allocations).toHaveLength(1);
      expect((await owner.get(`/supplier-payments?status=voided&pageSize=200`)).body.items.some((i: { id: string }) => i.id === p.body.id)).toBe(true);

      const twice = await voidPayment(accountant, p.body.id, 'Paid to the wrong supplier');
      expect(twice.status).toBe(409);
      expect(twice.body.error.code).toBe('already_voided');
      expect(await cashRows(p.body.id)).toHaveLength(2);
      // The purchase is payable again.
      expect((await pay(accountant, payBody([alloc('acquisition', acq.id, '9000.00')]))).status).toBe(201);
      const audit = await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'supplier_payment' AND entity_id = $1 ORDER BY seq`, [p.body.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['supplier_payment.posted', 'supplier_payment.voided']);
    });

    it('concurrent voids reverse the cash exactly once', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '4000.00' });
      const p = await pay(accountant, payBody([alloc('acquisition', acq.id, '4000.00')]));
      expect(p.status).toBe(201);
      const results = await Promise.all([voidPayment(accountant, p.body.id), voidPayment(owner, p.body.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe('already_voided');
      expect(await cashRows(p.body.id)).toHaveLength(2);
      expect(await outstanding(acq.id)).toEqual({ paid: '0.00', outstanding: '4000.00' });
    });

    it('payments.void is required to void (403), and supplier_payments.create to pay', async () => {
      const payer = (await addMemberWithPermissions(app, t, ['payments.read', 'supplier_payments.create', 'cash.read', 'acquisitions.read'])).client;
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '3000.00' });
      const p = await pay(payer, payBody([alloc('acquisition', acq.id, '3000.00')]));
      expect(p.status).toBe(201);
      const denied = await voidPayment(payer, p.body.id);
      expect(denied.status).toBe(403);
      expect((await owner.get(`/supplier-payments/${p.body.id}`)).body.status).toBe('posted');
      expect(await cashRows(p.body.id)).toHaveLength(1);

      const reader = (await addMemberWithPermissions(app, t, ['suppliers.read', 'payments.read'])).client;
      expect((await reader.get(`/supplier-payments/${p.body.id}`)).status).toBe(200);
      expect((await pay(reader, payBody([alloc('acquisition', acq.id, '1.00')]))).status).toBe(403);
      expect((await voidPayment(reader, p.body.id)).status).toBe(403);
      const inspector = (await addMember(app, t, 'inspector')).client;
      expect((await inspector.get(`/supplier-payments/${p.body.id}`)).status).toBe(403);
      expect((await inspector.get('/supplier-payments')).status).toBe(403);

      expect((await voidPayment(accountant, p.body.id)).status).toBe(200);
    });
  });

  describe('accounts', () => {
    it('a cash box cannot go below zero (409 insufficient_cash); a bank account may go negative', async () => {
      const small = await createCashAccount(owner, { name: 'Petty cash', openingBalance: '1000.00' });
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '5000.00' });
      const n = await paymentCount();
      const short = await pay(accountant, payBody([alloc('acquisition', acq.id, '1500.00')], { cashAccountId: small.id }));
      expect(short.status).toBe(409);
      expect(short.body.error.code).toBe('insufficient_cash');
      expect(short.body.error.details).toEqual({ available: '1000.00', required: '1500.00', date: expect.any(String) });
      expect(await paymentCount()).toBe(n);
      expect(await paymentsFor(acq.id)).toEqual([]);
      // Exactly the balance is fine; one more cent is not.
      expect((await pay(accountant, payBody([alloc('acquisition', acq.id, '1000.00')], { cashAccountId: small.id }))).status).toBe(201);
      expect((await owner.get(`/cash-accounts/${small.id}`)).body.balance).toBe('0.00');
      const cent = await pay(accountant, payBody([alloc('acquisition', acq.id, '0.01')], { cashAccountId: small.id }));
      expect(cent.status).toBe(409);
      expect(cent.body.error.code).toBe('insufficient_cash');

      const overdraft = await createCashAccount(owner, { type: 'bank', name: 'Overdraft bank' });
      const res = await pay(accountant, payBody([alloc('acquisition', acq.id, '1500.00')], { cashAccountId: overdraft.id, method: 'bank_transfer' }));
      expect(res.status).toBe(201);
      expect((await owner.get(`/cash-accounts/${overdraft.id}`)).body).toMatchObject({ balance: '-1500.00', balanceBase: '-1500.00' });
      expect(await glBalance(pool, t.tenantId, '1100', { col: 'cash_account_id', id: overdraft.id })).toBe('-1500.00');
    });

    it('pays from a USD account at the stated rate with exact base amounts (1,234.57 USD × 3.6725 = 4,533.96)', async () => {
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '10000.00' });
      const before = (await owner.get(`/cash-accounts/${usdBank.id}`)).body as { balance: string; balanceBase: string };
      const usd = (overrides: Record<string, unknown>) =>
        payBody([alloc('acquisition', acq.id, '4533.96')], { cashAccountId: usdBank.id, method: 'bank_transfer', amount: '1234.57', exchangeRate: '3.6725', ...overrides });
      const noRate = await pay(accountant, usd({ exchangeRate: undefined }));
      expect(noRate.status).toBe(422);
      expect(noRate.body.error.code).toBe('exchange_rate_required');
      // Allocations are in BASE currency: allocating the USD figure is a mismatch.
      const inUsd = await pay(accountant, usd({ allocations: [alloc('acquisition', acq.id, '1234.57')] }));
      expect(inUsd.status).toBe(422);
      expect(inUsd.body.error.code).toBe('allocation_mismatch');
      expect(inUsd.body.error.details.paymentBase).toBe('4533.96');

      const res = await pay(accountant, usd({}));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ amount: '1234.57', currency: 'USD', exchangeRate: '3.67250000', amountBase: '4533.96', cashAccountId: usdBank.id });
      // The USD leaves the account at its carrying cost (weighted average); the difference to the
      // transaction value (1,234.57 × 3.6725 = 4,533.96) is realized FX on 4300.
      const carrying = d(before.balance).eq('1234.57')
        ? d(before.balanceBase).toFixed(2)
        : d(before.balanceBase).times('1234.57').dividedBy(before.balance).toDecimalPlaces(2).toFixed(2);
      const fx = d(carrying).minus('4533.96');
      const rows = await cashRows(res.body.id);
      expect(rows.map((r) => [r.direction, r.amount, r.amountBase, r.exchangeRate])).toEqual([['out', '1234.57', carrying, '3.67250000']]);
      const fxLine = fx.isZero() ? [] : [['4300', fx.isPositive() ? fx.toFixed(2) : '0.00', fx.isPositive() ? '0.00' : fx.negated().toFixed(2), null, null]];
      expect((await lines(res.body.id)).map((l) => [l.account, l.debit, l.credit, l.cashAccountId, l.supplierId])).toEqual([
        ['1100', '0.00', carrying, usdBank.id, null],
        ['2000', '4533.96', '0.00', null, supplier.id],
        ...fxLine,
      ]);
      const after = (await owner.get(`/cash-accounts/${usdBank.id}`)).body as { balance: string; balanceBase: string };
      expect(d(before.balance).minus(after.balance).toFixed(2)).toBe('1234.57');
      expect(d(before.balanceBase).minus(after.balanceBase).toFixed(2)).toBe(carrying);
      expect(await outstanding(acq.id)).toEqual({ paid: '4533.96', outstanding: '5466.04' });

      expect((await voidPayment(accountant, res.body.id)).status).toBe(200);
      expect((await owner.get(`/cash-accounts/${usdBank.id}`)).body).toMatchObject(before);
      expect(await outstanding(acq.id)).toEqual({ paid: '0.00', outstanding: '10000.00' });
    });
  });

  it('trade-in costs are not payable as supplier documents (409 not_payable)', async () => {
    const v = await createVehicle(owner, t.branchId);
    // Control: a supplier-less manual cost on the same vehicle is payable.
    const manual = await postCost(v.id, { supplierId: null, amount: '300.00', description: 'Registration' });
    // No API creates trade-in costs yet (trade-ins arrive with the sales flow, Phase 5), so the
    // trade-in cost and its ledger entry (Dr 1300 / Cr 2100 customer advances, as
    // CostsService.postEntry posts it with a credit override) are inserted through the owner pool.
    const tradeInId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [t.tenantId]);
      const purchaseCat = await costCategory(owner, 'purchase');
      await client.query(
        `INSERT INTO vehicle_costs (id, tenant_id, vehicle_id, category_id, description, amount, currency, exchange_rate, amount_base, cost_date,
                                    supplier_id, status, source_type, source_id, approved_at)
         VALUES ($1, $2, $3, $4, 'Trade-in allowance', 40000.00, 'SAR', 1, 40000.00, '2026-04-01', NULL, 'posted', 'trade_in', $5, now())`,
        [tradeInId, t.tenantId, v.id, purchaseCat, randomUUID()],
      );
      const n = (await client.query(`SELECT app_next_number('journal') AS n`)).rows[0].n;
      const entry = (
        await client.query(
          `INSERT INTO journal_entries (tenant_id, entry_no, entry_date, source_type, source_id, event, description, branch_id)
           VALUES ($1, $2, '2026-04-01', 'vehicle_cost', $3, 'cost.posted', 'Trade-in allowance (test fixture)', $4) RETURNING id`,
          [t.tenantId, n, tradeInId, t.branchId],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_code, debit, credit, branch_id, vehicle_id, customer_id)
         VALUES ($1, $2, 1, '1300', 40000.00, 0, $3, $4, NULL), ($1, $2, 2, '2100', 0, 40000.00, $3, $4, $5)`,
        [t.tenantId, entry, t.branchId, v.id, randomUUID()],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const n = await paymentCount();
    const res = await pay(accountant, payBody([alloc('vehicle_cost', tradeInId, '40000.00')], { supplierId: null, cashAccountId: bank.id, method: 'bank_transfer' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_payable');
    const partial = await pay(accountant, payBody([alloc('vehicle_cost', tradeInId, '1.00')], { supplierId: null }));
    expect(partial.status).toBe(409);
    expect(partial.body.error.code).toBe('not_payable');
    expect(await paymentCount()).toBe(n);
    expect((await pay(accountant, payBody([alloc('vehicle_cost', manual.id, '300.00')], { supplierId: null }))).status).toBe(201);
  });

  describe('branch scope', () => {
    let b2: { id: string };
    let scoped: Client;
    let companyBank: { id: string };
    let mainSafe: { id: string };
    let vMain: string;
    let costMain: { id: string };

    beforeAll(async () => {
      b2 = await createBranch(owner, 'Khobar');
      scoped = (await addMember(app, t, 'branch_manager', { allBranches: false, branchIds: [b2.id] })).client;
      // Company-level account (no branch): every branch may pay from it.
      companyBank = await createCashAccount(owner, { type: 'bank', name: 'Company bank', openingBalance: '50000.00' });
      mainSafe = await createCashAccount(owner, { name: 'Main branch safe', branchId: t.branchId, openingBalance: '20000.00' });
      vMain = (await createVehicle(owner, t.branchId)).id;
      costMain = await postCost(vMain, { amount: '700.00' });
    });

    it('a branch-restricted payer cannot pay a cost on a vehicle in another branch, even from a company-level account', async () => {
      const n = { payments: await paymentCount(), entries: await entryCount() };
      const res = await pay(scoped, payBody([alloc('vehicle_cost', costMain.id, '700.00')], { cashAccountId: companyBank.id, method: 'bank_transfer' }));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('branch_forbidden');
      expect(await costPaid(vMain, costMain.id)).toBe('0.00');
      expect(await paymentCount()).toBe(n.payments);
      expect(await entryCount()).toBe(n.entries);

      // The other documents of the main branch are refused the same way.
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '2000.00' });
      const acqRes = await pay(scoped, payBody([alloc('acquisition', acq.id, '100.00')], { cashAccountId: companyBank.id }));
      expect(acqRes.status).toBe(422);
      expect(acqRes.body.error.code).toBe('branch_forbidden');
      const exp = await accountant.post(
        '/expenses',
        { branchId: t.branchId, categoryId: rent, description: 'Main branch rent', amount: '800.00', currency: 'SAR', expenseDate: '2026-04-01', supplierId: supplier.id },
        idem(),
      );
      const expRes = await pay(scoped, payBody([alloc('expense', exp.body.id, '800.00')], { cashAccountId: companyBank.id }));
      expect(expRes.status).toBe(422);
      expect(expRes.body.error.code).toBe('branch_forbidden');
      // A main-branch cash box is out of reach altogether.
      const vB2 = (await createVehicle(owner, b2.id)).id;
      const costB2 = await postCost(vB2, { amount: '800.00' });
      expect((await pay(scoped, payBody([alloc('vehicle_cost', costB2.id, '800.00')], { cashAccountId: mainSafe.id }))).status).toBe(403);
      expect(await paymentCount()).toBe(n.payments);

      // Their own branch's cost, from the company account: fine.
      const own = await pay(scoped, payBody([alloc('vehicle_cost', costB2.id, '800.00')], { cashAccountId: companyBank.id, method: 'bank_transfer' }));
      expect(own.status).toBe(201);
      expect(await costPaid(vB2, costB2.id)).toBe('800.00');
    });

    it('a branch-restricted user sees and voids only payments from accounts it can access', async () => {
      const mainPay = await pay(accountant, payBody([alloc('vehicle_cost', costMain.id, '100.00')], { cashAccountId: mainSafe.id }));
      expect(mainPay.status).toBe(201);
      const vB2 = (await createVehicle(owner, b2.id)).id;
      const costB2 = await postCost(vB2, { amount: '90.00' });
      const companyPay = await pay(scoped, payBody([alloc('vehicle_cost', costB2.id, '90.00')], { cashAccountId: companyBank.id, method: 'bank_transfer' }));
      expect(companyPay.status).toBe(201);
      expect((await scoped.get(`/supplier-payments/${mainPay.body.id}`)).status).toBe(403);
      expect((await scoped.get(`/supplier-payments/${companyPay.body.id}`)).status).toBe(200);
      const list = (await scoped.get('/supplier-payments?pageSize=200')).body.items as Array<{ id: string }>;
      expect(list.some((i) => i.id === mainPay.body.id)).toBe(false);
      expect(list.some((i) => i.id === companyPay.body.id)).toBe(true);
      expect((await scoped.get(`/supplier-payments?cashAccountId=${mainSafe.id}&pageSize=200`)).body.items).toEqual([]);
      expect((await voidPayment(scoped, mainPay.body.id)).status).toBe(403);
      expect((await owner.get(`/supplier-payments/${mainPay.body.id}`)).body.status).toBe('posted');
      expect((await voidPayment(accountant, mainPay.body.id)).status).toBe(200);
    });

    // BUG: Branch scope is checked after the overpayment and supplier checks, so a branch-restricted payer learns another branch's outstanding balances
    it("a branch-restricted payer is refused before any detail of another branch's document is revealed", async () => {
      const over = await pay(scoped, payBody([alloc('vehicle_cost', costMain.id, '999999.00')], { cashAccountId: companyBank.id, method: 'bank_transfer' }));
      expect(over.status).toBe(422);
      expect(over.body.error.code).toBe('branch_forbidden');
      expect(over.body.error.details?.outstanding).toBeUndefined();
    });
  });

  it("another company cannot pay with our accounts, settle our documents, or void our payments (404)", async () => {
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '1500.00' });
    const p = await pay(accountant, payBody([alloc('acquisition', acq.id, '500.00')]));
    expect(p.status).toBe(201);
    const o = t2.owner;
    const theirSupplier = await createSupplier(o);
    const theirCash = await createCashAccount(o, { openingBalance: '10000.00' });
    expect((await o.get(`/supplier-payments/${p.body.id}`)).status).toBe(404);
    expect((await voidPayment(o, p.body.id)).status).toBe(404);
    // Our account, their document-less attempt; their account, our document; our supplier.
    expect((await pay(o, payBody([alloc('acquisition', acq.id, '100.00')], { supplierId: theirSupplier.id, cashAccountId: cash.id }))).status).toBe(404);
    expect((await pay(o, payBody([alloc('acquisition', acq.id, '100.00')], { supplierId: theirSupplier.id, cashAccountId: theirCash.id }))).status).toBe(404);
    expect((await pay(o, payBody([alloc('acquisition', acq.id, '100.00')], { cashAccountId: theirCash.id }))).status).toBe(404);
    expect((await o.get('/supplier-payments?pageSize=200')).body).toMatchObject({ items: [], total: 0 });
    expect(await paymentCount(t2.tenantId)).toBe(0);
    expect((await owner.get(`/supplier-payments/${p.body.id}`)).body.status).toBe('posted');
    expect(await outstanding(acq.id)).toEqual({ paid: '500.00', outstanding: '1000.00' });
    await assertLedgerIntegrity(pool, t2.tenantId);
  });
});
