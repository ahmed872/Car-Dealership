import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { addDays, addMonths, todayInZone } from '@autohub/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/modules/jobs/jobs.service';
import {
  addMemberWithPermissions,
  assertLedgerIntegrity,
  catalogIds,
  createAcquisition,
  createCashAccount,
  createCustomer,
  createSupplier,
  glBalance,
  makeAvailable,
  secondApprover,
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

/**
 * Phase 5: the sales workflow end to end against real PostgreSQL — pricing and approval,
 * confirmation, payments held as advances until recognition (D-028), delivery rules, documents
 * and PDFs, installments with early settlement, trade-ins, deposits, commissions, cancellation,
 * returns, refunds and daily cash closing. Every test ends with a whole-ledger integrity check.
 */
describe('sales, installments, commissions and cash closing', () => {
  let app: INestApplication;
  let t: TestTenant;
  let pool: Pool;
  let owner: Client;
  let checker: Client;
  let cash: { id: string };
  let supplier: { id: string };
  let today: string;

  const customer = async (name = 'Faisal Al-Qahtani') => (await createCustomer(owner, { fullName: name })).id as string;

  /** A purchased vehicle (cost in 1300) that is available for sale. */
  async function stockVehicle(price = '80000.00', asking = '120000.00', floor = '110000.00') {
    const acq = await createAcquisition(owner, t.branchId, supplier.id, { price, approver: checker });
    await makeAvailable(owner, acq.vehicleId, asking, floor);
    return acq.vehicleId;
  }

  const saleGl = async (account: string, saleId: string) =>
    (
      await pool.query(
        `SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines WHERE account_code = $1 AND sale_id = $2`,
        [account, saleId],
      )
    ).rows[0].b as string;
  const events = async (sourceType: string, sourceId: string) =>
    (await pool.query(`SELECT event FROM journal_entries WHERE source_type = $1 AND source_id = $2 ORDER BY entry_no`, [sourceType, sourceId])).rows.map(
      (r) => r.event as string,
    );
  const vehicleStatus = async (id: string, c: Client = owner) => (await c.get(`/vehicles/${id}`)).body.vehicle.status as string;
  const getSale = async (id: string, c: Client = owner) => (await c.get(`/sales/${id}`)).body;
  const version = async (id: string, c: Client = owner) => (await getSale(id, c)).version as number;

  function pay(c: Client, customerId: string, targetId: string, amount: string, targetType: 'sale' | 'installment' = 'sale', account = cash.id) {
    return c.post(
      '/receipts',
      { customerId, cashAccountId: account, amount, method: 'cash', allocations: [{ targetType, targetId, amountBase: amount }] },
      idem(),
    );
  }

  async function newSale(c: Client, body: Record<string, unknown>) {
    const res = await c.post('/sales', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  }

  async function confirm(c: Client, id: string) {
    const res = await c.post(`/sales/${id}/confirm`, { version: await version(id, c) }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  async function invoice(c: Client, id: string) {
    const res = await c.post(`/sales/${id}/documents`, { type: 'invoice' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  }

  async function deliver(c: Client, id: string, extra: Record<string, unknown> = {}) {
    return c.post(`/sales/${id}/deliver`, { version: await version(id, c), ...extra }, idem());
  }

  async function setSettings(settings: Record<string, unknown>, c: Client = owner) {
    const res = await c.patch('/company', { settings });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  const INSTALLMENTS_ON = {
    enabled: true,
    defaultMethod: 'flat',
    allocationOrder: ['fees', 'interest', 'principal'],
    futureInterestPolicyFlat: 'charge_all',
    futureInterestPolicyReducing: 'charge_current_period',
    lateFeePolicy: 'none',
    reminderDaysBefore: 3,
  };

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    pool = ownerPool();
    owner = t.owner;
    checker = await secondApprover(owner);
    supplier = await createSupplier(owner);
    cash = await createCashAccount(owner, { name: 'Showroom safe', openingBalance: '50000.00' });
    today = todayInZone('Asia/Riyadh');
  });
  afterEach(async () => assertLedgerIntegrity(pool, t.tenantId));
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  describe('cash sale', () => {
    it('draft → confirm → payments held as advances → invoice → delivery recognises revenue, tax and COGS', async () => {
      const cust = await customer();
      const vehicleId = await stockVehicle('80000.00');

      // Preview: SA VAT 15% inclusive → 115,000 = 100,000 net + 15,000 tax; within the owner's limit.
      const preview = await owner.post('/sales/preview', { vehicleId, customerId: cust, agreedPrice: '115000.00' });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body).toMatchObject({ netAmount: '100000.00', taxAmount: '15000.00', grossAmount: '115000.00', requiresApproval: false, dueBeforeDelivery: '115000.00' });

      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '115000.00' });
      expect(s).toMatchObject({ status: 'draft', paymentType: 'cash', grossAmount: '115000.00', discountAmount: '5000.00' });
      expect(s.number).toMatch(/^SO-/);
      expect(await vehicleStatus(vehicleId)).toBe('sale_pending');

      // Money before confirmation is an advance on the sale (2100), never revenue.
      const early = await pay(owner, cust, s.id, '20000.00');
      expect(early.status, JSON.stringify(early.body)).toBe(201);
      expect(await saleGl('2100', s.id)).toBe('-20000.00');
      expect(await glBalance(pool, t.tenantId, '4000')).toBe('0.00');

      const c = await confirm(owner, s.id);
      expect(c).toMatchObject({ status: 'confirmed', costAtConfirmation: '80000.00' });
      expect(c.recognizedAt).toBeNull();
      expect(await vehicleStatus(vehicleId)).toBe('sold');
      expect(await glBalance(pool, t.tenantId, '4000')).toBe('0.00');
      expect(c.deliveryBlockers).toEqual([{ code: 'invoice_required' }, { code: 'balance_due', amount: '95000.00' }]);

      // Delivery needs the invoice first, then full payment (or an authorised override).
      const noInvoice = await deliver(owner, s.id);
      expect(noInvoice.status).toBe(409);
      expect(noInvoice.body.error.code).toBe('invoice_required');
      const inv = await invoice(owner, s.id);
      expect(inv).toMatchObject({ type: 'invoice', status: 'issued' });
      expect((await owner.post(`/sales/${s.id}/documents`, { type: 'invoice' })).body.error.code).toBe('document_already_issued');
      const blocked = await deliver(owner, s.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('delivery_blocked');
      expect(blocked.body.error.details.blockers).toEqual([{ code: 'balance_due', amount: '95000.00' }]);

      // Overpaying the sale is refused; the exact balance is accepted.
      const over = await pay(owner, cust, s.id, '95000.01');
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('overpayment');
      expect((await pay(owner, cust, s.id, '95000.00')).status).toBe(201);
      expect((await getSale(s.id)).money).toMatchObject({ held: '115000.00', outstandingBeforeDelivery: '0.00', receivable: null });

      const d = await deliver(owner, s.id, { odometer: 45200 });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect(d.body).toMatchObject({ status: 'delivered', cogsAmount: '80000.00', grossProfit: '20000.00' });
      expect(d.body.money.receivable).toBe('0.00');
      expect(await vehicleStatus(vehicleId)).toBe('delivered');
      expect(await events('sale', s.id)).toEqual(['sale.recognized', 'sale.cogs', 'sale.credit_applied']);
      expect(await saleGl('1200', s.id)).toBe('0.00');
      expect(await saleGl('2100', s.id)).toBe('0.00');
      expect(await saleGl('4000', s.id)).toBe('-100000.00');
      expect(await saleGl('2200', s.id)).toBe('-15000.00');
      expect(await saleGl('5000', s.id)).toBe('80000.00');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: vehicleId })).toBe('0.00');

      // Documents: invoice + automatic delivery note; the invoice stands once delivered.
      const docs = d.body.documents as Array<{ id: string; type: string; status: string; number: string }>;
      expect(docs.map((x) => x.type).sort()).toEqual(['delivery_note', 'invoice']);
      const dn = await pool.query(`SELECT snapshot->'deliveryOdometer' AS o FROM sale_documents WHERE sale_id = $1 AND type = 'delivery_note'`, [s.id]);
      expect(dn.rows[0].o).toEqual({ value: 45200, unit: 'km' });
      const locked = await owner.post(`/sale-documents/${inv.id}/void`, { reason: 'Wrong address' });
      expect(locked.status).toBe(409);
      expect(locked.body.error.code).toBe('document_locked');
      const pdf = await owner.get(`/sale-documents/${inv.id}/pdf`).responseType('blob');
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      // Text is drawn with the embedded fonts: Arabic and Latin subsets in both weights. (A PDF
      // printed before the fonts were decoded came out blank apart from one bold Latin line.)
      const fonts = new Set((pdf.body as Buffer).toString('latin1').match(/\/BaseFont \/[A-Z]{6}\+IBMPlexSansArabic-(Regular|Bold)/g));
      expect(fonts.size).toBeGreaterThanOrEqual(4);

      // Delivering again is refused; the vehicle cannot be sold twice.
      expect((await deliver(owner, s.id)).body.error.code).toBe('invalid_sale_status');
      const again = await owner.post('/sales', { vehicleId, customerId: cust, agreedPrice: '115000.00' });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('vehicle_not_available');
    });

    it('voiding a payment applied at recognition re-opens the receivable', async () => {
      const cust = await customer('Void after delivery');
      const vehicleId = await stockVehicle('70000.00');
      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '115000.00' });
      await confirm(owner, s.id);
      const r1 = await pay(owner, cust, s.id, '15000.00');
      expect((await pay(owner, cust, s.id, '100000.00')).status).toBe(201);
      await invoice(owner, s.id);
      expect((await deliver(owner, s.id)).status).toBe(200);
      expect(await saleGl('1200', s.id)).toBe('0.00');

      const v = await owner.post(`/receipts/${r1.body.id}/void`, { reason: 'Cheque bounced' }, idem());
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(await saleGl('1200', s.id)).toBe('15000.00');
      expect(await saleGl('2100', s.id)).toBe('0.00');
      expect((await getSale(s.id)).money.receivable).toBe('15000.00');
      // A payment after recognition reduces the receivable directly.
      expect((await pay(owner, cust, s.id, '15000.00')).status).toBe(201);
      expect(await saleGl('1200', s.id)).toBe('0.00');
      expect(await saleGl('2100', s.id)).toBe('0.00');
    });

    it('delivery with an unpaid balance needs sales.deliver_with_balance and a reason', async () => {
      const cust = await customer('Balance customer');
      const vehicleId = await stockVehicle();
      const manager = await addMember(app, t, 'sales_manager');
      const s = await newSale(manager.client, { vehicleId, customerId: cust, agreedPrice: '115000.00' });
      await confirm(manager.client, s.id);
      await invoice(manager.client, s.id);
      expect((await pay(manager.client, cust, s.id, '100000.00')).status).toBe(201);
      const denied = await deliver(manager.client, s.id, { overrideReason: 'Customer is a fleet account' });
      expect(denied.status).toBe(403);
      const ok = await deliver(owner, s.id, { overrideReason: 'Fleet account, balance on 30-day terms' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ status: 'delivered', deliveryOverrideReason: 'Fleet account, balance on 30-day terms' });
      expect(ok.body.money.receivable).toBe('15000.00');
      const audit = await pool.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 ORDER BY seq`, [t.tenantId, s.id]);
      expect(audit.rows.map((r) => r.action)).toContain('sale.delivered_with_balance');
      expect((await pay(owner, cust, s.id, '15000.00')).status).toBe(201);
      expect(await saleGl('1200', s.id)).toBe('0.00');
    });
  });

  describe('pricing approval and access', () => {
    it('a discount beyond the seller limit waits for approval; the seller cannot approve their own sale', async () => {
      const cust = await customer('Discount customer');
      const vehicleId = await stockVehicle();
      const manager = await addMember(app, t, 'sales_manager');
      // 9% off asking: over the sales manager's 7% limit but above the floor.
      const s = await newSale(manager.client, { vehicleId, customerId: cust, agreedPrice: '109200.00' });
      expect(s).toMatchObject({ status: 'pending_approval', approvalPermission: 'sales.approve_below_floor' });
      const vehicleId2 = await stockVehicle();
      const s2 = await newSale(manager.client, { vehicleId: vehicleId2, customerId: cust, agreedPrice: '111000.00' });
      expect(s2).toMatchObject({ status: 'pending_approval', approvalPermission: 'sales.approve_discount', discountPct: '7.5000' });

      const early = await manager.client.post(`/sales/${s2.id}/confirm`, { version: s2.version }, idem());
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('invalid_sale_status');
      // The manager holds sales.approve_discount but made the sale: maker-checker refuses.
      const self = await manager.client.post(`/sales/${s2.id}/approve`, {});
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe('self_approval_forbidden');
      const inbox = await checker.get('/approvals');
      expect(inbox.status).toBe(200);
      const item = (inbox.body as Array<{ entityId: string; type: string; canDecide: boolean }>).find((x) => x.entityId === s2.id);
      expect(item).toMatchObject({ type: 'sale_discount', canDecide: true });
      const ok = await checker.post(`/sales/${s2.id}/approve`, { note: 'Loyal customer' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ status: 'approved' });
      await confirm(manager.client, s2.id);

      // Changing the price of an approved sale needs a fresh decision.
      const rej = await checker.post(`/sales/${s.id}/reject`, { reason: 'Below floor without reason' });
      expect(rej.status).toBe(200);
      expect(rej.body.status).toBe('draft');
      const fixed = await manager.client.patch(`/sales/${s.id}`, { agreedPrice: '112000.00', version: rej.body.version });
      expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
      expect(fixed.body.status).toBe('draft');
      const stale = await manager.client.patch(`/sales/${s.id}`, { notes: 'x', version: rej.body.version });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('version_conflict');
      const cancel = await manager.client.post(`/sales/${s.id}/cancel`, { reason: 'Customer walked away', version: fixed.body.version }, idem());
      expect(cancel.status).toBe(200);
      expect(await vehicleStatus(vehicleId)).toBe('available');
    });

    it('sales reps see and act on only their own sales; permissions are enforced on every step', async () => {
      const rep = await addMember(app, t, 'sales_rep');
      const rep2 = await addMember(app, t, 'sales_rep');
      // Reps see only the customers they own.
      const cust = (await createCustomer(rep.client, { fullName: 'Rep customer' })).id as string;
      expect((await rep.client.post('/sales', { vehicleId: await stockVehicle(), customerId: await customer('Not mine'), agreedPrice: '118000.00' })).status).toBe(404);
      const vehicleId = await stockVehicle();
      const s = await newSale(rep.client, { vehicleId, customerId: cust, agreedPrice: '118000.00' });
      expect(s.status).toBe('draft');
      expect(s.costAtConfirmation).toBeNull();
      expect((await rep2.client.get(`/sales/${s.id}`)).status).toBe(404);
      expect(((await rep2.client.get('/sales')).body.items as Array<{ id: string }>).some((x) => x.id === s.id)).toBe(false);
      expect(((await rep.client.get('/sales')).body.items as Array<{ id: string }>).some((x) => x.id === s.id)).toBe(true);
      expect((await rep.client.post(`/sales/${s.id}/confirm`, { version: s.version }, idem())).status).toBe(403);
      expect((await rep.client.post(`/sales/${s.id}/documents`, { type: 'contract' })).status).toBe(403);
      expect((await rep.client.post(`/sales/${s.id}/cancel`, { reason: 'Changed mind', version: s.version }, idem())).status).toBe(403);
      // Selling on behalf of someone else needs leads.assign.
      const other = await stockVehicle();
      const behalf = await rep.client.post('/sales', { vehicleId: other, customerId: cust, agreedPrice: '118000.00', salespersonId: rep2.userId });
      expect(behalf.status).toBe(403);
      await confirm(owner, s.id);
      // Cancelling a confirmed sale needs sales.cancel_confirmed (the sales manager lacks it).
      const manager = await addMember(app, t, 'sales_manager');
      const deny = await manager.client.post(`/sales/${s.id}/cancel`, { reason: 'Customer changed mind', version: await version(s.id) }, idem());
      expect(deny.status).toBe(403);
      const cancelled = await owner.post(`/sales/${s.id}/cancel`, { reason: 'Customer changed mind', version: await version(s.id) }, idem());
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(await vehicleStatus(vehicleId)).toBe('available');
    });

    it('another tenant cannot see or act on sales, plans, documents or commissions (404)', async () => {
      const cust = await customer('Isolation customer');
      const vehicleId = await stockVehicle();
      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '116000.00' });
      await confirm(owner, s.id);
      const inv = await invoice(owner, s.id);
      const other = await createTenant(app, await createPlatformAdmin(app));
      expect((await other.owner.get(`/sales/${s.id}`)).status).toBe(404);
      expect((await other.owner.post(`/sales/${s.id}/confirm`, { version: 1 }, idem())).status).toBe(404);
      expect((await other.owner.post(`/sales/${s.id}/documents`, { type: 'contract' })).status).toBe(404);
      expect((await other.owner.get(`/sale-documents/${inv.id}/pdf`)).status).toBe(404);
      expect((await other.owner.post(`/sale-documents/${inv.id}/void`, { reason: 'not mine' })).status).toBe(404);
      const otherCash = await createCashAccount(other.owner, { openingBalance: '100.00' });
      const otherCust = (await createCustomer(other.owner, { fullName: 'Other tenant customer' })).id;
      const foreign = await other.owner.post(
        '/receipts',
        { customerId: otherCust, cashAccountId: otherCash.id, amount: '10.00', method: 'cash', allocations: [{ targetType: 'sale', targetId: s.id, amountBase: '10.00' }] },
        idem(),
      );
      expect(foreign.status).toBe(404);
      expect(((await other.owner.get('/sales')).body.items as unknown[]).length).toBe(0);
    });
  });

  describe('concurrency and idempotency', () => {
    it('concurrent sales of one vehicle: exactly one draft is created', async () => {
      const cust = await customer('Race customer');
      const vehicleId = await stockVehicle();
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => owner.post('/sales', { vehicleId, customerId: cust, agreedPrice: '118000.00' })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) expect(['vehicle_not_available', 'vehicle_already_sold']).toContain(r.body.error.code);
      const n = await pool.query(`SELECT count(*)::int AS n FROM sales WHERE vehicle_id = $1`, [vehicleId]);
      expect(n.rows[0].n).toBe(1);
    });

    it('a retried payment or confirmation with the same Idempotency-Key happens once', async () => {
      const cust = await customer('Retry customer');
      const vehicleId = await stockVehicle();
      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '118000.00' });
      const key = idem();
      const body = { customerId: cust, cashAccountId: cash.id, amount: '5000.00', method: 'cash', allocations: [{ targetType: 'sale', targetId: s.id, amountBase: '5000.00' }] };
      const [a, b] = [await owner.post('/receipts', body, key), await owner.post('/receipts', body, key)];
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.id).toBe(a.body.id);
      const ckey = idem();
      const c1 = await owner.post(`/sales/${s.id}/confirm`, { version: s.version }, ckey);
      const c2 = await owner.post(`/sales/${s.id}/confirm`, { version: s.version }, ckey);
      expect([c1.status, c2.status]).toEqual([200, 200]);
      expect(c2.headers['idempotent-replayed']).toBe('true');
      // Concurrent payments never exceed what is due.
      const due = (await getSale(s.id)).money.outstandingBeforeDelivery as string;
      expect(due).toBe('113000.00');
      const race = await Promise.all([1, 2, 3].map(() => pay(owner, cust, s.id, '60000.00')));
      expect(race.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect((await getSale(s.id)).money.held).toBe('65000.00');
    });
  });

  describe('deposits and trade-ins', () => {
    it('a reservation deposit transfers to the sale for the same customer only', async () => {
      const cust = await customer('Deposit customer');
      const stranger = await customer('Someone else');
      const vehicleId = await stockVehicle();
      const res = await owner.post(
        '/reservations',
        { vehicleId, customerId: cust, days: 7, deposit: { cashAccountId: cash.id, amount: '5000.00', method: 'cash' } },
        idem(),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const blocked = await owner.post('/sales', { vehicleId, customerId: stranger, agreedPrice: '118000.00' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('vehicle_reserved');

      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '115000.00' });
      expect(s.reservationId).toBe(res.body.id);
      // The reservation cannot be cancelled while the sale draft uses it.
      const rc = await owner.post(`/reservations/${res.body.id}/cancel`, { reason: 'Mistake' }, idem());
      expect(rc.status).toBe(409);
      expect(rc.body.error.code).toBe('reservation_in_sale');

      const c = await confirm(owner, s.id);
      expect(c).toMatchObject({ depositTransferred: '5000.00' });
      expect(c.money).toMatchObject({ held: '5000.00', outstandingBeforeDelivery: '110000.00' });
      expect((await owner.get(`/reservations/${res.body.id}`)).body).toMatchObject({ status: 'converted', saleId: s.id });
      // The deposit receipt now belongs to the sale and cannot be voided on its own.
      const v = await owner.post(`/receipts/${res.body.receipt.id}/void`, { reason: 'mistake' }, idem());
      expect(v.status).toBe(409);
      expect(v.body.error.code).toBe('receipt_applied');

      expect((await pay(owner, cust, s.id, '110000.00')).status).toBe(201);
      await invoice(owner, s.id);
      expect((await deliver(owner, s.id)).status).toBe(200);
      expect(await glBalance(pool, t.tenantId, '2100', { col: 'customer_id', id: cust })).toBe('0.00');
      expect(await saleGl('1200', s.id)).toBe('0.00');
    });

    it('a trade-in enters stock at the agreed value and is credited to the customer', async () => {
      const cust = await customer('Trade-in customer');
      const vehicleId = await stockVehicle();
      const ids = await catalogIds(owner);
      const tradeVehicle = { ...ids, modelYear: 2018, odometerValue: 120000, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'Silver' };
      const tooMuch = await owner.post('/sales', {
        vehicleId,
        customerId: cust,
        agreedPrice: '115000.00',
        tradeIns: [{ agreedValue: '115000.01', vehicle: tradeVehicle }],
      });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.error.code).toBe('credit_exceeds_due');

      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '115000.00', tradeIns: [{ agreedValue: '30000.00', vehicle: tradeVehicle }] });
      expect(s.tradeIns).toHaveLength(1);
      expect(s.tradeIns[0]).toMatchObject({ status: 'pending', agreedValue: '30000.00' });
      const c = await confirm(owner, s.id);
      expect(c).toMatchObject({ tradeInCredit: '30000.00' });
      expect(c.money).toMatchObject({ held: '30000.00', outstandingBeforeDelivery: '85000.00' });
      const ti = c.tradeIns[0];
      expect(ti.status).toBe('received');
      expect(await vehicleStatus(ti.vehicleId)).toBe('incoming');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: ti.vehicleId })).toBe('30000.00');
      expect(await saleGl('2100', s.id)).toBe('-30000.00');
      expect(await glBalance(pool, t.tenantId, '2000', { col: 'vehicle_id', id: ti.vehicleId })).toBe('0.00');

      expect((await pay(owner, cust, s.id, '85000.00')).status).toBe(201);
      await invoice(owner, s.id);
      expect((await deliver(owner, s.id)).status).toBe(200);
      expect(await saleGl('1200', s.id)).toBe('0.00');
      expect(await saleGl('2100', s.id)).toBe('0.00');
    });
  });

  describe('installments', () => {
    it('schedule at confirmation, activation at delivery, allocation with finance income release, early settlement with waiver', async () => {
      const cust = await customer('Installment customer');
      const vehicleId = await stockVehicle();
      const terms = { method: 'flat', annualRatePct: '10', count: 12, frequencyMonths: 1, firstDueDate: addMonths(today, 1) };
      const off = await owner.post('/sales/preview', { vehicleId, customerId: cust, agreedPrice: '115000.00', paymentType: 'installments', downPayment: '15000.00', installmentTerms: terms });
      expect(off.status).toBe(422);
      expect(off.body.error.code).toBe('installments_disabled');
      await setSettings({ installments: INSTALLMENTS_ON });

      const missing = await owner.post('/sales', { vehicleId, customerId: cust, agreedPrice: '115000.00', paymentType: 'installments' });
      expect(missing.status).toBe(422);
      const all = await owner.post('/sales/preview', { vehicleId, customerId: cust, agreedPrice: '115000.00', paymentType: 'installments', downPayment: '115000.00', installmentTerms: terms });
      expect(all.body.error.code).toBe('nothing_financed');
      const preview = await owner.post('/sales/preview', { vehicleId, customerId: cust, agreedPrice: '115000.00', paymentType: 'installments', downPayment: '15000.00', installmentTerms: terms });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body).toMatchObject({ financedAmount: '100000.00', dueBeforeDelivery: '15000.00' });
      expect(preview.body.schedule.totals).toMatchObject({ principal: '100000.00', interest: '10000.00', total: '110000.00' });

      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '115000.00', paymentType: 'installments', downPayment: '15000.00', installmentTerms: terms });
      const c = await confirm(owner, s.id);
      expect(c.installmentPlan).toMatchObject({ status: 'scheduled', totalAmount: '110000.00', count: 12, method: 'flat' });
      const planId = c.installmentPlan.id as string;
      // Not collectable before the sale is recognised.
      const tooEarly = await pay(owner, cust, planId, '100.00', 'installment');
      expect(tooEarly.status).toBe(409);
      expect(tooEarly.body.error.code).toBe('not_receivable');
      // The sale bucket only takes the down payment.
      expect((await pay(owner, cust, s.id, '15000.01')).body.error.code).toBe('overpayment');
      expect((await pay(owner, cust, s.id, '15000.00')).status).toBe(201);
      await invoice(owner, s.id);
      const d = await deliver(owner, s.id);
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect(d.body.installmentPlan.status).toBe('active');
      // AR = gross + interest − down payment; interest deferred in 2400.
      expect(await saleGl('1200', s.id)).toBe('110000.00');
      expect(await saleGl('2400', s.id)).toBe('-10000.00');
      expect(await saleGl('4000', s.id)).toBe('-100000.00');

      const plan = (await owner.get(`/installment-plans/${planId}`)).body;
      expect(plan).toMatchObject({ status: 'active', outstanding: '110000.00', overdueAmount: '0.00' });
      expect(plan.lines).toHaveLength(12);
      const first = plan.lines[0] as { totalDue: string; interestDue: string; principalDue: string };
      const r1 = await pay(owner, cust, planId, first.totalDue, 'installment');
      expect(r1.status, JSON.stringify(r1.body)).toBe(201);
      const alloc = await pool.query(`SELECT principal::text, interest::text, fees::text FROM installment_allocations WHERE receipt_id = $1`, [r1.body.id]);
      expect(alloc.rows).toEqual([{ principal: first.principalDue, interest: first.interestDue, fees: '0.00' }]);
      expect(await saleGl('4100', s.id)).toBe(`-${first.interestDue}`);
      expect(await saleGl('2400', s.id)).toBe((-(10000 - Number(first.interestDue))).toFixed(2));
      expect((await pay(owner, cust, planId, '200000.00', 'installment')).body.error.code).toBe('overpayment');

      // Early settlement: the flat-rate default charges all future interest; waive_all forgives it.
      const q1 = await owner.get(`/installment-plans/${planId}/settlement-quote`);
      expect(q1.status).toBe(200);
      expect(q1.body).toMatchObject({ policy: 'charge_all', waivedInterest: '0.00' });
      const q2 = await owner.get(`/installment-plans/${planId}/settlement-quote?futureInterestPolicy=waive_all`);
      const principalLeft = (100000 - Number(first.principalDue)).toFixed(2);
      const waived = (10000 - Number(first.interestDue)).toFixed(2);
      expect(q2.body).toMatchObject({ total: principalLeft, waivedInterest: waived });
      const stale = await owner.post(`/installment-plans/${planId}/settle`, { cashAccountId: cash.id, method: 'cash', futureInterestPolicy: 'waive_all', expectedTotal: '1.00' }, idem());
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('quote_changed');
      const settled = await owner.post(
        `/installment-plans/${planId}/settle`,
        { cashAccountId: cash.id, method: 'cash', futureInterestPolicy: 'waive_all', expectedTotal: principalLeft },
        idem(),
      );
      expect(settled.status, JSON.stringify(settled.body)).toBe(201);
      expect(settled.body.plan).toMatchObject({ status: 'settled', waivedInterest: waived });
      expect(await saleGl('1200', s.id)).toBe('0.00');
      expect(await saleGl('2400', s.id)).toBe('0.00');
      expect(await saleGl('4100', s.id)).toBe(`-${first.interestDue}`);
      expect((await owner.get(`/installment-plans/${planId}`)).body.outstanding).toBe('0.00');
      // A settled plan's payments stand.
      const v = await owner.post(`/receipts/${r1.body.id}/void`, { reason: 'mistake' }, idem());
      expect(v.status).toBe(409);
      expect(v.body.error.code).toBe('plan_settled');
    });

    it('returning an installment sale unwinds the plan: collected money and released interest go back, everything is refundable', async () => {
      const cust = await customer('Installment return customer');
      const vehicleId = await stockVehicle('80000.00');
      const terms = { method: 'flat', annualRatePct: '12', count: 10, frequencyMonths: 1, firstDueDate: addMonths(today, 1) };
      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '115000.00', paymentType: 'installments', downPayment: '35000.00', installmentTerms: terms });
      const c = await confirm(owner, s.id);
      const planId = c.installmentPlan.id as string;
      expect((await pay(owner, cust, s.id, '35000.00')).status).toBe(201);
      await invoice(owner, s.id);
      expect((await deliver(owner, s.id)).status).toBe(200);
      const plan = (await owner.get(`/installment-plans/${planId}`)).body;
      const first = plan.lines[0] as { totalDue: string; interestDue: string };
      expect((await pay(owner, cust, planId, first.totalDue, 'installment')).status).toBe(201);
      expect(await saleGl('4100', s.id)).toBe(`-${first.interestDue}`);

      const ret = await owner.post(`/sales/${s.id}/return`, { reason: 'Customer returned within the trial week', version: await version(s.id) }, idem());
      expect(ret.status, JSON.stringify(ret.body)).toBe(200);
      expect(ret.body.installmentPlan.status).toBe('cancelled');
      const refundable = (35000 + Number(first.totalDue)).toFixed(2);
      expect(ret.body.money.refundable).toBe(refundable);
      for (const acct of ['1200', '2400', '4100', '4000', '2200', '5000']) expect(await saleGl(acct, s.id), acct).toBe('0.00');
      expect(await saleGl('2100', s.id)).toBe(`-${refundable}`);
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: vehicleId })).toBe('80000.00');
      const closed = (await owner.get(`/installment-plans/${planId}`)).body;
      expect(closed).toMatchObject({ status: 'cancelled', outstanding: '0.00', overdueAmount: '0.00' });
      expect((await pay(owner, cust, planId, '10.00', 'installment')).body.error.code).toBe('not_receivable');
    });

    it('the reminder job notifies the salesperson once per installment state (no late fees)', async () => {
      const cust = await customer('Reminder customer');
      const vehicleId = await stockVehicle();
      const terms = { method: 'zero_interest', annualRatePct: '0', count: 3, frequencyMonths: 1, firstDueDate: addDays(today, 2) };
      const s = await newSale(owner, { vehicleId, customerId: cust, agreedPrice: '115000.00', paymentType: 'installments', downPayment: '55000.00', installmentTerms: terms });
      await confirm(owner, s.id);
      expect((await pay(owner, cust, s.id, '55000.00')).status).toBe(201);
      await invoice(owner, s.id);
      expect((await deliver(owner, s.id)).status).toBe(200);
      const jobs = app.get(JobsService);
      await jobs.runJob('installments.reminders', { tenantId: t.tenantId });
      await jobs.runJob('installments.reminders', { tenantId: t.tenantId });
      const n = await pool.query(`SELECT type, count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND entity_id = $2 GROUP BY type`, [t.tenantId, (await getSale(s.id)).installmentPlan.id]);
      expect(n.rows).toEqual([{ type: 'installment.due_soon', n: 1 }]);
      expect(await saleGl('4100', s.id)).toBe('0.00');
    });
  });

  describe('cancellation, returns, refunds and commissions', () => {
    it('on_confirmation recognition, then cancellation unwinds revenue and COGS and the payments are refunded (maker-checker)', async () => {
      // The recognition policy is fixed once a company has transactions: use a fresh company.
      const te = await createTenant(app, await createPlatformAdmin(app));
      const o = te.owner;
      await setSettings({ revenueRecognition: 'on_confirmation' }, o);
      const chk = await secondApprover(o);
      const sup = await createSupplier(o);
      const box = await createCashAccount(o, { name: 'Main safe', openingBalance: '5000.00' });
      const acq = await createAcquisition(o, te.branchId, sup.id, { price: '80000.00', approver: chk });
      await makeAvailable(o, acq.vehicleId, '120000.00', '110000.00');
      const vehicleId = acq.vehicleId;
      const cust = (await createCustomer(o, { fullName: 'Cancel customer' })).id as string;

      const s = await newSale(o, { vehicleId, customerId: cust, agreedPrice: '115000.00' });
      expect((await pay(o, cust, s.id, '30000.00', 'sale', box.id)).status).toBe(201);
      const c = await confirm(o, s.id);
      expect(c.recognizedAt).toBeTruthy();
      expect(await saleGl('1200', s.id)).toBe('85000.00');
      expect(await saleGl('4000', s.id)).toBe('-100000.00');
      expect(await saleGl('5000', s.id)).toBe('80000.00');
      expect((await o.post(`/sales/${s.id}/documents`, { type: 'contract' })).status).toBe(201);
      await invoice(o, s.id);
      // After recognition a payment reduces the receivable directly.
      const late = await pay(o, cust, s.id, '5000.00', 'sale', box.id);
      expect(late.status).toBe(201);
      expect(await saleGl('1200', s.id)).toBe('80000.00');

      const cancel = await o.post(`/sales/${s.id}/cancel`, { reason: 'Financing fell through', version: await version(s.id, o) }, idem());
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
      expect(cancel.body).toMatchObject({ status: 'cancelled' });
      expect(cancel.body.money.refundable).toBe('35000.00');
      expect(await saleGl('1200', s.id)).toBe('0.00');
      expect(await saleGl('4000', s.id)).toBe('0.00');
      expect(await saleGl('2200', s.id)).toBe('0.00');
      expect(await saleGl('5000', s.id)).toBe('0.00');
      expect(await saleGl('2100', s.id)).toBe('-35000.00');
      expect(await glBalance(pool, te.tenantId, '1300', { col: 'vehicle_id', id: vehicleId })).toBe('80000.00');
      expect(await vehicleStatus(vehicleId, o)).toBe('available');
      const docs = cancel.body.documents as Array<{ type: string; status: string }>;
      expect(docs.find((x) => x.type === 'contract')?.status).toBe('voided');
      expect(docs.find((x) => x.type === 'credit_note')?.status).toBe('issued');

      // Voiding the payment made after recognition takes it out of the credit, not the receivable.
      const voided = await o.post(`/receipts/${late.body.id}/void`, { reason: 'Card charge disputed' }, idem());
      expect(voided.status, JSON.stringify(voided.body)).toBe(200);
      expect(await saleGl('1200', s.id)).toBe('0.00');
      expect(await saleGl('2100', s.id)).toBe('-30000.00');
      expect((await getSale(s.id, o)).money.refundable).toBe('30000.00');

      // Refund: over-asking refused; requester cannot approve; another approver can; cashier pays.
      const over = await o.post('/refunds', { sourceType: 'sale', sourceId: s.id, amountBase: '30000.01', reason: 'Refund' }, idem());
      expect(over.status).toBe(409);
      const req = await o.post('/refunds', { sourceType: 'sale', sourceId: s.id, amountBase: '30000.00', reason: 'Sale cancelled' }, idem());
      expect(req.status, JSON.stringify(req.body)).toBe(201);
      expect((await o.post(`/refunds/${req.body.id}/approve`, {})).body.error.code).toBe('self_approval_forbidden');
      expect((await chk.post(`/refunds/${req.body.id}/approve`, { note: 'OK' })).status).toBe(200);
      const paid = await o.post(`/refunds/${req.body.id}/pay`, { cashAccountId: box.id, method: 'cash' }, idem());
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect(await saleGl('2100', s.id)).toBe('0.00');
      expect((await getSale(s.id, o)).money.refundable).toBe('0.00');

      // The vehicle can be sold again.
      const again = await newSale(o, { vehicleId, customerId: cust, agreedPrice: '118000.00' });
      expect(again.status).toBe('draft');
      expect((await o.post(`/sales/${again.id}/cancel`, { reason: 'Test cleanup', version: again.version }, idem())).status).toBe(200);
      await assertLedgerIntegrity(pool, te.tenantId);
    });

    it('commission: earned when paid and delivered, approved by someone else, paid, and clawed back on return', async () => {
      const policy = await owner.post('/commission-policies', { code: 'sales_ten', name: 'Ten percent of profit', rule: { type: 'pct_of_profit', ratePct: '10' } });
      expect(policy.status, JSON.stringify(policy.body)).toBe(201);
      const seller = await addMember(app, t, 'sales_manager');
      const prof = await owner.put(`/employees/${seller.userId}/profile`, { commissionPolicyId: policy.body.id, employeeCode: 'S-100' });
      expect(prof.status, JSON.stringify(prof.body)).toBe(200);

      const cust = await customer('Commission customer');
      const vehicleId = await stockVehicle('80000.00');
      const s = await newSale(seller.client, { vehicleId, customerId: cust, agreedPrice: '115000.00' });
      const c = await confirm(seller.client, s.id);
      expect(c.commission).toMatchObject({ status: 'expected', amount: '2000.00' });
      expect((await pay(seller.client, cust, s.id, '115000.00')).status).toBe(201);
      // Fully paid but not yet recognised: still expected.
      expect((await getSale(s.id, seller.client)).commission.status).toBe('expected');
      await invoice(seller.client, s.id);
      expect((await deliver(seller.client, s.id)).status).toBe(200);
      const list = await seller.client.get(`/commissions?saleId=${s.id}`);
      expect(list.status).toBe(200);
      const com = list.body.items[0];
      expect(com).toMatchObject({ status: 'earned', amount: '2000.00', userId: seller.userId });
      expect(await glBalance(pool, t.tenantId, '6100')).not.toBe('0.00');
      expect((await seller.client.post(`/commissions/${com.id}/approve`, {})).status).toBe(403);
      const rep = await addMember(app, t, 'sales_rep');
      expect((await rep.client.get(`/commissions/${com.id}`)).status).toBe(404);
      const unapprovedPay = await owner.post(`/commissions/${com.id}/pay`, { cashAccountId: cash.id, method: 'cash' }, idem());
      expect(unapprovedPay.body.error.code).toBe('commission_not_approved');
      expect((await owner.post(`/commissions/${com.id}/approve`, {})).status).toBe(200);
      const paid = await owner.post(`/commissions/${com.id}/pay`, { cashAccountId: cash.id, method: 'cash' }, idem());
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect(await events('commission', com.id)).toEqual(['commission.earned', 'commission.paid']);
      const payable = await pool.query(
        `SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.source_type = 'commission' AND e.source_id = $1 AND l.account_code = '2300'`,
        [com.id],
      );
      expect(payable.rows[0].b).toBe('0.00');

      // Return: revenue and COGS reversed, a credit note issued, the paid commission clawed back.
      expect((await seller.client.post(`/sales/${s.id}/return`, { reason: 'Gearbox fault', version: await version(s.id) }, idem())).status).toBe(403);
      const ret = await owner.post(`/sales/${s.id}/return`, { reason: 'Gearbox fault found in week one', version: await version(s.id) }, idem());
      expect(ret.status, JSON.stringify(ret.body)).toBe(200);
      expect(ret.body).toMatchObject({ status: 'returned' });
      expect(ret.body.money.refundable).toBe('115000.00');
      expect(await vehicleStatus(vehicleId)).toBe('returned');
      expect((ret.body.documents as Array<{ type: string }>).some((x) => x.type === 'credit_note')).toBe(true);
      expect(await saleGl('4000', s.id)).toBe('0.00');
      expect(await saleGl('1200', s.id)).toBe('0.00');
      expect(await saleGl('2100', s.id)).toBe('-115000.00');
      expect(await glBalance(pool, t.tenantId, '1300', { col: 'vehicle_id', id: vehicleId })).toBe('80000.00');
      expect((await owner.get(`/commissions/${com.id}`)).body.status).toBe('clawback');
      expect(await events('commission', com.id)).toEqual(['commission.earned', 'commission.paid', 'commission.clawback']);
      const claw = await pool.query(
        `SELECT l.account_code AS a, (l.debit - l.credit)::numeric(18,2)::text AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.source_type = 'commission' AND e.source_id = $1 AND e.event = 'commission.clawback' ORDER BY l.line_no`,
        [com.id],
      );
      expect(claw.rows).toEqual([
        { a: '1400', b: '2000.00' },
        { a: '6100', b: '-2000.00' },
      ]);
    });
  });

  describe('external finance', () => {
    it('delivery waits for the provider approval; the provider payment clears the receivable', async () => {
      const cust = await customer('Bank-financed customer');
      const vehicleId = await stockVehicle();
      const s = await newSale(owner, {
        vehicleId,
        customerId: cust,
        agreedPrice: '115000.00',
        paymentType: 'external_finance',
        externalFinance: { provider: 'Example Bank', amount: '90000.00' },
      });
      await confirm(owner, s.id);
      await invoice(owner, s.id);
      expect((await pay(owner, cust, s.id, '25000.00')).status).toBe(201);
      const blocked = await deliver(owner, s.id);
      expect(blocked.body.error.details.blockers).toEqual([{ code: 'finance_not_approved' }, { code: 'balance_due', amount: '90000.00' }]);
      const ok = await owner.post(`/sales/${s.id}/external-finance`, { status: 'approved', reference: 'EB-123' });
      expect(ok.status).toBe(200);
      expect(ok.body.externalFinance).toMatchObject({ status: 'approved', reference: 'EB-123' });
      const d = await deliver(owner, s.id);
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect(d.body.money.receivable).toBe('90000.00');
      expect((await pay(owner, cust, s.id, '90000.00')).status).toBe(201);
      expect(await saleGl('1200', s.id)).toBe('0.00');
    });
  });

  describe('daily cash closing', () => {
    it('closes a day with a shortage, locks that day and earlier ones, and only the latest closing can be reopened', async () => {
      const box = await createCashAccount(owner, { name: 'Closing box', openingBalance: '1000.00' });
      const yesterday = addDays(today, -1);
      const exp = await owner.get(`/cash-accounts/${box.id}/closings/expected?date=${yesterday}`);
      expect(exp.status, JSON.stringify(exp.body)).toBe(200);
      expect(exp.body.expectedBalance).toBe('1000.00');

      // A closer without cash.adjust may only close an exact count.
      const closer = await addMemberWithPermissions(app, t, ['cash.read', 'cash.close']);
      const denied = await closer.client.post(`/cash-accounts/${box.id}/closings`, { businessDate: yesterday, countedBalance: '990.00' }, idem());
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      const exact = await closer.client.post(`/cash-accounts/${box.id}/closings`, { businessDate: yesterday, countedBalance: '1000.00' }, idem());
      expect(exact.status, JSON.stringify(exact.body)).toBe(201);
      expect(exact.body).toMatchObject({ difference: '0.00', status: 'closed' });

      // Today: counted 10 short → 6200 debited and the cash book follows the count.
      const short = await owner.post(`/cash-accounts/${box.id}/closings`, { businessDate: today, countedBalance: '990.00', notes: 'Short by 10' }, idem());
      expect(short.status, JSON.stringify(short.body)).toBe(201);
      expect(short.body).toMatchObject({ expectedBalance: '1000.00', countedBalance: '990.00', difference: '-10.00' });
      expect(await glBalance(pool, t.tenantId, '1100', { col: 'cash_account_id', id: box.id })).toBe('990.00');
      const os = await pool.query(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.source_type = 'cash_closing' AND e.source_id = $1 AND l.account_code = '6200'`,
        [short.body.id],
      );
      expect(os.rows[0].b).toBe('10.00');
      expect((await owner.post(`/cash-accounts/${box.id}/closings`, { businessDate: today, countedBalance: '990.00' }, idem())).body.error.code).toBe('cash_day_closed');
      expect((await owner.post(`/cash-accounts/${box.id}/closings`, { businessDate: addDays(today, 1), countedBalance: '990.00' }, idem())).status).toBe(422);

      // No movement can land on a closed day.
      const cust = await customer('Closed-day customer');
      const late = await owner.post('/receipts', { customerId: cust, cashAccountId: box.id, amount: '50.00', method: 'cash' }, idem());
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('cash_day_closed');

      // Reopen: needs cash.reopen; only the latest closing; then the day accepts movements again.
      const manager = await addMember(app, t, 'branch_manager');
      expect((await manager.client.post(`/cash-closings/${short.body.id}/reopen`, { reason: 'Recount needed' })).status).toBe(403);
      const notLatest = await owner.post(`/cash-closings/${exact.body.id}/reopen`, { reason: 'Recount needed' });
      expect(notLatest.status).toBe(409);
      expect(notLatest.body.error.code).toBe('not_latest_closing');
      const reopened = await owner.post(`/cash-closings/${short.body.id}/reopen`, { reason: 'Found the missing 10 in the drawer' });
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
      expect(reopened.body.status).toBe('reopened');
      expect((await owner.post('/receipts', { customerId: cust, cashAccountId: box.id, amount: '50.00', method: 'cash' }, idem())).status).toBe(201);
      // Yesterday stays closed.
      const back = await owner.post('/receipts', { customerId: cust, cashAccountId: box.id, amount: '50.00', method: 'cash', receivedAt: yesterday }, idem());
      expect(back.status).toBe(409);
      expect(back.body.error.code).toBe('cash_day_closed');
      const list = await owner.get(`/cash-accounts/${box.id}/closings`);
      expect((list.body as Array<{ status: string }>).map((x) => x.status)).toEqual(['reopened', 'closed']);
    });
  });
});
