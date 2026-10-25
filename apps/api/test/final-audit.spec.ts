import type { INestApplication } from '@nestjs/common';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { Pool } from 'pg';
import pinoHttp, { type Options as PinoHttpOptions } from 'pino-http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition } from '../src/common/content-disposition';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { RETENTION_JOB } from '../src/modules/privacy/privacy.service';
import {
  addMemberWithPermissions,
  catalogIds,
  createAcquisition,
  createBranch,
  createCashAccount,
  createCustomer,
  createSupplier,
  createVehicle,
  makeAvailable,
  PDF,
  secondApprover,
  setFxReferences,
} from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

/**
 * Regression tests for the final audit (2026-10-25, D-054). Each test reproduces the auditor's
 * probe (scratchpad zz-audit-probe*.spec.ts) and asserts the attack is now refused.
 */
describe('final audit (D-054)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Client;
  let t: TestTenant;

  beforeAll(async () => {
    app = await getApp();
    pool = ownerPool();
    admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  type Inbox = Array<{ entityId: string; type: string; summary: string; payload: Record<string, unknown> | null }>;
  const inboxItem = async (c: Client, entityId: string) => ((await c.get('/approvals')).body as Inbox).find((x) => x.entityId === entityId);

  describe('A1: the retention period needs privacy.manage and company-wide scope', () => {
    it('settings.manage alone (branch-limited or company-wide) cannot switch on retention; the job then redacts nothing', async () => {
      const ins = await pool.query(
        `INSERT INTO showroom_inquiries (tenant_id, kind, name, phone, phone_normalized, email, message, consent_at, created_at)
         VALUES ($1, 'inquiry', 'Visitor Kept For Dispute', '+966500000077', '966500000077', 'keep@example.org', 'evidence', now() - interval '45 days', now() - interval '45 days')
         RETURNING id`,
        [t.tenantId],
      );
      const branchSettings = await addMemberWithPermissions(app, t, ['settings.manage', 'settings.read'], { allBranches: false, branchIds: [t.branchId] });
      const companySettings = await addMemberWithPermissions(app, t, ['settings.manage', 'settings.read'], { allBranches: true });
      const branchPrivacy = await addMemberWithPermissions(app, t, ['settings.manage', 'settings.read', 'privacy.manage'], {
        allBranches: false,
        branchIds: [t.branchId],
      });
      for (const c of [branchSettings.client, companySettings.client]) {
        const res = await c.patch('/company', { settings: { privacy: { inquiryRetentionDays: 30 } } });
        expect([res.status, res.body.error?.code]).toEqual([403, 'forbidden']);
      }
      const scoped = await branchPrivacy.client.patch('/company', { settings: { privacy: { inquiryRetentionDays: 30 } } });
      expect([scoped.status, scoped.body.error?.code]).toEqual([403, 'company_scope_required']);

      const stored = await pool.query(`SELECT settings->'privacy' AS p FROM tenants WHERE id = $1`, [t.tenantId]);
      expect(stored.rows[0].p?.inquiryRetentionDays ?? null).toBeNull();
      const run = (await app.get(JobsService).runJob(RETENTION_JOB, { tenantId: t.tenantId }))![0]!;
      expect(run).toMatchObject({ ok: true, result: { inquiries: 0, messages: 0 } });
      const row = (await pool.query(`SELECT name, redacted_at FROM showroom_inquiries WHERE id = $1`, [ins.rows[0].id])).rows[0];
      expect(row).toEqual({ name: 'Visitor Kept For Dispute', redacted_at: null });

      // The settings page sends every section: an unchanged privacy section, or none, still saves.
      const same = await branchSettings.client.patch('/company', { settings: { locale: 'en', privacy: { inquiryRetentionDays: null } } });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect((await branchSettings.client.patch('/company', { settings: { locale: 'ar' } })).status).toBe(200);
      // A company-wide privacy.manage holder (the owner) can set it.
      const owner = await t.owner.patch('/company', { settings: { privacy: { inquiryRetentionDays: 400 } } });
      expect([owner.status, owner.body.settings?.privacy]).toEqual([200, { inquiryRetentionDays: 400 }]);
      // ...and a settings-only user cannot clear it either.
      const clear = await companySettings.client.patch('/company', { settings: { privacy: { inquiryRetentionDays: null } } });
      expect(clear.status).toBe(403);
      await t.owner.patch('/company', { settings: { privacy: { inquiryRetentionDays: null } } });
    });
  });

  describe('A2: inbox decisions carry the version the approver saw', () => {
    it('a sale price changed after the inbox was loaded is refused (409); version is required', async () => {
      const owner = t.owner;
      const checker = await secondApprover(owner);
      const supplier = await createSupplier(owner);
      const acq = await createAcquisition(owner, t.branchId, supplier.id, { price: '80000.00', approver: checker });
      await makeAvailable(owner, acq.vehicleId, '120000.00', '110000.00');
      const cust = (await createCustomer(owner, { fullName: 'Race customer' })).id;
      const manager = await addMember(app, t, 'sales_manager');
      const s = (await manager.client.post('/sales', { vehicleId: acq.vehicleId, customerId: cust, agreedPrice: '111000.00' })).body;
      expect(s).toMatchObject({ status: 'pending_approval', approvalPermission: 'sales.approve_discount' });
      const seen = (await inboxItem(checker, s.id))!;
      expect(seen.payload).toMatchObject({ agreedPrice: '111000.00', version: s.version });

      // The seller lowers the price while the approver's dialog is open.
      const changed = await manager.client.patch(`/sales/${s.id}`, { agreedPrice: '109500.00', version: s.version });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      const noVersion = await checker.post(`/sales/${s.id}/approve`, { note: null });
      expect([noVersion.status, noVersion.body.error?.code]).toEqual([422, 'validation_failed']);
      expect((await checker.post(`/sales/${s.id}/reject`, { reason: 'No version given' })).status).toBe(422);
      const stale = await checker.post(`/sales/${s.id}/approve`, { note: null, version: seen.payload!.version });
      expect([stale.status, stale.body.error?.code]).toEqual([409, 'version_conflict']);
      const staleReject = await checker.post(`/sales/${s.id}/reject`, { reason: 'Stale view', version: seen.payload!.version });
      expect([staleReject.status, staleReject.body.error?.code]).toEqual([409, 'version_conflict']);

      // The reloaded inbox shows the new price at the new version; a trade-in added while pending
      // (no new approval) keeps the inbox version in step with the sale.
      const fresh = (await inboxItem(checker, s.id))!;
      expect(fresh.payload).toMatchObject({ agreedPrice: '109500.00', version: changed.body.version });
      const ids = await catalogIds(owner);
      const ti = await manager.client.post(`/sales/${s.id}/trade-ins`, {
        version: changed.body.version,
        agreedValue: '5000.00',
        vehicle: { ...ids, modelYear: 2018, odometerValue: 120000, odometerUnit: 'km', specRegion: 'gcc', exteriorColor: 'Silver' },
      });
      expect(ti.status, JSON.stringify(ti.body)).toBe(201);
      const afterTradeIn = (await inboxItem(checker, s.id))!;
      expect(afterTradeIn.payload!.version).toBe(ti.body.version);
      const ok = await checker.post(`/sales/${s.id}/approve`, { note: null, version: afterTradeIn.payload!.version });
      expect([ok.status, ok.body.status, ok.body.agreedPrice]).toEqual([200, 'approved', '109500.00']);
    });

    it('an acquisition edited after the inbox was loaded is refused when the inbox approves it', async () => {
      const checker = await secondApprover(t.owner);
      const supplier = await createSupplier(t.owner);
      const acq = await createAcquisition(t.owner, t.branchId, supplier.id, { price: '70000.00', approve: false });
      const seen = (await inboxItem(checker, acq.id))!;
      expect(seen.payload).toMatchObject({ amountBase: '70000.00', version: expect.any(Number) });
      // An ownership update while pending keeps the request valid, at the new version.
      const own = await t.owner.put(`/acquisitions/${acq.id}/ownership`, { status: 'in_progress' });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const synced = (await inboxItem(checker, acq.id))!;
      expect(synced.payload!.version).toBe(own.body.version);
      // The maker raises the price (back to draft) while the approver's dialog is open.
      const edit = await t.owner.patch(`/acquisitions/${acq.id}`, { version: own.body.version, purchasePrice: '95000.00' });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      const stale = await checker.post(`/acquisitions/${acq.id}/approve`, { note: null, version: synced.payload!.version }, idem());
      expect([stale.status, stale.body.error?.code]).toEqual([409, 'version_conflict']);
    });
  });

  describe('A3: privacy search never puts the contact in a URL or a log', () => {
    it('POST /privacy/search with a JSON body; the old GET with a query string is gone', async () => {
      await pool.query(
        `INSERT INTO showroom_inquiries (tenant_id, kind, name, phone, phone_normalized, consent_at)
         VALUES ($1, 'inquiry', 'Search Me', '+966500000066', '966500000066', now())`,
        [t.tenantId],
      );
      const get = await t.owner.get('/privacy/search?phone=0500000066');
      expect(get.status).toBe(404);
      const post = await t.owner.post('/privacy/search', { phone: '0500000066' });
      expect(post.status, JSON.stringify(post.body)).toBe(200);
      expect(post.body.inquiries).toHaveLength(1);
    });

    it('request logs keep the path but drop the query string (the app’s own pino-http options)', async () => {
      const params = app.get<Params>(PARAMS_PROVIDER_TOKEN);
      const opts = params.pinoHttp as PinoHttpOptions;
      const lines: string[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      });
      // Same options as the app, with request logging on (it is off under NODE_ENV=test) and a captured stream.
      const logger = pinoHttp({ ...opts, level: 'info', autoLogging: true }, sink);
      const server = http.createServer((req, res) => {
        logger(req, res);
        res.end('{}');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/v1/customers?q=0501234567&email=erase.me%40example.org`, (r) => {
            r.resume();
            r.on('end', resolve);
          })
          .on('error', reject);
      });
      await new Promise((r) => setTimeout(r, 50));
      await new Promise<void>((r) => server.close(() => r()));
      const text = lines.join('');
      expect(text).toContain('"url":"/api/v1/customers"');
      for (const leak of ['0501234567', 'erase.me', '?q=', '"query"']) expect(text).not.toContain(leak);
    });
  });

  describe('A4: role edits respect the editor’s branch scope', () => {
    it('a branch-limited role manager cannot change or delete a role held beyond their branches', async () => {
      const far = await createBranch(t.owner, 'Far HQ');
      const perms = ['payments.read', 'payments.receive', 'cash.read'];
      const hq = await addMemberWithPermissions(app, t, perms, { allBranches: true });
      const farMember = await addMemberWithPermissions(app, t, perms, { allBranches: false, branchIds: [far.id] });
      const local = await addMemberWithPermissions(app, t, perms, { allBranches: false, branchIds: [t.branchId] });
      const admin = await addMemberWithPermissions(app, t, ['users.read', 'users.manage', 'roles.manage', ...perms], {
        allBranches: false,
        branchIds: [t.branchId],
      });
      for (const target of [hq, farMember]) {
        const put = await admin.client.put(`/roles/${target.roleId}`, { name: 'Narrowed', permissions: ['cash.read'], maxDiscountPct: '0' });
        expect([put.status, put.body.error?.code]).toEqual([403, 'branch_scope_exceeded']);
        const del = await admin.client.delete(`/roles/${target.roleId}`);
        expect([del.status, del.body.error?.code]).toEqual([403, 'branch_scope_exceeded']);
      }
      const role = (await t.owner.get('/roles')).body.find((r: { id: string }) => r.id === hq.roleId);
      expect([...role.permissions].sort()).toEqual([...perms].sort());
      expect((await hq.client.get('/receipts')).status).toBe(200);
      // A role whose members are all within the editor's branches stays editable; an unused one deletable.
      const ok = await admin.client.put(`/roles/${local.roleId}`, { name: 'Local cashier', permissions: ['cash.read'], maxDiscountPct: '0' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const spare = await admin.client.post('/roles', { name: 'Spare role', permissions: ['cash.read'], maxDiscountPct: '0' });
      expect(spare.status).toBe(201);
      expect((await admin.client.delete(`/roles/${spare.body.id}`)).status).toBe(200);
      // The company-wide owner still manages every role.
      expect((await t.owner.put(`/roles/${hq.roleId}`, { name: 'Company cashier', permissions: perms, maxDiscountPct: '0' })).status).toBe(200);
    });
  });

  describe('A5: refund source funds are scoped to the reader’s branches', () => {
    it('a branch-limited user sees neither another branch’s receipts on a customer-credit refund nor their details in the inbox', async () => {
      const tt = await createTenant(app, admin);
      await setFxReferences(tt.owner, { USD: '3.75' });
      const far = await createBranch(tt.owner, 'Far branch');
      const farUsd = await createCashAccount(tt.owner, { branchId: far.id, type: 'bank', currency: 'USD', name: 'Far USD' });
      const cust = await createCustomer(tt.owner, { fullName: 'Far customer', branchId: far.id });
      const rc = await tt.owner.post(
        '/receipts',
        { customerId: cust.id, cashAccountId: farUsd.id, amount: '1000.00', exchangeRate: '3.75', method: 'bank_transfer', reference: 'FAR-REF-1' },
        idem(),
      );
      expect([rc.status, rc.body.branchId]).toEqual([201, far.id]);
      const ref = await tt.owner.post('/refunds', { sourceType: 'customer_credit', sourceId: cust.id, amountBase: '100.00', reason: 'probe refund' }, idem());
      expect([ref.status, ref.body.branchId]).toEqual([201, null]);

      const local = await addMemberWithPermissions(app, tt, ['payments.read', 'customers.read', 'refunds.approve', 'approvals.read'], {
        allBranches: false,
        branchIds: [tt.branchId],
      });
      const detail = await local.client.get(`/refunds/${ref.body.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.sourceFunds).toEqual({ baseCurrency: 'SAR', foreignCurrency: false, receipts: [] });
      const item = (await inboxItem(local.client, ref.body.id))!;
      expect(item).toBeDefined();
      expect(item.payload!.foreignReceipts).toBeUndefined();
      expect(JSON.stringify(item)).not.toContain(rc.body.number);
      expect(item.summary).not.toContain('USD');

      // Company-wide readers still see where the money came from.
      const checker = await secondApprover(tt.owner);
      const full = await checker.get(`/refunds/${ref.body.id}`);
      expect(full.body.sourceFunds).toMatchObject({ foreignCurrency: true, receipts: [{ number: rc.body.number, currency: 'USD', amount: '1000.00' }] });
      const fullItem = (await inboxItem(checker, ref.body.id))!;
      expect(fullItem.payload!.foreignReceipts).toEqual([
        { number: rc.body.number, currency: 'USD', amount: '1000.00', exchangeRate: '3.75000000', amountBase: '3750.00' },
      ]);
    });
  });

  describe('A6: file downloads use the shared Content-Disposition builder', () => {
    it('a non-ASCII file name gets an ASCII fallback and the exact UTF-8 name (inline for PDFs)', async () => {
      const v = await createVehicle(t.owner, t.branchId);
      const doc = await t.owner.upload(`/vehicles/${v.id}/documents`, { buffer: PDF, name: 'contract.pdf' }, { docType: 'ownership' });
      expect(doc.status, JSON.stringify(doc.body)).toBe(201);
      const name = 'عقد البيع (نهائي).pdf';
      await pool.query(`UPDATE files SET original_name = $2 WHERE id = $1`, [doc.body.fileId, name]);
      const file = await t.owner.get(`/files/${doc.body.fileId}`);
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toBe(contentDisposition('inline', name));
      expect(file.headers['content-disposition']).toMatch(/^inline; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/);
    });
  });
});
