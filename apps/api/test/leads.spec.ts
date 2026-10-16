import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { createCustomer } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, ownerPool, TestTenant } from './helpers';

interface Stage {
  id: string;
  code: string;
  kind: string;
  isActive: boolean;
}

describe('leads & sales pipeline', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  let pool: Pool;
  let rep: { client: Client; userId: string };
  let rep2: { client: Client; userId: string };
  let manager: { client: Client; userId: string };
  let stages: Stage[];
  const stage = (code: string) => stages.find((s) => s.code === code)!;

  async function lead(client: Client, extra: Record<string, unknown> = {}) {
    const c = await createCustomer(client);
    const res = await client.post('/leads', { customerId: c.id, branchId: t.branchId, source: 'walk_in', ...extra });
    if (res.status !== 201) throw new Error(`lead create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; number: string; version: number; stageId: string; status: string; assignedUserId: string | null; customerId: string };
  }

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
    pool = ownerPool();
    rep = await addMember(app, t, 'sales_rep');
    rep2 = await addMember(app, t, 'sales_rep');
    manager = await addMember(app, t, 'sales_manager');
    stages = (await t.owner.get('/pipeline-stages')).body;
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('ships the default pipeline and numbers leads LD-YYYY-NNNNNN in the first open stage, owned by the creator', async () => {
    expect(stages.map((s) => s.code)).toEqual(['new', 'contacted', 'qualified', 'test_drive', 'negotiation', 'reserved', 'won', 'lost']);
    const l = await lead(rep.client, { budgetMin: '80000', budgetMax: '120000.5' });
    expect(l.number).toMatch(/^LD-\d{4}-\d{6}$/);
    expect(l).toMatchObject({ stageId: stage('new').id, status: 'open', assignedUserId: rep.userId });
    const hist = await pool.query(`SELECT from_stage_id, to_stage_id, to_status FROM lead_stage_history WHERE lead_id = $1`, [l.id]);
    expect(hist.rows).toEqual([{ from_stage_id: null, to_stage_id: stage('new').id, to_status: 'open' }]);
    const bad = await rep.client.post('/leads', { customerId: l.customerId, branchId: t.branchId, source: 'phone', budgetMin: '9000', budgetMax: '100' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_budget_range');
  });

  it('only users with leads.assign may give a lead to someone else', async () => {
    const c = await createCustomer(rep.client);
    const denied = await rep.client.post('/leads', { customerId: c.id, branchId: t.branchId, source: 'phone', assignedUserId: rep2.userId });
    expect(denied.status).toBe(403);
    const l = await lead(rep.client);
    expect((await rep.client.post(`/leads/${l.id}/assign`, { userId: rep2.userId })).status).toBe(403);
    const ok = await manager.client.post(`/leads/${l.id}/assign`, { userId: rep2.userId, note: 'Arabic speaker' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.assignedUserId).toBe(rep2.userId);
    // The previous owner loses sight of it; the new owner sees it and is notified.
    expect((await rep.client.get(`/leads/${l.id}`)).status).toBe(404);
    expect((await rep2.client.get(`/leads/${l.id}`)).status).toBe(200);
    const notes = await rep2.client.get('/notifications?unread=true');
    expect(notes.body.items.some((n: { entityId: string }) => n.entityId === l.id)).toBe(true);
  });

  it('moves through stages with append-only history; won/lost close the lead and reopen restores it', async () => {
    const l = await lead(rep.client);
    const s1 = await rep.client.post(`/leads/${l.id}/stage`, { stageId: stage('qualified').id, version: l.version });
    expect(s1.status, JSON.stringify(s1.body)).toBe(200);
    const stale = await rep.client.post(`/leads/${l.id}/stage`, { stageId: stage('negotiation').id, version: l.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    const toLost = await rep.client.post(`/leads/${l.id}/stage`, { stageId: stage('lost').id, version: s1.body.version });
    expect(toLost.body.error.code).toBe('use_lost_endpoint');
    const lost = await rep.client.post(`/leads/${l.id}/lost`, { reason: 'price', notes: 'Found cheaper', version: s1.body.version });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body).toMatchObject({ status: 'lost', stageId: stage('lost').id, lostReason: 'price' });
    const closed = await rep.client.post(`/leads/${l.id}/stage`, { stageId: stage('contacted').id, version: lost.body.version });
    expect(closed.body.error.code).toBe('lead_closed');
    const reopened = await rep.client.post(`/leads/${l.id}/reopen`, { note: 'Called back' });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'open', stageId: stage('new').id, lostReason: null });
    const won = await rep.client.post(`/leads/${l.id}/stage`, { stageId: stage('won').id, version: reopened.body.version });
    expect(won.body).toMatchObject({ status: 'won' });
    expect(won.body.closedAt).toBeTruthy();

    const detail = await rep.client.get(`/leads/${l.id}`);
    expect(detail.body.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(expect.arrayContaining(['open', 'lost', 'won']));
    expect(detail.body.history).toHaveLength(5);
    await expect(pool.query(`UPDATE lead_stage_history SET note = 'x' WHERE lead_id = $1`, [l.id])).rejects.toThrow();
    await expect(pool.query(`DELETE FROM lead_stage_history WHERE lead_id = $1`, [l.id])).rejects.toThrow();
  });

  it('sales reps see only their own leads in lists and on the board; managers see everyone', async () => {
    const mine = await lead(rep.client);
    const theirs = await lead(rep2.client);
    const ids = (r: { body: { items: Array<{ id: string }> } }) => r.body.items.map((i) => i.id);
    const repList = await rep.client.get('/leads?pageSize=100');
    expect(ids(repList)).toContain(mine.id);
    expect(ids(repList)).not.toContain(theirs.id);
    expect((await rep.client.get(`/leads/${theirs.id}`)).status).toBe(404);
    const mgr = await manager.client.get('/leads?pageSize=100');
    expect(ids(mgr)).toEqual(expect.arrayContaining([mine.id, theirs.id]));

    const board = await rep.client.get('/leads/board');
    expect(board.status).toBe(200);
    const cards = board.body.columns.flatMap((c: { leads: Array<{ id: string }> }) => c.leads.map((x) => x.id));
    expect(cards).toContain(mine.id);
    expect(cards).not.toContain(theirs.id);
    expect(board.body.columns.every((c: { stage: Stage }) => c.stage.kind === 'open')).toBe(true);
    expect(board.body.totals.count).toBe(board.body.columns.reduce((n: number, c: { count: number }) => n + c.count, 0));
  });

  it('follow-up reminders: overdue list per user and exactly one notification per due follow-up', async () => {
    const past = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const l = await lead(rep2.client, { nextFollowUpAt: past });
    const fu = await rep2.client.get('/leads/follow-ups');
    expect(fu.status).toBe(200);
    const item = fu.body.items.find((i: { id: string }) => i.id === l.id);
    expect(item).toMatchObject({ overdue: true });
    expect(fu.body.overdue).toBeGreaterThanOrEqual(1);

    const jobs = app.get(JobsService);
    const run1 = await jobs.runJob('leads.follow_up_reminders', { tenantId: t.tenantId });
    expect(run1?.[0]?.ok).toBe(true);
    await jobs.runJob('leads.follow_up_reminders', { tenantId: t.tenantId });
    const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE entity_id = $1 AND type = 'lead.follow_up'`, [l.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('pipeline stages are company settings: customise a default, add, and deactivate with lead moves', async () => {
    expect((await rep.client.post('/pipeline-stages', { code: 'financing', nameEn: 'Financing', nameAr: 'تمويل', sortOrder: 55 })).status).toBe(403);
    const created = await t.owner.post('/pipeline-stages', { code: 'financing', nameEn: 'Financing', nameAr: 'تمويل', sortOrder: 55, probabilityPct: 70 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dup = await t.owner.post('/pipeline-stages', { code: 'qualified', nameEn: 'Q', nameAr: 'Q', sortOrder: 1 });
    expect(dup.body.error.code).toBe('stage_code_taken');
    const wonProb = await t.owner.patch(`/pipeline-stages/${stage('won').id}`, { probabilityPct: 50 });
    expect(wonProb.body.error.code).toBe('invalid_probability');

    const l = await lead(t.owner, { stageId: created.body.id });
    const inUse = await t.owner.post(`/pipeline-stages/${created.body.id}/deactivate`, {});
    expect(inUse.body.error.code).toBe('stage_in_use');
    const off = await t.owner.post(`/pipeline-stages/${created.body.id}/deactivate`, { moveToStageId: stage('negotiation').id });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ isActive: false, movedLeads: 1 });
    expect((await t.owner.get(`/leads/${l.id}`)).body.stageId).toBe(stage('negotiation').id);

    // Renaming a default stage copies it for this company only; leads follow the copy.
    const renamed = await t.owner.patch(`/pipeline-stages/${stage('negotiation').id}`, { nameEn: 'Price talk' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.id).not.toBe(stage('negotiation').id);
    expect((await t.owner.get(`/leads/${l.id}`)).body.stageId).toBe(renamed.body.id);
    const otherStages: Stage[] = (await other.owner.get('/pipeline-stages')).body;
    expect(otherStages.find((s) => s.code === 'negotiation')!.id).toBe(stage('negotiation').id);
    expect(otherStages.some((s) => s.code === 'financing')).toBe(false);
  });

  it("another company's leads are invisible and cannot be created against its customers", async () => {
    const l = await lead(t.owner);
    expect((await other.owner.get(`/leads/${l.id}`)).status).toBe(404);
    expect((await other.owner.post(`/leads/${l.id}/lost`, { reason: 'price', version: l.version })).status).toBe(404);
    const otherBranch = (await other.owner.get('/branches')).body[0]?.id ?? t.branchId;
    expect((await other.owner.post('/leads', { customerId: l.customerId, branchId: otherBranch, source: 'phone' })).status).toBe(404);
  });
});
