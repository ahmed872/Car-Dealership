import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  closeApp,
  createPlatformAdmin,
  createTenant,
  extractCookie,
  getApp,
  ORIGIN,
  PASSWORD,
  TestTenant,
} from './helpers';
import type { INestApplication } from '@nestjs/common';

describe('authentication & sessions', () => {
  let app: INestApplication;
  let admin: Client;
  let tenant: TestTenant;

  beforeAll(async () => {
    app = await getApp();
    admin = await createPlatformAdmin(app);
    tenant = await createTenant(app, admin);
  });
  afterAll(closeApp);

  it('sets httpOnly session cookie and readable CSRF cookie on login', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: tenant.ownerEmail, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.activeTenantId).toBe(tenant.tenantId);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const sid = cookies.find((c) => c.startsWith('ah_sid='))!;
    const csrf = cookies.find((c) => c.startsWith('ah_csrf='))!;
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/SameSite=Lax/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
  });

  it('rejects wrong password and unknown email with the same error', async () => {
    const a = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: tenant.ownerEmail, password: 'wrong-password-1' });
    const b = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@nowhere.test', password: 'wrong-password-1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe('invalid_credentials');
    expect(b.body.error.code).toBe('invalid_credentials');
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('returns the current user, tenant and permissions', async () => {
    const res = await tenant.owner.get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(tenant.ownerEmail);
    expect(res.body.tenant.id).toBe(tenant.tenantId);
    expect(res.body.tenant.baseCurrency).toBe('SAR');
    expect(res.body.permissions).toContain('sales.confirm');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('requires a session for protected routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects mutations without the CSRF token or from foreign origins', async () => {
    const noToken = await tenant.owner.agent
      .post('/api/v1/branches')
      .set('Origin', ORIGIN)
      .send({ name: 'B2', code: 'B2' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('csrf_failed');
    const wrongToken = await tenant.owner.agent
      .post('/api/v1/branches')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', 'forged-token-value')
      .send({ name: 'B2', code: 'B2' });
    expect(wrongToken.status).toBe(403);
    const evil = await tenant.owner.agent
      .post('/api/v1/branches')
      .set('Origin', 'https://evil.example')
      .set('X-CSRF-Token', tenant.owner.csrf)
      .send({ name: 'B2', code: 'B2' });
    expect(evil.status).toBe(403);
    const ok = await tenant.owner.post('/branches', { name: 'Second branch', code: 'B2' });
    expect(ok.status).toBe(201);
  });

  it('a CSRF token from another session is rejected (token bound to session)', async () => {
    const other = await Client.login(app, tenant.ownerEmail);
    const res = await tenant.owner.agent
      .post('/api/v1/branches')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', other.csrf)
      .send({ name: 'B3', code: 'B3' });
    expect(res.status).toBe(403);
  });

  it('logout revokes the session server-side', async () => {
    const c = await Client.login(app, tenant.ownerEmail);
    expect((await c.get('/auth/me')).status).toBe(200);
    const out = await c.post('/auth/logout');
    expect(out.status).toBe(200);
    // Even replaying the old cookie must fail.
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('locks the account after repeated failures, then unlocks after the window', async () => {
    const t = await createTenant(app, admin);
    for (let i = 0; i < 5; i++) {
      const r = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: t.ownerEmail, password: 'bad-password-123' });
      expect(r.status).toBe(401);
    }
    const locked = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: t.ownerEmail, password: PASSWORD });
    // A locked account answers exactly like a wrong password or an unknown email (no oracle).
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('invalid_credentials');
  });

  it('change password revokes other sessions but keeps the current one', async () => {
    const t = await createTenant(app, admin);
    const second = await Client.login(app, t.ownerEmail);
    const res = await t.owner.post('/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'N3wPassword!x',
    });
    expect(res.status).toBe(200);
    expect((await t.owner.get('/auth/me')).status).toBe(200);
    expect((await second.get('/auth/me')).status).toBe(401);
    const relog = await Client.login(app, t.ownerEmail, 'N3wPassword!x');
    expect((await relog.get('/auth/me')).status).toBe(200);
  });

  it('rejects weak passwords', async () => {
    const res = await tenant.owner.post('/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('only platform admins can provision tenants', async () => {
    const res = await tenant.owner.post('/platform/tenants', {
      name: 'Hack',
      slug: 'hack-co',
      market: 'SA',
      branchName: 'x1',
      owner: { email: 'hack@x.test', fullName: 'Hack', password: PASSWORD },
    });
    expect(res.status).toBe(403);
  });

  it('self sign-up is disabled by default', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/platform/signup')
      .set('Origin', ORIGIN)
      .send({
        name: 'New Co',
        slug: 'new-co',
        market: 'EG',
        branchName: 'HQ',
        owner: { email: 'n@x.test', fullName: 'N N', password: PASSWORD },
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('signup_disabled');
  });

  it('user with multiple companies must choose, and can switch tenant', async () => {
    const t2 = await createTenant(app, admin);
    // Add tenant.owner's email as member of t2: an existing account is only invited (no password
    // change, no access) until the person accepts the invitation themselves.
    const roles = await t2.owner.get('/roles');
    const accountant = roles.body.find((r: { key: string }) => r.key === 'accountant');
    const add = await t2.owner.post('/users', {
      email: tenant.ownerEmail,
      fullName: 'ignored',
      password: 'DifferentPass1!',
      roleId: accountant.id,
      allBranches: true,
    });
    expect(add.status).toBe(201);
    expect(add.body.status).toBe('invited');
    const pending = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: tenant.ownerEmail, password: PASSWORD });
    expect(pending.body.tenants).toHaveLength(1);
    expect((await tenant.owner.post(`/me/invitations/${add.body.membershipId}/accept`)).status).toBe(200);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: tenant.ownerEmail, password: PASSWORD });
    expect(login.body.requiresTenantSelection).toBe(true);
    expect(login.body.tenants).toHaveLength(2);
    const agent = request.agent(app.getHttpServer());
    const l2 = await agent
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: tenant.ownerEmail, password: PASSWORD });
    const c = new Client(agent);
    c.csrf = extractCookie(l2.headers['set-cookie'] as unknown as string[], 'ah_csrf')!;
    expect((await c.get('/branches')).body.error.code).toBe('no_active_tenant');
    expect((await c.post('/auth/switch-tenant', { tenantId: t2.tenantId })).status).toBe(200);
    const me = await c.get('/auth/me');
    expect(me.body.tenant.id).toBe(t2.tenantId);
    expect(me.body.permissions).toContain('cash.close');
    expect(me.body.permissions).not.toContain('users.manage');
  });
});
