import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { createApp } from '../src/bootstrap';
import { DbService } from '../src/db/db.service';
import { users } from '../src/db/schema';
import { PasswordService } from '../src/modules/auth/password.service';

export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'TestPassw0rd!';

let appPromise: Promise<INestApplication> | null = null;

export async function getApp(): Promise<INestApplication> {
  appPromise ??= (async () => {
    const app = await createApp({ logger: false });
    await app.init();
    return app;
  })();
  return appPromise;
}

export async function closeApp(): Promise<void> {
  if (appPromise) {
    const app = await appPromise;
    await app.close();
    appPromise = null;
  }
}

export const uniq = (prefix = 't') => `${prefix}${randomUUID().slice(0, 8)}`;

/** Owner-role connection for assertions that must bypass the API (e.g. tamper simulation). */
export function ownerPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL, max: 2 });
}

/** Cookie-carrying client that sends the CSRF header and Origin like the real SPA. */
export class Client {
  csrf = '';
  constructor(readonly agent: TestAgent) {}

  static async login(
    app: INestApplication,
    email: string,
    password = PASSWORD,
    tenantSlug?: string,
  ): Promise<Client> {
    const agent = request.agent(app.getHttpServer());
    const res = await agent
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password, ...(tenantSlug ? { tenantSlug } : {}) });
    if (res.status !== 200)
      throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    const c = new Client(agent);
    c.csrf = extractCookie(res.headers['set-cookie'], 'ah_csrf') ?? '';
    return c;
  }

  get(path: string) {
    return this.agent.get(`/api/v1${path}`).set('Origin', ORIGIN);
  }
  post(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.agent
      .post(`/api/v1${path}`)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', this.csrf)
      .set(headers)
      .send(body as object);
  }
  put(path: string, body?: unknown) {
    return this.agent
      .put(`/api/v1${path}`)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', this.csrf)
      .send(body as object);
  }
  patch(path: string, body?: unknown) {
    return this.agent
      .patch(`/api/v1${path}`)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', this.csrf)
      .send(body as object);
  }
  upload(path: string, file: { buffer: Buffer; name: string }, fields: Record<string, string> = {}) {
    let req = this.agent.post(`/api/v1${path}`).set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', file.buffer, file.name);
  }
  delete(path: string) {
    return this.agent.delete(`/api/v1${path}`).set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf);
  }
}

export function extractCookie(setCookie: string[] | string | undefined, name: string): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list) {
    const m = c.match(new RegExp(`(?:^|\\s)(?:__Host-)?${name}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]!);
  }
  return undefined;
}

export async function createPlatformAdmin(app: INestApplication): Promise<Client> {
  const email = `${uniq('admin')}@autohub.test`;
  const dbs = app.get(DbService);
  const hash = await app.get(PasswordService).hash(PASSWORD);
  await dbs.runInTenant({ tenantId: null, userId: null }, () =>
    dbs.db
      .insert(users)
      .values({ email, fullName: 'Platform Admin', passwordHash: hash, isPlatformAdmin: true }),
  );
  return Client.login(app, email);
}

export interface TestTenant {
  tenantId: string;
  branchId: string;
  slug: string;
  ownerEmail: string;
  owner: Client;
}

export async function createTenant(
  app: INestApplication,
  admin: Client,
  opts: { market?: 'SA' | 'EG' | 'AE'; planCode?: string } = {},
): Promise<TestTenant> {
  const slug = uniq('co-');
  const ownerEmail = `${uniq('owner')}@autohub.test`;
  const res = await admin.post('/platform/tenants', {
    name: `Company ${slug}`,
    slug,
    market: opts.market ?? 'SA',
    branchName: 'Main branch',
    planCode: opts.planCode ?? 'enterprise',
    owner: { email: ownerEmail, fullName: 'Owner User', password: PASSWORD },
  });
  if (res.status !== 201) throw new Error(`provision failed: ${res.status} ${JSON.stringify(res.body)}`);
  const owner = await Client.login(app, ownerEmail);
  return { tenantId: res.body.tenantId, branchId: res.body.branchId, slug, ownerEmail, owner };
}

/** Adds a member with a system role and returns a logged-in client. */
export async function addMember(
  app: INestApplication,
  tenant: TestTenant,
  roleKey: string,
  opts: { allBranches?: boolean; branchIds?: string[] } = {},
): Promise<{ client: Client; email: string; membershipId: string; userId: string }> {
  const roles = await tenant.owner.get('/roles');
  const role = (roles.body as Array<{ id: string; key: string | null }>).find((r) => r.key === roleKey);
  if (!role) throw new Error(`role ${roleKey} not found`);
  const email = `${uniq(roleKey.replace(/_/g, ''))}@autohub.test`;
  const res = await tenant.owner.post('/users', {
    email,
    fullName: `${roleKey} user`,
    password: PASSWORD,
    roleId: role.id,
    allBranches: opts.allBranches ?? true,
    branchIds: opts.branchIds ?? [],
  });
  if (res.status !== 201) throw new Error(`add member failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    client: await Client.login(app, email),
    email,
    membershipId: res.body.membershipId,
    userId: res.body.userId,
  };
}

export const idem = () => ({ 'Idempotency-Key': `test-${randomUUID()}` });
