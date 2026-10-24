import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { d, todayInZone } from '@autohub/shared';
import { costCategory, createCashAccount, createSupplier, setFxReferences } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, PASSWORD, TestTenant, uniq } from './helpers';

/** GL balance (debit − credit) for one account, optionally filtered by a dimension column. */
async function gl(pool: Pool, tenantId: string, account: string, dim?: { col: string; id: string }) {
  const r = await pool.query(
    `SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines WHERE tenant_id = $1 AND account_code = $2 ${dim ? `AND ${dim.col} = $3` : ''}`,
    dim ? [tenantId, account, dim.id] : [tenantId, account],
  );
  return r.rows[0].b as string;
}

/** Ledger lines posted for one source document, in entry/line order. */
async function sourceLines(pool: Pool, tenantId: string, sourceType: string, sourceId: string) {
  const r = await pool.query(
    `SELECT e.event, e.entry_date AS "entryDate", l.account_code AS account, l.debit, l.credit, l.branch_id AS "branchId", l.supplier_id AS "supplierId"
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.tenant_id = $1 AND e.source_type = $2 AND e.source_id = $3
      ORDER BY e.entry_no, l.line_no`,
    [tenantId, sourceType, sourceId],
  );
  return r.rows as Array<{ event: string; entryDate: string; account: string; debit: string; credit: string; branchId: string | null; supplierId: string | null }>;
}

/** Whole-tenant trial balance and cash-book ↔ GL 1100 reconciliation. */
async function assertBooksBalance(pool: Pool, tenantId: string) {
  const tb = await pool.query(`SELECT coalesce(sum(debit),0)::text AS dr, coalesce(sum(credit),0)::text AS cr FROM journal_lines WHERE tenant_id = $1`, [tenantId]);
  expect(tb.rows[0].dr).toBe(tb.rows[0].cr);
  const unbalanced = await pool.query(
    `SELECT entry_id FROM journal_lines WHERE tenant_id = $1 GROUP BY entry_id HAVING sum(debit) <> sum(credit)`,
    [tenantId],
  );
  expect(unbalanced.rows).toHaveLength(0);
  const book = await pool.query(
    `SELECT coalesce(sum(CASE WHEN direction='in' THEN amount_base ELSE -amount_base END),0)::numeric(18,2)::text AS b FROM cash_transactions WHERE tenant_id = $1`,
    [tenantId],
  );
  expect(book.rows[0].b).toBe(await gl(pool, tenantId, '1100'));
}

/** Adds a member with a custom role holding exactly the given permissions. */
async function addCustomMember(app: INestApplication, t: TestTenant, permissions: string[], opts: { allBranches?: boolean; branchIds?: string[] } = {}) {
  const role = await t.owner.post('/roles', { name: uniq('Role '), permissions, maxDiscountPct: '0' });
  if (role.status !== 201) throw new Error(`create role failed ${role.status} ${JSON.stringify(role.body)}`);
  const email = `${uniq('clerk')}@autohub.test`;
  const res = await t.owner.post('/users', {
    email,
    fullName: 'Expense clerk',
    password: PASSWORD,
    roleId: role.body.id,
    allBranches: opts.allBranches ?? true,
    branchIds: opts.branchIds ?? [],
  });
  if (res.status !== 201) throw new Error(`add member failed ${res.status} ${JSON.stringify(res.body)}`);
  return { client: await Client.login(app, email), userId: res.body.userId as string };
}

async function expenseCategory(c: Client, code: string) {
  const res = await c.get('/expense-categories');
  const cat = (res.body as Array<{ id: string; code: string }>).find((x) => x.code === code);
  if (!cat) throw new Error(`expense category ${code} not found`);
  return cat.id;
}

