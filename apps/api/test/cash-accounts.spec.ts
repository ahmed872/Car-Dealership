import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ORIGIN, ownerPool, TestTenant, uniq } from './helpers';

/**
 * Cash boxes and bank accounts against a real database: opening balances (Dr 1100 / Cr 3000, gated
 * by ledger.post_manual and rolled back as a whole when refused), unique names, deactivation rules,
 * derived balances, branch scope, the payment-picker options list and tenant isolation. Every test
 * leaves the tenant's books balanced (assertLedgerIntegrity after each test).
 */
describe('cash accounts', () => {
  let app: INestApplication;
  let t: TestTenant;
  let t2: TestTenant;
  let pool: Pool;
  let owner: Client;
  let accountant: Client;
  let main: { id: string };

  const create = (c: Client, body: Record<string, unknown>) => c.post('/cash-accounts', { type: 'cashbox', currency: 'SAR', ...body }, idem());
  const transfer = (c: Client, body: Record<string, unknown>) => c.post('/cash/transfers', { date: '2026-04-02', ...body }, idem());
  const accountsNamed = async (tenantId: string, name: string) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM cash_accounts WHERE tenant_id = $1 AND name = $2`, [tenantId, name])).rows[0].n);
  const entryCount = async (tenantId = t.tenantId) => Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1`, [tenantId])).rows[0].n);
  const cashRowCount = async (tenantId = t.tenantId) => Number((await pool.query(`SELECT count(*)::int AS n FROM cash_transactions WHERE tenant_id = $1`, [tenantId])).rows[0].n);

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    t2 = await createTenant(app, admin);
    pool = ownerPool();
    owner = t.owner;
    accountant = (await addMember(app, t, 'accountant')).client;
    main = await createCashAccount(owner, { name: 'Main safe', openingBalance: '100000.00' });
  });

  afterEach(async () => {
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('an opening balance is a real cash-book row posted Dr 1100 (account) / Cr 3000 on the opening date', async () => {
    const res = await create(accountant, {
      type: 'bank',
      name: 'Al Rajhi current',
      bankName: 'Al Rajhi Bank',
      accountNumber: '608010167519',
      iban: 'SA0380000000608010167519',
      openingBalance: '25000.00',
      openingDate: '2026-01-01',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: 'bank',
      name: 'Al Rajhi current',
      currency: 'SAR',
      bankName: 'Al Rajhi Bank',
      iban: 'SA0380000000608010167519',
      branchId: null,
      isActive: true,
      balance: '25000.00',
      balanceBase: '25000.00',
    });
    const id = res.body.id as string;
    const rows = await pool.query(
      `SELECT direction, amount, amount_base, kind, business_date, source_type, source_id, journal_entry_id FROM cash_transactions WHERE cash_account_id = $1`,
      [id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ direction: 'in', amount: '25000.00', amount_base: '25000.00', kind: 'opening_balance', business_date: '2026-01-01', source_type: 'cash_account', source_id: id });
    const gl = await pool.query(
      `SELECT e.id, e.event, e.entry_date, l.account_code, l.debit, l.credit, l.cash_account_id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
        WHERE e.source_type = 'cash_account' AND e.source_id = $1 ORDER BY l.line_no`,
      [id],
    );
    expect(gl.rows.map((r) => [r.event, r.entry_date, r.account_code, r.debit, r.credit, r.cash_account_id])).toEqual([
      ['cash_account.opening_balance', '2026-01-01', '1100', '25000.00', '0.00', id],
      ['cash_account.opening_balance', '2026-01-01', '3000', '0.00', '25000.00', null],
    ]);
    expect(rows.rows[0].journal_entry_id).toBe(gl.rows[0].id);
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'cash_account' AND entity_id = $1 ORDER BY seq`, [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['cash_account.created', 'cash_account.opening_balance']);

    // Without an opening balance (or with zero) nothing is posted.
    const n = { entries: await entryCount(), rows: await cashRowCount() };
    const empty = await create(accountant, { name: 'Empty box', openingBalance: '0.00' });
    expect(empty.status).toBe(201);
    expect(empty.body).toMatchObject({ balance: '0.00', balanceBase: '0.00' });
    expect({ entries: await entryCount(), rows: await cashRowCount() }).toEqual(n);
  });

  it('a foreign-currency opening balance needs its rate; the base currency only accepts rate 1; failures create nothing', async () => {
    const noRate = await create(owner, { type: 'bank', name: 'USD reserve', currency: 'USD', openingBalance: '1000.00' });
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.code).toBe('exchange_rate_required');
    expect(await accountsNamed(t.tenantId, 'USD reserve')).toBe(0);
    const badBase = await create(owner, { name: 'SAR at 3.75', openingBalance: '1000.00', exchangeRate: '3.75' });
    expect(badBase.status).toBe(422);
    expect(badBase.body.error.code).toBe('fx_rate_invalid');
    expect(await accountsNamed(t.tenantId, 'SAR at 3.75')).toBe(0);

    const usd = await create(owner, { type: 'bank', name: 'USD reserve', currency: 'USD', openingBalance: '1000.00', exchangeRate: '3.75' });
    expect(usd.status).toBe(201);
    expect(usd.body).toMatchObject({ currency: 'USD', balance: '1000.00', balanceBase: '3750.00' });
    expect(await cashBookBalance(pool, usd.body.id)).toEqual({ amount: '1000.00', amountBase: '3750.00' });
    expect(await glBalance(pool, t.tenantId, '1100', { col: 'cash_account_id', id: usd.body.id })).toBe('3750.00');
  });

  it('an opening balance requires ledger.post_manual (403) and the whole request rolls back: no half-created account', async () => {
    const mgr = (await addMemberWithPermissions(app, t, ['cash.read', 'cash.manage_accounts'])).client;
    const name = `Branch safe ${uniq()}`;
    const n = { entries: await entryCount(), rows: await cashRowCount() };
    const res = await create(mgr, { name, openingBalance: '5000.00' });
    expect(res.status).toBe(403);
    expect(res.body.error.details.permission).toBe('ledger.post_manual');
    expect(await accountsNamed(t.tenantId, name)).toBe(0);
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'cash_account.created' AND summary LIKE $2`, [t.tenantId, `${name}%`]);
    expect(audit.rows[0].n).toBe(0);
    expect({ entries: await entryCount(), rows: await cashRowCount() }).toEqual(n);

    // The same account without an opening balance is fine (the name was never taken).
    const ok = await create(mgr, { name });
    expect(ok.status).toBe(201);
    expect(ok.body.balance).toBe('0.00');
    expect(await accountsNamed(t.tenantId, name)).toBe(1);
    // Managing accounts at all needs cash.manage_accounts.
    const inventory = (await addMember(app, t, 'inventory_manager')).client;
    expect((await create(inventory, { name: `Not allowed ${uniq()}` })).status).toBe(403);
    expect((await inventory.patch(`/cash-accounts/${ok.body.id}`, { name: 'Renamed' })).status).toBe(403);
  });

  it('names are unique per company (409 cash_account_name_taken) on create and rename; another company may reuse a name', async () => {
    const first = await create(owner, { name: 'Main vault' });
    expect(first.status).toBe(201);
    const dup = await create(accountant, { type: 'bank', name: 'Main vault' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('cash_account_name_taken');
    const second = await create(owner, { name: 'Side vault' });
    const rename = await owner.patch(`/cash-accounts/${second.body.id}`, { name: 'Main vault' });
    expect(rename.status).toBe(409);
    expect(rename.body.error.code).toBe('cash_account_name_taken');
    expect((await owner.get(`/cash-accounts/${second.body.id}`)).body.name).toBe('Side vault');
    const renamed = await owner.patch(`/cash-accounts/${second.body.id}`, { name: 'Side vault 2', bankName: null });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Side vault 2');
    const elsewhere = await create(t2.owner, { name: 'Main vault' });
    expect(elsewhere.status).toBe(201);
    expect(await accountsNamed(t.tenantId, 'Main vault')).toBe(1);
    await assertLedgerIntegrity(pool, t2.tenantId);
  });

  it('deactivation needs a zero balance (409 cash_account_not_empty); inactive accounts leave the lists and take no movements', async () => {
    const box = await createCashAccount(owner, { name: 'Temporary box', openingBalance: '700.00' });
    const full = await owner.patch(`/cash-accounts/${box.id}`, { isActive: false });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('cash_account_not_empty');
    expect(full.body.error.details.balance).toBe('700.00');
    expect((await owner.get(`/cash-accounts/${box.id}`)).body.isActive).toBe(true);

    expect((await transfer(owner, { fromAccountId: box.id, toAccountId: main.id, amount: '700.00' })).status).toBe(201);
    const off = await owner.patch(`/cash-accounts/${box.id}`, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ isActive: false, balance: '0.00' });
    expect(((await owner.get('/cash-accounts')).body as Array<{ id: string }>).some((a) => a.id === box.id)).toBe(false);
    expect(((await owner.get('/cash-accounts?includeInactive=true')).body as Array<{ id: string; isActive: boolean }>).find((a) => a.id === box.id)?.isActive).toBe(false);
    expect(((await owner.get('/cash-accounts/options')).body as Array<{ id: string }>).some((a) => a.id === box.id)).toBe(false);
    const into = await transfer(owner, { fromAccountId: main.id, toAccountId: box.id, amount: '1.00' });
    expect(into.status).toBe(409);
    expect(into.body.error.code).toBe('cash_account_inactive');
    const supplier = await createSupplier(owner);
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '1000.00' });
    const payFromInactive = await owner.post(
      '/supplier-payments',
      { supplierId: supplier.id, cashAccountId: box.id, paidAt: '2026-04-02', method: 'cash', amount: '10.00', allocations: [{ targetType: 'acquisition', targetId: acq.id, amountBase: '10.00' }] },
      idem(),
    );
    expect(payFromInactive.status).toBe(409);
    expect(payFromInactive.body.error.code).toBe('cash_account_inactive');
    expect((await owner.patch(`/cash-accounts/${box.id}`, { isActive: true })).body.isActive).toBe(true);

    // An overdrawn bank account is not empty either.
    const bank = await createCashAccount(owner, { type: 'bank', name: 'Overdrawn bank' });
    expect((await transfer(owner, { fromAccountId: bank.id, toAccountId: main.id, amount: '100.00' })).status).toBe(201);
    expect((await owner.get(`/cash-accounts/${bank.id}`)).body.balance).toBe('-100.00');
    const neg = await owner.patch(`/cash-accounts/${bank.id}`, { isActive: false });
    expect(neg.status).toBe(409);
    expect(neg.body.error.code).toBe('cash_account_not_empty');
    expect(neg.body.error.details.balance).toBe('-100.00');
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'cash_account' AND entity_id = $1 ORDER BY seq`, [box.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['cash_account.created', 'cash_account.opening_balance', 'cash_account.updated', 'cash_account.updated']);
  });

  // BUG: PATCH /cash-accounts/:id accepts another company's branch id (only the FK is checked, and FK checks ignore RLS)
  it("an account cannot be moved to another company's branch (404, as on create)", async () => {
    const theirs = await createCashAccount(t2.owner, { name: `Their box ${uniq()}` });
    const onCreate = await create(t2.owner, { name: `Their box ${uniq()}`, branchId: t.branchId });
    expect(onCreate.status).toBe(404);
    const moved = await t2.owner.patch(`/cash-accounts/${theirs.id}`, { branchId: t.branchId });
    expect(moved.status).toBe(404);
    const row = await pool.query(`SELECT branch_id FROM cash_accounts WHERE id = $1`, [theirs.id]);
    expect(row.rows[0].branch_id).toBeNull();
  });

  it('balances are derived per account from the cash book (list, detail and book agree)', async () => {
    const a = await createCashAccount(owner, { name: 'Balance A', openingBalance: '111.11' });
    const b = await createCashAccount(owner, { type: 'bank', name: 'Balance B', openingBalance: '222.22' });
    expect((await transfer(owner, { fromAccountId: b.id, toAccountId: a.id, amount: '22.22' })).status).toBe(201);
    const list = (await accountant.get('/cash-accounts')).body as Array<{ id: string; balance: string; balanceBase: string; branchName: string | null }>;
    expect(list.find((x) => x.id === a.id)).toMatchObject({ balance: '133.33', balanceBase: '133.33' });
    expect(list.find((x) => x.id === b.id)).toMatchObject({ balance: '200.00', balanceBase: '200.00' });
    expect(list.find((x) => x.id === main.id)!.balance).toBe((await cashBookBalance(pool, main.id)).amount);
    for (const acct of [a, b]) {
      const one = (await accountant.get(`/cash-accounts/${acct.id}`)).body;
      const book = await cashBookBalance(pool, acct.id);
      expect({ balance: one.balance, balanceBase: one.balanceBase }).toEqual({ balance: book.amount, balanceBase: book.amountBase });
      expect(await glBalance(pool, t.tenantId, '1100', { col: 'cash_account_id', id: acct.id })).toBe(book.amountBase);
    }
  });

  it("branch-scoped users see company-level and their own branch's accounts only; another branch's account is 403", async () => {
    const b2 = await createBranch(owner, 'Khobar');
    const scoped = (await addMember(app, t, 'branch_manager', { allBranches: false, branchIds: [b2.id] })).client;
    const mainBox = await createCashAccount(owner, { name: 'Main branch box', branchId: t.branchId, openingBalance: '500.00' });
    const b2Box = await createCashAccount(owner, { name: 'Khobar box', branchId: b2.id });
    const company = await createCashAccount(owner, { type: 'bank', name: 'Company bank' });

    const list = await scoped.get('/cash-accounts');
    expect(list.status).toBe(200);
    const ids = (list.body as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(b2Box.id);
    expect(ids).toContain(company.id);
    expect(ids).not.toContain(mainBox.id);
    const opts = ((await scoped.get('/cash-accounts/options')).body as Array<{ id: string }>).map((a) => a.id);
    expect(opts).toContain(b2Box.id);
    expect(opts).not.toContain(mainBox.id);
    const denied = await scoped.get(`/cash-accounts/${mainBox.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
    expect((await scoped.patch(`/cash-accounts/${mainBox.id}`, { name: 'Taken over' })).status).toBe(403);
    expect((await transfer(scoped, { fromAccountId: mainBox.id, toAccountId: b2Box.id, amount: '100.00' })).status).toBe(403);
    expect((await scoped.get(`/cash-accounts/${b2Box.id}`)).status).toBe(200);
    expect((await scoped.get(`/cash-accounts/${company.id}`)).status).toBe(200);
    // Creating in another branch is refused; in their own branch it works.
    expect((await create(scoped, { name: `Main branch box 2 ${uniq()}`, branchId: t.branchId })).status).toBe(403);
    const own = await create(scoped, { name: `Khobar box 2 ${uniq()}`, branchId: b2.id });
    expect(own.status).toBe(201);
    expect(own.body.branchId).toBe(b2.id);
    // The company owner sees everything.
    const all = ((await owner.get('/cash-accounts')).body as Array<{ id: string }>).map((a) => a.id);
    expect(all).toEqual(expect.arrayContaining([mainBox.id, b2Box.id, company.id, own.body.id]));
    expect((await owner.get(`/cash-accounts/${mainBox.id}`)).body.name).toBe('Main branch box');
  });

  it('GET /cash-accounts/options serves any signed-in member a minimal list without balances', async () => {
    const rep = (await addMember(app, t, 'sales_rep')).client;
    expect((await rep.get('/cash-accounts')).status).toBe(403);
    expect((await rep.get(`/cash-accounts/${main.id}`)).status).toBe(403);
    const opts = await rep.get('/cash-accounts/options');
    expect(opts.status).toBe(200);
    const items = opts.body as Array<Record<string, unknown>>;
    expect(items.find((i) => i.id === main.id)).toEqual({ id: main.id, type: 'cashbox', name: 'Main safe', currency: 'SAR', branchId: null });
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['branchId', 'currency', 'id', 'name', 'type']);
    const inspector = (await addMember(app, t, 'inspector')).client;
    expect((await inspector.get('/cash-accounts/options')).status).toBe(200);
    const anon = await request(app.getHttpServer()).get('/api/v1/cash-accounts/options').set('Origin', ORIGIN);
    expect(anon.status).toBe(401);
  });

  it('another company gets 404 for our cash accounts, vehicle costs and supplier payments', async () => {
    const supplier = await createSupplier(owner);
    const v = await createVehicle(owner, t.branchId);
    const cost = await accountant.post(
      '/vehicle-costs',
      { vehicleId: v.id, categoryId: await costCategory(owner, 'transport'), description: 'Tow', amount: '150.00', currency: 'SAR', costDate: '2026-04-03', supplierId: supplier.id },
      idem(),
    );
    expect(cost.status).toBe(201);
    const payment = await accountant.post(
      '/supplier-payments',
      { supplierId: supplier.id, cashAccountId: main.id, paidAt: '2026-04-03', method: 'cash', amount: '150.00', allocations: [{ targetType: 'vehicle_cost', targetId: cost.body.id, amountBase: '150.00' }] },
      idem(),
    );
    expect(payment.status).toBe(201);
    const o = t2.owner;
    for (const path of [`/cash-accounts/${main.id}`, `/vehicle-costs/${cost.body.id}`, `/supplier-payments/${payment.body.id}`, `/cash/accounts/${main.id}/book`]) {
      const r = await o.get(path);
      expect(r.status, path).toBe(404);
    }
    expect((await o.patch(`/cash-accounts/${main.id}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await o.patch(`/cash-accounts/${main.id}`, { isActive: false })).status).toBe(404);
    expect(((await o.get('/cash-accounts?includeInactive=true')).body as Array<{ id: string }>).some((a) => a.id === main.id)).toBe(false);
    expect(((await o.get('/cash-accounts/options')).body as Array<{ id: string }>).some((a) => a.id === main.id)).toBe(false);
    const theirs = await createCashAccount(o, { openingBalance: '50.00' });
    expect((await transfer(o, { fromAccountId: theirs.id, toAccountId: main.id, amount: '10.00' })).status).toBe(404);
    expect((await owner.get(`/cash-accounts/${main.id}`)).body).toMatchObject({ name: 'Main safe', isActive: true });
    await assertLedgerIntegrity(pool, t2.tenantId);
  });
});
