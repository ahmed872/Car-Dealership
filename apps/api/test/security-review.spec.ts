import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReportResult } from '@autohub/shared';
import { DbService } from '../src/db/db.service';
import { users } from '../src/db/schema';
import { PasswordService } from '../src/modules/auth/password.service';
import { PdfService } from '../src/modules/pdf/pdf.service';
import { MAX_PDF_ROWS, ReportExportService } from '../src/modules/reports/report-export.service';
import { addMemberWithPermissions, createBranch, createCustomer, createVehicle, JPEG, PDF } from './fixtures';
import {
  addMember,
  Client,
  closeApp,
  createPlatformAdmin,
  createTenant,
  getApp,
  ORIGIN,
  ownerPool,
  PASSWORD,
  TestTenant,
  uniq,
} from './helpers';

/**
 * Regression tests for the Phase 8 security review (F1–F5, F7–F11). Each test reproduces the
 * reviewer's attack and asserts it is refused.
 */
let app: INestApplication;
let pool: Pool;
let admin: Client;
let t: TestTenant;
let branchB: { id: string };
let bm: Awaited<ReturnType<typeof addMember>>;

const login = (email: string, password: string) =>
  request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password });

async function roleId(c: Client, key: string): Promise<string> {
  const roles = await c.get('/roles');
  return (roles.body as Array<{ id: string; key: string | null }>).find((r) => r.key === key)!.id;
}

async function memberRow(c: Client, email: string) {
  const list = await c.get('/users');
  return (list.body as Array<Record<string, unknown> & { email: string; membershipId: string }>).find((u) => u.email === email);
}

beforeAll(async () => {
  app = await getApp();
  pool = ownerPool();
  admin = await createPlatformAdmin(app);
  t = await createTenant(app, admin);
  branchB = await createBranch(t.owner, 'Branch B');
  bm = await addMember(app, t, 'branch_manager', { allBranches: false, branchIds: [t.branchId] });
});
afterAll(async () => {
  await pool.end();
  await closeApp();
});

