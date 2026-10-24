import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sum } from '@autohub/shared';
import { catalogIds, costCategory, createCashAccount, createSupplier, secondApprover } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

/** Credit-positive balance of GL 2000 (amount owed to suppliers), optionally up to a date / for one supplier. */
async function gl2000(pool: Pool, tenantId: string, opts: { asOf?: string; supplierId?: string } = {}) {
  const r = await pool.query(
    `SELECT coalesce(sum(jl.credit - jl.debit), 0)::numeric(18,2)::text AS b
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.tenant_id = $1 AND jl.account_code = '2000'
        AND ($2::date IS NULL OR je.entry_date <= $2::date)
        AND ($3::uuid IS NULL OR jl.supplier_id = $3::uuid)`,
    [tenantId, opts.asOf ?? null, opts.supplierId ?? null],
  );
  return r.rows[0].b as string;
}

async function ledgerBalanced(pool: Pool, tenantId: string) {
  const r = await pool.query(`SELECT coalesce(sum(debit),0)::text AS dr, coalesce(sum(credit),0)::text AS cr FROM journal_lines WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0].dr === r.rows[0].cr;
}

/** Records and approves a purchase with explicit dates (the shared fixture uses fixed dates). */
async function acquire(c: Client, branchId: string, supplierId: string, o: { price: string; purchaseDate: string; dueDate?: string | null }) {
  const ids = await catalogIds(c);
  const res = await c.post(
    '/acquisitions',
    {
      branchId,
      supplierId,
      sourceType: 'company',
      purchaseDate: o.purchaseDate,
      purchasePrice: o.price,
      currency: 'SAR',
      dueDate: o.dueDate ?? null,
      submit: true,
      vehicle: { ...ids, modelYear: 2021, odometerValue: 30000, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'Black' },
    },
    idem(),
  );
  if (res.status !== 201) throw new Error(`acquisition failed ${res.status} ${JSON.stringify(res.body)}`);
  const ap = await (await secondApprover(c)).post(`/acquisitions/${res.body.id}/approve`, {}, idem());
  if (ap.status !== 200) throw new Error(`approve failed ${ap.status} ${JSON.stringify(ap.body)}`);
  return res.body as { id: string; number: string; vehicleId: string; vehicle: { id: string; stockNumber: string } };
}

async function addCost(c: Client, o: { vehicleId: string; categoryId: string; amount: string; costDate: string; supplierId: string | null; description?: string }) {
  const res = await c.post(
    '/vehicle-costs',
    { vehicleId: o.vehicleId, categoryId: o.categoryId, description: o.description ?? 'Vehicle cost', amount: o.amount, currency: 'SAR', costDate: o.costDate, supplierId: o.supplierId },
    idem(),
  );
  if (res.status !== 201) throw new Error(`cost failed ${res.status} ${JSON.stringify(res.body)}`);
  expect(res.body.status).toBe('posted');
  return res.body as { id: string };
}

type Alloc = { targetType: 'acquisition' | 'vehicle_cost' | 'expense'; targetId: string; amountBase: string };
function pay(c: Client, o: { supplierId: string | null; cashAccountId: string; paidAt: string; amount: string; allocations: Alloc[] }, headers = idem()) {
  return c.post('/supplier-payments', { method: 'cash', ...o }, headers);
}

describe('suppliers 360, statements and accounts payable', () => {
  let app: INestApplication;
  let admin: Client;
  let t: TestTenant;
  let other: TestTenant;
  let pool: Pool;

  beforeAll(async () => {
    app = await getApp();
    admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
    pool = ownerPool();
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  describe('supplier records', () => {
    it('creates, validates, updates and audits suppliers; accountant manages, sales rep is refused', async () => {
      const accountant = (await addMember(app, t, 'accountant')).client;
      const rep = (await addMember(app, t, 'sales_rep')).client;

      const created = await accountant.post('/suppliers', { type: 'workshop', name: 'Gulf Body Shop', phone: '+966 55 000 1111', email: 'shop@example.com', city: 'Riyadh' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'Gulf Body Shop', type: 'workshop', isActive: true, tenantId: t.tenantId });
      const id = created.body.id as string;

      // Validation errors carry the field path.
      const bad = [
        [{ type: 'company', name: 'A' }, 'name'],
        [{ type: 'bogus', name: 'Valid Name' }, 'type'],
        [{ type: 'company', name: 'Valid Name', phone: 'call me' }, 'phone'],
        [{ type: 'company', name: 'Valid Name', email: 'not-an-email' }, 'email'],
      ] as const;
      for (const [body, path] of bad) {
        const r = await accountant.post('/suppliers', body);
        expect(r.status).toBe(422);
        expect(r.body.error.code).toBe('validation_failed');
        expect(r.body.error.details.issues.map((i: { path: string }) => i.path)).toContain(path);
      }
      expect((await accountant.patch(`/suppliers/${id}`, {})).status).toBe(422);

      // Deactivate, then an unrelated edit must NOT silently reactivate it.
      const off = await accountant.patch(`/suppliers/${id}`, { isActive: false });
      expect(off.status).toBe(200);
      expect(off.body.isActive).toBe(false);
      const renamed = await accountant.patch(`/suppliers/${id}`, { name: 'Gulf Body Shop LLC', email: '' });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ name: 'Gulf Body Shop LLC', isActive: false, email: null, phone: '+966 55 000 1111' });

      const list = await accountant.get('/suppliers?active=false&q=Gulf');
      expect(list.status).toBe(200);
      expect(list.body.items.map((s: { id: string }) => s.id)).toContain(id);

      const one = await accountant.get(`/suppliers/${id}`);
      expect(one.status).toBe(200);
      expect(one.body.summary).toEqual({ currency: 'SAR', outstandingBase: '0.00', totalPurchasedBase: '0.00', totalPaidBase: '0.00', lastPaymentDate: null, openDocuments: 0 });

      const audit = await pool.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_type = 'supplier' AND entity_id = $2 ORDER BY seq`, [t.tenantId, id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['supplier.created', 'supplier.deactivated', 'supplier.updated']);

      // Sales reps have no supplier permissions at all.
      expect((await rep.get('/suppliers')).status).toBe(403);
      expect((await rep.get(`/suppliers/${id}`)).status).toBe(403);
      expect((await rep.post('/suppliers/check-duplicates', { name: 'x' })).status).toBe(403);
      expect((await rep.get(`/suppliers/${id}/statement`)).status).toBe(403);
      const denied = await rep.post('/suppliers', { type: 'company', name: 'Sneaky Supplier' });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.missing).toContain('suppliers.manage');
      expect((await rep.patch(`/suppliers/${id}`, { name: 'Hijack' })).status).toBe(403);

      // Bad and unknown ids.
      expect((await accountant.get('/suppliers/not-a-uuid')).status).toBe(400);
      expect((await accountant.get('/suppliers/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });

    it('hides the money summary and statement from users without payments.read', async () => {
      const inv = (await addMember(app, t, 'inventory_manager')).client;
      const s = await createSupplier(inv);
      const r = await inv.get(`/suppliers/${s.id}`);
      expect(r.status).toBe(200);
      expect(r.body.summary).toBeNull();
      const st = await inv.get(`/suppliers/${s.id}/statement`);
      expect(st.status).toBe(403);
      expect(st.body.error.details.missing).toEqual(['payments.read']);
      expect((await inv.get(`/payables/open?supplierId=${s.id}`)).status).toBe(403);
    });

    it('another tenant cannot read, edit or get a statement for the supplier (404)', async () => {
      const s = await createSupplier(t.owner, { taxNumber: 'XT-998877' });
      expect((await other.owner.get(`/suppliers/${s.id}`)).status).toBe(404);
      expect((await other.owner.patch(`/suppliers/${s.id}`, { name: 'Taken over' })).status).toBe(404);
      expect((await other.owner.get(`/suppliers/${s.id}/statement`)).status).toBe(404);
      const dup = await other.owner.post('/suppliers/check-duplicates', { taxNumber: 'XT-998877' });
      expect(dup.status).toBe(200);
      expect(dup.body).toEqual([]);
      const open = await other.owner.get(`/payables/open?supplierId=${s.id}`);
      expect(open.status).toBe(200);
      expect(open.body.items).toEqual([]);
      expect((await t.owner.get(`/suppliers/${s.id}`)).body.name).toBe(s.name);
    });

    it('finds possible duplicates by phone, tax number, national id and name', async () => {
      const c = t.owner;
      const s = await createSupplier(c, { type: 'individual', name: 'Al Noor  Motors', phone: '+966 50 123 4567', taxNumber: '300123456700003', nationalId: '1012345678' });
      const other1 = await createSupplier(c, { name: 'Unrelated Trading' });
      const check = (body: Record<string, unknown>) => c.post('/suppliers/check-duplicates', body);

      const byPhone = await check({ phone: '+966501234567' });
      expect(byPhone.status).toBe(200);
      expect(byPhone.body).toEqual([{ id: s.id, name: 'Al Noor  Motors', type: 'individual', phone: '+966 50 123 4567', isActive: true, matchedOn: ['phone'] }]);
      // Arabic-Indic digits are the same number.
      const arabic = await check({ phone: '+٩٦٦٥٠١٢٣٤٥٦٧' });
      expect(arabic.body.map((x: { id: string }) => x.id)).toEqual([s.id]);

      const byTax = await check({ taxNumber: ' 300123456700003 ' });
      expect(byTax.body).toHaveLength(1);
      expect(byTax.body[0].matchedOn).toEqual(['taxNumber']);
      // Identifier values are never echoed back.
      expect(byTax.body[0]).not.toHaveProperty('taxNumber');
      expect(byTax.body[0]).not.toHaveProperty('nationalId');

      const byNid = await check({ nationalId: '1012345678' });
      expect(byNid.body[0].matchedOn).toEqual(['nationalId']);

      const byName = await check({ name: '  al noor motors ' });
      expect(byName.body.map((x: { id: string }) => x.id)).toEqual([s.id]);

      const all = await check({ name: 'AL NOOR MOTORS', taxNumber: '300123456700003', phone: '0000000' });
      expect(all.body[0].matchedOn).toEqual(['taxNumber', 'name']);

      // Editing the supplier itself is not a duplicate; near misses are not reported.
      expect((await check({ taxNumber: '300123456700003', excludeId: s.id })).body).toEqual([]);
      expect((await check({ name: 'Al Noor' })).body).toEqual([]);
      expect((await check({})).body).toEqual([]);
      expect((await check({ excludeId: other1.id, name: 'Unrelated Trading' })).body).toEqual([]);
      expect((await check({ excludeId: 'nope' })).status).toBe(422);
    });
  });

  /**
   * One realistic AP book (all SAR, tenant base currency):
   *   Supplier A: A1 80,000 (03-01, due 07-15) paid 30,000 on 04-01 · A2 50,000 (03-10, due 05-20)
   *               A4 10,000 (08-01, after the as-of date) · C3 cost 400 (05-05) reversed later
   *               E1 rent expense 3,000 (06-01)
   *   Supplier B: A3 120,000 (02-01, due 03-01) paid 20,000 on 03-15, that payment voided later
   *               C1 transport 2,500 (06-10) paid 1,000 on 06-20 · A5 15,000 (05-01) cancelled later
   *   Direct:     C2 detailing 750 (04-15) · E2 utilities 200 (02-10) reversed later
   * "Later" = today (all reversal entries are dated today, after 2026-06-30).
   */
  describe('accounts payable book', () => {
    let c: Client;
    let cash: { id: string };
    let supA: { id: string; name: string };
    let supB: { id: string; name: string };
    let A1: Awaited<ReturnType<typeof acquire>>;
    let A2: Awaited<ReturnType<typeof acquire>>;
    let A3: Awaited<ReturnType<typeof acquire>>;
    let A4: Awaited<ReturnType<typeof acquire>>;
    let A5: Awaited<ReturnType<typeof acquire>>;
    let C1: { id: string };
    let C2: { id: string };
    let E1: { id: string; number: string };
    let P2: { id: string; number: string };
    let P3: { id: string; number: string };

    beforeAll(async () => {
      c = t.owner;
      cash = await createCashAccount(c, { openingBalance: '500000.00' });
      supA = await createSupplier(c, { name: 'A Supplier Motors' });
      supB = await createSupplier(c, { name: 'B Supplier Auctions' });
      const transport = await costCategory(c, 'transport');
      const detailing = await costCategory(c, 'detailing');
      const parts = await costCategory(c, 'parts');
      const rent = await costCategory(c, 'rent');
      const utilities = await costCategory(c, 'utilities');

      A1 = await acquire(c, t.branchId, supA.id, { price: '80000.00', purchaseDate: '2026-03-01', dueDate: '2026-07-15' });
      A2 = await acquire(c, t.branchId, supA.id, { price: '50000.00', purchaseDate: '2026-03-10', dueDate: '2026-05-20' });
      A3 = await acquire(c, t.branchId, supB.id, { price: '120000.00', purchaseDate: '2026-02-01', dueDate: '2026-03-01' });
      A4 = await acquire(c, t.branchId, supA.id, { price: '10000.00', purchaseDate: '2026-08-01' });
      A5 = await acquire(c, t.branchId, supB.id, { price: '15000.00', purchaseDate: '2026-05-01' });
      C1 = await addCost(c, { vehicleId: A3.vehicleId, categoryId: transport, amount: '2500.00', costDate: '2026-06-10', supplierId: supB.id, description: 'Transport from auction' });
      C2 = await addCost(c, { vehicleId: A1.vehicleId, categoryId: detailing, amount: '750.00', costDate: '2026-04-15', supplierId: null, description: 'Detailing (cash purchase)' });
      const C3 = await addCost(c, { vehicleId: A2.vehicleId, categoryId: parts, amount: '400.00', costDate: '2026-05-05', supplierId: supA.id, description: 'Brake pads' });

      const e1 = await c.post('/expenses', { branchId: t.branchId, categoryId: rent, description: 'Showroom rent June', amount: '3000.00', currency: 'SAR', expenseDate: '2026-06-01', supplierId: supA.id }, idem());
      expect(e1.status).toBe(201);
      E1 = e1.body;
      const e2 = await c.post('/expenses', { branchId: t.branchId, categoryId: utilities, description: 'Electricity February', amount: '200.00', currency: 'SAR', expenseDate: '2026-02-10' }, idem());
      expect(e2.status).toBe(201);

      const p1 = await pay(c, { supplierId: supA.id, cashAccountId: cash.id, paidAt: '2026-04-01', amount: '30000.00', allocations: [{ targetType: 'acquisition', targetId: A1.id, amountBase: '30000.00' }] });
      expect(p1.status).toBe(201);
      const p2 = await pay(c, { supplierId: supB.id, cashAccountId: cash.id, paidAt: '2026-03-15', amount: '20000.00', allocations: [{ targetType: 'acquisition', targetId: A3.id, amountBase: '20000.00' }] });
      expect(p2.status).toBe(201);
      P2 = p2.body;
      const p3 = await pay(c, { supplierId: supB.id, cashAccountId: cash.id, paidAt: '2026-06-20', amount: '1000.00', allocations: [{ targetType: 'vehicle_cost', targetId: C1.id, amountBase: '1000.00' }] });
      expect(p3.status).toBe(201);
      P3 = p3.body;

      // Later corrections, all dated today.
      expect((await c.post(`/supplier-payments/${P2.id}/void`, { reason: 'Paid into the wrong account' }, idem())).status).toBe(200);
      expect((await c.post(`/acquisitions/${A5.id}/cancel`, { reason: 'Seller withdrew' }, idem())).status).toBe(200);
      expect((await c.post(`/vehicle-costs/${C3.id}/reverse`, { reason: 'Recorded on the wrong car' }, idem())).status).toBe(200);
      expect((await c.post(`/expenses/${e2.body.id}/reverse`, { reason: 'Duplicate bill' }, idem())).status).toBe(200);
    });

    it('lists open payable documents per supplier after partial payments (current position)', async () => {
      const a = await c.get(`/payables/open?supplierId=${supA.id}`);
      expect(a.status).toBe(200);
      expect(a.body.items.map((i: { targetType: string; number: string | null; dueDate: string | null; outstandingBase: string }) => [i.targetType, i.number, i.dueDate, i.outstandingBase])).toEqual([
        ['acquisition', A2.number, '2026-05-20', '50000.00'],
        ['expense', E1.number, null, '3000.00'],
        ['acquisition', A1.number, '2026-07-15', '50000.00'],
        ['acquisition', A4.number, null, '10000.00'],
      ]);
      const a1 = a.body.items.find((i: { targetId: string }) => i.targetId === A1.id);
      expect(a1).toMatchObject({ supplierId: supA.id, supplierName: supA.name, branchId: t.branchId, docDate: '2026-03-01', vehicleId: A1.vehicleId, vehicleStockNumber: A1.vehicle.stockNumber, totalBase: '80000.00', paidBase: '30000.00', outstandingBase: '50000.00' });
      expect(a.body.totals).toEqual({ totalBase: '143000.00', paidBase: '30000.00', outstandingBase: '113000.00' });

      // Voided payment no longer counts; cancelled acquisition is gone; cost partially paid.
      const b = await c.get(`/payables/open?supplierId=${supB.id}`);
      expect(b.body.items.map((i: { targetId: string; paidBase: string; outstandingBase: string }) => [i.targetId, i.paidBase, i.outstandingBase])).toEqual([
        [A3.id, '0.00', '120000.00'],
        [C1.id, '1000.00', '1500.00'],
      ]);
      expect(b.body.items[1]).toMatchObject({ targetType: 'vehicle_cost', number: null, vehicleStockNumber: A3.vehicle.stockNumber, label: `${A3.vehicle.stockNumber} · Transport from auction` });

      // Direct purchases (no supplier): the cash-bought detailing; the reversed bill is gone.
      const direct = await c.get('/payables/open?supplierId=none');
      expect(direct.body.items).toHaveLength(1);
      expect(direct.body.items[0]).toMatchObject({ targetType: 'vehicle_cost', targetId: C2.id, supplierId: null, supplierName: null, vehicleStockNumber: A1.vehicle.stockNumber, outstandingBase: '750.00' });

      const onlyExpenses = await c.get(`/payables/open?supplierId=${supA.id}&targetType=expense`);
      expect(onlyExpenses.body.items.map((i: { targetId: string }) => i.targetId)).toEqual([E1.id]);
      expect((await c.get('/payables/open?supplierId=someone')).status).toBe(422);

      // Accountant (supplier_payments.create) may list; an inspector may not.
      const accountant = (await addMember(app, t, 'accountant')).client;
      expect((await accountant.get('/payables/open?supplierId=none')).status).toBe(200);
      const inspector = (await addMember(app, t, 'inspector')).client;
      const denied = await inspector.get('/payables/open');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('forbidden');
    });

    it('supplier 360 summary: purchased − paid = outstanding', async () => {
      const a = await c.get(`/suppliers/${supA.id}`);
      expect(a.status).toBe(200);
      expect(a.body.name).toBe(supA.name);
      expect(a.body.summary).toEqual({ currency: 'SAR', outstandingBase: '113000.00', totalPurchasedBase: '143000.00', totalPaidBase: '30000.00', lastPaymentDate: '2026-04-01', openDocuments: 4 });
      const b = await c.get(`/suppliers/${supB.id}`);
      expect(b.body.summary).toEqual({ currency: 'SAR', outstandingBase: '121500.00', totalPurchasedBase: '122500.00', totalPaidBase: '1000.00', lastPaymentDate: '2026-06-20', openDocuments: 2 });
      expect(b.body.summary.outstandingBase).toBe(await gl2000(pool, t.tenantId, { supplierId: supB.id }));
    });

    it('statement: opening, running and closing balances equal the GL (credit-positive)', async () => {
      const st = await c.get(`/suppliers/${supB.id}/statement?from=2026-03-01&to=2026-06-30`);
      expect(st.status).toBe(200);
      expect(st.body).toMatchObject({ supplierId: supB.id, account: '2000', balanceSide: 'payable', currency: 'SAR', from: '2026-03-01', to: '2026-06-30' });
      expect(st.body.openingBalance).toBe('120000.00');
      expect(st.body.openingBalance).toBe(await gl2000(pool, t.tenantId, { asOf: '2026-02-28', supplierId: supB.id }));
      const rows = st.body.rows as Array<Record<string, unknown>>;
      expect(rows.map((r) => [r.date, r.documentType, r.documentNumber, r.debit, r.credit, r.runningBalance])).toEqual([
        ['2026-03-15', 'supplier_payment', P2.number, '20000.00', '0.00', '100000.00'],
        ['2026-05-01', 'acquisition', A5.number, '0.00', '15000.00', '115000.00'],
        ['2026-06-10', 'vehicle_cost', A3.vehicle.stockNumber, '0.00', '2500.00', '117500.00'],
        ['2026-06-20', 'supplier_payment', P3.number, '1000.00', '0.00', '116500.00'],
      ]);
      expect(rows[1]).toMatchObject({ documentId: A5.id, vehicleStockNumber: A5.vehicle.stockNumber, sourceType: 'vehicle_cost', isReversal: false });
      expect(rows[2]).toMatchObject({ documentId: C1.id, label: `${A3.vehicle.stockNumber} · Transport from auction` });
      expect(st.body).toMatchObject({ totalDebit: '21000.00', totalCredit: '17500.00', closingBalance: '116500.00' });
      expect(st.body.closingBalance).toBe(await gl2000(pool, t.tenantId, { asOf: '2026-06-30', supplierId: supB.id }));

      // Whole history: opening 0, includes the void and cancellation reversals, closes at the GL balance.
      const full = await c.get(`/suppliers/${supB.id}/statement`);
      expect(full.body.openingBalance).toBe('0.00');
      expect(full.body.closingBalance).toBe('121500.00');
      expect(full.body.closingBalance).toBe(await gl2000(pool, t.tenantId, { supplierId: supB.id }));
      const reversals = (full.body.rows as Array<{ isReversal: boolean; documentNumber: string; credit: string; debit: string }>).filter((r) => r.isReversal);
      expect(reversals.map((r) => [r.documentNumber, r.debit, r.credit]).sort()).toEqual(
        [
          [A5.number, '15000.00', '0.00'],
          [P2.number, '0.00', '20000.00'],
        ].sort(),
      );
      const last = full.body.rows[full.body.rows.length - 1];
      expect(last.runningBalance).toBe(full.body.closingBalance);

      // Supplier A's expense resolves to its number.
      const a = await c.get(`/suppliers/${supA.id}/statement?from=2026-06-01&to=2026-06-01`);
      expect(a.body.rows).toHaveLength(1);
      expect(a.body.rows[0]).toMatchObject({ documentType: 'expense', documentId: E1.id, documentNumber: E1.number, credit: '3000.00' });

      const bad = await c.get(`/suppliers/${supB.id}/statement?from=2026-06-30&to=2026-03-01`);
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('validation_failed');
      expect((await c.get(`/suppliers/${supB.id}/statement?from=2026-02-30`)).status).toBe(422);
    });

    it('aging as of 2026-06-30 by due date, reconciled to GL 2000 with zero difference', async () => {
      const r = await c.get('/payables/summary?asOf=2026-06-30');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ asOf: '2026-06-30', currency: 'SAR', scope: 'all' });
      const rows = r.body.rows as Array<{ supplierId: string | null; isDirect: boolean; documents: number; outstandingBase: string; buckets: Record<string, string> }>;
      // Suppliers sorted by name, direct purchases last.
      expect(rows.map((x) => x.supplierId)).toEqual([supA.id, supB.id, null]);
      expect(rows[0]).toMatchObject({
        supplierName: supA.name,
        isDirect: false,
        documents: 4, // A1, A2, C3 (reversed only after asOf), E1 — A4 is dated after asOf
        outstandingBase: '103400.00',
        buckets: { notDue: '50000.00', d1_30: '3000.00', d31_60: '50400.00', d61_90: '0.00', d90plus: '0.00' },
      });
      expect(rows[1]).toMatchObject({
        documents: 3, // A3 (voided payment still effective at asOf), C1, A5 (cancelled after asOf)
        outstandingBase: '116500.00',
        buckets: { notDue: '0.00', d1_30: '1500.00', d31_60: '15000.00', d61_90: '0.00', d90plus: '100000.00' },
      });
      expect(rows[2]).toMatchObject({
        isDirect: true,
        supplierName: null,
        documents: 2,
        outstandingBase: '950.00',
        buckets: { notDue: '0.00', d1_30: '0.00', d31_60: '0.00', d61_90: '750.00', d90plus: '200.00' },
      });
      expect(r.body.totals).toEqual({
        documents: 9,
        outstandingBase: '220850.00',
        buckets: { notDue: '50000.00', d1_30: '4500.00', d31_60: '65400.00', d61_90: '750.00', d90plus: '100200.00' },
      });
      expect(r.body.reconciliation).toEqual({ subledgerTotal: '220850.00', glPayablesBalance: '220850.00', difference: '0.00', mismatches: [] });
      expect(r.body.reconciliation.glPayablesBalance).toBe(await gl2000(pool, t.tenantId, { asOf: '2026-06-30' }));
      // The aged supplier balance equals that supplier's statement closing balance at the same date.
      const st = await c.get(`/suppliers/${supB.id}/statement?to=2026-06-30`);
      expect(st.body.closingBalance).toBe(rows[1]!.outstandingBase);
    });

    it('current aging (default asOf = today) also reconciles and matches the open list', async () => {
      const r = await c.get('/payables/summary');
      expect(r.status).toBe(200);
      const open = await c.get('/payables/open');
      expect(r.body.totals.outstandingBase).toBe('235250.00');
      expect(r.body.totals.outstandingBase).toBe(open.body.totals.outstandingBase);
      expect(r.body.totals.documents).toBe(open.body.items.length);
      expect(r.body.reconciliation).toMatchObject({ subledgerTotal: '235250.00', difference: '0.00', mismatches: [] });
      expect(r.body.reconciliation.glPayablesBalance).toBe(await gl2000(pool, t.tenantId));
      expect(sum(Object.values(r.body.totals.buckets as Record<string, string>)).toFixed(2)).toBe('235250.00');
      expect((await c.get('/payables/summary?asOf=2026-13-01')).status).toBe(422);
      const inspector = (await addMember(app, t, 'inspector')).client;
      expect((await inspector.get('/payables/summary')).status).toBe(403);
      // Another tenant sees only its own (empty) book.
      const o = await other.owner.get('/payables/summary');
      expect(o.body.rows).toEqual([]);
      expect(o.body.reconciliation).toMatchObject({ subledgerTotal: '0.00', difference: '0.00' });
    });

    it('refuses overpayment and supplier mismatch, replays idempotent payments once, and stays reconciled', async () => {
      const over = await pay(c, { supplierId: supA.id, cashAccountId: cash.id, paidAt: '2026-07-01', amount: '50000.01', allocations: [{ targetType: 'acquisition', targetId: A1.id, amountBase: '50000.01' }] });
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('overpayment');
      expect(over.body.error.details.outstanding).toBe('50000.00');

      const mismatch = await pay(c, { supplierId: supA.id, cashAccountId: cash.id, paidAt: '2026-07-01', amount: '750.00', allocations: [{ targetType: 'vehicle_cost', targetId: C2.id, amountBase: '750.00' }] });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.error.code).toBe('supplier_mismatch');

      // Settle A1 in full; the same Idempotency-Key replays the first response without paying twice.
      const key = idem();
      const first = await pay(c, { supplierId: supA.id, cashAccountId: cash.id, paidAt: '2026-07-01', amount: '50000.00', allocations: [{ targetType: 'acquisition', targetId: A1.id, amountBase: '50000.00' }] }, key);
      expect(first.status).toBe(201);
      const again = await pay(c, { supplierId: supA.id, cashAccountId: cash.id, paidAt: '2026-07-01', amount: '50000.00', allocations: [{ targetType: 'acquisition', targetId: A1.id, amountBase: '50000.00' }] }, key);
      expect(again.body.id).toBe(first.body.id);
      const count = await pool.query(`SELECT count(*)::int AS n FROM supplier_payments WHERE tenant_id = $1 AND supplier_id = $2 AND status = 'posted'`, [t.tenantId, supA.id]);
      expect(count.rows[0].n).toBe(2);

      // Pay the direct purchase without a supplier.
      const direct = await pay(c, { supplierId: null, cashAccountId: cash.id, paidAt: '2026-07-02', amount: '750.00', allocations: [{ targetType: 'vehicle_cost', targetId: C2.id, amountBase: '750.00' }] });
      expect(direct.status).toBe(201);
      expect((await c.get('/payables/open?supplierId=none')).body.items).toEqual([]);

      const a = await c.get(`/payables/open?supplierId=${supA.id}`);
      expect(a.body.items.map((i: { targetId: string }) => i.targetId)).not.toContain(A1.id);
      expect((await c.get(`/suppliers/${supA.id}`)).body.summary).toMatchObject({ outstandingBase: '63000.00', totalPaidBase: '80000.00', lastPaymentDate: '2026-07-01', openDocuments: 3 });

      const summary = await c.get('/payables/summary');
      expect(summary.body.reconciliation).toMatchObject({ subledgerTotal: '184500.00', glPayablesBalance: '184500.00', difference: '0.00' });
      // The historical position is unchanged by later payments dated after it.
      const hist = await c.get('/payables/summary?asOf=2026-06-30');
      expect(hist.body.reconciliation).toMatchObject({ subledgerTotal: '220850.00', difference: '0.00' });
      expect(await ledgerBalanced(pool, t.tenantId)).toBe(true);
    });

    it('a payment dated before its document is an advance in the historical position, still reconciled', async () => {
      // A4 is dated 2026-08-01; pay part of it on 2026-07-20.
      const adv = await pay(c, { supplierId: supA.id, cashAccountId: cash.id, paidAt: '2026-07-20', amount: '5000.00', allocations: [{ targetType: 'acquisition', targetId: A4.id, amountBase: '5000.00' }] });
      expect(adv.status).toBe(201);
      const r = await c.get('/payables/summary?asOf=2026-07-25');
      const a = (r.body.rows as Array<{ supplierId: string | null; outstandingBase: string; buckets: Record<string, string> }>).find((x) => x.supplierId === supA.id)!;
      // A1 settled (0), A2 50,000 (d61_90), C3 400 (d61_90), E1 3,000 (d31_60), A4 −5,000 advance (not yet due).
      expect(a).toMatchObject({ outstandingBase: '48400.00', buckets: { notDue: '-5000.00', d1_30: '0.00', d31_60: '3000.00', d61_90: '50400.00', d90plus: '0.00' } });
      expect(a.outstandingBase).toBe(await gl2000(pool, t.tenantId, { asOf: '2026-07-25', supplierId: supA.id }));
      expect(r.body.reconciliation).toMatchObject({ difference: '0.00', mismatches: [] });
      // Today it is simply a partially paid document.
      const open = await c.get(`/payables/open?supplierId=${supA.id}&targetType=acquisition`);
      expect(open.body.items.find((i: { targetId: string }) => i.targetId === A4.id)).toMatchObject({ paidBase: '5000.00', outstandingBase: '5000.00' });
      expect((await c.get('/payables/summary')).body.reconciliation.difference).toBe('0.00');
    });

    it('a supplier without ledger lines has an empty, zero statement', async () => {
      const s = await createSupplier(c);
      const st = await c.get(`/suppliers/${s.id}/statement?from=2026-01-01`);
      expect(st.status).toBe(200);
      expect(st.body).toMatchObject({ openingBalance: '0.00', closingBalance: '0.00', totalDebit: '0.00', totalCredit: '0.00', rows: [] });
    });
  });

  describe('branch scope', () => {
    it('branch-limited users see only their branches, get no GL reconciliation and no statement', async () => {
      const tb = await createTenant(app, admin);
      const b2 = await tb.owner.post('/branches', { name: 'Jeddah', code: `J${Date.now() % 100000}` });
      expect(b2.status).toBe(201);
      const s = await createSupplier(tb.owner);
      const main = await acquire(tb.owner, tb.branchId, s.id, { price: '10000.00', purchaseDate: '2026-04-01' });
      const far = await acquire(tb.owner, b2.body.id, s.id, { price: '7000.00', purchaseDate: '2026-04-02' });
      const transport = await costCategory(tb.owner, 'transport');
      await addCost(tb.owner, { vehicleId: far.vehicleId, categoryId: transport, amount: '300.00', costDate: '2026-04-03', supplierId: s.id });

      const scoped = (await addMember(app, tb, 'accountant', { allBranches: false, branchIds: [tb.branchId] })).client;
      const open = await scoped.get(`/payables/open?supplierId=${s.id}`);
      expect(open.status).toBe(200);
      expect(open.body.items.map((i: { targetId: string }) => i.targetId)).toEqual([main.id]);
      expect((await scoped.get(`/suppliers/${s.id}`)).body.summary).toMatchObject({ outstandingBase: '10000.00', openDocuments: 1 });
      const sum = await scoped.get('/payables/summary?asOf=2026-12-31');
      expect(sum.body).toMatchObject({ scope: 'branches', reconciliation: null });
      expect(sum.body.totals.outstandingBase).toBe('10000.00');
      const st = await scoped.get(`/suppliers/${s.id}/statement`);
      expect(st.status).toBe(403);
      expect(st.body.error.code).toBe('all_branches_required');

      const ownerView = await tb.owner.get('/payables/summary?asOf=2026-12-31');
      expect(ownerView.body).toMatchObject({ scope: 'all' });
      expect(ownerView.body.reconciliation).toMatchObject({ subledgerTotal: '17300.00', glPayablesBalance: '17300.00', difference: '0.00' });
      expect((await tb.owner.get(`/payables/open?supplierId=${s.id}`)).body.items).toHaveLength(3);
    });
  });

  describe('approval inbox summary', () => {
    it('counts what each caller may decide, by type', async () => {
      const ta = await createTenant(app, admin);
      const s = await createSupplier(ta.owner);
      const ids = await catalogIds(ta.owner);
      const acq = await ta.owner.post(
        '/acquisitions',
        { branchId: ta.branchId, supplierId: s.id, sourceType: 'company', purchaseDate: '2026-05-01', purchasePrice: '45000.00', currency: 'SAR', submit: true, vehicle: { ...ids, modelYear: 2020, odometerValue: 10, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'Red' } },
        idem(),
      );
      expect(acq.status).toBe(201);
      // Inventory managers may record costs but not approve them → pending cost approval.
      const inv = (await addMember(app, ta, 'inventory_manager')).client;
      const pending = await inv.post('/vehicle-costs', { vehicleId: acq.body.vehicleId, categoryId: await costCategory(inv, 'transport'), description: 'Tow truck', amount: '600.00', currency: 'SAR', costDate: '2026-05-02', supplierId: s.id }, idem());
      expect(pending.status).toBe(201);
      expect(pending.body.status).toBe('pending_approval');

      const owner = await ta.owner.get('/approvals/summary');
      expect(owner.status).toBe(200);
      expect(owner.body.total).toBe(2);
      expect(owner.body.truncated).toBe(false);
      expect(owner.body.byType).toMatchObject({ acquisition: 1, vehicle_cost: 1, expense: 0, work_order: 0 });
      expect(owner.body.total).toBe((await ta.owner.get('/approvals')).body.length);

      const accountant = (await addMember(app, ta, 'accountant')).client; // costs.approve, not acquisitions.approve
      const acc = await accountant.get('/approvals/summary');
      expect(acc.body).toMatchObject({ total: 1, byType: { acquisition: 0, vehicle_cost: 1 } });

      const inspector = (await addMember(app, ta, 'inspector')).client;
      expect((await inspector.get('/approvals/summary')).body).toMatchObject({ total: 0, byType: { acquisition: 0, vehicle_cost: 0 } });

      // Approving the cost removes it from the inbox counts.
      expect((await accountant.post(`/vehicle-costs/${pending.body.id}/approve`, {})).status).toBe(200);
      expect((await ta.owner.get('/approvals/summary')).body).toMatchObject({ total: 1, byType: { acquisition: 1, vehicle_cost: 0 } });
      // Other tenants see nothing of it.
      expect((await other.owner.get('/approvals/summary')).body.byType.acquisition).toBe(0);
    });
  });
});