describe('operating expenses', () => {
  let app: INestApplication;
  let admin: Client;
  let t: TestTenant;
  let pool: Pool;
  let accountant: Client;
  let clerk: Client;
  let rent: string;
  let utilities: string;
  let fuel: string;

  const expense = (overrides: Record<string, unknown> = {}) => ({
    branchId: t.branchId,
    categoryId: rent,
    description: 'Showroom rent',
    amount: '12000.00',
    currency: 'SAR',
    expenseDate: '2026-01-31',
    ...overrides,
  });

  beforeAll(async () => {
    app = await getApp();
    admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    await setFxReferences(t.owner, { USD: '3.75' });
    pool = ownerPool();
    accountant = (await addMember(app, t, 'accountant')).client;
    // No system role has expenses.create without expenses.approve, so the maker path uses a custom role.
    clerk = (await addCustomMember(app, t, ['expenses.read', 'expenses.create'])).client;
    rent = await expenseCategory(t.owner, 'rent');
    utilities = await expenseCategory(t.owner, 'utilities');
    fuel = await expenseCategory(t.owner, 'fuel');
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('lists only active operating categories', async () => {
    const res = await accountant.get('/expense-categories');
    expect(res.status).toBe(200);
    const codes = (res.body as Array<{ code: string; kind: string }>).map((c) => c.code);
    expect(codes).toContain('rent');
    expect(codes).toContain('salaries');
    expect(codes).not.toContain('transport');
    expect(codes).not.toContain('purchase');
    expect((res.body as Array<{ kind: string }>).every((c) => c.kind === 'operating')).toBe(true);
  });

  it('accountant posts directly: Dr 6000 (branch) / Cr 2000 (supplier), numbered and audited', async () => {
    const landlord = await createSupplier(t.owner, { name: 'Landlord Co' });
    const res = await accountant.post('/expenses', expense({ supplierId: landlord.id, notes: 'January' }), idem());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'posted',
      amount: '12000.00',
      currency: 'SAR',
      amountBase: '12000.00',
      paidBase: '0.00',
      outstandingBase: '12000.00',
      categoryCode: 'rent',
      supplierName: 'Landlord Co',
      branchName: 'Main branch',
    });
    expect(res.body.number).toMatch(/^EXP-\d{4}-\d{6}$/);
    expect(res.body.approvedBy).toBeTruthy();
    expect(res.body.journalEntries).toHaveLength(1);
    expect(res.body.journalEntries[0].event).toBe('expense.posted');

    const lines = await sourceLines(pool, t.tenantId, 'expense', res.body.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: 'expense.posted', entryDate: '2026-01-31', account: '6000', debit: '12000.00', credit: '0.00', branchId: t.branchId });
    expect(lines[1]).toMatchObject({ account: '2000', debit: '0.00', credit: '12000.00', supplierId: landlord.id, branchId: t.branchId });
    expect(await gl(pool, t.tenantId, '2000', { col: 'supplier_id', id: landlord.id })).toBe('-12000.00');

    const audit = await pool.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_type = 'expense' AND entity_id = $2`, [t.tenantId, res.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['expense.posted']);

    const detail = await accountant.get(`/expenses/${res.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: res.body.id, status: 'posted', notes: 'January', outstandingBase: '12000.00' });
  });

  it('a user without expenses.approve creates a pending expense; approval posts it once', async () => {
    const res = await clerk.post('/expenses', expense({ categoryId: utilities, description: 'Electricity bill', amount: '845.30', expenseDate: '2026-02-05' }), idem());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval', amountBase: '845.30', paidBase: '0.00', outstandingBase: null, approvedBy: null });
    expect(res.body.journalEntries).toHaveLength(0);
    expect(await sourceLines(pool, t.tenantId, 'expense', res.body.id)).toHaveLength(0);

    // A pending expense cannot be paid, neither on recording nor through a supplier payment.
    const cash = await createCashAccount(t.owner, { openingBalance: '1000.00' });
    const payPending = await clerk.post('/expenses', expense({ amount: '10.00', payNow: { cashAccountId: cash.id, method: 'cash' } }), idem());
    expect(payPending.status).toBe(422);
    expect(payPending.body.error.code).toBe('cannot_pay_unapproved');
    const direct = await accountant.post(
      '/supplier-payments',
      { supplierId: null, cashAccountId: cash.id, paidAt: '2026-02-05', method: 'cash', amount: '845.30', allocations: [{ targetType: 'expense', targetId: res.body.id, amountBase: '845.30' }] },
      idem(),
    );
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('not_payable');

    // Makers cannot approve; approvers see it in their inbox.
    expect((await clerk.post(`/expenses/${res.body.id}/approve`, {})).status).toBe(403);
    const inbox = await accountant.get('/approvals');
    expect(inbox.body.some((a: { entityId: string; type: string }) => a.entityId === res.body.id && a.type === 'expense')).toBe(true);
    expect((await clerk.get('/approvals')).body.some((a: { entityId: string }) => a.entityId === res.body.id)).toBe(false);

    const ap = await accountant.post(`/expenses/${res.body.id}/approve`, { note: 'OK' });
    expect(ap.status).toBe(200);
    expect(ap.body).toMatchObject({ status: 'posted', outstandingBase: '845.30', approvedByName: 'accountant user' });
    const lines = await sourceLines(pool, t.tenantId, 'expense', res.body.id);
    expect(lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['6000', '845.30', '0.00'],
      ['2000', '0.00', '845.30'],
    ]);
    expect(lines[0]!.entryDate).toBe('2026-02-05');

    const again = await accountant.post(`/expenses/${res.body.id}/approve`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('expense_not_pending');
    expect((await accountant.post(`/expenses/${res.body.id}/reject`, { reason: 'Too late' })).body.error.code).toBe('expense_not_pending');
    expect(await sourceLines(pool, t.tenantId, 'expense', res.body.id)).toHaveLength(2);

    const req = await pool.query(`SELECT status, decision_note FROM approval_requests WHERE tenant_id = $1 AND entity_id = $2`, [t.tenantId, res.body.id]);
    expect(req.rows).toEqual([{ status: 'approved', decision_note: 'OK' }]);
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at`, [t.tenantId, res.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['expense.submitted', 'expense.approved']);
  });

  it('concurrent approvals and reversals post exactly once (row lock)', async () => {
    const pending = await clerk.post('/expenses', expense({ categoryId: utilities, description: 'Water bill', amount: '120.00' }), idem());
    expect(pending.status).toBe(201);
    const approvals = await Promise.all([
      accountant.post(`/expenses/${pending.body.id}/approve`, {}),
      t.owner.post(`/expenses/${pending.body.id}/approve`, {}),
    ]);
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(approvals.find((r) => r.status === 409)!.body.error.code).toBe('expense_not_pending');
    expect(await sourceLines(pool, t.tenantId, 'expense', pending.body.id)).toHaveLength(2);

    const reversals = await Promise.all([
      accountant.post(`/expenses/${pending.body.id}/reverse`, { reason: 'Duplicate bill' }, idem()),
      t.owner.post(`/expenses/${pending.body.id}/reverse`, { reason: 'Duplicate bill' }, idem()),
    ]);
    expect(reversals.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(reversals.find((r) => r.status === 409)!.body.error.code).toBe('expense_not_posted');
    const lines = await sourceLines(pool, t.tenantId, 'expense', pending.body.id);
    expect(lines.map((l) => l.event)).toEqual(['expense.posted', 'expense.posted', 'expense.reversed', 'expense.reversed']);
  });

  it('rejecting a pending expense posts nothing and is final', async () => {
    const res = await clerk.post('/expenses', expense({ categoryId: fuel, description: 'Fuel for test drives', amount: '220.00' }), idem());
    expect(res.status).toBe(201);
    const short = await accountant.post(`/expenses/${res.body.id}/reject`, { reason: 'no' });
    expect(short.status).toBe(422);
    const rej = await accountant.post(`/expenses/${res.body.id}/reject`, { reason: 'Personal fuel, not a business expense' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: 'rejected', rejectedReason: 'Personal fuel, not a business expense', outstandingBase: null });
    expect(await sourceLines(pool, t.tenantId, 'expense', res.body.id)).toHaveLength(0);
    expect((await accountant.post(`/expenses/${res.body.id}/approve`, {})).body.error.code).toBe('expense_not_pending');
    expect((await accountant.post(`/expenses/${res.body.id}/reverse`, { reason: 'Cleanup' }, idem())).body.error.code).toBe('expense_not_posted');
    const req = await pool.query(`SELECT status FROM approval_requests WHERE tenant_id = $1 AND entity_id = $2`, [t.tenantId, res.body.id]);
    expect(req.rows).toEqual([{ status: 'rejected' }]);
  });

  it('payNow pays from cash; reversal is blocked while paid and works after the payment is voided', async () => {
    const t2 = await createTenant(app, admin);
    const acc = (await addMember(app, t2, 'accountant')).client;
    const cash = await createCashAccount(t2.owner, { openingBalance: '50000.00' });
    const fuel2 = await expenseCategory(acc, 'fuel');

    const res = await acc.post(
      '/expenses',
      { branchId: t2.branchId, categoryId: fuel2, description: 'Fuel', amount: '350.75', currency: 'SAR', expenseDate: '2026-03-10', payNow: { cashAccountId: cash.id, method: 'cash', reference: 'R-1' } },
      idem(),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'posted', paidBase: '350.75', outstandingBase: '0.00', supplierId: null });
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toMatchObject({ status: 'posted', amountBase: '350.75', paidAt: '2026-03-10', method: 'cash' });
    expect((await acc.get(`/cash-accounts/${cash.id}`)).body.balance).toBe('49649.25');
    expect(await gl(pool, t2.tenantId, '1100', { col: 'cash_account_id', id: cash.id })).toBe('49649.25');
    expect(await gl(pool, t2.tenantId, '6000')).toBe('350.75');
    expect(await gl(pool, t2.tenantId, '2000')).toBe('0.00');
    const listed = await acc.get('/expenses');
    expect(listed.body.items[0]).toMatchObject({ id: res.body.id, paidBase: '350.75', outstandingBase: '0.00' });

    // Nothing more can be paid on it.
    const over = await acc.post(
      '/supplier-payments',
      { supplierId: null, cashAccountId: cash.id, paidAt: '2026-03-10', method: 'cash', amount: '1.00', allocations: [{ targetType: 'expense', targetId: res.body.id, amountBase: '1.00' }] },
      idem(),
    );
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('overpayment');

    const blocked = await acc.post(`/expenses/${res.body.id}/reverse`, { reason: 'Entered twice' }, idem());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('expense_has_payments');

    const voided = await acc.post(`/supplier-payments/${res.body.payments[0].paymentId}/void`, { reason: 'Entered twice' }, idem());
    expect(voided.status).toBe(200);
    expect((await acc.get(`/expenses/${res.body.id}`)).body).toMatchObject({ paidBase: '0.00', outstandingBase: '350.75' });

    // Reverse needs a reason and expenses.approve.
    expect((await acc.post(`/expenses/${res.body.id}/reverse`, {}, idem())).status).toBe(422);
    const maker = (await addCustomMember(app, t2, ['expenses.read', 'expenses.create'])).client;
    expect((await maker.post(`/expenses/${res.body.id}/reverse`, { reason: 'Entered twice' }, idem())).status).toBe(403);

    const key = idem();
    const rev = await acc.post(`/expenses/${res.body.id}/reverse`, { reason: 'Entered twice' }, key);
    expect(rev.status).toBe(200);
    expect(rev.body).toMatchObject({ status: 'reversed', reversalReason: 'Entered twice', outstandingBase: null });
    expect(rev.body.journalEntries.map((j: { event: string }) => j.event)).toEqual(['expense.posted', 'expense.reversed']);
    // Retrying with the same key replays the result instead of reversing twice.
    const replay = await acc.post(`/expenses/${res.body.id}/reverse`, { reason: 'Entered twice' }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(rev.body.id);
    expect(replay.body.status).toBe('reversed');

    const tz = (await pool.query(`SELECT settings->>'timezone' AS tz FROM tenants WHERE id = $1`, [t2.tenantId])).rows[0].tz as string;
    const lines = await sourceLines(pool, t2.tenantId, 'expense', res.body.id);
    expect(lines.map((l) => [l.event, l.account, l.debit, l.credit])).toEqual([
      ['expense.posted', '6000', '350.75', '0.00'],
      ['expense.posted', '2000', '0.00', '350.75'],
      ['expense.reversed', '6000', '0.00', '350.75'],
      ['expense.reversed', '2000', '350.75', '0.00'],
    ]);
    expect(lines[2]!.entryDate).toBe(todayInZone(tz));
    expect(await gl(pool, t2.tenantId, '6000')).toBe('0.00');
    expect(await gl(pool, t2.tenantId, '2000')).toBe('0.00');
    expect((await acc.get(`/cash-accounts/${cash.id}`)).body.balance).toBe('50000.00');

    const twice = await acc.post(`/expenses/${res.body.id}/reverse`, { reason: 'Entered twice' }, idem());
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('expense_not_posted');
    // A reversed expense is no longer payable.
    const payReversed = await acc.post(
      '/supplier-payments',
      { supplierId: null, cashAccountId: cash.id, paidAt: '2026-03-11', method: 'cash', amount: '350.75', allocations: [{ targetType: 'expense', targetId: res.body.id, amountBase: '350.75' }] },
      idem(),
    );
    expect(payReversed.status).toBe(409);
    expect(payReversed.body.error.code).toBe('not_payable');

    // Posted amounts are frozen by the database even outside the API.
    await expect(pool.query(`UPDATE expenses SET amount = 1 WHERE id = $1`, [res.body.id])).rejects.toThrow(/immutable_record/);
    await assertBooksBalance(pool, t2.tenantId);
  });

  it('a future-dated expense is reversed on its own date; partial payments show in list and detail', async () => {
    const supplier = await createSupplier(t.owner);
    const cash = await createCashAccount(t.owner, { type: 'bank', openingBalance: '5000.00' });
    const future = await accountant.post('/expenses', expense({ description: 'Prepaid rent', expenseDate: '2099-01-01', amount: '100.00', supplierId: supplier.id }), idem());
    expect(future.status).toBe(201);
    const rev = await accountant.post(`/expenses/${future.body.id}/reverse`, { reason: 'Wrong date' }, idem());
    expect(rev.status).toBe(200);
    const lines = await sourceLines(pool, t.tenantId, 'expense', future.body.id);
    expect(lines[2]).toMatchObject({ event: 'expense.reversed', entryDate: '2099-01-01' });

    const a = await accountant.post('/expenses', expense({ description: 'Cleaning contract', amount: '1000.00', supplierId: supplier.id, expenseDate: '2026-04-01' }), idem());
    const b = await accountant.post('/expenses', expense({ description: 'Cleaning supplies', amount: '300.00', supplierId: supplier.id, expenseDate: '2026-04-02' }), idem());
    const pay = await accountant.post(
      '/supplier-payments',
      { supplierId: supplier.id, cashAccountId: cash.id, paidAt: '2026-04-03', method: 'bank_transfer', amount: '700.00', allocations: [{ targetType: 'expense', targetId: a.body.id, amountBase: '600.00' }, { targetType: 'expense', targetId: b.body.id, amountBase: '100.00' }] },
      idem(),
    );
    expect(pay.status).toBe(201);
    const list = await accountant.get(`/expenses?supplierId=${supplier.id}&sort=expenseDate`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string; paidBase: string; outstandingBase: string | null; status: string }) => [i.id, i.status, i.paidBase, i.outstandingBase])).toEqual([
      [a.body.id, 'posted', '600.00', '400.00'],
      [b.body.id, 'posted', '100.00', '200.00'],
      [future.body.id, 'reversed', '0.00', null],
    ]);
    const detail = await accountant.get(`/expenses/${a.body.id}`);
    expect(detail.body).toMatchObject({ paidBase: '600.00', outstandingBase: '400.00' });
    expect(detail.body.payments).toEqual([expect.objectContaining({ paymentId: pay.body.id, amountBase: '600.00', status: 'posted' })]);
    const over = await accountant.post(
      '/supplier-payments',
      { supplierId: supplier.id, cashAccountId: cash.id, paidAt: '2026-04-03', method: 'bank_transfer', amount: '401.00', allocations: [{ targetType: 'expense', targetId: a.body.id, amountBase: '401.00' }] },
      idem(),
    );
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('overpayment');
    expect(await gl(pool, t.tenantId, '2000', { col: 'supplier_id', id: supplier.id })).toBe('-600.00');
  });

  it('replaying POST /expenses with the same Idempotency-Key returns the same expense and creates one row', async () => {
    const key = idem();
    const body = expense({ description: `Internet ${uniq()}`, categoryId: utilities, amount: '399.00' });
    const first = await accountant.post('/expenses', body, key);
    expect(first.status).toBe(201);
    const second = await accountant.post('/expenses', body, key);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.number).toBe(first.body.number);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM expenses WHERE tenant_id = $1 AND description = $2`, [t.tenantId, body.description]);
    expect(rows.rows[0].n).toBe(1);
    expect(await sourceLines(pool, t.tenantId, 'expense', first.body.id)).toHaveLength(2);
    // Same key with a different body is refused; no key at all is refused.
    const reused = await accountant.post('/expenses', { ...body, amount: '400.00' }, key);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
    const noKey = await accountant.post('/expenses', body);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('idempotency_key_required');
  });

  it('records a USD expense at 3.75 with exact base amounts', async () => {
    const res = await accountant.post('/expenses', expense({ categoryId: utilities, description: 'Software subscription', amount: '1234.57', currency: 'USD', exchangeRate: '3.75' }), idem());
    expect(res.status).toBe(201);
    // 1234.57 × 3.75 = 4629.6375 → 4629.64 (half-up)
    expect(res.body).toMatchObject({ amount: '1234.57', currency: 'USD', exchangeRate: '3.75000000', amountBase: '4629.64', outstandingBase: '4629.64' });
    const lines = await sourceLines(pool, t.tenantId, 'expense', res.body.id);
    expect(lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['6000', '4629.64', '0.00'],
      ['2000', '0.00', '4629.64'],
    ]);

    const noRate = await accountant.post('/expenses', expense({ amount: '10.00', currency: 'USD' }), idem());
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.code).toBe('exchange_rate_required');
    const badBase = await accountant.post('/expenses', expense({ amount: '10.00', exchangeRate: '2' }), idem());
    expect(badBase.status).toBe(422);
    expect(badBase.body.error.code).toBe('fx_rate_invalid');

    // Immediate payment must come from a base-currency account; the USD expense is paid in SAR.
    const usd = await createCashAccount(t.owner, { type: 'bank', currency: 'USD' });
    const usdPay = await accountant.post('/expenses', expense({ amount: '10.00', currency: 'USD', exchangeRate: '3.75', payNow: { cashAccountId: usd.id, method: 'bank_transfer' } }), idem());
    expect(usdPay.status).toBe(422);
    expect(usdPay.body.error.code).toBe('pay_now_base_currency');
    const sar = await createCashAccount(t.owner, { type: 'bank', openingBalance: '10000.00' });
    const paid = await accountant.post('/expenses', expense({ amount: '100.00', currency: 'USD', exchangeRate: '3.75', payNow: { cashAccountId: sar.id, method: 'bank_transfer' } }), idem());
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ amountBase: '375.00', paidBase: '375.00', outstandingBase: '0.00' });
    expect((await accountant.get(`/cash-accounts/${sar.id}`)).body.balance).toBe('9625.00');
  });

  it('validates category, supplier and permissions', async () => {
    const transport = await costCategory(t.owner, 'transport');
    const veh = await accountant.post('/expenses', expense({ categoryId: transport }), idem());
    expect(veh.status).toBe(422);
    expect(veh.body.error.code).toBe('category_not_operating');
    const unknownCat = await accountant.post('/expenses', expense({ categoryId: '00000000-0000-4000-8000-000000000001' }), idem());
    expect(unknownCat.status).toBe(404);
    const unknownSupplier = await accountant.post('/expenses', expense({ supplierId: '00000000-0000-4000-8000-000000000002' }), idem());
    expect(unknownSupplier.status).toBe(404);
    const inactive = await createSupplier(t.owner, { isActive: false });
    const inactiveRes = await accountant.post('/expenses', expense({ supplierId: inactive.id }), idem());
    expect(inactiveRes.status).toBe(422);
    expect(inactiveRes.body.error.code).toBe('supplier_inactive');
    const zero = await accountant.post('/expenses', expense({ amount: '0.00' }), idem());
    expect(zero.status).toBe(422);

    const rep = (await addMember(app, t, 'sales_rep')).client;
    expect((await rep.get('/expenses')).status).toBe(403);
    expect((await rep.get('/expenses/summary')).status).toBe(403);
    expect((await rep.post('/expenses', expense(), idem())).status).toBe(403);
    const auditor = (await addMember(app, t, 'auditor')).client;
    expect((await auditor.get('/expenses')).status).toBe(200);
    expect((await auditor.post('/expenses', expense(), idem())).status).toBe(403);

    const badSort = await accountant.get('/expenses?sort=password');
    expect(badSort.status).toBe(422);
    expect(badSort.body.error.code).toBe('invalid_sort');
    expect((await accountant.get('/expenses/not-a-uuid')).status).toBe(400);
  });

  it('isolates tenants: other companies get 404 and never see the expense', async () => {
    const mine = await accountant.post('/expenses', expense({ description: 'Tenant A only' }), idem());
    expect(mine.status).toBe(201);
    const pending = await clerk.post('/expenses', expense({ description: 'Tenant A pending' }), idem());
    const other = await createTenant(app, admin);
    expect((await other.owner.get(`/expenses/${mine.body.id}`)).status).toBe(404);
    expect((await other.owner.post(`/expenses/${pending.body.id}/approve`, {})).status).toBe(404);
    expect((await other.owner.post(`/expenses/${pending.body.id}/reject`, { reason: 'Not ours' })).status).toBe(404);
    expect((await other.owner.post(`/expenses/${mine.body.id}/reverse`, { reason: 'Not ours' }, idem())).status).toBe(404);
    const list = await other.owner.get('/expenses?pageSize=200');
    expect(list.body.total).toBe(0);
    // Tenant A's branch is invisible to tenant B.
    const otherRent = await expenseCategory(other.owner, 'rent');
    const cross = await other.owner.post('/expenses', { ...expense(), categoryId: otherRent }, idem());
    expect(cross.status).toBe(404);
    expect((await accountant.get(`/expenses/${pending.body.id}`)).body.status).toBe('pending_approval');
  });

  it('enforces branch scope on create, read, list, summary and approval', async () => {
    const b2 = await t.owner.post('/branches', { name: 'Jeddah', code: `J${Date.now() % 100000}` });
    expect(b2.status).toBe(201);
    const scoped = (await addMember(app, t, 'accountant', { allBranches: false, branchIds: [t.branchId] })).client;

    const denied = await scoped.post('/expenses', expense({ branchId: b2.body.id }), idem());
    expect(denied.status).toBe(403);
    const own = await scoped.post('/expenses', expense({ description: 'Main branch only' }), idem());
    expect(own.status).toBe(201);

    const jeddah = await t.owner.post('/expenses', expense({ branchId: b2.body.id, description: 'Jeddah rent', amount: '7000.00' }), idem());
    expect(jeddah.status).toBe(201);
    const jeddahPending = await clerk.post('/expenses', expense({ branchId: b2.body.id, description: 'Jeddah water', amount: '90.00' }), idem());
    expect(jeddahPending.status).toBe(201);

    expect((await scoped.get(`/expenses/${jeddah.body.id}`)).status).toBe(403);
    expect((await scoped.post(`/expenses/${jeddahPending.body.id}/approve`, {})).status).toBe(403);
    expect((await scoped.post(`/expenses/${jeddahPending.body.id}/reject`, { reason: 'Not my branch' })).status).toBe(403);
    expect((await scoped.post(`/expenses/${jeddah.body.id}/reverse`, { reason: 'Not my branch' }, idem())).status).toBe(403);
    expect((await scoped.get(`/expenses?branchId=${b2.body.id}`)).status).toBe(403);
    expect((await scoped.get(`/expenses/summary?branchId=${b2.body.id}`)).status).toBe(403);

    const list = await scoped.get('/expenses?pageSize=200');
    expect(list.status).toBe(200);
    const ids = list.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(own.body.id);
    expect(ids).not.toContain(jeddah.body.id);
    expect(list.body.items.every((i: { branchId: string }) => i.branchId === t.branchId)).toBe(true);
    // The scoped approver does not see the other branch's request in the inbox either.
    expect((await scoped.get('/approvals')).body.some((a: { entityId: string }) => a.entityId === jeddahPending.body.id)).toBe(false);

    // Without a branch filter the scoped summary only totals the branches the user can access.
    const ownerSum = await t.owner.get('/expenses/summary');
    const scopedSum = await scoped.get('/expenses/summary');
    expect(scopedSum.status).toBe(200);
    expect(d(ownerSum.body.totalBase).minus(scopedSum.body.totalBase).toFixed(2)).toBe('7000.00');

    const all = await t.owner.get(`/expenses?branchId=${b2.body.id}&status=posted`);
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([jeddah.body.id]);
    expect(await gl(pool, t.tenantId, '6000', { col: 'branch_id', id: b2.body.id })).toBe('7000.00');
  });

  it('summarises posted expenses by category and month (pending and reversed excluded)', async () => {
    const t3 = await createTenant(app, admin);
    await setFxReferences(t3.owner, { USD: '3.75' });
    const acc = (await addMember(app, t3, 'accountant')).client;
    const maker = (await addCustomMember(app, t3, ['expenses.read', 'expenses.create'])).client;
    const r = await expenseCategory(acc, 'rent');
    const u = await expenseCategory(acc, 'utilities');
    const base = { branchId: t3.branchId, currency: 'SAR', description: 'Monthly' };
    const post = async (c: Client, body: Record<string, unknown>) => {
      const res = await c.post('/expenses', { ...base, ...body }, idem());
      expect(res.status).toBe(201);
      return res.body as { id: string };
    };
    await post(acc, { categoryId: r, amount: '10000.00', expenseDate: '2026-01-31' });
    await post(acc, { categoryId: r, amount: '10000.00', expenseDate: '2026-02-28' });
    await post(acc, { categoryId: u, amount: '1500.50', expenseDate: '2026-02-10' });
    await post(acc, { categoryId: u, amount: '0.25', currency: 'USD', exchangeRate: '3.75', expenseDate: '2026-02-11' }); // 0.94 SAR
    await post(maker, { categoryId: u, amount: '999.00', expenseDate: '2026-02-12' }); // pending
    const rev = await post(acc, { categoryId: r, amount: '5000.00', expenseDate: '2026-02-01' });
    expect((await acc.post(`/expenses/${rev.id}/reverse`, { reason: 'Duplicate entry' }, idem())).status).toBe(200);
    await post(acc, { categoryId: r, amount: '10000.00', expenseDate: '2026-03-31' }); // outside range

    const s = await acc.get('/expenses/summary?from=2026-01-01&to=2026-02-28');
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ currency: 'SAR', from: '2026-01-01', to: '2026-02-28', totalBase: '21501.44', count: 4 });
    expect(s.body.byCategory.map((c: { code: string; totalBase: string; count: number }) => [c.code, c.totalBase, c.count])).toEqual([
      ['rent', '20000.00', 2],
      ['utilities', '1501.44', 2],
    ]);
    expect(s.body.byMonth).toEqual([
      { month: '2026-01', count: 1, totalBase: '10000.00' },
      { month: '2026-02', count: 3, totalBase: '11501.44' },
    ]);
    // The summary agrees with GL 6000 for the same period.
    const glPeriod = await pool.query(
      `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.tenant_id = $1 AND l.account_code = '6000' AND e.source_type = 'expense'
          AND e.source_id IN (SELECT id FROM expenses WHERE tenant_id = $1 AND expense_date BETWEEN '2026-01-01' AND '2026-02-28')`,
      [t3.tenantId],
    );
    expect(glPeriod.rows[0].b).toBe('21501.44');

    const allTime = await acc.get('/expenses/summary');
    expect(allTime.body).toMatchObject({ totalBase: '31501.44', count: 5 });
    const empty = await acc.get('/expenses/summary?from=2025-01-01&to=2025-12-31');
    expect(empty.body).toMatchObject({ totalBase: '0.00', count: 0, byCategory: [], byMonth: [] });
    const inverted = await acc.get('/expenses/summary?from=2026-03-01&to=2026-01-01');
    expect(inverted.status).toBe(422);

    // List filters.
    const pendingList = await acc.get('/expenses?status=pending_approval');
    expect(pendingList.body.total).toBe(1);
    const feb = await acc.get(`/expenses?from=2026-02-01&to=2026-02-28&categoryId=${u}&sort=-amountBase`);
    expect(feb.body.items.map((i: { amountBase: string }) => i.amountBase)).toEqual(['1500.50', '999.00', '0.94']);
    expect(feb.body.items[0]).toMatchObject({ categoryCode: 'utilities', categoryEn: 'Utilities', categoryAr: 'الكهرباء والمياه والمرافق', branchName: 'Main branch' });
    const search = await acc.get(`/expenses?q=${encodeURIComponent('EXP-')}`);
    expect(search.body.total).toBe(7);

    await assertBooksBalance(pool, t3.tenantId);
    expect(await gl(pool, t3.tenantId, '6000')).toBe('31501.44');
    expect(await gl(pool, t3.tenantId, '2000')).toBe('-31501.44');
  });
});
