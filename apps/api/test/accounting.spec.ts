import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayInZone } from '@autohub/shared';
import { costCategory, createAcquisition, createSupplier, setFxReferences } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, PASSWORD, TestTenant, uniq } from './helpers';

const TODAY = todayInZone('Asia/Riyadh'); // SA tenants

/** GL balance (debit − credit) for one account, optionally filtered by a dimension column. */
async function gl(pool: Pool, tenantId: string, account: string, dim?: { col: string; id: string }) {
  const r = await pool.query(
    `SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines WHERE tenant_id = $1 AND account_code = $2 ${dim ? `AND ${dim.col} = $3` : ''}`,
    dim ? [tenantId, account, dim.id] : [tenantId, account],
  );
  return r.rows[0].b as string;
}

/** Cash or bank account with an opening balance dated 1 Jan 2026 (so back-dated movements stay in order). */
async function account(
  c: Client,
  o: { type?: 'cashbox' | 'bank'; currency?: string; openingBalance?: string; exchangeRate?: string; branchId?: string | null; name?: string } = {},
) {
  const res = await c.post(
    '/cash-accounts',
    { type: 'cashbox', name: uniq('Acct '), currency: 'SAR', ...(o.openingBalance ? { openingDate: '2026-01-01' } : {}), ...o },
    idem(),
  );
  if (res.status !== 201) throw new Error(`create cash account failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; currency: string };
}

async function balanceOf(c: Client, id: string) {
  const r = await c.get(`/cash-accounts/${id}`);
  return { balance: r.body.balance as string, balanceBase: r.body.balanceBase as string };
}

function transfer(c: Client, body: Record<string, unknown>, key = idem()) {
  return c.post('/cash/transfers', { date: '2026-02-01', ...body }, key);
}

describe('accounting: transfers, cash book, GL reports, reconciliation', () => {
  let app: INestApplication;
  let admin: Client;
  let t: TestTenant;
  let pool: Pool;

  beforeAll(async () => {
    app = await getApp();
    admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    await setFxReferences(t.owner, { USD: '3.75' });
    pool = ownerPool();
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('same-currency transfer moves both balances with one balanced GL entry, idempotently', async () => {
    const c = t.owner;
    const box = await account(c, { openingBalance: '10000.00' });
    const bank = await account(c, { type: 'bank' });
    const key = idem();
    const body = { fromAccountId: box.id, toAccountId: bank.id, amount: '2500.00', reference: 'DEP-001', notes: 'Daily deposit' };
    const res = await transfer(c, body, key);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'posted',
      amountBase: '2500.00',
      baseCurrency: 'SAR',
      businessDate: '2026-02-01',
      reference: 'DEP-001',
      from: { cashAccountId: box.id, amount: '2500.00', currency: 'SAR', exchangeRate: '1.00000000' },
      to: { cashAccountId: bank.id, amount: '2500.00', currency: 'SAR' },
      reversal: null,
    });
    expect(res.body.description).toContain('Daily deposit');
    const transferId = res.body.transferId as string;

    // Retrying with the same Idempotency-Key replays the response and moves nothing.
    const again = await transfer(c, body, key);
    expect(again.status).toBe(201);
    expect(again.body.transferId).toBe(transferId);

    expect((await balanceOf(c, box.id)).balance).toBe('7500.00');
    expect((await balanceOf(c, bank.id)).balance).toBe('2500.00');
    expect(await gl(pool, t.tenantId, '1100', { col: 'cash_account_id', id: box.id })).toBe('7500.00');
    expect(await gl(pool, t.tenantId, '1100', { col: 'cash_account_id', id: bank.id })).toBe('2500.00');

    const je = await pool.query(
      `SELECT je.event, count(*)::int AS n, sum(jl.debit)::text AS dr, sum(jl.credit)::text AS cr
         FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.tenant_id = $1 AND je.source_type = 'cash_transfer' AND je.source_id = $2
        GROUP BY je.id, je.event`,
      [t.tenantId, transferId],
    );
    expect(je.rows).toEqual([{ event: 'cash_transfer.posted', n: 2, dr: '2500.00', cr: '2500.00' }]);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM cash_transactions WHERE tenant_id = $1 AND source_id = $2`, [t.tenantId, transferId]);
    expect(rows.rows[0].n).toBe(2);
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'cash_transfer.posted' AND entity_id = $2`, [
      t.tenantId,
      transferId,
    ]);
    expect(audit.rows[0].n).toBe(1);

    const list = await c.get(`/cash/transfers?cashAccountId=${bank.id}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ transferId, status: 'posted', from: { cashAccountName: box.name }, to: { cashAccountName: bank.name } });
    const one = await c.get(`/cash/transfers/${transferId}`);
    expect(one.status).toBe(200);
    expect(one.body.journalEntryId).toBeTruthy();
  });

  it('refuses overdrawing a cash box, same-account transfers and inconsistent amounts; banks may overdraw', async () => {
    const c = t.owner;
    const box = await account(c, { openingBalance: '1000.00' });
    const box2 = await account(c);
    const over = await transfer(c, { fromAccountId: box.id, toAccountId: box2.id, amount: '1000.01' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('insufficient_cash');
    expect(over.body.error.details).toMatchObject({ available: '1000.00', required: '1000.01' });
    const same = await transfer(c, { fromAccountId: box.id, toAccountId: box.id, amount: '10.00' });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('same_account');
    const mismatch = await transfer(c, { fromAccountId: box.id, toAccountId: box2.id, amount: '100.00', amountTo: '99.00' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('amount_to_mismatch');
    const rate = await transfer(c, { fromAccountId: box.id, toAccountId: box2.id, amount: '100.00', exchangeRate: '3.75' });
    expect(rate.status).toBe(422);
    expect(rate.body.error.code).toBe('fx_rate_invalid');
    const invalid = await transfer(c, { fromAccountId: box.id, toAccountId: box2.id, amount: '-5.00' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('validation_failed');
    const missing = await transfer(c, { fromAccountId: box.id, toAccountId: randomUUID(), amount: '5.00' });
    expect(missing.status).toBe(404);
    expect((await balanceOf(c, box.id)).balance).toBe('1000.00');
    expect((await balanceOf(c, box2.id)).balance).toBe('0.00');

    // Bank accounts may go into overdraft (flagged in reports, not blocked).
    const bank = await account(c, { type: 'bank' });
    const od = await transfer(c, { fromAccountId: bank.id, toAccountId: box2.id, amount: '300.00' });
    expect(od.status).toBe(201);
    expect((await balanceOf(c, bank.id)).balance).toBe('-300.00');
  });

  it('SAR → USD needs amountTo; both legs carry the same base amount; USD → SAR uses the stated rate', async () => {
    const c = t.owner;
    const box = await account(c, { openingBalance: '20000.00' });
    const usd = await account(c, { type: 'bank', currency: 'USD' });
    const noTo = await transfer(c, { fromAccountId: box.id, toAccountId: usd.id, amount: '3750.00' });
    expect(noTo.status).toBe(422);
    expect(noTo.body.error.code).toBe('amount_to_required');

    const out = await transfer(c, { fromAccountId: box.id, toAccountId: usd.id, amount: '3750.00', amountTo: '1000.00', date: '2026-03-01' });
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({
      amountBase: '3750.00',
      from: { amount: '3750.00', currency: 'SAR' },
      to: { amount: '1000.00', currency: 'USD', exchangeRate: '3.75000000' },
    });
    expect(await balanceOf(c, usd.id)).toEqual({ balance: '1000.00', balanceBase: '3750.00' });
    expect((await balanceOf(c, box.id)).balance).toBe('16250.00');
    const legs = await pool.query(`SELECT kind, amount, amount_base FROM cash_transactions WHERE tenant_id = $1 AND source_id = $2 ORDER BY kind`, [
      t.tenantId,
      out.body.transferId,
    ]);
    expect(legs.rows).toEqual([
      { kind: 'transfer_in', amount: '1000.00', amount_base: '3750.00' },
      { kind: 'transfer_out', amount: '3750.00', amount_base: '3750.00' },
    ]);
    expect(await gl(pool, t.tenantId, '1100', { col: 'cash_account_id', id: usd.id })).toBe('3750.00');

    const noRate = await transfer(c, { fromAccountId: usd.id, toAccountId: box.id, amount: '400.00' });
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.code).toBe('exchange_rate_required');
    const wrongTo = await transfer(c, { fromAccountId: usd.id, toAccountId: box.id, amount: '400.00', exchangeRate: '3.76', amountTo: '1500.00' });
    expect(wrongTo.status).toBe(422);
    expect(wrongTo.body.error.code).toBe('amount_to_mismatch');
    const back = await transfer(c, { fromAccountId: usd.id, toAccountId: box.id, amount: '400.00', exchangeRate: '3.76', date: '2026-03-02' });
    expect(back.status).toBe(201);
    // 400 USD carried at 3.75 (1,500.00) are sold at 3.76 (1,504.00): the box receives 1,504.00 and
    // the 4.00 difference is a realized FX gain, so the remaining 600 USD stay at 3.75 (2,250.00).
    expect(back.body).toMatchObject({ amountBase: '1504.00', fromBase: '1500.00', fxDifference: '4.00', from: { amount: '400.00', exchangeRate: '3.76000000' }, to: { amount: '1504.00' } });
    expect(await balanceOf(c, usd.id)).toEqual({ balance: '600.00', balanceBase: '2250.00' });
    expect((await balanceOf(c, box.id)).balance).toBe('17754.00');
    expect(await gl(pool, t.tenantId, '1100', { col: 'cash_account_id', id: usd.id })).toBe('2250.00');
    expect(await gl(pool, t.tenantId, '4300')).toBe('-4.00');
  });

  it('reverses a transfer exactly once: balances restored, mirrored entry, reversal rows linked to each leg', async () => {
    const c = t.owner;
    const box = await account(c, { openingBalance: '5000.00' });
    const bank = await account(c, { type: 'bank' });
    const tr = await transfer(c, { fromAccountId: box.id, toAccountId: bank.id, amount: '1200.00', date: '2026-04-01' });
    expect(tr.status).toBe(201);
    const id = tr.body.transferId as string;

    const key = idem();
    const rev = await c.post(`/cash/transfers/${id}/reverse`, { reason: 'Posted to the wrong account' }, key);
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe('reversed');
    expect(rev.body.reversal).toMatchObject({ businessDate: TODAY, description: 'Reversal: Posted to the wrong account' });
    expect((await balanceOf(c, box.id)).balance).toBe('5000.00');
    expect((await balanceOf(c, bank.id)).balance).toBe('0.00');
    expect(await gl(pool, t.tenantId, '1100', { col: 'cash_account_id', id: box.id })).toBe('5000.00');
    expect(await gl(pool, t.tenantId, '1100', { col: 'cash_account_id', id: bank.id })).toBe('0.00');

    const entries = await pool.query(
      `SELECT id, event, reversal_of_id, entry_date FROM journal_entries WHERE tenant_id = $1 AND source_type = 'cash_transfer' AND source_id = $2 ORDER BY entry_no`,
      [t.tenantId, id],
    );
    expect(entries.rows.map((r) => r.event)).toEqual(['cash_transfer.posted', 'cash_transfer.reversed']);
    expect(entries.rows[1].reversal_of_id).toBe(entries.rows[0].id);
    const rows = await pool.query(
      `SELECT id, cash_account_id, kind, direction, amount, reversal_of_id FROM cash_transactions WHERE tenant_id = $1 AND source_id = $2`,
      [t.tenantId, id],
    );
    const byKind = Object.fromEntries(rows.rows.map((r) => [r.kind, r]));
    expect(Object.keys(byKind).sort()).toEqual(['transfer_in', 'transfer_in_reversal', 'transfer_out', 'transfer_out_reversal']);
    expect(byKind.transfer_out_reversal).toMatchObject({ cash_account_id: box.id, direction: 'in', amount: '1200.00', reversal_of_id: byKind.transfer_out.id });
    expect(byKind.transfer_in_reversal).toMatchObject({ cash_account_id: bank.id, direction: 'out', amount: '1200.00', reversal_of_id: byKind.transfer_in.id });

    // Same key replays; a new attempt is refused.
    const replay = await c.post(`/cash/transfers/${id}/reverse`, { reason: 'Posted to the wrong account' }, key);
    expect(replay.status).toBe(200);
    const twice = await c.post(`/cash/transfers/${id}/reverse`, { reason: 'Again' }, idem());
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('already_reversed');
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'cash_transfer.reversed' AND entity_id = $2`, [
      t.tenantId,
      id,
    ]);
    expect(audit.rows[0].n).toBe(1);
    const noReason = await c.post(`/cash/transfers/${id}/reverse`, {}, idem());
    expect(noReason.status).toBe(422);
    expect((await c.post(`/cash/transfers/${randomUUID()}/reverse`, { reason: 'Nothing' }, idem())).status).toBe(404);

    // The destination cash box already spent part of the money: the reversal is refused.
    const box2 = await account(c);
    const t2 = await transfer(c, { fromAccountId: box.id, toAccountId: box2.id, amount: '800.00', date: '2026-04-02' });
    await transfer(c, { fromAccountId: box2.id, toAccountId: bank.id, amount: '500.00', date: '2026-04-03' });
    const blocked = await c.post(`/cash/transfers/${t2.body.transferId}/reverse`, { reason: 'Mistake' }, idem());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('insufficient_cash');
    expect((await balanceOf(c, box2.id)).balance).toBe('300.00');

    const reversed = await c.get(`/cash/transfers?status=reversed&cashAccountId=${box.id}`);
    expect(reversed.body.items.map((i: { transferId: string }) => i.transferId)).toEqual([id]);
    const posted = await c.get(`/cash/transfers?status=posted&cashAccountId=${box.id}`);
    expect(posted.body.items.map((i: { transferId: string }) => i.transferId)).toEqual([t2.body.transferId]);
  });

  it('cash book: opening before the period, running balance across pages, document numbers and reversal markers', async () => {
    const c = t.owner;
    const box = await account(c, { name: uniq('Book box '), openingBalance: '10000.00' });
    const bank = await account(c, { type: 'bank', name: uniq('Book bank ') });
    const supplier = await createSupplier(c);
    const acq = await createAcquisition(c, t.branchId, supplier.id, { price: '50000.00' });
    await transfer(c, { fromAccountId: box.id, toAccountId: bank.id, amount: '3000.00', date: '2026-02-05' });
    const pay = await c.post(
      '/supplier-payments',
      { supplierId: supplier.id, cashAccountId: box.id, paidAt: '2026-02-10', method: 'cash', amount: '4000.00', allocations: [{ targetType: 'acquisition', targetId: acq.id, amountBase: '4000.00' }] },
      idem(),
    );
    expect(pay.status).toBe(201);
    const back = await transfer(c, { fromAccountId: bank.id, toAccountId: box.id, amount: '500.00', date: '2026-02-20' });
    await transfer(c, { fromAccountId: box.id, toAccountId: bank.id, amount: '1000.00', date: '2026-03-05' });
    expect((await c.post(`/cash/transfers/${back.body.transferId}/reverse`, { reason: 'Duplicate' }, idem())).status).toBe(200);

    const feb = await c.get(`/cash/accounts/${box.id}/book?from=2026-02-01&to=2026-02-28`);
    expect(feb.status).toBe(200);
    expect(feb.body).toMatchObject({
      account: { id: box.id, currency: 'SAR', type: 'cashbox' },
      from: '2026-02-01',
      to: '2026-02-28',
      opening: { amount: '10000.00', amountBase: '10000.00' },
      totals: { in: '500.00', out: '7000.00', inBase: '500.00', outBase: '7000.00' },
      closing: { amount: '3500.00', amountBase: '3500.00' },
      total: 3,
    });
    const r = feb.body.rows;
    expect(r.map((x: { kind: string; runningBalance: string }) => [x.kind, x.runningBalance])).toEqual([
      ['transfer_out', '7000.00'],
      ['supplier_payment', '3000.00'],
      ['transfer_in', '3500.00'],
    ]);
    expect(r[0]).toMatchObject({ signedAmount: '-3000.00', counterpartAccountId: bank.id, counterpartAccountName: bank.name, sourceType: 'cash_transfer' });
    expect(r[1]).toMatchObject({ documentNumber: pay.body.number, sourceType: 'supplier_payment', sourceId: pay.body.id, isReversal: false, reversedById: null });
    expect(r[2].reversedById).toBeTruthy();

    // Page 2 of size 1 still carries the running balance of the whole period.
    const page2 = await c.get(`/cash/accounts/${box.id}/book?from=2026-02-01&to=2026-02-28&page=2&pageSize=1`);
    expect(page2.body.rows).toHaveLength(1);
    expect(page2.body.rows[0]).toMatchObject({ kind: 'supplier_payment', runningBalance: '3000.00' });
    expect(page2.body.total).toBe(3);

    // Whole history up to today: the reversal row is dated today and points at the reversed row.
    const all = await c.get(`/cash/accounts/${box.id}/book`);
    expect(all.body.opening.amount).toBe('0.00');
    expect(all.body.closing.amount).toBe('2000.00');
    expect(all.body.closing.amount).toBe((await balanceOf(c, box.id)).balance);
    const last = all.body.rows[all.body.rows.length - 1];
    expect(last).toMatchObject({ kind: 'transfer_in_reversal', businessDate: TODAY, isReversal: true, reversalOfId: r[2].id, runningBalance: '2000.00', signedAmount: '-500.00' });
    expect(all.body.rows[0]).toMatchObject({ kind: 'opening_balance', runningBalance: '10000.00' });

    // The GL statement of 1100 for this account says the same thing.
    const st = await c.get(`/ledger/accounts/1100/statement?cashAccountId=${box.id}&from=2026-02-01&to=2026-02-28`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ opening: '10000.00', totalDebit: '500.00', totalCredit: '7000.00', closing: '3500.00', normalSide: 'debit', total: 3 });
    expect(st.body.rows.map((x: { runningBalance: string }) => x.runningBalance)).toEqual(['7000.00', '3000.00', '3500.00']);

    const bad = await c.get(`/cash/accounts/${box.id}/book?from=2026-03-01&to=2026-02-01`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_range');
    expect((await c.get(`/cash/accounts/${randomUUID()}/book`)).status).toBe(404);
  });

  it('mixed scenario: trial balance, income statement and balance sheet balance; every reconciliation is 0.00', async () => {
    const m = await createTenant(app, admin);
    const c = m.owner;
    const box = await account(c, { name: 'Main cash box', openingBalance: '100000.00' });
    const bank = await account(c, { type: 'bank', name: 'Operating bank', openingBalance: '50000.00' });
    const supplier = await createSupplier(c);
    const acq1 = await createAcquisition(c, m.branchId, supplier.id, { price: '80000.00' }); // 2026-01-15
    const pay = await c.post(
      '/supplier-payments',
      { supplierId: supplier.id, cashAccountId: bank.id, paidAt: '2026-01-20', method: 'bank_transfer', amount: '30000.00', allocations: [{ targetType: 'acquisition', targetId: acq1.id, amountBase: '30000.00' }] },
      idem(),
    );
    expect(pay.status).toBe(201);
    const cost1 = await c.post(
      '/vehicle-costs',
      { vehicleId: acq1.vehicleId, categoryId: await costCategory(c, 'transport'), description: 'Transport', amount: '1500.00', currency: 'SAR', costDate: '2026-01-17', supplierId: supplier.id },
      idem(),
    );
    expect(cost1.status).toBe(201);
    const cost2 = await c.post(
      '/vehicle-costs',
      { vehicleId: acq1.vehicleId, categoryId: await costCategory(c, 'detailing'), description: 'Detailing', amount: '700.00', currency: 'SAR', costDate: '2026-01-18', payNow: { cashAccountId: box.id, method: 'cash' } },
      idem(),
    );
    expect(cost2.status).toBe(201);
    expect((await transfer(c, { fromAccountId: box.id, toAccountId: bank.id, amount: '20000.00', date: '2026-01-25' })).status).toBe(201);
    const acq2 = await createAcquisition(c, m.branchId, supplier.id, { price: '40000.00' });
    const cost3 = await c.post(
      '/vehicle-costs',
      { vehicleId: acq2.vehicleId, categoryId: await costCategory(c, 'bodywork'), description: 'Bodywork', amount: '2000.00', currency: 'SAR', costDate: '2026-01-19', supplierId: supplier.id },
      idem(),
    );
    expect(cost3.status).toBe(201);
    // Cancelling the second purchase reverses its price and writes the bodywork off to 6300 (today).
    expect((await c.post(`/acquisitions/${acq2.id}/cancel`, { reason: 'Seller withdrew' }, idem())).status).toBe(200);

    const tb = await c.get('/ledger/trial-balance');
    expect(tb.status).toBe(200);
    expect(tb.body.isBalanced).toBe(true);
    const closing = Object.fromEntries(tb.body.rows.map((r: { code: string; closing: string }) => [r.code, r.closing]));
    expect(closing).toMatchObject({ '1100': '119300.00', '1300': '82200.00', '2000': '-53500.00', '3000': '-150000.00', '6300': '2000.00', '4000': '0.00' });
    expect(tb.body.totals).toMatchObject({ closingDebit: '203500.00', closingCredit: '203500.00', opening: '0.00', closing: '0.00' });
    expect(tb.body.totals.periodDebit).toBe(tb.body.totals.periodCredit);

    const jan = await c.get('/ledger/trial-balance?from=2026-01-16&to=2026-01-31');
    expect(jan.body.isBalanced).toBe(true);
    const row = (code: string) => jan.body.rows.find((r: { code: string }) => r.code === code);
    expect(row('1100')).toMatchObject({ opening: '150000.00', periodDebit: '20000.00', periodCredit: '50700.00', closing: '119300.00', closingDebit: '119300.00' });
    expect(row('1300')).toMatchObject({ opening: '120000.00', periodDebit: '4200.00', periodCredit: '0.00', closing: '124200.00' });
    expect(row('2000')).toMatchObject({ opening: '-120000.00', periodDebit: '30700.00', periodCredit: '4200.00', closing: '-93500.00', closingCredit: '93500.00' });

    // Branch filter = entries recorded by the branch; company-level cash movements are excluded.
    const br = await c.get(`/ledger/trial-balance?branchId=${m.branchId}`);
    expect(br.body.isBalanced).toBe(true);
    const brClosing = Object.fromEntries(br.body.rows.map((r: { code: string; closing: string }) => [r.code, r.closing]));
    expect(brClosing).toMatchObject({ '1100': '0.00', '1300': '82200.00', '2000': '-84200.00', '6300': '2000.00', '3000': '0.00' });
    expect((await c.get(`/ledger/trial-balance?branchId=${randomUUID()}`)).status).toBe(404);
    expect((await c.get('/ledger/trial-balance?from=2026-02-01&to=2026-01-01')).body.error.code).toBe('invalid_range');

    const is = await c.get('/ledger/income-statement?from=2026-01-01&to=2026-12-31');
    expect(is.status).toBe(200);
    expect(is.body).toMatchObject({ revenue: { total: '0.00' }, costOfSales: { total: '0.00' }, grossProfit: '0.00', expenses: { total: '2000.00' }, netIncome: '-2000.00' });
    expect(is.body.expenses.lines.find((l: { code: string }) => l.code === '6300').amount).toBe('2000.00');
    const isBefore = await c.get(`/ledger/income-statement?from=2026-01-01&to=2026-09-30`);
    expect(isBefore.body.netIncome).toBe('0.00');

    const bs = await c.get('/ledger/balance-sheet');
    expect(bs.status).toBe(200);
    expect(bs.body).toMatchObject({
      asOf: TODAY,
      assets: { total: '201500.00' },
      liabilities: { total: '53500.00' },
      equity: { earnings: '-2000.00', total: '148000.00' },
      liabilitiesAndEquity: '201500.00',
      check: { difference: '0.00', isBalanced: true },
    });
    const bsJan = await c.get('/ledger/balance-sheet?asOf=2026-01-31');
    expect(bsJan.body).toMatchObject({ assets: { total: '243500.00' }, liabilities: { total: '93500.00' }, equity: { total: '150000.00' }, check: { isBalanced: true } });

    for (const asOf of [TODAY, '2026-01-31', '2026-01-16']) {
      const rec = await c.get(`/ledger/reconciliation?asOf=${asOf}`);
      expect(rec.status).toBe(200);
      expect(rec.body.ok).toBe(true);
      expect(rec.body.trialBalance.isBalanced).toBe(true);
      for (const s of rec.body.sections) {
        expect(s.difference).toBe('0.00');
        expect(s.mismatches).toEqual([]);
      }
    }
    const rec = await c.get('/ledger/reconciliation');
    const sec = Object.fromEntries(rec.body.sections.map((s: { name: string }) => [s.name, s]));
    expect(sec.cash).toMatchObject({ account: '1100', subledgerTotal: '119300.00', glTotal: '119300.00' });
    expect(sec.inventory).toMatchObject({ account: '1300', subledgerTotal: '82200.00', glTotal: '82200.00' });
    expect(sec.payables).toMatchObject({ account: '2000', subledgerTotal: '53500.00', glTotal: '53500.00' });
    const recJan = await c.get('/ledger/reconciliation?asOf=2026-01-31');
    const secJan = Object.fromEntries(recJan.body.sections.map((s: { name: string }) => [s.name, s]));
    expect(secJan.inventory.subledgerTotal).toBe('124200.00');
    expect(secJan.payables.subledgerTotal).toBe('93500.00');

    // Chart with balances and the journal views.
    const accts = await c.get('/ledger/accounts');
    const a2000 = accts.body.items.find((a: { code: string }) => a.code === '2000');
    expect(a2000).toMatchObject({ type: 'liability', balance: '-53500.00', naturalBalance: '53500.00' });
    const transfers = await c.get('/ledger/entries?sourceType=cash_transfer');
    expect(transfers.body.total).toBe(1);
    expect(transfers.body.items[0]).toMatchObject({ event: 'cash_transfer.posted', totalDebit: '20000.00', totalCredit: '20000.00' });
    expect(transfers.body.items[0].lines.map((l: { cashAccountId: string; debit: string }) => [l.cashAccountId, l.debit])).toEqual([
      [bank.id, '20000.00'],
      [box.id, '0.00'],
    ]);
    const v2 = await c.get(`/ledger/entries?vehicleId=${acq2.vehicleId}&pageSize=2`);
    expect(v2.body.total).toBe(4); // purchase, bodywork, purchase reversal, write-off
    expect(v2.body.items).toHaveLength(2);
    const writeOffs = await c.get('/ledger/entries?accountCode=6300');
    expect(writeOffs.body.items.map((e: { event: string }) => e.event)).toEqual(['vehicle.written_off']);
    const reversal = (await c.get(`/ledger/entries?vehicleId=${acq2.vehicleId}&sourceType=vehicle_cost`)).body.items.find(
      (e: { event: string }) => e.event === 'cost.reversed',
    );
    const original = await c.get(`/ledger/entries/${reversal.reversalOfId}`);
    expect(original.status).toBe(200);
    expect(original.body).toMatchObject({ event: 'cost.posted', reversedById: reversal.id, totalDebit: '40000.00' });
    expect(original.body.lines).toHaveLength(2);
    expect((await c.get(`/ledger/entries/${randomUUID()}`)).status).toBe(404);
    const st = await c.get(`/ledger/accounts/2000/statement?supplierId=${supplier.id}`);
    expect(st.body).toMatchObject({ normalSide: 'credit', opening: '0.00', closing: '-53500.00' });
    expect((await c.get('/ledger/accounts/9999/statement')).status).toBe(404);

    // A GL line without a matching document (simulated tampering) is caught item by item.
    await pool.query(
      `WITH e AS (
         INSERT INTO journal_entries (tenant_id, entry_no, entry_date, source_type, source_id, event, description)
         VALUES ($1::uuid, 900001, '2026-01-20', 'test', gen_random_uuid(), 'tamper', 'Unsupported adjustment') RETURNING id
       )
       INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_code, debit, credit, vehicle_id, supplier_id)
       SELECT $1::uuid, e.id, 1, '1300', 100, 0, $2::uuid, NULL::uuid FROM e
       UNION ALL SELECT $1::uuid, e.id, 2, '2000', 0, 100, NULL::uuid, $3::uuid FROM e`,
      [m.tenantId, acq1.vehicleId, supplier.id],
    );
    const bad = await c.get('/ledger/reconciliation');
    expect(bad.body.ok).toBe(false);
    expect(bad.body.trialBalance.isBalanced).toBe(true);
    const badSec = Object.fromEntries(bad.body.sections.map((s: { name: string }) => [s.name, s]));
    expect(badSec.cash.ok).toBe(true);
    expect(badSec.inventory).toMatchObject({ ok: false, difference: '100.00', mismatchCount: 1 });
    expect(badSec.inventory.mismatches[0]).toMatchObject({ key: acq1.vehicleId, subledgerBase: '82200.00', glBase: '82300.00', difference: '100.00' });
    expect(badSec.payables.mismatches[0]).toMatchObject({ key: supplier.id, subledgerBase: '53500.00', glBase: '53600.00', difference: '100.00' });
  });

  it('permissions and branch scope: sales rep 403, company scope for GL, branch-scoped cash book and transfers', async () => {
    const c = t.owner;
    const rep = await addMember(app, t, 'sales_rep');
    for (const path of ['/ledger/trial-balance', '/ledger/reconciliation', '/ledger/entries', '/ledger/accounts', '/ledger/balance-sheet', '/ledger/income-statement', '/cash/transfers']) {
      const res = await rep.client.get(path);
      expect(res.status, path).toBe(403);
    }
    const box = await account(c, { openingBalance: '1000.00' });
    const bank = await account(c, { type: 'bank' });
    expect((await transfer(rep.client, { fromAccountId: box.id, toAccountId: bank.id, amount: '1.00' })).status).toBe(403);

    // cash.transfer alone cannot reverse a transfer (payments.void is also required).
    const role = await c.post('/roles', { name: uniq('Cashier '), permissions: ['cash.read', 'cash.transfer'], maxDiscountPct: '0' });
    expect(role.status).toBe(201);
    const email = `${uniq('cashier')}@autohub.test`;
    expect((await c.post('/users', { email, fullName: 'Cashier', password: PASSWORD, roleId: role.body.id, allBranches: true })).status).toBe(201);
    const cashier = await Client.login(app, email);
    const tr = await transfer(cashier, { fromAccountId: box.id, toAccountId: bank.id, amount: '100.00' });
    expect(tr.status).toBe(201);
    expect((await cashier.post(`/cash/transfers/${tr.body.transferId}/reverse`, { reason: 'Mistake' }, idem())).status).toBe(403);
    expect((await cashier.get('/ledger/trial-balance')).status).toBe(403);

    const acc = await addMember(app, t, 'accountant');
    expect((await acc.client.get('/ledger/trial-balance')).status).toBe(200);
    expect((await acc.client.post(`/cash/transfers/${tr.body.transferId}/reverse`, { reason: 'Mistake' }, idem())).status).toBe(200);

    // A second branch with its own cash box.
    const b2 = await c.post('/branches', { name: 'North branch', code: uniq('N').toUpperCase() });
    expect(b2.status).toBe(201);
    const mainBox = await account(c, { branchId: t.branchId, openingBalance: '2000.00' });
    const northBox = await account(c, { branchId: b2.body.id, openingBalance: '2000.00' });
    const inter = await transfer(c, { fromAccountId: mainBox.id, toAccountId: northBox.id, amount: '250.00' });
    expect(inter.status).toBe(201);
    // Each leg of an inter-branch transfer carries its own account's branch.
    const lines = await pool.query(
      `SELECT jl.cash_account_id, jl.branch_id FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.tenant_id = $1 AND je.source_id = $2`,
      [t.tenantId, inter.body.transferId],
    );
    expect(Object.fromEntries(lines.rows.map((l) => [l.cash_account_id, l.branch_id]))).toEqual({ [mainBox.id]: t.branchId, [northBox.id]: b2.body.id });

    const scoped = await addMember(app, t, 'accountant', { allBranches: false, branchIds: [t.branchId] });
    const denied = await scoped.client.get('/ledger/trial-balance');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('company_scope_required');
    expect((await scoped.client.get('/ledger/reconciliation')).body.error.code).toBe('company_scope_required');
    expect((await scoped.client.get(`/cash/accounts/${mainBox.id}/book`)).status).toBe(200);
    expect((await scoped.client.get(`/cash/accounts/${northBox.id}/book`)).status).toBe(403);
    // Visible: the transfer touches the caller's branch. Hidden: one strictly between other-branch accounts.
    const northBox2 = await account(c, { branchId: b2.body.id });
    const northOnly = await transfer(c, { fromAccountId: northBox.id, toAccountId: northBox2.id, amount: '50.00' });
    const visible = (await scoped.client.get('/cash/transfers?pageSize=200')).body.items.map((i: { transferId: string }) => i.transferId);
    expect(visible).toContain(inter.body.transferId);
    expect(visible).not.toContain(northOnly.body.transferId);
    expect((await scoped.client.get(`/cash/transfers/${northOnly.body.transferId}`)).status).toBe(403);
    expect((await transfer(scoped.client, { fromAccountId: northBox.id, toAccountId: mainBox.id, amount: '10.00' })).status).toBe(403);
    expect((await scoped.client.post(`/cash/transfers/${inter.body.transferId}/reverse`, { reason: 'Mistake' }, idem())).status).toBe(403);
  });

  it("tenant isolation: another company's ledger, transfers and cash book are invisible", async () => {
    const other = await createTenant(app, admin);
    const oBox = await account(other.owner, { openingBalance: '7777.00' });
    const oBank = await account(other.owner, { type: 'bank' });
    const oTr = await transfer(other.owner, { fromAccountId: oBox.id, toAccountId: oBank.id, amount: '777.00' });
    expect(oTr.status).toBe(201);
    const oEntry = (await pool.query(`SELECT id FROM journal_entries WHERE tenant_id = $1 AND source_id = $2`, [other.tenantId, oTr.body.transferId])).rows[0].id;

    const c = t.owner;
    expect((await c.get(`/ledger/entries/${oEntry}`)).status).toBe(404);
    expect((await c.get(`/cash/transfers/${oTr.body.transferId}`)).status).toBe(404);
    expect((await c.post(`/cash/transfers/${oTr.body.transferId}/reverse`, { reason: 'Steal' }, idem())).status).toBe(404);
    expect((await c.get(`/cash/accounts/${oBox.id}/book`)).status).toBe(404);
    const own = await account(c, { openingBalance: '100.00' });
    expect((await transfer(c, { fromAccountId: own.id, toAccountId: oBox.id, amount: '10.00' })).status).toBe(404);
    expect((await c.get(`/ledger/entries?cashAccountId=${oBox.id}`)).body.total).toBe(0);
    const list = (await c.get('/cash/transfers?pageSize=200')).body.items.map((i: { transferId: string }) => i.transferId);
    expect(list).not.toContain(oTr.body.transferId);

    // Reports only see the caller's company.
    const tb = await c.get('/ledger/trial-balance');
    const cash = tb.body.rows.find((r: { code: string }) => r.code === '1100');
    expect(cash.closing).toBe(await gl(pool, t.tenantId, '1100'));
    const rec = await c.get('/ledger/reconciliation');
    const cashSec = rec.body.sections.find((s: { name: string }) => s.name === 'cash');
    expect(cashSec.glTotal).toBe(await gl(pool, t.tenantId, '1100'));
    expect(rec.body.ok).toBe(true);
    const otherTb = await other.owner.get('/ledger/trial-balance');
    expect(otherTb.body.rows.find((r: { code: string }) => r.code === '1100').closing).toBe('7777.00');
  });
});