describe('F1/F4: an existing account is only invited, never taken over', () => {
  it('F1: a company owner cannot take over a platform administrator account', async () => {
    // A platform admin created like the CLI does (no company membership).
    const adminEmail = `${uniq('padmin')}@autohub.test`;
    const dbs = app.get(DbService);
    const hash = await app.get(PasswordService).hash(PASSWORD);
    await dbs.runInTenant({ tenantId: null, userId: null }, () =>
      dbs.db.insert(users).values({ email: adminEmail, fullName: 'Platform Admin', passwordHash: hash, isPlatformAdmin: true }),
    );
    const role = await t.owner.post('/roles', { name: uniq('Nobody '), permissions: [], maxDiscountPct: '0' });
    expect(role.status).toBe(201);
    const add = await t.owner.post('/users', { email: adminEmail, fullName: 'X Y', password: 'Irrelevant1x', roleId: role.body.id, allBranches: true });
    expect(add.status).toBe(201);
    expect(add.body).toEqual({ membershipId: expect.any(String), userId: expect.any(String), status: 'invited' });

    const reset = await t.owner.post(`/users/${add.body.membershipId}/reset-password`, { newPassword: 'Owned12345x' });
    expect(reset.status).toBe(409);
    expect(reset.body.error.code).toBe('membership_not_active');
    const rename = await t.owner.patch(`/users/${add.body.membershipId}`, { fullName: 'Owned Admin' });
    expect(rename.body.error.code).toBe('invitation_pending');
    const activate = await t.owner.patch(`/users/${add.body.membershipId}`, { status: 'active' });
    expect(activate.body.error.code).toBe('invitation_pending');
    expect((await login(adminEmail, 'Owned12345x')).status).toBe(401);
    expect((await login(adminEmail, 'Irrelevant1x')).status).toBe(401);

    // Even after the admin accepts, a company can never change a platform administrator's account.
    const pa = await Client.login(app, adminEmail);
    expect((await pa.get('/auth/me')).body.tenants).toEqual([]);
    const inv = await pa.get('/me/invitations');
    expect(inv.body).toEqual([expect.objectContaining({ membershipId: add.body.membershipId, tenantId: t.tenantId })]);
    expect((await pa.post(`/me/invitations/${add.body.membershipId}/accept`)).status).toBe(200);
    const reset2 = await t.owner.post(`/users/${add.body.membershipId}/reset-password`, { newPassword: 'Owned12345x' });
    expect(reset2.status).toBe(403);
    expect(reset2.body.error.code).toBe('platform_admin_account');
    const rename2 = await t.owner.patch(`/users/${add.body.membershipId}`, { fullName: 'Owned Admin' });
    expect(rename2.body.error.code).toBe('platform_admin_account');
    const me = await (await Client.login(app, adminEmail)).get('/auth/me');
    expect(me.body.user).toMatchObject({ isPlatformAdmin: true, fullName: 'Platform Admin' });
  });

  it('F4: attaching another company’s user creates an invitation the person must accept themselves', async () => {
    const a = await createTenant(app, admin);
    const b = await createTenant(app, admin);
    const victim = await addMember(app, b, 'accountant');
    expect((await b.owner.patch(`/users/${victim.membershipId}`, { phone: '+966501234567' })).status).toBe(200);
    await victim.client.get('/auth/me');

    const repRole = await roleId(a.owner, 'sales_rep');
    const fresh = await a.owner.post('/users', { email: `${uniq('new')}@autohub.test`, fullName: 'Brand New', password: PASSWORD, roleId: repRole, allBranches: true });
    const add = await a.owner.post('/users', { email: victim.email, fullName: 'ignored', password: 'Whatever123', roleId: repRole, allBranches: true });
    expect(add.status).toBe(201);
    // Same response shape for a new and an existing account; no `accountCreated` oracle.
    expect(Object.keys(add.body).sort()).toEqual(Object.keys(fresh.body).sort());
    expect(add.body).not.toHaveProperty('accountCreated');
    expect([fresh.body.status, add.body.status]).toEqual(['active', 'invited']);

    // The inviting company sees only the email, not the account's global profile.
    const row = await memberRow(a.owner, victim.email);
    expect(row).toMatchObject({ status: 'invited', fullName: null, phone: null, lastLoginAt: null });
    expect((await a.owner.get('/employees')).body.map((e: { email: string }) => e.email)).not.toContain(victim.email);
    // No access, no company switch, and the invitation cannot be activated or used by the company.
    expect((await victim.client.get('/auth/me')).body.tenants).toHaveLength(1);
    expect((await victim.client.post('/auth/switch-tenant', { tenantId: a.tenantId })).status).toBe(401);
    expect((await a.owner.post(`/users/${add.body.membershipId}/reset-password`, { newPassword: 'NewPassw0rd1' })).status).toBe(409);
    expect((await a.owner.patch(`/users/${add.body.membershipId}`, { status: 'suspended' })).body.error.code).toBe('invitation_pending');
    expect((await a.owner.put(`/employees/${victim.userId}/profile`, { jobTitle: 'x' })).body.error.code).toBe('invitation_pending');
    // The account's own company keeps control of it while the invitation is pending.
    expect((await b.owner.post(`/users/${victim.membershipId}/reset-password`, { newPassword: 'NewPassw0rd1' })).status).toBe(200);
    const victimClient = await Client.login(app, victim.email, 'NewPassw0rd1');

    // Another signed-in user cannot answer someone else's invitation.
    const stranger = await addMember(app, b, 'sales_rep');
    expect((await stranger.client.post(`/me/invitations/${add.body.membershipId}/accept`)).status).toBe(404);

    const invitations = await victimClient.get('/me/invitations');
    expect(invitations.status).toBe(200);
    expect(invitations.body).toEqual([
      expect.objectContaining({ membershipId: add.body.membershipId, tenantId: a.tenantId, tenantName: expect.any(String), roleName: expect.any(String) }),
    ]);
    const accept = await victimClient.post(`/me/invitations/${add.body.membershipId}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body).toEqual({ ok: true, tenantId: a.tenantId });
    expect((await victimClient.post(`/me/invitations/${add.body.membershipId}/accept`)).status).toBe(404);
    expect((await victimClient.get('/me/invitations')).body).toEqual([]);
    expect((await victimClient.get('/auth/me')).body.tenants).toHaveLength(2);
    expect((await victimClient.post('/auth/switch-tenant', { tenantId: a.tenantId })).status).toBe(200);
    expect((await memberRow(a.owner, victim.email))).toMatchObject({ status: 'active', fullName: 'accountant user', phone: '+966501234567' });
    // Accepted: the account is now shared, so neither company may change it.
    expect((await b.owner.post(`/users/${victim.membershipId}/reset-password`, { newPassword: 'NewPassw0rd2' })).body.error.code).toBe('account_shared');

    const audit = await a.owner.get(`/audit-logs?entityType=membership&entityId=${add.body.membershipId}`);
    expect(audit.body.items.map((i: { action: string }) => i.action).sort()).toEqual(['user.invitation_accepted', 'user.invited']);
  });

  it('F4: the invited person can decline; the invitation then disappears', async () => {
    const a = await createTenant(app, admin);
    const other = await addMember(app, t, 'sales_rep');
    const add = await a.owner.post('/users', { email: other.email, fullName: 'x x', password: PASSWORD, roleId: await roleId(a.owner, 'accountant'), allBranches: true });
    expect(add.body.status).toBe('invited');
    const decline = await other.client.post(`/me/invitations/${add.body.membershipId}/decline`);
    expect(decline.status).toBe(200);
    expect(decline.body).toEqual({ ok: true, tenantId: null });
    expect(await memberRow(a.owner, other.email)).toBeUndefined();
    expect((await other.client.post(`/me/invitations/${add.body.membershipId}/accept`)).status).toBe(404);
    const audit = await a.owner.get(`/audit-logs?entityType=membership&entityId=${add.body.membershipId}`);
    expect(audit.body.items.map((i: { action: string }) => i.action).sort()).toEqual(['user.invitation_declined', 'user.invited']);
  });
});

describe('F2: user management stays inside the manager’s branch scope', () => {
  it('a branch-scoped manager cannot grant or manage access outside their branches', async () => {
    const bmRole = await roleId(bm.client, 'branch_manager');
    const repRole = await roleId(bm.client, 'sales_rep');
    const allBranches = await bm.client.post('/users', { email: `${uniq('alt')}@autohub.test`, fullName: 'Alt account', password: PASSWORD, roleId: bmRole, allBranches: true });
    expect(allBranches.status).toBe(403);
    expect(allBranches.body.error.code).toBe('branch_scope_exceeded');
    const otherBranch = await bm.client.post('/users', { email: `${uniq('alt')}@autohub.test`, fullName: 'Alt account', password: PASSWORD, roleId: repRole, branchIds: [branchB.id] });
    expect(otherBranch.body.error.code).toBe('branch_scope_exceeded');
    const own = await bm.client.post('/users', { email: `${uniq('own')}@autohub.test`, fullName: 'Own branch', password: PASSWORD, roleId: repRole, branchIds: [t.branchId] });
    expect(own.status).toBe(201);

    // An all-branch member is out of reach: no password reset, no suspension, no role change.
    const sm = await addMember(app, t, 'sales_manager', { allBranches: true });
    const reset = await bm.client.post(`/users/${sm.membershipId}/reset-password`, { newPassword: 'Owned12345x' });
    expect(reset.status).toBe(403);
    expect(reset.body.error.code).toBe('branch_scope_exceeded');
    expect((await login(sm.email, 'Owned12345x')).status).toBe(401);
    expect((await bm.client.patch(`/users/${sm.membershipId}`, { status: 'suspended' })).body.error.code).toBe('branch_scope_exceeded');
    expect((await bm.client.patch(`/users/${sm.membershipId}`, { roleId: repRole })).body.error.code).toBe('branch_scope_exceeded');
    expect((await bm.client.put(`/employees/${sm.userId}/profile`, { jobTitle: 'Demoted' })).body.error.code).toBe('branch_scope_exceeded');

    // A member of the manager's own branch cannot be widened beyond it.
    const rep = await addMember(app, t, 'sales_rep', { allBranches: false, branchIds: [t.branchId] });
    expect((await bm.client.patch(`/users/${rep.membershipId}`, { allBranches: true })).body.error.code).toBe('branch_scope_exceeded');
    expect((await bm.client.patch(`/users/${rep.membershipId}`, { branchIds: [t.branchId, branchB.id] })).body.error.code).toBe('branch_scope_exceeded');
    const repRow = await memberRow(t.owner, rep.email);
    expect(repRow).toMatchObject({ allBranches: false, branchIds: [t.branchId] });
    // …but is still manageable inside it.
    expect((await bm.client.patch(`/users/${rep.membershipId}`, { branchIds: [t.branchId] })).status).toBe(200);
    expect((await bm.client.post(`/users/${rep.membershipId}/reset-password`, { newPassword: 'Reset12345x' })).status).toBe(200);
    // A member spanning both branches is out of reach too.
    const both = await addMember(app, t, 'sales_rep', { allBranches: false, branchIds: [t.branchId, branchB.id] });
    expect((await bm.client.post(`/users/${both.membershipId}/reset-password`, { newPassword: 'Owned12345x' })).body.error.code).toBe('branch_scope_exceeded');
    // The owner (all branches) is unaffected.
    expect((await t.owner.patch(`/users/${rep.membershipId}`, { allBranches: true })).status).toBe(200);
  });
});

describe('F3: the audit log is company-wide', () => {
  it('a branch-scoped auditor cannot read other branches’ snapshots through the audit log', async () => {
    const vB = await createVehicle(t.owner, branchB.id);
    const c = await createCustomer(t.owner, { branchId: branchB.id });
    expect([403, 404]).toContain((await bm.client.get(`/customers/${c.id}`)).status);
    for (const path of [`/audit-logs?entityType=vehicle&entityId=${vB.id}`, `/audit-logs?entityType=customer&entityId=${c.id}`, '/audit-logs']) {
      const r = await bm.client.get(path);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('company_scope_required');
    }
    expect((await bm.client.post('/audit-logs/verify')).body.error.code).toBe('company_scope_required');
    const owner = await t.owner.get(`/audit-logs?entityType=customer&entityId=${c.id}`);
    expect(owner.status).toBe(200);
    expect(owner.body.items.length).toBeGreaterThan(0);
  });
});

describe('F5: sign-in lockout', () => {
  it('parallel guesses cannot exceed the limit, and a locked account looks like an unknown one', async () => {
    const victim = await addMember(app, t, 'sales_rep');
    const { rows } = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', [victim.email]);
    const realHash = rows[0]!.password_hash;
    // Parallel requests need a listening server (supertest would otherwise start and stop it per request).
    const server = app.getHttpServer() as import('node:http').Server;
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const spy = vi.spyOn(app.get(PasswordService), 'verify');
    try {
      const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => login(victim.email, `wrong-guess-${i}`)));
      expect(burst.map((r) => `${r.status}:${r.body.error?.code}`)).toEqual(Array(20).fill('401:invalid_credentials'));
      // LOGIN_MAX_FAILURES=5 in tests: at most 5 guesses were checked against the real password.
      const realChecks = spy.mock.calls.filter(([h]) => h === realHash).length;
      expect(realChecks).toBeLessThanOrEqual(5);
      expect(realChecks).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
    // After the limit even the right password is refused — exactly like an unknown email.
    const locked = await login(victim.email, PASSWORD);
    const unknown = await login(`${uniq('nobody')}@autohub.test`, PASSWORD);
    expect(locked.status).toBe(401);
    expect({ status: locked.status, error: locked.body.error.code, message: locked.body.error.message }).toEqual({
      status: unknown.status,
      error: unknown.body.error.code,
      message: unknown.body.error.message,
    });
    // When the lock expires, the right password works and the counter starts again.
    await pool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE email = $1`, [victim.email]);
    expect((await login(victim.email, PASSWORD)).status).toBe(200);
    const after = await pool.query('SELECT failed_login_count, locked_until FROM users WHERE email = $1', [victim.email]);
    expect(after.rows[0]).toEqual({ failed_login_count: 0, locked_until: null });
  });

  it('a success before the limit clears the failure count', async () => {
    const u = await addMember(app, t, 'sales_rep');
    for (let i = 0; i < 4; i++) expect((await login(u.email, 'bad-password-123')).status).toBe(401);
    expect((await login(u.email, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(u.email, 'bad-password-123')).status).toBe(401);
    expect((await login(u.email, PASSWORD)).status).toBe(200);
  });
});

describe('F7: file downloads respect branch scope', () => {
  it('a branch-scoped user cannot download another branch’s vehicle photos or documents', async () => {
    const vB = await createVehicle(t.owner, branchB.id);
    const vA = await createVehicle(t.owner, t.branchId);
    const photoB = await t.owner.upload(`/vehicles/${vB.id}/media`, { buffer: JPEG, name: 'front.jpg' });
    const docB = await t.owner.upload(`/vehicles/${vB.id}/documents`, { buffer: PDF, name: 'registration.pdf' }, { docType: 'registration' });
    const photoA = await t.owner.upload(`/vehicles/${vA.id}/media`, { buffer: JPEG, name: 'front.jpg' });
    expect([photoB.status, docB.status, photoA.status]).toEqual([201, 201, 201]);
    expect([403, 404]).toContain((await bm.client.get(`/vehicles/${vB.id}`)).status);
    expect((await bm.client.get(`/files/${photoB.body.fileId}`)).status).toBe(403);
    expect((await bm.client.get(`/files/${docB.body.fileId}`)).status).toBe(403);
    expect((await bm.client.get(`/files/${photoA.body.fileId}`)).status).toBe(200);
    expect((await t.owner.get(`/files/${photoB.body.fileId}`)).status).toBe(200);
  });
});

describe('F8: prototype keys in sort parameters', () => {
  it('never reach the sort map', async () => {
    for (const p of ['/vehicles?sort=__proto__', '/vehicles?sort=constructor', '/vehicles?sort=-toString', '/customers?sort=constructor', '/customers?sort=__proto__']) {
      const r = await t.owner.get(p);
      expect(r.status, p).toBe(200);
    }
    for (const p of ['/leads?sort=constructor', '/leads?sort=__proto__', '/work-orders?sort=constructor']) {
      const r = await t.owner.get(p);
      expect(r.status, p).toBe(422);
      expect(r.body.error.code, p).toBe('invalid_sort');
    }
  });
});

describe('F9: commission policy assignment', () => {
  it('nobody sets their own commission policy; others need commissions.manage_policies', async () => {
    const policy = await t.owner.post('/commission-policies', { code: uniq('p_').replace(/-/g, '_').toLowerCase(), name: 'Generous', rule: { type: 'pct_of_profit', ratePct: '50' } });
    expect(policy.status, JSON.stringify(policy.body)).toBe(201);
    const bmMe = (await bm.client.get('/auth/me')).body.user.id as string;
    const self = await bm.client.put(`/employees/${bmMe}/profile`, { commissionPolicyId: policy.body.id });
    expect(self.status).toBe(403);
    // Other profile fields stay editable.
    expect((await bm.client.put(`/employees/${bmMe}/profile`, { jobTitle: 'Branch manager' })).status).toBe(200);
    const rep = await addMember(app, t, 'sales_rep', { allBranches: false, branchIds: [t.branchId] });
    const other = await bm.client.put(`/employees/${rep.userId}/profile`, { commissionPolicyId: policy.body.id });
    expect(other.status).toBe(403);
    expect(other.body.error.details.permission).toBe('commissions.manage_policies');
    // The owner holds the permission for others, but not for themselves either.
    const ownerId = (await t.owner.get('/auth/me')).body.user.id as string;
    expect((await t.owner.put(`/employees/${ownerId}/profile`, { commissionPolicyId: policy.body.id })).status).toBe(403);
    expect((await t.owner.put(`/employees/${rep.userId}/profile`, { commissionPolicyId: policy.body.id })).status).toBe(200);
    // Re-sending the unchanged policy with other fields is not a change.
    expect((await bm.client.put(`/employees/${rep.userId}/profile`, { commissionPolicyId: policy.body.id, jobTitle: 'Rep' })).status).toBe(200);
  });
});

describe('F10: document sensitivity', () => {
  it('only a reader of sensitive documents can change a document’s sensitivity', async () => {
    const clerk = await addMemberWithPermissions(app, t, ['vehicles.read', 'vehicles.manage_documents']);
    const v = await createVehicle(t.owner, t.branchId);
    const secret = await t.owner.upload(`/vehicles/${v.id}/documents`, { buffer: PDF, name: 'id.pdf' }, { docType: 'ownership', docNumber: 'OWN-1234', isSensitive: 'true' });
    const plain = await t.owner.upload(`/vehicles/${v.id}/documents`, { buffer: PDF, name: 'reg.pdf' }, { docType: 'registration' });
    const unhide = await clerk.client.patch(`/vehicles/${v.id}/documents/${secret.body.id}`, { isSensitive: false });
    expect(unhide.status).toBe(403);
    expect(unhide.body.error.details.permission).toBe('documents.read_sensitive');
    expect((await clerk.client.get(`/files/${secret.body.fileId}`)).status).toBe(403);
    expect((await clerk.client.patch(`/vehicles/${v.id}/documents/${plain.body.id}`, { isSensitive: true })).status).toBe(403);
    // Other edits are allowed, without revealing the sensitive details.
    const note = await clerk.client.patch(`/vehicles/${v.id}/documents/${secret.body.id}`, { expiresAt: '2030-01-01' });
    expect(note.status).toBe(200);
    expect(note.body).toMatchObject({ restricted: true, docNumber: null, fileId: null, isSensitive: true });
    expect((await t.owner.patch(`/vehicles/${v.id}/documents/${secret.body.id}`, { isSensitive: false })).status).toBe(200);
    expect((await clerk.client.get(`/files/${secret.body.fileId}`)).status).toBe(200);
  });
});

describe('F11: report exports are bounded', () => {
  it('PDF exports are capped in rows (pdf_too_many_rows)', async () => {
    const exporter = app.get(ReportExportService);
    const report: ReportResult = {
      key: 'inventory',
      titleEn: 'Inventory',
      titleAr: 'المخزون',
      params: {},
      columns: [{ key: 'n', labelEn: 'N', labelAr: 'ن', type: 'number' } as ReportResult['columns'][number]],
      rows: Array.from({ length: MAX_PDF_ROWS + 1 }, (_, i) => ({ n: i })),
      totals: null,
      summary: [],
      reconciliation: null,
      generatedAt: new Date().toISOString(),
      truncated: false,
    };
    await expect(exporter.render(report, 'pdf', 'en', 'Co', 'SAR')).rejects.toMatchObject({ code: 'pdf_too_many_rows', status: 422 });
    // The same rows still export as a spreadsheet.
    const csv = await exporter.render(report, 'csv', 'en', 'Co', 'SAR');
    expect(csv.ext).toBe('csv');
  });

  it('Chromium renders are limited process-wide (pdf_busy when saturated)', async () => {
    const pdf = app.get(PdfService);
    let running = 0;
    let peak = 0;
    const spy = vi.spyOn(pdf as unknown as { renderNow: () => Promise<Buffer> }, 'renderNow').mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return Buffer.from('%PDF-');
    });
    try {
      // Defaults: 2 at once, 4 waiting; the rest are refused immediately.
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => pdf.render('<p>x</p>')));
      const busy = results.filter((r) => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
      expect(busy).toHaveLength(4);
      for (const b of busy) expect((b as PromiseRejectedResult).reason).toMatchObject({ code: 'pdf_busy', status: 503 });
      expect(peak).toBe(2);
      // Once the queue drains, renders are accepted again.
      await expect(pdf.render('<p>x</p>')).resolves.toBeInstanceOf(Buffer);
    } finally {
      spy.mockRestore();
    }
  });

  it('the export route has its own per-client rate limit', async () => {
    // EXPORT_RATE_LIMIT_PER_MIN defaults to 20 per client per minute.
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await t.owner.get('/reports/inventory/export?format=csv')).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    // Other routes are not affected by the export budget.
    expect((await t.owner.get('/reports/inventory')).status).toBe(200);
  });
});
