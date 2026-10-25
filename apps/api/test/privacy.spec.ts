import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { RETENTION_JOB } from '../src/modules/privacy/privacy.service';
import { addMemberWithPermissions, createBranch } from './fixtures';
import {
  addMember,
  closeApp,
  createPlatformAdmin,
  createTenant,
  getApp,
  ORIGIN,
  ownerPool,
  TestTenant,
} from './helpers';

const MARKER = '[redacted]';

/**
 * Data protection (KI-021, D-053): personal fields of the append-only showroom inquiries and message
 * log can be overwritten only through app_redact_contact(); every other change stays refused, for the
 * application role in every way it could try, and for the owner role outside the function.
 */
describe('privacy: search, redaction and retention of showroom contact data', () => {
  let app: INestApplication;
  let pool: Pool; // owner role: assertions and tamper attempts
  let appRole: Pool; // the API's own database role
  let a: TestTenant;
  let b: TestTenant;
  let ownerUserId: string;

  const phoneA = `+9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const localA = `0${phoneA.slice(4)}`; // the same number as typed locally (05…)
  const emailA = `visitor.${Date.now()}@example.org`;
  const nameA = 'Privacy Visitor Alpha';
  const messageA = 'Call me after 5pm about the white Camry';

  async function inquire(t: TestTenant, body: Record<string, unknown>) {
    await app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/public/showroom/${t.slug}/inquiries`)
      .set('Origin', ORIGIN)
      .send({ consent: true, kind: 'inquiry', ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  async function enableShowroom(t: TestTenant) {
    const res = await t.owner.patch('/company', {
      settings: { showroom: { enabled: true, acknowledgeInquiries: true } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  /** Runs `fn` as the application role inside a transaction with the given company context; always rolls back. */
  async function asApp<T>(tenantId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appRole.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [
        tenantId ?? '',
        ownerUserId,
      ]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  /** The error a statement raises (as the application role), or null if it succeeded. */
  async function appError(
    tenantId: string | null,
    ...sqls: string[]
  ): Promise<{ code?: string; message: string } | null> {
    return asApp(tenantId, async (c) => {
      try {
        for (const s of sqls) await c.query(s);
        return null;
      } catch (e) {
        return { code: (e as { code?: string }).code, message: (e as Error).message };
      }
    });
  }

  async function ownerError(...sqls: string[]): Promise<{ code?: string; message: string } | null> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const s of sqls) await c.query(s);
      return null;
    } catch (e) {
      return { code: (e as { code?: string }).code, message: (e as Error).message };
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  const inquiryRow = async (id: string) =>
    (await pool.query(`SELECT * FROM showroom_inquiries WHERE id = $1`, [id])).rows[0] as Record<
      string,
      unknown
    >;
  const auditCount = async (tenantId: string) =>
    Number(
      (
        await pool.query(
          `SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'privacy.redacted'`,
          [tenantId],
        )
      ).rows[0].n,
    );

  let inquiryA: string;
  let messageAId: string;
  let inquiryB: string;

  beforeAll(async () => {
    app = await getApp();
    pool = ownerPool();
    appRole = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const admin = await createPlatformAdmin(app);
    a = await createTenant(app, admin);
    b = await createTenant(app, admin);
    ownerUserId = (await pool.query(`SELECT id FROM users WHERE email = $1`, [a.ownerEmail])).rows[0].id;
    await enableShowroom(a);
    await enableShowroom(b);
    await inquire(a, { name: nameA, phone: phoneA, email: emailA, message: messageA });
    // The same person also contacted company B.
    await inquire(b, { name: nameA, phone: phoneA, email: emailA, message: messageA });
    inquiryA = (
      await pool.query(`SELECT id FROM showroom_inquiries WHERE tenant_id = $1 AND phone = $2`, [
        a.tenantId,
        phoneA,
      ])
    ).rows[0].id;
    inquiryB = (
      await pool.query(`SELECT id FROM showroom_inquiries WHERE tenant_id = $1 AND phone = $2`, [
        b.tenantId,
        phoneA,
      ])
    ).rows[0].id;
    // The acknowledgement (log adapter) is recorded after the inquiry's transaction committed.
    const msg = await pool.query(`SELECT id FROM message_log WHERE tenant_id = $1 AND related_id = $2`, [
      a.tenantId,
      inquiryA,
    ]);
    expect(msg.rowCount).toBe(1);
    messageAId = msg.rows[0].id;
  }, 120_000);

  afterAll(async () => {
    await appRole.end();
    await pool.end();
    await closeApp();
  });

  it('finds one person by phone (any format) or email, showing only masked contacts', async () => {
    for (const q of [{ phone: localA }, { phone: phoneA }, { email: emailA.toUpperCase() }]) {
      const res = await a.owner.post('/privacy/search', q);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.inquiries.map((r: { id: string }) => r.id)).toEqual([inquiryA]);
      expect(res.body.messages.map((r: { id: string }) => r.id)).toEqual([messageAId]);
      expect(res.body.inquiries[0]).toMatchObject({
        kind: 'showroom_inquiry',
        inquiryKind: 'inquiry',
        initials: 'P. V.',
        phoneMasked: `•••• ${phoneA.slice(-4)}`,
        emailMasked: 'v•••@e•••.org',
        linkedCustomer: true,
        messages: 1,
      });
      expect(res.body.messages[0]).toMatchObject({
        kind: 'message_log',
        channel: 'whatsapp',
        relatedInquiryId: inquiryA,
        recipientMasked: `•••• ${phoneA.slice(-4)}`,
      });
      const text = JSON.stringify(res.body);
      for (const secret of [phoneA, phoneA.slice(4), emailA, 'Alpha', 'Camry'])
        expect(text).not.toContain(secret);
    }
    const both = await a.owner.post('/privacy/search', { phone: phoneA, email: emailA });
    expect(both.body.inquiries[0].matchedOn).toEqual(['phone', 'email']);
    // Company B finds only its own row for the same person.
    const inB = await b.owner.post('/privacy/search', { phone: phoneA });
    expect(inB.body.inquiries.map((r: { id: string }) => r.id)).toEqual([inquiryB]);
    expect(JSON.stringify(inB.body)).not.toContain(inquiryA);
    // Validation: a phone or an email is required; an impossible phone is refused.
    expect((await a.owner.post('/privacy/search', {})).status).toBe(422);
    const bad = await a.owner.post('/privacy/search', { phone: 'abcdefgh' });
    // The old query-string form is gone (the contact must never be in a URL).
    expect((await a.owner.get(`/privacy/search?phone=${encodeURIComponent(phoneA)}`)).status).toBe(404);
    expect([bad.status, bad.body.error?.code]).toEqual([422, 'invalid_phone']);
  });

  it('requires privacy.manage (owner only by default) and access to all branches', async () => {
    const manager = await addMember(app, a, 'branch_manager');
    const sales = await addMember(app, a, 'sales_manager');
    for (const c of [manager.client, sales.client]) {
      const s = await c.post('/privacy/search', { phone: phoneA });
      expect([s.status, s.body.error?.code]).toEqual([403, 'forbidden']);
      const r = await c.post('/privacy/redactions', {
        kind: 'showroom_inquiry',
        ids: [inquiryA],
        reason: 'Erasure request #1',
      });
      expect([r.status, r.body.error?.code]).toEqual([403, 'forbidden']);
    }
    const branch = await createBranch(a.owner, 'Privacy branch');
    const limited = await addMemberWithPermissions(app, a, ['privacy.manage'], {
      allBranches: false,
      branchIds: [branch.id],
    });
    const s = await limited.client.post('/privacy/search', { phone: phoneA });
    expect([s.status, s.body.error?.code]).toEqual([403, 'company_scope_required']);
    const r = await limited.client.post('/privacy/redactions', {
      kind: 'showroom_inquiry',
      ids: [inquiryA],
      reason: 'Erasure request #1',
    });
    expect([r.status, r.body.error?.code]).toEqual([403, 'company_scope_required']);
    // The new permission is on the owner's system role.
    const roles = (await a.owner.get('/roles')).body as Array<{ key: string | null; permissions: string[] }>;
    expect(roles.find((x) => x.key === 'owner')!.permissions).toContain('privacy.manage');
    expect(roles.find((x) => x.key === 'branch_manager')!.permissions).not.toContain('privacy.manage');
    expect((await inquiryRow(inquiryA)).redacted_at).toBeNull();
  });

  it("another company's ids are never touched", async () => {
    const before = await auditCount(a.tenantId);
    const res = await b.owner.post('/privacy/redactions', {
      kind: 'showroom_inquiry',
      ids: [inquiryA],
      reason: 'Erasure request #2',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: 'showroom_inquiry', requested: 1, inquiries: 0, messages: 0 });
    const msg = await b.owner.post('/privacy/redactions', {
      kind: 'message_log',
      ids: [messageAId],
      reason: 'Erasure request #2',
    });
    expect(msg.body).toMatchObject({ inquiries: 0, messages: 0 });
    const row = await inquiryRow(inquiryA);
    expect(row).toMatchObject({
      name: nameA,
      phone: phoneA,
      email: emailA,
      message: messageA,
      redacted_at: null,
    });
    expect(
      (await pool.query(`SELECT recipient FROM message_log WHERE id = $1`, [messageAId])).rows[0].recipient,
    ).toBe(phoneA);
    expect(await auditCount(a.tenantId)).toBe(before);
    // Even called directly in B's context, the function cannot reach A's rows.
    const direct = await asApp(
      b.tenantId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM app_redact_contact('showroom_inquiry', $1::uuid[], 'cross-company test')`,
            [[inquiryA]],
          )
        ).rows[0],
    );
    expect(direct).toEqual({ inquiries: 0, messages: 0 });
    expect((await inquiryRow(inquiryA)).redacted_at).toBeNull();
    // Validation of the request body.
    expect(
      (await a.owner.post('/privacy/redactions', { kind: 'showroom_inquiry', ids: [inquiryA], reason: 'x' }))
        .status,
    ).toBe(422);
    expect(
      (
        await a.owner.post('/privacy/redactions', {
          kind: 'customers',
          ids: [inquiryA],
          reason: 'Erasure request',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await a.owner.post('/privacy/redactions', {
          kind: 'showroom_inquiry',
          ids: [],
          reason: 'Erasure request',
        })
      ).status,
    ).toBe(422);
  });

  it('overwrites only the personal fields, with the messages and notification, and audits without personal values', async () => {
    const before = await inquiryRow(inquiryA);
    const msgBefore = (await pool.query(`SELECT * FROM message_log WHERE id = $1`, [messageAId])).rows[0];
    const notifBefore = await pool.query(
      `SELECT title_en FROM notifications WHERE tenant_id = $1 AND dedupe_key LIKE $2`,
      [a.tenantId, `showroom.inquiry:${inquiryA}:%`],
    );
    expect(notifBefore.rows.length).toBeGreaterThan(0);
    expect(notifBefore.rows[0].title_en).toContain(nameA);

    const reason = 'Erasure request #17 received 2026-10-20';
    const res = await a.owner.post('/privacy/redactions', {
      kind: 'showroom_inquiry',
      ids: [inquiryA, inquiryA],
      reason,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ kind: 'showroom_inquiry', requested: 1, inquiries: 1, messages: 1 });

    const after = await inquiryRow(inquiryA);
    expect(after).toMatchObject({
      name: MARKER,
      phone: MARKER,
      phone_normalized: null,
      email: null,
      message: null,
      client_hash: null,
      redacted_by: ownerUserId,
    });
    expect(after.redacted_at).toBeInstanceOf(Date);
    const untouched = (r: Record<string, unknown>, personal: string[]) =>
      Object.fromEntries(
        Object.entries(r).filter(([k]) => ![...personal, 'redacted_at', 'redacted_by'].includes(k)),
      );
    const personalInquiry = ['name', 'phone', 'phone_normalized', 'email', 'message', 'client_hash'];
    expect(untouched(after, personalInquiry)).toEqual(untouched(before, personalInquiry));
    expect(before.customer_id).not.toBeNull();

    const msgAfter = (await pool.query(`SELECT * FROM message_log WHERE id = $1`, [messageAId])).rows[0];
    expect(msgAfter).toMatchObject({
      recipient: MARKER,
      body: MARKER,
      error: null,
      redacted_by: ownerUserId,
    });
    expect(untouched(msgAfter, ['recipient', 'body', 'error'])).toEqual(
      untouched(msgBefore, ['recipient', 'body', 'error']),
    );

    const notif = await pool.query(
      `SELECT title_ar, title_en FROM notifications WHERE tenant_id = $1 AND dedupe_key LIKE $2`,
      [a.tenantId, `showroom.inquiry:${inquiryA}:%`],
    );
    expect(notif.rows.length).toBe(notifBefore.rows.length);
    for (const n of notif.rows) {
      expect(n.title_en).toBe('Online showroom inquiry (personal data removed)');
      expect(n.title_ar).not.toContain(nameA);
    }

    const audit = (
      await pool.query(
        `SELECT * FROM audit_logs WHERE tenant_id = $1 AND action = 'privacy.redacted' ORDER BY seq DESC LIMIT 1`,
        [a.tenantId],
      )
    ).rows[0];
    expect(audit).toMatchObject({ entity_type: 'showroom_inquiry', actor_user_id: ownerUserId });
    expect(audit.metadata).toMatchObject({
      reason,
      requested: 1,
      inquiries: 1,
      messages: 1,
      inquiryIds: [inquiryA],
      messageIds: [messageAId],
      source: 'api',
    });
    expect(audit.metadata.requestId).toEqual(expect.any(String));
    const auditText = JSON.stringify(audit);
    for (const secret of [phoneA, phoneA.slice(4), emailA, nameA, 'Camry'])
      expect(auditText).not.toContain(secret);
    // Its own audit log shows the entry (company-wide reader).
    const listed = await a.owner.get('/audit-logs?entityType=showroom_inquiry');
    expect(listed.body.items[0]).toMatchObject({ action: 'privacy.redacted' });

    // Staff see the inquiry as redacted; the person can no longer be found; a second request changes nothing.
    const staff = await a.owner.get('/showroom/inquiries');
    const listedRow = staff.body.items.find((r: { id: string }) => r.id === inquiryA);
    expect(listedRow).toMatchObject({ name: MARKER, phone: MARKER, email: null, message: null });
    expect(listedRow.redactedAt).toBeTruthy();
    const search = await a.owner.post('/privacy/search', { phone: phoneA });
    expect([search.body.inquiries.length, search.body.messages.length]).toEqual([0, 0]);
    const again = await a.owner.post('/privacy/redactions', {
      kind: 'showroom_inquiry',
      ids: [inquiryA],
      reason,
    });
    expect(again.body).toMatchObject({ inquiries: 0, messages: 0 });
    expect((await inquiryRow(inquiryA)).redacted_at).toEqual(after.redacted_at);
    // Company B's copy of the same person is untouched.
    expect(await inquiryRow(inquiryB)).toMatchObject({ name: nameA, phone: phoneA, redacted_at: null });

    const verify = await a.owner.post('/audit-logs/verify');
    expect(verify.body).toMatchObject({ ok: true });
  });

  it('the application role cannot change or delete these rows any other way', async () => {
    const id = inquiryB;
    const t = b.tenantId;
    const denied = (e: { code?: string; message: string } | null) => {
      expect(e, 'the statement must fail').not.toBeNull();
      return e!;
    };
    // Plain UPDATE / DELETE / TRUNCATE: no privilege.
    for (const s of [
      `UPDATE showroom_inquiries SET name = '[redacted]' WHERE id = '${id}'`,
      `UPDATE showroom_inquiries SET name = '[redacted]', redacted_at = now() WHERE id = '${id}'`,
      `DELETE FROM showroom_inquiries WHERE id = '${id}'`,
      `UPDATE message_log SET body = '[redacted]', redacted_at = now() WHERE tenant_id = '${t}'`,
      `DELETE FROM message_log WHERE tenant_id = '${t}'`,
      'TRUNCATE showroom_inquiries',
      'TRUNCATE message_log',
    ]) {
      expect(denied(await appError(t, s)).code, s).toBe('42501');
    }
    // Setting the function's flag itself changes nothing: the privilege check comes first, and the
    // trigger also requires the function owner's identity.
    for (const flag of [
      `SELECT set_config('app.redaction_in_progress', 'on', false)`,
      `SET app.redaction_in_progress = 'on'`,
      `SET LOCAL app.redaction_in_progress = 'on'`,
    ]) {
      const e = denied(
        await appError(
          t,
          flag,
          `UPDATE showroom_inquiries SET name = '[redacted]', redacted_at = now() WHERE id = '${id}'`,
        ),
      );
      expect(e.code).toBe('42501');
    }
    // It cannot become the owner, take over the tables, disable the triggers or attach its own trigger
    // (which would run with the owner's rights inside the function).
    expect(denied(await appError(t, 'SET ROLE autohub_owner')).message).toMatch(/permission denied/);
    expect(denied(await appError(t, 'SET SESSION AUTHORIZATION autohub_owner')).message).toMatch(
      /permission denied/,
    );
    expect(
      denied(await appError(t, 'ALTER TABLE showroom_inquiries DISABLE TRIGGER showroom_inquiries_immutable'))
        .message,
    ).toMatch(/must be owner/);
    expect(denied(await appError(t, 'ALTER TABLE message_log DISABLE TRIGGER USER')).message).toMatch(
      /must be owner/,
    );
    expect(
      denied(await appError(t, 'DROP TRIGGER showroom_inquiries_immutable ON showroom_inquiries')).message,
    ).toMatch(/must be owner/);
    expect(
      denied(
        await appError(
          t,
          `CREATE FUNCTION public.ah_evil() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        ),
      ).message,
    ).toMatch(/permission denied/);
    expect(
      denied(
        await appError(
          t,
          `CREATE FUNCTION pg_temp.ah_evil() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public.showroom_inquiries SET email = 'x'; RETURN NEW; END $$`,
          'CREATE TRIGGER ah_evil BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION pg_temp.ah_evil()',
        ),
      ).message,
    ).toMatch(/must be owner|permission denied/);
    expect(
      denied(
        await appError(
          t,
          `CREATE OR REPLACE FUNCTION public.app_contact_redaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        ),
      ).message,
    ).toMatch(/must be owner|permission denied/);
    expect(
      denied(
        await appError(t, 'ALTER FUNCTION app_redact_contact(text, uuid[], text, jsonb) SECURITY INVOKER'),
      ).message,
    ).toMatch(/must be owner/);
    // A temporary table named like the real one does not redirect the function (fixed search_path,
    // schema-qualified tables): the call still redacts nothing of another company and only marks rows.
    const shadow = await asApp(t, async (c) => {
      await c.query(
        'CREATE TEMP TABLE showroom_inquiries (id uuid, tenant_id uuid, redacted_at timestamptz)',
      );
      return (
        await c.query(`SELECT * FROM app_redact_contact('showroom_inquiry', $1::uuid[], 'shadow test')`, [
          [inquiryA],
        ])
      ).rows[0];
    });
    expect(shadow).toEqual({ inquiries: 0, messages: 0 });
    // Privileges as the catalog states them.
    const priv = (
      await pool.query(`SELECT has_table_privilege('autohub_app', 'showroom_inquiries', 'UPDATE') AS upd,
                               has_table_privilege('autohub_app', 'message_log', 'DELETE') AS del,
                               has_table_privilege('autohub_app', 'notifications', 'TRIGGER') AS trg_n,
                               has_table_privilege('autohub_app', 'showroom_inquiries', 'TRIGGER') AS trg_i,
                               has_table_privilege('autohub_app', 'audit_logs', 'TRIGGER') AS trg_a,
                               has_schema_privilege('autohub_app', 'public', 'CREATE') AS create_public,
                               has_function_privilege('autohub_app', 'app_redact_contact(text, uuid[], text, jsonb)', 'EXECUTE') AS exec_app,
                               pg_has_role('autohub_app', 'autohub_owner', 'MEMBER') AS member_owner,
                               (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'app_redact_contact(text, uuid[], text, jsonb)'::regprocedure) AS definer,
                               (SELECT p.proconfig FROM pg_proc p WHERE p.oid = 'app_redact_contact(text, uuid[], text, jsonb)'::regprocedure) AS config,
                               (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'app_redact_contact(text, uuid[], text, jsonb)'::regprocedure) AS acl`)
    ).rows[0];
    expect(priv).toMatchObject({
      upd: false,
      del: false,
      trg_n: false,
      trg_i: false,
      trg_a: false,
      create_public: false,
      exec_app: true,
      member_owner: false,
      definer: true,
    });
    expect(priv.config).toEqual(['search_path=public, pg_temp']);
    expect(priv.acl).not.toMatch(/(^|[{,])=X/); // no EXECUTE for PUBLIC
    // The function validates its input and needs a company context.
    expect(
      denied(
        await appError(
          null,
          `SELECT * FROM app_redact_contact('showroom_inquiry', ARRAY['${id}']::uuid[], 'no tenant')`,
        ),
      ).message,
    ).toMatch(/tenant context required/);
    expect(
      denied(
        await appError(
          t,
          `SELECT * FROM app_redact_contact('customers', ARRAY['${id}']::uuid[], 'wrong kind')`,
        ),
      ).message,
    ).toMatch(/redaction kind/);
    expect(
      denied(
        await appError(
          t,
          `SELECT * FROM app_redact_contact('showroom_inquiry', ARRAY['${id}']::uuid[], ' ')`,
        ),
      ).message,
    ).toMatch(/reason/);
    expect(
      denied(
        await appError(t, `SELECT * FROM app_redact_contact('showroom_inquiry', ARRAY[]::uuid[], 'empty')`),
      ).message,
    ).toMatch(/between 1 and 5000/);
    expect(await inquiryRow(inquiryB)).toMatchObject({ name: nameA, redacted_at: null });
  });

  it('the owner role is refused outside the function too, even with the flag set', async () => {
    const id = inquiryB;
    const flag = `SELECT set_config('app.redaction_in_progress', 'on', true)`;
    for (const sqls of [
      [`UPDATE showroom_inquiries SET name = 'changed' WHERE id = '${id}'`],
      [`DELETE FROM showroom_inquiries WHERE id = '${id}'`],
      [`DELETE FROM message_log WHERE tenant_id = '${b.tenantId}'`],
      ['TRUNCATE showroom_inquiries'],
      // With the flag: anything but the exact redaction transition is still refused.
      [flag, `UPDATE showroom_inquiries SET name = 'someone else', redacted_at = now() WHERE id = '${id}'`],
      [
        flag,
        `UPDATE showroom_inquiries SET name = '[redacted]', kind = 'test_drive', redacted_at = now() WHERE id = '${id}'`,
      ],
      [flag, `UPDATE showroom_inquiries SET name = '[redacted]' WHERE id = '${id}'`],
      [flag, `UPDATE showroom_inquiries SET redacted_at = NULL WHERE id = '${inquiryA}'`],
      [flag, `DELETE FROM showroom_inquiries WHERE id = '${id}'`],
    ]) {
      const e = await ownerError(...sqls);
      expect(e, sqls.join('; ')).not.toBeNull();
      expect(e!.code, sqls.join('; ')).toBe('AH001');
    }
    expect(await inquiryRow(inquiryB)).toMatchObject({ name: nameA, redacted_at: null });
  });

  it('message-log rows can be redacted on their own', async () => {
    await inquire(a, {
      name: 'Second Visitor',
      phone: `+9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      message: 'Is it still available?',
    });
    const [row] = (
      await pool.query(
        `SELECT m.id, m.related_id FROM message_log m WHERE m.tenant_id = $1 AND m.redacted_at IS NULL AND m.related_type = 'showroom_inquiry' ORDER BY m.created_at DESC LIMIT 1`,
        [a.tenantId],
      )
    ).rows;
    const res = await a.owner.post('/privacy/redactions', {
      kind: 'message_log',
      ids: [row.id],
      reason: 'Erasure request #18',
    });
    expect(res.body).toMatchObject({ kind: 'message_log', inquiries: 0, messages: 1 });
    expect(
      (await pool.query(`SELECT recipient, body, redacted_at FROM message_log WHERE id = $1`, [row.id]))
        .rows[0],
    ).toMatchObject({ recipient: MARKER, body: MARKER });
    // The inquiry itself keeps its data until it is redacted too.
    expect((await inquiryRow(row.related_id)).name).toBe('Second Visitor');
  });

  describe('retention', () => {
    async function oldInquiry(t: TestTenant, daysAgo: number, name: string) {
      const r = await pool.query(
        `INSERT INTO showroom_inquiries (tenant_id, kind, name, phone, phone_normalized, email, message, consent_at, created_at)
         VALUES ($1, 'inquiry', $2, '+966500000099', '966500000099', 'old@example.org', 'old message', now() - make_interval(days => $3), now() - make_interval(days => $3))
         RETURNING id`,
        [t.tenantId, name, daysAgo],
      );
      const id = r.rows[0].id as string;
      await pool.query(
        `INSERT INTO message_log (tenant_id, channel, recipient, body, provider, status, related_type, related_id, created_at)
         VALUES ($1, 'whatsapp', '+966500000099', 'Thank you', 'log', 'logged', 'showroom_inquiry', $2, now() - make_interval(days => $3))`,
        [t.tenantId, id, daysAgo],
      );
      return id;
    }
    const run = async (t: TestTenant) =>
      (await app.get(JobsService).runJob(RETENTION_JOB, { tenantId: t.tenantId }))![0]!;

    it('validates the setting and reads settings stored without the section', async () => {
      for (const v of [0, 29, 3651, 45.5, '90']) {
        const res = await a.owner.patch('/company', { settings: { privacy: { inquiryRetentionDays: v } } });
        expect(res.status, String(v)).toBe(422);
      }
      // Stored before the section existed: reads as "keep", other sections still save.
      await pool.query(`UPDATE tenants SET settings = settings - 'privacy' WHERE id = $1`, [b.tenantId]);
      const company = await b.owner.get('/company');
      expect(company.body.settings.privacy).toEqual({ inquiryRetentionDays: null });
      expect(
        (await b.owner.patch('/company', { settings: { inventory: { staleDaysWarning: 45 } } })).status,
      ).toBe(200);
      const stored = (await pool.query(`SELECT settings FROM tenants WHERE id = $1`, [b.tenantId])).rows[0]
        .settings;
      expect(stored.privacy).toEqual({ inquiryRetentionDays: null });
      expect(await run(b)).toMatchObject({ ok: true, result: { inquiries: 0, messages: 0 } });
    });

    it('redacts only inquiries older than the retention period, once', async () => {
      const old1 = await oldInquiry(a, 400, 'Old Visitor One');
      const old2 = await oldInquiry(a, 120, 'Old Visitor Two');
      const recent = await oldInquiry(a, 60, 'Recent Visitor');
      const otherCompany = await oldInquiry(b, 400, 'Old Visitor B');

      // Off by default: nothing happens.
      expect(await run(a)).toMatchObject({ ok: true, result: { inquiries: 0, messages: 0 } });
      expect((await inquiryRow(old1)).redacted_at).toBeNull();

      const set = await a.owner.patch('/company', { settings: { privacy: { inquiryRetentionDays: 90 } } });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect((await a.owner.get('/company')).body.settings.privacy).toEqual({ inquiryRetentionDays: 90 });

      const audits = await auditCount(a.tenantId);
      const first = await run(a);
      expect(first).toMatchObject({ ok: true, result: { inquiries: 2, messages: 2 } });
      for (const id of [old1, old2])
        expect(await inquiryRow(id)).toMatchObject({
          name: MARKER,
          phone: MARKER,
          email: null,
          message: null,
        });
      expect(await inquiryRow(recent)).toMatchObject({ name: 'Recent Visitor', redacted_at: null });
      expect(await inquiryRow(otherCompany)).toMatchObject({ name: 'Old Visitor B', redacted_at: null });
      const msgs = await pool.query(
        `SELECT related_id, recipient FROM message_log WHERE related_id = ANY($1::uuid[])`,
        [[old1, old2, recent]],
      );
      for (const m of msgs.rows) expect(m.recipient).toBe(m.related_id === recent ? '+966500000099' : MARKER);
      expect(await auditCount(a.tenantId)).toBe(audits + 1);
      const audit = (
        await pool.query(
          `SELECT summary, metadata, actor_user_id FROM audit_logs WHERE tenant_id = $1 AND action = 'privacy.redacted' ORDER BY seq DESC LIMIT 1`,
          [a.tenantId],
        )
      ).rows[0];
      expect(audit.metadata).toMatchObject({
        source: 'retention',
        inquiries: 2,
        messages: 2,
        reason: 'Retention: online inquiries older than 90 days',
      });
      expect(audit.actor_user_id).toBe('00000000-0000-4000-8000-000000000001');
      expect(JSON.stringify(audit)).not.toMatch(/Old Visitor|966500000099|old@example/);

      // Idempotent: the next run finds nothing and audits nothing.
      expect(await run(a)).toMatchObject({ ok: true, result: { inquiries: 0, messages: 0 } });
      expect(await auditCount(a.tenantId)).toBe(audits + 1);

      // The hash chains still verify after redactions (the audit log itself is never rewritten).
      for (const t of [a, b])
        expect((await t.owner.post('/audit-logs/verify')).body).toMatchObject({ ok: true });
    });
  });
});
