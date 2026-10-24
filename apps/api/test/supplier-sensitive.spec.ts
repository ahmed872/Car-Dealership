import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLES, SystemRoleKey } from '@autohub/shared';
import { decryptSecret, hmacHex } from '../src/common/crypto';
import { DbService } from '../src/db/db.service';
import { encryptSupplierNationalIds } from '../src/modules/purchasing/supplier-id-backfill';
import { SuppliersService } from '../src/modules/purchasing/suppliers.service';
import { addMemberWithPermissions, createSupplier } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, ownerPool, TestTenant, uniq } from './helpers';

const HIDDEN_KEYS = ['nationalId', 'nationalIdEnc', 'nationalIdHash', 'nationalIdLast4', 'legacyNationalId'];

/** A supplier row as written before D-047 (plain-text national_id), or by the previous release during the rollout. */
async function insertLegacySupplier(pool: Pool, tenantId: string, nationalId: string, opts: { enc?: string } = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO suppliers (tenant_id, type, name, national_id, national_id_enc) VALUES ($1, 'individual', $2, $3, $4) RETURNING id`,
    [tenantId, `Legacy ${uniq()}`, nationalId, opts.enc ?? null],
  );
  return r.rows[0].id as string;
}

async function storedRow(pool: Pool, id: string) {
  const r = await pool.query(`SELECT national_id, national_id_enc, national_id_hash, national_id_last4 FROM suppliers WHERE id = $1`, [id]);
  return r.rows[0] as { national_id: string | null; national_id_enc: string | null; national_id_hash: string | null; national_id_last4: string | null };
}

describe('supplier national IDs (D-047): encrypted at rest, masked, revealed with permission', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  let inventory: Client;

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
    pool = ownerPool();
    inventory = (await addMember(app, t, 'inventory_manager')).client;
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('stores only the ciphertext, a keyed hash of the normalised value and the last 4; responses are masked', async () => {
    const res = await t.owner.post('/suppliers', { type: 'individual', name: 'Saad Motors', nationalId: ' 1012-345 678 ' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ nationalIdMasked: '••••5678', hasNationalId: true });
    for (const k of HIDDEN_KEYS) expect(res.body).not.toHaveProperty(k);

    const row = await storedRow(pool, res.body.id);
    expect(row.national_id).toBeNull();
    expect(row.national_id_enc).toMatch(/^v1\./);
    expect(row.national_id_enc).not.toContain('1012345678');
    expect(decryptSecret(row.national_id_enc!)).toBe('1012345678');
    expect(row.national_id_hash).toBe(hmacHex('1012345678'));
    expect(row.national_id_last4).toBe('5678');

    const one = await t.owner.get(`/suppliers/${res.body.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ nationalIdMasked: '••••5678', hasNationalId: true });
    const list = await t.owner.get(`/suppliers?q=Saad%20Motors`);
    const item = (list.body.items as Array<Record<string, unknown>>).find((s) => s.id === res.body.id)!;
    expect(item).toMatchObject({ nationalIdMasked: '••••5678', hasNationalId: true });
    for (const body of [one.body, item]) {
      for (const k of HIDDEN_KEYS) expect(body).not.toHaveProperty(k);
      expect(JSON.stringify(body)).not.toContain('1012345678');
    }

    // Neither the audit row nor anything else in it carries the number.
    const audit = await pool.query(`SELECT action, before, after, metadata, summary FROM audit_logs WHERE entity_type = 'supplier' AND entity_id = $1`, [res.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['supplier.created']);
    expect(JSON.stringify(audit.rows)).not.toContain('1012345678');
    expect(JSON.stringify(audit.rows)).not.toContain(row.national_id_enc);

    // A supplier without an ID.
    const none = await createSupplier(t.owner);
    expect(none).toMatchObject({ nationalIdMasked: null, hasNationalId: false });
  });

  it('refuses a national ID that is not letters and digits (422), on create and on edit', async () => {
    const bad = await t.owner.post('/suppliers', { type: 'individual', name: 'Bad ID', nationalId: 'رقم ١٢' });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain('invalid_national_id');
    const s = await createSupplier(t.owner);
    const badEdit = await t.owner.patch(`/suppliers/${s.id}`, { nationalId: '12' });
    expect(badEdit.status).toBe(422);
  });

  it('PATCH: absent keeps the stored ID, a new value replaces it, null removes it', async () => {
    const s = await createSupplier(t.owner, { type: 'individual', nationalId: '1098765432' });
    const before = await storedRow(pool, s.id);
    const renamed = await t.owner.patch(`/suppliers/${s.id}`, { name: `Renamed ${uniq()}` });
    expect(renamed.status).toBe(200);
    expect(renamed.body.nationalIdMasked).toBe('••••5432');
    expect(await storedRow(pool, s.id)).toEqual(before);

    const changed = await t.owner.patch(`/suppliers/${s.id}`, { nationalId: 'a12 345 678' });
    expect(changed.status).toBe(200);
    expect(changed.body.nationalIdMasked).toBe('••••5678');
    const after = await storedRow(pool, s.id);
    expect(after.national_id_hash).toBe(hmacHex('A12345678'));
    expect(after.national_id).toBeNull();

    const removed = await t.owner.patch(`/suppliers/${s.id}`, { nationalId: null });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ nationalIdMasked: null, hasNationalId: false });
    expect(await storedRow(pool, s.id)).toEqual({ national_id: null, national_id_enc: null, national_id_hash: null, national_id_last4: null });

    const audit = await pool.query(`SELECT before, after FROM audit_logs WHERE entity_type = 'supplier' AND entity_id = $1`, [s.id]);
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain('1098765432');
    expect(text).not.toContain('A12345678');
  });

  it('the duplicate check matches the national ID through its hash, ignoring case, spaces and separators', async () => {
    const s = await createSupplier(t.owner, { type: 'individual', nationalId: 'X9876543' });
    const check = (c: Client, body: Record<string, unknown>) => c.post('/suppliers/check-duplicates', body);
    for (const variant of ['X9876543', ' x9876543 ', 'x 987-6543']) {
      const r = await check(t.owner, { nationalId: variant });
      expect(r.status).toBe(200);
      expect(r.body.filter((d: { id: string }) => d.id === s.id), variant).toEqual([expect.objectContaining({ id: s.id, matchedOn: ['nationalId'] })]);
      expect(r.body[0]).not.toHaveProperty('nationalId');
    }
    expect((await check(t.owner, { nationalId: 'X9876543', excludeId: s.id })).body).toEqual([]);
    expect((await check(t.owner, { nationalId: 'X987654' })).body).toEqual([]);
    // Another company's suppliers are never matched.
    expect((await check(other.owner, { nationalId: 'X9876543' })).body).toEqual([]);
    // The ID travels in the body, never in the URL.
    expect((await t.owner.get('/suppliers/check-duplicates?nationalId=X9876543')).status).toBe(400);
  });

  it('reveals the full ID only with suppliers.view_sensitive (+ suppliers.read), audited without the value', async () => {
    const s = await createSupplier(t.owner, { type: 'individual', nationalId: '1055566677' });

    // inventory_manager: suppliers.read without the reveal permission.
    const denied = await inventory.get(`/suppliers/${s.id}/sensitive`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.missing).toEqual(['suppliers.view_sensitive']);
    expect((await inventory.get(`/suppliers/${s.id}`)).body.nationalIdMasked).toBe('••••6677');
    // The reveal permission alone does not open suppliers the member cannot read.
    const onlySensitive = (await addMemberWithPermissions(app, t, ['suppliers.view_sensitive'])).client;
    const noRead = await onlySensitive.get(`/suppliers/${s.id}/sensitive`);
    expect(noRead.status).toBe(403);
    expect(noRead.body.error.details.missing).toEqual(['suppliers.read']);

    const r = await t.owner.get(`/suppliers/${s.id}/sensitive`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: s.id, nationalId: '1055566677', nationalIdMasked: '••••6677' });
    const manager = (await addMember(app, t, 'branch_manager')).client;
    expect((await manager.get(`/suppliers/${s.id}/sensitive`)).body.nationalId).toBe('1055566677');

    const audit = await pool.query(`SELECT action, actor_user_id, before, after, metadata, summary FROM audit_logs WHERE entity_type = 'supplier' AND entity_id = $1 ORDER BY seq`, [s.id]);
    expect(audit.rows.map((x) => x.action)).toEqual(['supplier.created', 'supplier.sensitive_viewed', 'supplier.sensitive_viewed']);
    expect(audit.rows[1].metadata).toMatchObject({ fields: ['nationalId'] });
    expect(JSON.stringify(audit.rows)).not.toContain('1055566677');

    // Another company: 404 (never the value, never 403); unknown ids 404.
    expect((await other.owner.get(`/suppliers/${s.id}/sensitive`)).status).toBe(404);
    expect((await t.owner.get('/suppliers/00000000-0000-4000-8000-000000000000/sensitive')).status).toBe(404);
    expect((await t.owner.get('/suppliers/not-a-uuid/sensitive')).status).toBe(400);
    const otherAudit = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'supplier.sensitive_viewed'`, [other.tenantId]);
    expect(otherAudit.rows[0].n).toBe(0);
  });

  it('the reveal permission is held by the owner and branch-manager system roles only', () => {
    const holders = (Object.keys(SYSTEM_ROLES) as SystemRoleKey[]).filter((k) => SYSTEM_ROLES[k].permissions.includes('suppliers.view_sensitive'));
    const customerHolders = (Object.keys(SYSTEM_ROLES) as SystemRoleKey[]).filter((k) => SYSTEM_ROLES[k].permissions.includes('customers.view_sensitive'));
    expect(holders.sort()).toEqual(['branch_manager', 'owner']);
    expect(holders.sort()).toEqual(customerHolders.sort());
  });

  it('migration 0018 grants the permission to existing companies (owner; branch manager when it may reveal customer IDs)', async () => {
    const admin = await createPlatformAdmin(app);
    const co = await createTenant(app, admin);
    const roleSql = readFileSync(join(__dirname, '../src/db/migrations/0018_supplier_national_id_security.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((stmt) => stmt.replace(/^\s*--.*$/gm, '').trim())
      .find((stmt) => stmt.startsWith('UPDATE roles'))!;
    expect(roleSql).toBeTruthy();
    const perms = async () =>
      Object.fromEntries(
        (await pool.query(`SELECT key, permissions FROM roles WHERE tenant_id = $1 AND is_system`, [co.tenantId])).rows.map((r) => [
          r.key,
          (r.permissions as string[]).filter((p) => p === 'suppliers.view_sensitive').length,
        ]),
      );
    // A company created before 0018: no role holds the new permission, and this one's branch-manager
    // role was edited to drop customers.view_sensitive.
    await pool.query(`UPDATE roles SET permissions = array_remove(permissions, 'suppliers.view_sensitive') WHERE tenant_id = $1`, [co.tenantId]);
    await pool.query(`UPDATE roles SET permissions = array_remove(permissions, 'customers.view_sensitive') WHERE tenant_id = $1 AND key = 'branch_manager'`, [co.tenantId]);
    expect(Object.values(await perms()).every((n) => n === 0)).toBe(true);
    await pool.query(roleSql);
    expect(await perms()).toMatchObject({ owner: 1, branch_manager: 0, sales_manager: 0, sales_rep: 0, accountant: 0, inventory_manager: 0, inspector: 0, auditor: 0 });
    // Restore customers.view_sensitive on the branch manager: it then gets the supplier one too; reruns add nothing twice.
    await pool.query(`UPDATE roles SET permissions = array_append(permissions, 'customers.view_sensitive') WHERE tenant_id = $1 AND key = 'branch_manager'`, [co.tenantId]);
    await pool.query(roleSql);
    await pool.query(roleSql);
    expect(await perms()).toMatchObject({ owner: 1, branch_manager: 1, sales_manager: 0, accountant: 0, inventory_manager: 0, auditor: 0 });
    // The member's session picks it up.
    const s = await createSupplier(co.owner, { type: 'individual', nationalId: '1234509876' });
    expect((await co.owner.get(`/suppliers/${s.id}/sensitive`)).body.nationalId).toBe('1234509876');
  });

  it('editing a pre-D-047 supplier encrypts its old plain-text value', async () => {
    const legacy = await insertLegacySupplier(pool, t.tenantId, ' 1077-788-899 ');
    // Before the backfill the old value still reads correctly (masked; revealed with the permission).
    expect((await t.owner.get(`/suppliers/${legacy}`)).body).toMatchObject({ nationalIdMasked: '••••8899', hasNationalId: true });
    expect((await t.owner.get(`/suppliers/${legacy}/sensitive`)).body.nationalId).toBe('1077-788-899');

    const edited = await t.owner.patch(`/suppliers/${legacy}`, { city: 'Riyadh' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const row = await storedRow(pool, legacy);
    expect(row.national_id).toBeNull();
    expect(decryptSecret(row.national_id_enc!)).toBe('1077788899');
    expect(row.national_id_hash).toBe(hmacHex('1077788899'));
    expect(edited.body.nationalIdMasked).toBe('••••8899');
  });

  it('`encrypt-supplier-ids` moves every plain-text ID of every company into the encrypted columns, idempotently', async () => {
    const valid = await insertLegacySupplier(pool, t.tenantId, '2088 776 655');
    const freeText = await insertLegacySupplier(pool, t.tenantId, 'رقم ٥٥٤٤');
    const blank = await insertLegacySupplier(pool, t.tenantId, '   ');
    const alreadyEncrypted = (await createSupplier(t.owner, { type: 'individual', nationalId: '2011122233' })).id;
    const encBefore = (await storedRow(pool, alreadyEncrypted)).national_id_enc!;
    const both = await insertLegacySupplier(pool, t.tenantId, '9999999999', { enc: encBefore });
    const otherCo = await insertLegacySupplier(pool, other.tenantId, 'p 7654321');

    // Not migrated yet: no hash, so the duplicate check cannot see it.
    expect((await t.owner.post('/suppliers/check-duplicates', { nationalId: '2088776655' })).body).toEqual([]);

    const dbs = app.get(DbService);
    const service = app.get(SuppliersService);
    const first = await encryptSupplierNationalIds(dbs, service, { batchSize: 2 });
    const mine = first.tenants.find((x) => x.tenantId === t.tenantId)!;
    expect(mine).toMatchObject({ slug: t.slug, encrypted: 1, unrecognised: 1, cleared: 2 });
    expect(first.tenants.find((x) => x.tenantId === other.tenantId)).toMatchObject({ encrypted: 1, unrecognised: 0, cleared: 0 });
    expect(first.totals.encrypted).toBeGreaterThanOrEqual(2);

    expect((await pool.query(`SELECT count(*)::int AS n FROM suppliers WHERE national_id IS NOT NULL`)).rows[0].n).toBe(0);
    const v = await storedRow(pool, valid);
    expect(decryptSecret(v.national_id_enc!)).toBe('2088776655');
    expect(v).toMatchObject({ national_id: null, national_id_hash: hmacHex('2088776655'), national_id_last4: '6655' });
    const f = await storedRow(pool, freeText);
    expect(decryptSecret(f.national_id_enc!)).toBe('رقم ٥٥٤٤');
    expect(f).toMatchObject({ national_id: null, national_id_hash: null });
    expect(await storedRow(pool, blank)).toEqual({ national_id: null, national_id_enc: null, national_id_hash: null, national_id_last4: null });
    expect((await storedRow(pool, both)).national_id_enc).toBe(encBefore);
    const o = await storedRow(pool, otherCo);
    expect(decryptSecret(o.national_id_enc!)).toBe('P7654321');
    expect(o.national_id_hash).toBe(hmacHex('P7654321'));

    // The migrated values behave like new ones.
    const dup = await t.owner.post('/suppliers/check-duplicates', { nationalId: '2088-776-655' });
    expect(dup.body.map((d: { id: string }) => d.id)).toEqual([valid]);
    expect((await t.owner.get(`/suppliers/${valid}/sensitive`)).body.nationalId).toBe('2088776655');
    expect((await t.owner.get(`/suppliers/${freeText}`)).body.hasNationalId).toBe(true);

    const audit = await pool.query(`SELECT actor_user_id, metadata, summary FROM audit_logs WHERE tenant_id = $1 AND action = 'supplier.national_ids_encrypted'`, [t.tenantId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ encrypted: 1, unrecognised: 1, cleared: 2 });
    expect(JSON.stringify(audit.rows)).not.toContain('2088776655');

    // Second run: nothing left to do, nothing rewritten, no new audit entry.
    const snapshot = (await pool.query(`SELECT id, national_id_enc FROM suppliers ORDER BY id`)).rows;
    const second = await encryptSupplierNationalIds(dbs, service);
    expect(second.totals).toEqual({ encrypted: 0, unrecognised: 0, cleared: 0 });
    expect((await pool.query(`SELECT id, national_id_enc FROM suppliers ORDER BY id`)).rows).toEqual(snapshot);
    const runs = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = ANY($1::uuid[]) AND action = 'supplier.national_ids_encrypted'`, [[t.tenantId, other.tenantId]]);
    expect(runs.rows[0].n).toBe(2);

    // One company only; an unknown company is an error.
    expect((await encryptSupplierNationalIds(dbs, service, { tenantId: other.tenantId })).tenants.map((x) => x.tenantId)).toEqual([other.tenantId]);
    await expect(encryptSupplierNationalIds(dbs, service, { tenantId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/not found/);
  });
});
