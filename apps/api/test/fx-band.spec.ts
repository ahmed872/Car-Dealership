import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMemberWithPermissions,
  assertLedgerIntegrity,
  catalogIds,
  costCategory,
  createCashAccount,
  createCustomer,
  createSupplier,
  createVehicle,
  glBalance,
  makeAvailable,
  secondApprover,
  setFxReferences,
} from './fixtures';
import { Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant, uniq } from './helpers';

/**
 * F6: a stated exchange rate must lie within the company's tolerance band around its reference
 * rate for the currency (company settings), or a small foreign receipt could become a large
 * base-currency credit and be refunded in cash. Also: settings PATCH semantics and audit for the
 * reference rates, and the refund approver seeing the currency and rate the money came in at.
 */
describe('FX reference rates and tolerance band (F6)', () => {
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

  async function counts(tenantId: string) {
    const r = await pool.query(
      `SELECT (SELECT count(*) FROM journal_entries WHERE tenant_id = $1)::int AS entries,
              (SELECT count(*) FROM cash_transactions WHERE tenant_id = $1)::int AS "cashRows",
              (SELECT count(*) FROM receipts WHERE tenant_id = $1)::int AS receipts`,
      [tenantId],
    );
    return r.rows[0] as { entries: number; cashRows: number; receipts: number };
  }

  const receipt = (c: Client, body: { customerId: string; cashAccountId: string; amount: string; exchangeRate?: string }) =>
    c.post('/receipts', { method: 'bank_transfer', ...body }, idem());

  it('a foreign receipt without a company reference rate is refused (fx_reference_missing) and posts nothing', async () => {
    const t = await createTenant(app, admin);
    const usd = await createCashAccount(t.owner, { type: 'bank', currency: 'USD' });
    const cust = await createCustomer(t.owner);
    const before = await counts(t.tenantId);

    const res = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '100.00', exchangeRate: '3.75' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('fx_reference_missing');
    expect(res.body.error.message).toContain('USD');
    expect(res.body.error.message).toContain('company settings');
    expect(res.body.error.details).toMatchObject({ currency: 'USD' });
    // Omitting the rate still asks for the rate (no silent default to a reference).
    const noRate = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '100.00' });
    expect(noRate.status).toBe(422);
    expect(noRate.body.error.code).toBe('exchange_rate_required');
    expect(await counts(t.tenantId)).toEqual(before);
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  it('within the band a receipt posts at the stated rate with exact base amounts; the bounds are inclusive', async () => {
    const t = await createTenant(app, admin);
    expect(await setFxReferences(t.owner, { USD: '3.75' })).toEqual({ referenceRates: { USD: '3.75' }, maxDeviationPct: '2' });
    const usd = await createCashAccount(t.owner, { type: 'bank', currency: 'USD' });
    const cust = await createCustomer(t.owner);

    const ok = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '100.00', exchangeRate: '3.80' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ amount: '100.00', currency: 'USD', exchangeRate: '3.80000000', amountBase: '380.00' });
    // 3.75 ± 2 % = [3.675, 3.825], both ends included.
    const high = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '10.00', exchangeRate: '3.825' });
    expect(high.status, JSON.stringify(high.body)).toBe(201);
    expect(high.body.amountBase).toBe('38.25');
    const low = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '10.00', exchangeRate: '3.675' });
    expect(low.status, JSON.stringify(low.body)).toBe(201);
    expect(low.body.amountBase).toBe('36.75');
    for (const rate of ['3.8251', '3.6749']) {
      const out = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '10.00', exchangeRate: rate });
      expect(out.status).toBe(422);
      expect(out.body.error.code).toBe('fx_rate_out_of_band');
    }
    expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust.id })).toBe('-455.00');
    expect(await glBalance(pool, t.tenantId, '1100', { col: 'cash_account_id', id: usd.id })).toBe('455.00');
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  it('the F6 path: 1.00 USD at 100000 is refused, nothing is posted, and there is no credit to refund', async () => {
    const t = await createTenant(app, admin);
    await setFxReferences(t.owner, { USD: '3.75' });
    const usd = await createCashAccount(t.owner, { type: 'bank', currency: 'USD' });
    const cust = await createCustomer(t.owner);
    const insider = (await addMemberWithPermissions(app, t, ['payments.read', 'payments.receive', 'refunds.create'])).client;
    const before = await counts(t.tenantId);

    const res = await receipt(insider, { customerId: cust.id, cashAccountId: usd.id, amount: '1.00', exchangeRate: '100000' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('fx_rate_out_of_band');
    expect(res.body.error.details).toMatchObject({ currency: 'USD', reference: '3.75', maxDeviationPct: '2' });
    expect(await counts(t.tenantId)).toEqual(before);
    expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust.id })).toBe('0.00');
    expect(await glBalance(pool, t.tenantId, '1100', { col: 'cash_account_id', id: usd.id })).toBe('0.00');

    const refund = await insider.post('/refunds', { sourceType: 'customer_credit', sourceId: cust.id, amountBase: '100000.00', reason: 'Customer asked' }, idem());
    expect(refund.status).toBe(409);
    expect(refund.body.error.code).toBe('refund_exceeds_available');
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  it('every foreign-currency entry point applies the band, including the rate implied by a transfer amount', async () => {
    const t = await createTenant(app, admin);
    const c = t.owner;
    await setFxReferences(c, { USD: '3.75' });
    const usd = await createCashAccount(c, { type: 'bank', name: uniq('USD '), currency: 'USD', openingBalance: '1000.00', exchangeRate: '3.75' });
    const sar = await createCashAccount(c, { type: 'bank', openingBalance: '50000.00' });
    const supplier = await createSupplier(c);
    const rent = ((await c.get('/expense-categories')).body as Array<{ id: string; code: string }>).find((x) => x.code === 'rent')!.id;
    const transport = await costCategory(c, 'transport');
    const [v1, v2] = [await createVehicle(c, t.branchId), await createVehicle(c, t.branchId)];
    const forSale = await createVehicle(c, t.branchId);
    await makeAvailable(c, forSale.id, '120000.00', '100000.00');
    const cust = await createCustomer(c);
    // A real SAR payable of 50.00: 10 USD at 5 would match it exactly, if the rate were accepted.
    const payable = await c.post('/expenses', { branchId: t.branchId, categoryId: rent, description: 'Rent', amount: '50.00', currency: 'SAR', expenseDate: '2026-02-01', supplierId: supplier.id }, idem());
    expect(payable.status, JSON.stringify(payable.body)).toBe(201);
    const before = await counts(t.tenantId);

    const bad = '5'; // 33 % above the 3.75 reference
    const attempts: Array<[string, () => Promise<{ status: number; body: { error?: { code: string } } }>]> = [
      ['opening balance', () => c.post('/cash-accounts', { type: 'bank', name: 'USD at 5', currency: 'USD', openingBalance: '10.00', openingDate: '2026-01-01', exchangeRate: bad }, idem())],
      ['expense', () => c.post('/expenses', { branchId: t.branchId, categoryId: rent, description: 'Rent', amount: '10.00', currency: 'USD', exchangeRate: bad, expenseDate: '2026-02-01' }, idem())],
      ['vehicle cost', () => c.post('/vehicle-costs', { vehicleId: v1.id, categoryId: transport, description: 'Tow', amount: '10.00', currency: 'USD', exchangeRate: bad, costDate: '2026-02-01' }, idem())],
      [
        'cost allocation',
        () => c.post('/vehicle-costs/allocate', { vehicleIds: [v1.id, v2.id], method: 'equal', categoryId: transport, description: 'Carrier', totalAmount: '10.00', currency: 'USD', exchangeRate: bad, costDate: '2026-02-01' }, idem()),
      ],
      [
        'acquisition',
        async () => {
          const ids = await catalogIds(c);
          const vehicle = { ...ids, modelYear: 2022, odometerValue: 40000, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'White' };
          return c.post('/acquisitions', { branchId: t.branchId, supplierId: supplier.id, sourceType: 'company', purchaseDate: '2026-01-15', purchasePrice: '1000.00', currency: 'USD', exchangeRate: bad, submit: false, vehicle }, idem());
        },
      ],
      [
        'supplier payment',
        () =>
          c.post(
            '/supplier-payments',
            { supplierId: supplier.id, cashAccountId: usd.id, paidAt: '2026-02-02', method: 'bank_transfer', amount: '10.00', exchangeRate: bad, allocations: [{ targetType: 'expense', targetId: payable.body.id, amountBase: '50.00' }] },
            idem(),
          ),
      ],
      ['reservation deposit', () => c.post('/reservations', { vehicleId: forSale.id, customerId: cust.id, deposit: { cashAccountId: usd.id, amount: '10.00', method: 'bank_transfer', exchangeRate: bad } }, idem())],
      ['transfer from USD', () => c.post('/cash/transfers', { fromAccountId: usd.id, toAccountId: sar.id, amount: '10.00', exchangeRate: bad, date: '2026-02-03' }, idem())],
      // 100.00 SAR for 1.00 USD implies 100 SAR per USD: the destination rate is checked too.
      ['transfer to USD', () => c.post('/cash/transfers', { fromAccountId: sar.id, toAccountId: usd.id, amount: '100.00', amountTo: '1.00', date: '2026-02-03' }, idem())],
    ];
    for (const [name, attempt] of attempts) {
      const res = await attempt();
      expect([name, res.status, res.body.error?.code]).toEqual([name, 422, 'fx_rate_out_of_band']);
    }
    expect(await counts(t.tenantId)).toEqual(before);
    expect((await pool.query(`SELECT count(*)::int AS n FROM cash_accounts WHERE tenant_id = $1 AND name = 'USD at 5'`, [t.tenantId])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM reservations WHERE tenant_id = $1`, [t.tenantId])).rows[0].n).toBe(0);
    expect((await c.get(`/vehicles/${forSale.id}`)).body.vehicle.status).toBe('available');

    // The same transfers at in-band rates go through.
    const toUsd = await c.post('/cash/transfers', { fromAccountId: sar.id, toAccountId: usd.id, amount: '375.00', amountTo: '100.00', date: '2026-02-03' }, idem());
    expect(toUsd.status, JSON.stringify(toUsd.body)).toBe(201);
    expect(toUsd.body).toMatchObject({ to: { amount: '100.00', currency: 'USD', exchangeRate: '3.75000000' } });
    const fromUsd = await c.post('/cash/transfers', { fromAccountId: usd.id, toAccountId: sar.id, amount: '10.00', exchangeRate: '3.76', date: '2026-02-04' }, idem());
    expect(fromUsd.status, JSON.stringify(fromUsd.body)).toBe(201);
    expect(fromUsd.body.amountBase).toBe('37.60');
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  it('a purchase recorded in band can still be approved after the reference moves; re-pricing it needs a current rate', async () => {
    const t = await createTenant(app, admin);
    const c = t.owner;
    await setFxReferences(c, { USD: '3.75' });
    const supplier = await createSupplier(c);
    const ids = await catalogIds(c);
    const vehicle = { ...ids, modelYear: 2022, odometerValue: 40000, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'White' };
    const acq = (submit: boolean) =>
      c.post('/acquisitions', { branchId: t.branchId, supplierId: supplier.id, sourceType: 'company', purchaseDate: '2026-01-15', purchasePrice: '10000.00', currency: 'USD', exchangeRate: '3.75', submit, vehicle }, idem());
    const pending = await acq(true);
    expect(pending.status, JSON.stringify(pending.body)).toBe(201);
    const draft = await acq(false);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);

    // The reference moves to 3.90: 3.75 is now 3.85 % away, outside the 2 % band.
    await setFxReferences(c, { USD: '3.90' });
    expect((await acq(false)).body.error.code).toBe('fx_rate_out_of_band');
    // Approval books the stored base of the purchase as recorded; it does not re-judge its rate.
    const ap = await (await secondApprover(c)).post(`/acquisitions/${pending.body.id}/approve`, {}, idem());
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: pending.body.vehicleId })).toBe('37500.00');
    // A new price is a new conversion: the stored 3.75 no longer passes, a current rate does.
    const reprice = await c.patch(`/acquisitions/${draft.body.id}`, { version: draft.body.version, purchasePrice: '10001.00' });
    expect(reprice.status).toBe(422);
    expect(reprice.body.error.code).toBe('fx_rate_out_of_band');
    const current = await c.patch(`/acquisitions/${draft.body.id}`, { version: draft.body.version, purchasePrice: '10001.00', exchangeRate: '3.90' });
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    expect(current.body).toMatchObject({ exchangeRate: '3.90000000', purchasePriceBase: '39003.90' });
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  it('reference rates: the base currency, non-positive rates, unknown currencies and bad tolerances are refused', async () => {
    const t = await createTenant(app, admin);
    await setFxReferences(t.owner, { USD: '3.75' });
    const before = (await t.owner.get('/company')).body.settings;
    const patchFx = (fx: Record<string, unknown>) => t.owner.patch('/company', { settings: { fx } });

    const base = await patchFx({ referenceRates: { USD: '3.75', SAR: '1' } });
    expect(base.status).toBe(422);
    expect(base.body.error).toMatchObject({ code: 'fx_reference_base_currency', details: { currency: 'SAR' } });
    for (const fx of [
      { referenceRates: { USD: '0' } },
      { referenceRates: { USD: '-3.75' } },
      { referenceRates: { USD: 'abc' } },
      { referenceRates: { GBP: '4.70' } },
      { maxDeviationPct: '-1' },
      { maxDeviationPct: '100.01' },
    ]) {
      const res = await patchFx(fx);
      expect([JSON.stringify(fx), res.status, res.body.error?.code]).toEqual([JSON.stringify(fx), 422, 'validation_failed']);
    }
    expect((await t.owner.get('/company')).body.settings).toEqual(before);

    // An Egyptian company's base currency is EGP: it cannot have a reference either; SAR can.
    const eg = await createTenant(app, admin, { market: 'EG' });
    const egBase = await eg.owner.patch('/company', { settings: { fx: { referenceRates: { EGP: '1' } } } });
    expect(egBase.status).toBe(422);
    expect(egBase.body.error.code).toBe('fx_reference_base_currency');
    expect(await setFxReferences(eg.owner, { SAR: '13.2', USD: '49.5' })).toEqual({ referenceRates: { SAR: '13.2', USD: '49.5' }, maxDeviationPct: '2' });
  });

  it('a settings PATCH of fx keeps every other setting, other PATCHes keep fx, and every change is audited with before/after', async () => {
    const t = await createTenant(app, admin);
    const o = t.owner;
    const get = async () => (await o.get('/company')).body.settings as Record<string, unknown> & { fx: unknown; reservation: Record<string, unknown> };
    const without = (s: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== key));
    const initial = await get();
    expect(initial.fx).toEqual({ referenceRates: {}, maxDeviationPct: '2' });

    // Only settings.manage may change the reference rates.
    const viewer = (await addMemberWithPermissions(app, t, ['settings.read', 'payments.read'])).client;
    expect((await viewer.patch('/company', { settings: { fx: { referenceRates: { USD: '3.75' } } } })).status).toBe(403);

    const set = await o.patch('/company', { settings: { fx: { referenceRates: { USD: '3.75', EUR: '4.05' }, maxDeviationPct: '1.5' } } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const s1 = await get();
    expect(s1.fx).toEqual({ referenceRates: { USD: '3.75', EUR: '4.05' }, maxDeviationPct: '1.5' });
    expect(without(s1, 'fx')).toEqual(without(initial, 'fx'));

    // One fx field: the other is kept (no default re-applied).
    expect((await o.patch('/company', { settings: { fx: { maxDeviationPct: '2.5' } } })).status).toBe(200);
    expect((await get()).fx).toEqual({ referenceRates: { USD: '3.75', EUR: '4.05' }, maxDeviationPct: '2.5' });

    // Another section: fx is kept, and so are the section's own fields that were not sent.
    expect((await o.patch('/company', { settings: { reservation: { defaultRefundPolicy: 'non_refundable' } } })).status).toBe(200);
    expect((await o.patch('/company', { settings: { reservation: { defaultDays: 10 } } })).status).toBe(200);
    const s2 = await get();
    expect(s2.fx).toEqual({ referenceRates: { USD: '3.75', EUR: '4.05' }, maxDeviationPct: '2.5' });
    expect(s2.reservation).toEqual({ ...initial.reservation, defaultDays: 10, defaultRefundPolicy: 'non_refundable' });

    // The map is replaced whole: sending it without USD removes USD.
    expect((await o.patch('/company', { settings: { fx: { referenceRates: { EUR: '4.05' } } } })).status).toBe(200);
    expect((await get()).fx).toEqual({ referenceRates: { EUR: '4.05' }, maxDeviationPct: '2.5' });

    const audit = await pool.query(
      `SELECT summary, before, after FROM audit_logs WHERE tenant_id = $1 AND action = 'company.updated' AND entity_type = 'tenant' ORDER BY seq`,
      [t.tenantId],
    );
    const fxChanges = audit.rows.filter((r) => JSON.stringify(r.before?.settings?.fx) !== JSON.stringify(r.after?.settings?.fx));
    expect(fxChanges.map((r) => [r.summary, r.before.settings.fx, r.after.settings.fx])).toEqual([
      ['Settings changed: fx', { referenceRates: {}, maxDeviationPct: '2' }, { referenceRates: { USD: '3.75', EUR: '4.05' }, maxDeviationPct: '1.5' }],
      ['Settings changed: fx', { referenceRates: { USD: '3.75', EUR: '4.05' }, maxDeviationPct: '1.5' }, { referenceRates: { USD: '3.75', EUR: '4.05' }, maxDeviationPct: '2.5' }],
      ['Settings changed: fx', { referenceRates: { USD: '3.75', EUR: '4.05' }, maxDeviationPct: '2.5' }, { referenceRates: { EUR: '4.05' }, maxDeviationPct: '2.5' }],
    ]);
    expect(audit.rows.map((r) => r.summary)).toContain('Settings changed: reservation');
  });

  it('a company whose stored settings predate fx reads the defaults, refuses foreign amounts, and keeps fx on its next PATCH', async () => {
    const t = await createTenant(app, admin);
    await pool.query(`UPDATE tenants SET settings = settings - 'fx' WHERE id = $1`, [t.tenantId]);
    const company = await t.owner.get('/company');
    expect(company.body.settings.fx).toEqual({ referenceRates: {}, maxDeviationPct: '2' });
    const usd = await createCashAccount(t.owner, { type: 'bank', currency: 'USD' });
    const cust = await createCustomer(t.owner);
    const res = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '10.00', exchangeRate: '3.75' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('fx_reference_missing');
    expect((await t.owner.patch('/company', { settings: { locale: 'en' } })).status).toBe(200);
    const stored = await pool.query(`SELECT settings FROM tenants WHERE id = $1`, [t.tenantId]);
    expect(stored.rows[0].settings).toMatchObject({ locale: 'en', fx: { referenceRates: {}, maxDeviationPct: '2' } });
    await setFxReferences(t.owner, { USD: '3.75' });
    const ok = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '10.00', exchangeRate: '3.75' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await assertLedgerIntegrity(pool, t.tenantId);
  });

  describe('refund approval shows where the money came from', () => {
    let t: TestTenant;
    let checker: Client;
    let usd: { id: string };
    let sar: { id: string };

    beforeAll(async () => {
      t = await createTenant(app, admin);
      await setFxReferences(t.owner, { USD: '3.75' });
      checker = await secondApprover(t.owner);
      usd = await createCashAccount(t.owner, { type: 'bank', currency: 'USD' });
      sar = await createCashAccount(t.owner, { type: 'bank', openingBalance: '20000.00' });
    });

    async function inboxItem(refundId: string) {
      const inbox = await checker.get('/approvals');
      expect(inbox.status).toBe(200);
      return (inbox.body as Array<{ entityId: string; summary: string; payload: Record<string, unknown> }>).find((i) => i.entityId === refundId)!;
    }

    it('customer credit received in USD: GET /refunds/:id and the approval inbox carry the currency, amount and rate', async () => {
      const cust = await createCustomer(t.owner);
      const rc = await receipt(t.owner, { customerId: cust.id, cashAccountId: usd.id, amount: '1000.00', exchangeRate: '3.75' });
      expect(rc.status, JSON.stringify(rc.body)).toBe(201);
      const req = await t.owner.post('/refunds', { sourceType: 'customer_credit', sourceId: cust.id, amountBase: '3750.00', reason: 'Deal fell through' }, idem());
      expect(req.status, JSON.stringify(req.body)).toBe(201);

      const detail = await checker.get(`/refunds/${req.body.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ amountBase: '3750.00', status: 'requested' });
      expect(detail.body.sourceFunds).toEqual({
        baseCurrency: 'SAR',
        foreignCurrency: true,
        receipts: [
          {
            receiptId: rc.body.id,
            number: rc.body.number,
            receivedAt: rc.body.receivedAt,
            targetType: 'customer_credit',
            currency: 'USD',
            amount: '1000.00',
            exchangeRate: '3.75000000',
            amountBase: '3750.00',
            allocatedBase: '3750.00',
          },
        ],
      });

      const item = await inboxItem(req.body.id);
      expect(item.summary).toContain('3750.00 SAR');
      expect(item.summary).toContain('1000.00 USD @ 3.75');
      expect(item.payload.foreignReceipts).toEqual([{ number: rc.body.number, currency: 'USD', amount: '1000.00', exchangeRate: '3.75000000', amountBase: '3750.00' }]);

      // The approval and payout still work as before.
      expect((await checker.post(`/refunds/${req.body.id}/approve`, { note: 'Checked the USD receipt' })).status).toBe(200);
      const paid = await t.owner.post(`/refunds/${req.body.id}/pay`, { cashAccountId: sar.id, method: 'bank_transfer' }, idem());
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust.id })).toBe('0.00');
      await assertLedgerIntegrity(pool, t.tenantId);
    });

    it('a reservation deposit taken in USD shows on the refund its cancellation opens', async () => {
      const cust = await createCustomer(t.owner);
      const v = await createVehicle(t.owner, t.branchId);
      await makeAvailable(t.owner, v.id, '120000.00', '100000.00');
      const r = await t.owner.post(
        '/reservations',
        { vehicleId: v.id, customerId: cust.id, deposit: { cashAccountId: usd.id, amount: '100.00', method: 'bank_transfer', exchangeRate: '3.76' } },
        idem(),
      );
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.depositAmount).toBe('376.00');
      const cancel = await t.owner.post(`/reservations/${r.body.id}/cancel`, { reason: 'Customer changed mind', refund: 'per_policy' }, idem());
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      const refundId = cancel.body.refund.id as string;
      const detail = await checker.get(`/refunds/${refundId}`);
      expect(detail.body.sourceFunds).toMatchObject({
        foreignCurrency: true,
        receipts: [{ number: r.body.receipt.number, targetType: 'reservation', currency: 'USD', amount: '100.00', exchangeRate: '3.76000000', amountBase: '376.00', allocatedBase: '376.00' }],
      });
      expect((await inboxItem(refundId)).payload.foreignReceipts).toEqual([
        { number: r.body.receipt.number, currency: 'USD', amount: '100.00', exchangeRate: '3.76000000', amountBase: '376.00' },
      ]);
    });

    it('money received in the base currency is shown as such, with no foreign note', async () => {
      const cust = await createCustomer(t.owner);
      const rc = await receipt(t.owner, { customerId: cust.id, cashAccountId: sar.id, amount: '500.00' });
      expect(rc.status).toBe(201);
      const req = await t.owner.post('/refunds', { sourceType: 'customer_credit', sourceId: cust.id, amountBase: '500.00', reason: 'Overpaid' }, idem());
      expect(req.status).toBe(201);
      const detail = await checker.get(`/refunds/${req.body.id}`);
      expect(detail.body.sourceFunds).toMatchObject({ foreignCurrency: false, receipts: [{ currency: 'SAR', amount: '500.00', exchangeRate: '1.00000000', amountBase: '500.00' }] });
      const item = await inboxItem(req.body.id);
      expect(item.summary).not.toContain('@');
      expect(item.payload.foreignReceipts).toBeUndefined();
    });
  });

  it('cross-tenant: another company’s reference rates never apply, and its refunds stay invisible', async () => {
    const a = await createTenant(app, admin);
    const b = await createTenant(app, admin);
    // B configures USD at 100000 for itself (its own business, audited in B).
    await setFxReferences(b.owner, { USD: '100000' });
    const usdA = await createCashAccount(a.owner, { type: 'bank', currency: 'USD' });
    const usdB = await createCashAccount(b.owner, { type: 'bank', currency: 'USD' });
    const custA = await createCustomer(a.owner);
    const custB = await createCustomer(b.owner);

    const aMissing = await receipt(a.owner, { customerId: custA.id, cashAccountId: usdA.id, amount: '1.00', exchangeRate: '100000' });
    expect(aMissing.status).toBe(422);
    expect(aMissing.body.error.code).toBe('fx_reference_missing');
    const bOk = await receipt(b.owner, { customerId: custB.id, cashAccountId: usdB.id, amount: '1.00', exchangeRate: '100000' });
    expect(bOk.status, JSON.stringify(bOk.body)).toBe(201);

    await setFxReferences(a.owner, { USD: '3.75' });
    const aOut = await receipt(a.owner, { customerId: custA.id, cashAccountId: usdA.id, amount: '1.00', exchangeRate: '100000' });
    expect(aOut.status).toBe(422);
    expect(aOut.body.error).toMatchObject({ code: 'fx_rate_out_of_band', details: { reference: '3.75', maxDeviationPct: '2' } });
    expect((await b.owner.get('/company')).body.settings.fx.referenceRates).toEqual({ USD: '100000' });
    // A cannot reach B's cash account (so B's policy can never be used for A's money).
    const viaB = await receipt(a.owner, { customerId: custA.id, cashAccountId: usdB.id, amount: '1.00', exchangeRate: '100000' });
    expect(viaB.status).toBe(404);

    const aOk = await receipt(a.owner, { customerId: custA.id, cashAccountId: usdA.id, amount: '10.00', exchangeRate: '3.75' });
    expect(aOk.status).toBe(201);
    const refund = await a.owner.post('/refunds', { sourceType: 'customer_credit', sourceId: custA.id, amountBase: '37.50', reason: 'Refund' }, idem());
    expect(refund.status).toBe(201);
    expect((await b.owner.get(`/refunds/${refund.body.id}`)).status).toBe(404);
    await assertLedgerIntegrity(pool, a.tenantId);
    await assertLedgerIntegrity(pool, b.tenantId);
  });
});
