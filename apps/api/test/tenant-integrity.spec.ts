import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVehicle } from './fixtures';
import { closeApp, createPlatformAdmin, createTenant, getApp, ownerPool, TestTenant } from './helpers';

/**
 * KI-001: the database itself refuses a reference from one company's record to another
 * company's record, even for a role that bypasses RLS (the owner pool used here). Composite
 * (tenant_id, id) keys guard tenant tables; a trigger guards references to shared catalogs.
 */
describe('cross-company references are refused by the database', () => {
  let app: INestApplication;
  let pool: Pool;
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    a = await createTenant(app, admin);
    b = await createTenant(app, admin);
    pool = ownerPool();
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  const fails = async (sql: string, params: unknown[]) => {
    const err = await pool.query(sql, params).then(
      () => null,
      (e: { code?: string; message: string }) => e,
    );
    expect(err, sql).not.toBeNull();
    expect(err!.code).toBe('23503');
    return err!.message;
  };

  it('a vehicle cannot be moved to another company\'s branch', async () => {
    const v = await createVehicle(a.owner, a.branchId);
    await fails(`UPDATE vehicles SET branch_id = $1 WHERE id = $2`, [b.branchId, v.id]);
    // Its own branch is fine.
    await pool.query(`UPDATE vehicles SET branch_id = $1 WHERE id = $2`, [a.branchId, v.id]);
  });

  it('a record cannot point at another company\'s customer', async () => {
    const [cust] = (await pool.query(`INSERT INTO customers (tenant_id, full_name, phone) VALUES ($1, 'Cross', '966500000999') RETURNING id`, [a.tenantId])).rows;
    await fails(`INSERT INTO customer_wishes (tenant_id, customer_id) VALUES ($1, $2)`, [b.tenantId, cust.id]);
    await fails(`UPDATE customers SET branch_id = $1 WHERE id = $2`, [b.branchId, cust.id]);
    await pool.query(`INSERT INTO customer_wishes (tenant_id, customer_id) VALUES ($1, $2)`, [a.tenantId, cust.id]);
  });

  it('a company may use global catalog rows and its own, but not another company\'s private ones', async () => {
    const v = await createVehicle(a.owner, a.branchId);
    const [privateMake] = (await pool.query(`INSERT INTO vehicle_makes (tenant_id, name_en, name_ar) VALUES ($1, 'Private B', 'خاص') RETURNING id`, [b.tenantId])).rows;
    const msg = await fails(`UPDATE vehicles SET make_id = $1 WHERE id = $2`, [privateMake.id, v.id]);
    expect(msg).toContain('cross_tenant_reference');
    const [globalMake] = (await pool.query(`SELECT id FROM vehicle_makes WHERE tenant_id IS NULL AND name_en = 'Toyota'`)).rows;
    await pool.query(`UPDATE vehicles SET make_id = $1 WHERE id = $2`, [globalMake.id, v.id]);
    const [ownMake] = (await pool.query(`INSERT INTO vehicle_makes (tenant_id, name_en, name_ar) VALUES ($1, 'Private A', 'خاص أ') RETURNING id`, [a.tenantId])).rows;
    await pool.query(`UPDATE vehicles SET make_id = $1 WHERE id = $2`, [ownMake.id, v.id]);
  });

  it('every tenant-to-tenant foreign key has its company guard, and re-applying is a no-op', async () => {
    const missing = await pool.query(
      `SELECT c.conname FROM pg_constraint c
         JOIN pg_attribute s ON s.attrelid = c.conrelid AND s.attname = 'tenant_id' AND s.attnotnull
         JOIN pg_attribute r ON r.attrelid = c.confrelid AND r.attname = 'tenant_id' AND r.attnotnull
        WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND c.conname NOT LIKE '%\\_tfk' ESCAPE '\\'
          AND NOT EXISTS (SELECT 1 FROM pg_constraint g WHERE g.conrelid = c.conrelid AND g.conname = left(c.conname, 59) || '_tfk')`,
    );
    expect(missing.rows).toEqual([]);
    const before = (await pool.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE '%\\_tfk' ESCAPE '\\'`)).rows[0].n;
    await pool.query('SELECT app_apply_tenant_fks()');
    const after = (await pool.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE '%\\_tfk' ESCAPE '\\'`)).rows[0].n;
    expect(after).toBe(before);
    expect(before).toBeGreaterThan(90);
  });
});
