import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { ACCOUNTS } from '../src/modules/ledger/chart';
import { PostingService, UnbalancedPostingError } from '../src/modules/ledger/posting.service';
import { NumberingService } from '../src/modules/numbering/numbering.service';
import { closeApp, createPlatformAdmin, createTenant, getApp, ownerPool, TestTenant } from './helpers';

describe('audit trail', () => {
  let app: INestApplication;
  let t: TestTenant;

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    await t.owner.post('/branches', { name: 'Audit Branch', code: 'AUD' });
  });
  afterAll(closeApp);

  it('records sensitive actions with actor and request id, redacting secrets', async () => {
    const res = await t.owner.get('/audit-logs?entityType=branch');
    expect(res.status).toBe(200);
    const entry = res.body.items.find((i: { action: string }) => i.action === 'branch.created');
    expect(entry).toBeTruthy();
    expect(entry.actorName).toBe('Owner User');
    expect(entry.metadata.requestId).toBeTruthy();
    const provision = (await t.owner.get('/audit-logs?entityType=tenant')).body.items[0];
    expect(JSON.stringify(provision)).not.toMatch(/TestPassw0rd/);
  });

  it('verifies an intact chain and detects tampering by a privileged DB user', async () => {
    const ok = await t.owner.post('/audit-logs/verify');
    expect(ok.body).toMatchObject({ ok: true, reason: null });
    expect(ok.body.checked).toBeGreaterThan(1);

    const pool = ownerPool();
    try {
      // The app role cannot modify audit rows at all; even the owner is blocked by the trigger…
      await expect(pool.query(`UPDATE audit_logs SET summary = 'x' WHERE tenant_id = $1`, [t.tenantId])).rejects.toThrow(/immutable_record/);
      // …unless it deliberately disables the trigger. That tampering must be detected.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_immutable');
        await c.query(`UPDATE audit_logs SET summary = 'tampered' WHERE tenant_id = $1 AND seq = 1`, [t.tenantId]);
        await c.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_immutable');
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    } finally {
      await pool.end();
    }
    const bad = await t.owner.post('/audit-logs/verify');
    expect(bad.body).toMatchObject({ ok: false, firstBadSeq: 1, reason: 'hash_mismatch' });
  });
});

describe('ledger posting engine', () => {
  let app: INestApplication;
  let t: TestTenant;
  let dbs: DbService;
  let posting: PostingService;

  const inTenant = <T>(fn: () => Promise<T>) => dbs.runInTenant({ tenantId: t.tenantId, userId: null }, fn);

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    dbs = app.get(DbService);
    posting = app.get(PostingService);
  });

  it('posts a balanced entry and computes dimension balances', async () => {
    const vehicleId = randomUUID();
    await inTenant(() =>
      posting.post({
        sourceType: 'test',
        sourceId: vehicleId,
        event: 'purchase',
        date: '2026-01-10',
        description: 'Vehicle purchase',
        lines: [
          { account: ACCOUNTS.INVENTORY, debit: '150000.00', vehicleId },
          { account: ACCOUNTS.PAYABLES, credit: '150000.00' },
        ],
      }),
    );
    const bal = await inTenant(() => posting.balance(ACCOUNTS.INVENTORY, { vehicleId }));
    expect(bal).toBe('150000.00');
  });

  it('rejects unbalanced postings in the application', async () => {
    await expect(
      inTenant(() =>
        posting.post({
          sourceType: 'test',
          sourceId: randomUUID(),
          event: 'bad',
          date: '2026-01-10',
          description: 'x',
          lines: [
            { account: ACCOUNTS.CASH, debit: '100.00' },
            { account: ACCOUNTS.EQUITY, credit: '99.99' },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(UnbalancedPostingError);
  });

  it('rejects posting the same business event twice', async () => {
    const sourceId = randomUUID();
    const req = {
      sourceType: 'test',
      sourceId,
      event: 'once',
      date: '2026-01-11',
      description: 'once',
      lines: [
        { account: ACCOUNTS.CASH, debit: '10.00' },
        { account: ACCOUNTS.EQUITY, credit: '10.00' },
      ],
    } as const;
    await inTenant(() => posting.post({ ...req, lines: [...req.lines] }));
    await expect(inTenant(() => posting.post({ ...req, lines: [...req.lines] }))).rejects.toThrow();
  });

  it('reverses an entry so the net effect is zero', async () => {
    const sourceId = randomUUID();
    await inTenant(async () => {
      await posting.post({
        sourceType: 'test',
        sourceId,
        event: 'cost',
        date: '2026-01-12',
        description: 'cost',
        lines: [
          { account: ACCOUNTS.INVENTORY, debit: '500.00', vehicleId: sourceId },
          { account: ACCOUNTS.PAYABLES, credit: '500.00' },
        ],
      });
      await posting.reverse({ sourceType: 'test', sourceId, event: 'cost' }, 'cost.reversed', '2026-01-13', 'reversal');
    });
    expect(await inTenant(() => posting.balance(ACCOUNTS.INVENTORY, { vehicleId: sourceId }))).toBe('0.00');
  });

  it('issues gapless numbers and rolls back unused ones', async () => {
    const numbering = app.get(NumberingService);
    const first = await inTenant(() => numbering.next('invoice', 2026));
    await expect(
      inTenant(async () => {
        await numbering.next('invoice', 2026);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const second = await inTenant(() => numbering.next('invoice', 2026));
    expect(first).toBe('INV-2026-000001');
    expect(second).toBe('INV-2026-000002');
  });
});
