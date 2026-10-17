import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { addMonths, todayInZone } from '@autohub/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addMemberWithPermissions,
  assertLedgerIntegrity,
  costCategory,
  createAcquisition,
  createCashAccount,
  createCustomer,
  createSupplier,
  makeAvailable,
  secondApprover,
  sellVehicle,
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant, uniq } from './helpers';

type Report = {
  columns: Array<{ key: string; type: string }>;
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string | number | null> | null;
  summary: Array<{ key: string; value: string | number | null }>;
  reconciliation: Array<{ difference: string; report: string; ledger: string }> | null;
};

/**
 * Phase 6: dashboard, reports and exports against real data. Report totals must agree with the
 * general ledger, cost/profit columns must disappear (screen and exports) without
 * vehicles.view_cost, and branch scope must hold.
 */
describe('dashboard, reports and exports', () => {
  let app: INestApplication;
  let t: TestTenant;
  let pool: Pool;
  let owner: Client;
  let checker: Client;
  let cash: { id: string };
  let supplier: { id: string };
  let today: string;
  let stockVehicle: string;
  let cashSale: { id: string; number: string };
  let planSale: { id: string; number: string };
  let leadId: string;

  const gl = async (account: string) =>
    (await pool.query(`SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines WHERE tenant_id = $1 AND account_code = $2`, [t.tenantId, account])).rows[0]
      .b as string;
  const report = async (c: Client, path: string) => {
    const res = await c.get(path);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Report;
  };
  const value = (r: Report, key: string) => r.summary.find((s) => s.key === key)?.value;

  async function available(price: string, asking = '120000.00', floor = '100000.00') {
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { price, approver: checker });
    await makeAvailable(owner, acq.vehicleId, asking, floor);
    return acq.vehicleId;
  }

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    pool = ownerPool();
    owner = t.owner;
    checker = await secondApprover(owner);
    supplier = await createSupplier(owner);
    cash = await createCashAccount(owner, { name: 'Main safe', openingBalance: '50000.00' });
    today = todayInZone('Asia/Riyadh');
    const patch = await owner.patch('/company', {
      settings: {
        installments: {
          enabled: true,
          defaultMethod: 'flat',
          allocationOrder: ['fees', 'interest', 'principal'],
          futureInterestPolicyFlat: 'charge_all',
          futureInterestPolicyReducing: 'charge_current_period',
          lateFeePolicy: 'none',
          reminderDaysBefore: 3,
        },
      },
    });
    expect(patch.status).toBe(200);

    // One vehicle stays in stock; one is sold for cash (from a walk-in lead) with a cost added
    // after the sale; one is sold on installments.
    stockVehicle = await available('80000.00');
    const vCash = await available('60000.00');
    const vPlan = await available('70000.00', '95000.00', '90000.00');
    const cust = (await createCustomer(owner, { fullName: 'Majed Al-Otaibi' })).id as string;
    const lead = await owner.post('/leads', { customerId: cust, branchId: t.branchId, source: 'walk_in' });
    expect(lead.status, JSON.stringify(lead.body)).toBe(201);
    leadId = lead.body.id;
    cashSale = await sellVehicle(owner, { vehicleId: vCash, customerId: cust, cashAccountId: cash.id, agreedPrice: '115000.00', leadId });
    const post = await owner.post(
      '/vehicle-costs',
      { vehicleId: vCash, categoryId: await costCategory(owner, 'transport'), description: 'Delivery to customer', amount: '500.00', currency: 'SAR', costDate: today, supplierId: supplier.id },
      idem(),
    );
    expect(post.status, JSON.stringify(post.body)).toBe(201);
    const cust2 = (await createCustomer(owner, { fullName: '=HYPERLINK("http://evil.test","x")' })).id as string;
    planSale = await sellVehicle(owner, {
      vehicleId: vPlan,
      customerId: cust2,
      cashAccountId: cash.id,
      agreedPrice: '92000.00',
      paymentType: 'installments',
      downPayment: '20000.00',
      installmentTerms: { method: 'flat', annualRatePct: '12', count: 12, frequencyMonths: 1, firstDueDate: addMonths(today, 1) },
    });
  });
  afterEach(async () => assertLedgerIntegrity(pool, t.tenantId));
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('post-sale costs are tagged with the sale they belong to', async () => {
    const r = await pool.query(
      `SELECT l.sale_id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.source_type = 'vehicle_cost' AND l.account_code = '5000' AND l.tenant_id = $1`,
      [t.tenantId],
    );
    expect(r.rows).toEqual([{ sale_id: cashSale.id }]);
  });

  it('inventory valuation lists stock at cost and reconciles to ledger 1300', async () => {
    const r = await report(owner, '/reports/inventory');
    expect(r.rows.map((x) => x.id)).toEqual([stockVehicle]);
    expect(r.rows[0]).toMatchObject({ status: 'available', cost: '80000.00', askingPrice: '120000.00', expectedMargin: '40000.00', marginPct: '33.33', bucket: '0-30', daysInStock: 0 });
    expect(value(r, 'cost')).toBe('80000.00');
    expect(r.reconciliation).toEqual([expect.objectContaining({ report: '80000.00', ledger: await gl('1300'), difference: '0.00' })]);
    expect((await report(owner, '/reports/inventory?bucket=90%2B')).rows).toEqual([]);
  });

  it('sales profitability comes from the ledger and reconciles to 4000 and 5000', async () => {
    const r = await report(owner, '/reports/sales');
    const byNumber = Object.fromEntries(r.rows.map((x) => [x.number, x]));
    // 115,000 incl. 15% VAT = 100,000 net; COGS 60,000 + 500 post-sale cost.
    expect(byNumber[cashSale.number]).toMatchObject({ units: 1, netRevenue: '100000.00', tax: '15000.00', cogs: '60500.00', grossProfit: '39500.00', source: 'walk_in', paymentType: 'cash', status: 'delivered' });
    expect(byNumber[planSale.number]).toMatchObject({ units: 1, netRevenue: '80000.00', cogs: '70000.00', grossProfit: '10000.00', source: 'direct', paymentType: 'installments' });
    expect(r.totals).toMatchObject({ units: 2, netRevenue: '180000.00', cogs: '130500.00', grossProfit: '49500.00' });
    expect(r.reconciliation!.map((x) => x.difference)).toEqual(['0.00', '0.00']);
    expect(r.reconciliation![0]!.ledger).toBe((-Number(await gl('4000'))).toFixed(2));

    for (const groupBy of ['salesperson', 'branch', 'source', 'paymentType', 'month']) {
      const g = await report(owner, `/reports/sales?groupBy=${groupBy}`);
      expect(g.totals, groupBy).toMatchObject({ netRevenue: '180000.00', grossProfit: '49500.00', sales: 2 });
    }
    const bySource = await report(owner, '/reports/sales?groupBy=source');
    expect(bySource.rows.find((x) => x.groupKey === 'walk_in')).toMatchObject({ sales: 1, netRevenue: '100000.00' });
    // A period before the sales is empty.
    const old = await report(owner, `/reports/sales?from=2025-01-01&to=2025-01-31`);
    expect(old.rows).toEqual([]);
    expect((await owner.get('/reports/sales?from=2026-02-01&to=2026-01-01')).body.error.code).toBe('invalid_range');
  });

  it('a user without vehicles.view_cost gets no cost or profit columns, on screen or in any export', async () => {
    const viewer = await addMemberWithPermissions(app, t, ['reports.view', 'reports.export', 'vehicles.read']);
    const r = await report(viewer.client, '/reports/sales');
    const keys = r.columns.map((c) => c.key);
    expect(keys).toContain('netRevenue');
    for (const k of ['cogs', 'grossProfit', 'commission', 'contribution', 'marginPct']) expect(keys).not.toContain(k);
    for (const row of r.rows) expect(Object.keys(row)).not.toContain('cogs');
    expect(Object.keys(r.totals!)).not.toContain('grossProfit');
    expect(r.summary.map((s) => s.key)).not.toContain('grossProfit');
    expect(r.reconciliation!.length).toBe(1);
    const inv = await report(viewer.client, '/reports/inventory');
    expect(inv.columns.map((c) => c.key)).not.toContain('cost');
    expect(inv.columns.map((c) => c.key)).not.toContain('floorPrice');
    expect(inv.reconciliation).toEqual([]);

    const csv = await viewer.client.get('/reports/sales/export?format=csv&locale=en').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(csv.status).toBe(200);
    const header = (csv.body as Buffer).toString('utf8').split('\r\n')[0]!;
    expect(header).toContain('Net revenue');
    expect(header).not.toMatch(/Cost of sale|Gross profit|Commission/);

    const xlsx = await viewer.client.get('/reports/inventory/export?format=xlsx&locale=en').responseType('blob');
    expect(xlsx.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as never);
    const values = (wb.worksheets[0]!.getRow(4).values as unknown[]).filter(Boolean);
    expect(values).toContain('Asking price');
    expect(values).not.toContain('Cost');
    // No export without reports.export, and none for a report the user cannot open.
    const noExport = await addMemberWithPermissions(app, t, ['reports.view', 'vehicles.read']);
    expect((await noExport.client.get('/reports/sales/export?format=csv')).status).toBe(403);
    expect((await viewer.client.get('/reports/receivables/export?format=csv')).status).toBe(403);
  });

  it('exports: Arabic CSV with BOM and neutralised formulas, right-to-left XLSX, PDF with embedded fonts, audited', async () => {
    const csv = await owner.get('/reports/receivables/export?format=csv&locale=ar').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="receivables-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = (csv.body as Buffer).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('رقم البيع');
    expect(text).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);

    const xlsx = await owner.get('/reports/sales/export?format=xlsx&locale=ar').responseType('blob');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as never);
    const ws = wb.worksheets[0]!;
    expect(ws.views[0]?.rightToLeft).toBe(true);
    const net = (ws.getRow(4).values as unknown[]).indexOf('صافي الإيراد');
    expect(net).toBeGreaterThan(0);
    const totalRow = ws.getRow(ws.rowCount);
    expect(totalRow.getCell(net).value).toBe(180000);

    const pdf = await owner.get('/reports/inventory/export?format=pdf&locale=ar').responseType('blob');
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const fonts = new Set((pdf.body as Buffer).toString('latin1').match(/\/BaseFont \/[A-Z]{6}\+IBMPlexSansArabic-(Regular|Bold)/g));
    expect(fonts.size).toBeGreaterThanOrEqual(2);

    const audit = await pool.query(`SELECT entity_id, summary FROM audit_logs WHERE tenant_id = $1 AND action = 'report.exported' ORDER BY seq`, [t.tenantId]);
    expect(audit.rows.map((r) => r.entity_id)).toEqual(expect.arrayContaining(['receivables', 'sales', 'inventory']));
    expect((await owner.get('/reports/nope/export?format=csv')).status).toBe(404);
    expect((await owner.get('/reports/sales/export?format=docx')).status).toBe(422);
    expect((await owner.get('/reports/sales/export?format=csv&groupBy=planet')).status).toBe(422);
  });

  it('receivables and installment aging reconcile to ledger 1200', async () => {
    const r = await report(owner, '/reports/receivables');
    expect(r.rows.map((x) => x.number)).toEqual([planSale.number]);
    // 92,000 gross − 20,000 down payment + 12% flat interest on 72,000 for a year (8,640).
    expect(r.rows[0]).toMatchObject({ balance: '80640.00', overdue: '0.00', bucket: 'current', paymentType: 'installments' });
    expect(r.reconciliation).toEqual([expect.objectContaining({ report: '80640.00', ledger: await gl('1200'), difference: '0.00' })]);
    // As of a date before the sales nothing was owed.
    expect((await report(owner, '/reports/receivables?asOf=2025-12-31')).rows).toEqual([]);
    // A month after the first due date, that installment is overdue (aged from its due date).
    const later = await report(owner, `/reports/receivables?asOf=${addMonths(today, 2)}`);
    expect(Number(later.rows[0]!.overdue)).toBeGreaterThan(0);
    expect(later.rows[0]!.bucket).toBe('0-30');
    const muchLater = await report(owner, `/reports/receivables?asOf=${addMonths(today, 3)}`);
    expect(muchLater.rows[0]!.bucket).toBe('61-90');
  });

  it('cash flow reconciles to ledger 1100 and breaks down by kind', async () => {
    const r = await report(owner, `/reports/cash-flow?from=2026-01-01&to=${today}`);
    const row = r.rows.find((x) => x.id === cash.id)!;
    // Opening 50,000 + cash sale 115,000 + down payment 20,000 (acquisitions were left unpaid).
    expect(row).toMatchObject({ opening: '0.00', inflow: '185000.00', outflow: '0.00', closing: '185000.00' });
    expect(r.reconciliation).toEqual([expect.objectContaining({ difference: '0.00', ledger: await gl('1100') })]);
    expect(value(r, 'in:customer_receipt')).toBe('135000.00');
    expect(value(r, 'in:opening_balance')).toBe('50000.00');
  });

  it('lead conversion by source and by assignee', async () => {
    const r = await report(owner, '/reports/leads');
    expect(r.rows).toEqual([expect.objectContaining({ groupKey: 'walk_in', total: 1, won: 1, open: 0, conversionPct: '100.00' })]);
    const byUser = await report(owner, '/reports/leads?groupBy=assignee');
    expect(byUser.totals).toMatchObject({ total: 1, won: 1 });
    expect((await pool.query(`SELECT status FROM leads WHERE id = $1`, [leadId])).rows[0].status).toBe('won');
  });

  it('dashboard blocks follow permissions and scope', async () => {
    const d = (await owner.get('/dashboard')).body;
    expect(d.inventory).toMatchObject({ onHand: 1, available: 1, inventoryValue: '80000.00' });
    expect(d.sales).toMatchObject({ scope: 'all', units: 2, netRevenue: '180000.00', grossProfit: '49500.00', awaitingDelivery: 0 });
    expect(d.sales.monthly.at(-1)).toMatchObject({ units: 2, netRevenue: '180000.00' });
    expect(d.leads).toMatchObject({ wonInPeriod: 1, newInPeriod: 1, conversionPct: '100.00' });
    expect(d.cash.balanceBase).toBe('185000.00');
    expect(d.receivables).toMatchObject({ total: '80640.00', overdueInstallments: '0.00' });
    expect(d.receivables.customerAdvances).toBe((-Number(await gl('2100'))).toFixed(2));

    const rep = await addMember(app, t, 'sales_rep');
    const rd = (await rep.client.get('/dashboard')).body;
    expect(rd.sales).toMatchObject({ scope: 'own', units: 0, netRevenue: '0.00' });
    expect(rd.sales.grossProfit).toBeUndefined();
    expect(rd.inventory.inventoryValue).toBeUndefined();
    expect(rd.cash).toBeUndefined();
    expect(rd.receivables).toBeUndefined();
    expect((await rep.client.get('/reports/sales')).status).toBe(403);
  });

  it('branch-scoped users see only their branches; other companies see nothing', async () => {
    const b2 = await owner.post('/branches', { name: 'Jeddah', code: uniq('J').toUpperCase().slice(0, 8) });
    expect(b2.status, JSON.stringify(b2.body)).toBe(201);
    const scoped = await addMemberWithPermissions(app, t, ['reports.view', 'reports.financial', 'cash.read', 'vehicles.read', 'vehicles.view_cost', 'dashboard.view'], {
      allBranches: false,
      branchIds: [b2.body.id],
    });
    expect((await report(scoped.client, '/reports/inventory')).rows).toEqual([]);
    const s = await report(scoped.client, '/reports/sales');
    expect(s.rows).toEqual([]);
    expect(s.reconciliation).toBeNull();
    expect((await report(scoped.client, '/reports/receivables')).rows).toEqual([]);
    // The company-level cash account is not visible to a branch user.
    expect((await report(scoped.client, '/reports/cash-flow')).rows).toEqual([]);
    expect((await scoped.client.get(`/reports/sales?branchId=${t.branchId}`)).status).toBe(403);
    const sd = (await scoped.client.get('/dashboard')).body;
    expect(sd.inventory.onHand).toBe(0);
    expect(sd.receivables.customerAdvances).toBeNull();

    const other = await createTenant(app, await createPlatformAdmin(app));
    expect((await report(other.owner, '/reports/sales')).rows).toEqual([]);
    expect((await report(other.owner, '/reports/inventory')).rows).toEqual([]);
    expect((await report(other.owner, '/reports/receivables')).rows).toEqual([]);
  });
});
