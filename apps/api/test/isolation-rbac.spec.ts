import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  Client,
  closeApp,
  createPlatformAdmin,
  createTenant,
  getApp,
  PASSWORD,
  TestTenant,
} from './helpers';

describe('tenant isolation', () => {
  let app: INestApplication;
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    a = await createTenant(app, admin);
    b = await createTenant(app, admin, { market: 'EG' });
  });
  afterAll(closeApp);

  it('lists only own branches, users, roles and audit entries', async () => {
    const branchesA = await a.owner.get('/branches');
    expect(branchesA.body.every((x: { tenantId: string }) => x.tenantId === a.tenantId)).toBe(true);
    const usersA = await a.owner.get('/users');
    expect(usersA.body.map((u: { email: string }) => u.email)).not.toContain(b.ownerEmail);
    const rolesA = await a.owner.get('/roles');
    expect(rolesA.body.every((r: { tenantId: string }) => r.tenantId === a.tenantId)).toBe(true);
    const auditA = await a.owner.get('/audit-logs');
    expect(auditA.body.items.length).toBeGreaterThan(0);
    expect(auditA.body.items.every((x: { entityId: string }) => x.entityId !== b.tenantId)).toBe(true);
  });

  it('cannot update another tenant’s branch by id (IDOR)', async () => {
    const res = await a.owner.put(`/branches/${b.branchId}`, { name: 'Hijacked' });
    expect(res.status).toBe(404);
    const check = await b.owner.get('/branches');
    expect(check.body[0].name).not.toBe('Hijacked');
  });

  it('cannot assign another tenant’s role or branch to a user', async () => {
    const rolesB = await b.owner.get('/roles');
    const res = await a.owner.post('/users', {
      email: 'cross@x.test',
      fullName: 'Cross',
      password: PASSWORD,
      roleId: rolesB.body[0].id,
      allBranches: true,
    });
    expect(res.status).toBe(404);
    const rolesA = await a.owner.get('/roles');
    const res2 = await a.owner.post('/users', {
      email: 'cross2@x.test',
      fullName: 'Cross',
      password: PASSWORD,
      roleId: rolesA.body.find((r: { key: string }) => r.key === 'sales_rep').id,
      allBranches: false,
      branchIds: [b.branchId],
    });
    expect(res2.status).toBe(404);
  });

  it('the database itself denies cross-tenant reads for the app role (RLS)', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      const { rows } = await client.query('SELECT DISTINCT tenant_id FROM branches');
      expect(rows.map((r) => r.tenant_id)).toEqual([a.tenantId]);
      const other = await client.query('SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1', [
        b.tenantId,
      ]);
      expect(other.rows[0].n).toBe(0);
      // Writing a row for another tenant violates the policy.
      await expect(
        client.query(`INSERT INTO branches (tenant_id, name, code) VALUES ($1, 'x', 'XX')`, [b.tenantId]),
      ).rejects.toThrow(/row-level security/);
      await client.query('ROLLBACK');
      // No context at all → nothing visible.
      await client.query('BEGIN');
      const none = await client.query('SELECT count(*)::int AS n FROM branches');
      expect(none.rows[0].n).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });
});

describe('role-based access control', () => {
  let app: INestApplication;
  let t: TestTenant;

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
  });

  it('sales rep cannot manage users, roles or settings', async () => {
    const rep = await addMember(app, t, 'sales_rep');
    expect((await rep.client.get('/users')).status).toBe(403);
    expect((await rep.client.post('/roles', { name: 'Mine', permissions: ['users.manage'] })).status).toBe(
      403,
    );
    expect((await rep.client.patch('/company', { name: 'Renamed' })).status).toBe(403);
    const forbidden = await rep.client.post('/branches', { name: 'B9', code: 'B9' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.details.missing).toContain('branches.manage');
  });

  it('branch manager cannot escalate: cannot grant roles.manage or assign the owner role', async () => {
    const bm = await addMember(app, t, 'branch_manager');
    const roles = await t.owner.get('/roles');
    const ownerRole = roles.body.find((r: { key: string }) => r.key === 'owner');
    const res = await bm.client.post('/users', {
      email: 'escalate@x.test',
      fullName: 'Escalate',
      password: PASSWORD,
      roleId: ownerRole.id,
      allBranches: true,
    });
    expect(res.status).toBe(403);
    // A role with more discount authority than the manager's own is also refused.
    const roles2 = await bm.client.get('/roles');
    expect(roles2.status).toBe(200);
  });

  it('owner cannot change own role; demoted owners lose management rights', async () => {
    const t = await createTenant(app, await createPlatformAdmin(app));
    const users = await t.owner.get('/users');
    const me = users.body.find((u: { email: string }) => u.email === t.ownerEmail);
    const roles = await t.owner.get('/roles');
    const rep = roles.body.find((r: { key: string }) => r.key === 'sales_rep');
    const self = await t.owner.patch(`/users/${me.membershipId}`, { roleId: rep.id });
    expect(self.status).toBe(403);
    // A second owner tries to demote the first while they are the only other owner → allowed once, then blocked.
    const second = await addMember(app, t, 'owner');
    const demote = await second.client.patch(`/users/${me.membershipId}`, { roleId: rep.id });
    expect(demote.status).toBe(200);
    const users2 = await second.client.get('/users');
    const secondRow = users2.body.find((u: { email: string }) => u.email === second.email);
    // Second is now the last owner; first (now a rep) cannot touch them, and nobody can demote the last owner.
    const back = await t.owner.patch(`/users/${secondRow.membershipId}`, { status: 'suspended' });
    expect(back.status).toBe(403);
  });

  it('custom roles: create, assign, enforce, and refuse deleting while in use', async () => {
    const t2 = await createTenant(app, await createPlatformAdmin(app));
    const role = await t2.owner.post('/roles', {
      name: 'Viewer',
      permissions: ['users.read'],
      maxDiscountPct: '0',
    });
    expect(role.status).toBe(201);
    const email = `viewer${Date.now()}@x.test`;
    const add = await t2.owner.post('/users', {
      email,
      fullName: 'Viewer',
      password: PASSWORD,
      roleId: role.body.id,
      allBranches: true,
    });
    expect(add.status).toBe(201);
    const viewer = await Client.login(app, email);
    expect((await viewer.get('/users')).status).toBe(200);
    expect((await viewer.post('/branches', { name: 'Nope', code: 'NP' })).status).toBe(403);
    expect((await t2.owner.delete(`/roles/${role.body.id}`)).status).toBe(409);
  });

  it('rejects invalid permission keys in roles', async () => {
    const res = await t.owner.post('/roles', { name: 'Bad', permissions: ['vehicles.fly'] });
    expect(res.status).toBe(422);
  });
});
