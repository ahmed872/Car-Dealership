import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMemberWithPermissions, createBranch } from './fixtures';
import { addMember, closeApp, createPlatformAdmin, createTenant, getApp, TestTenant } from './helpers';

type Row = { id: string; fullName: string };

/**
 * GET /members/assignable: the staff list behind assignee pickers. Any company member may ask
 * (no users.read), it lists only active members whose role holds the asked permission and who can
 * reach the branch, returns id and name only, and accepts only the assignable permissions.
 */
describe('assignable members', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  let jeddah: { id: string };
  let repAll: { userId: string };
  let repRiyadh: { userId: string };
  let repJeddah: { userId: string; membershipId: string };
  let accountant: { userId: string };

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
    jeddah = await createBranch(t.owner, 'Jeddah');
    repAll = await addMember(app, t, 'sales_rep');
    repRiyadh = await addMember(app, t, 'sales_rep', { allBranches: false, branchIds: [t.branchId] });
    repJeddah = await addMember(app, t, 'sales_rep', { allBranches: false, branchIds: [jeddah.id] });
    accountant = await addMember(app, t, 'accountant');
  });
  afterAll(() => closeApp());

  const ids = (body: Row[]) => body.map((r) => r.id);

  it('lists active members whose role holds the permission, by branch, with id and name only', async () => {
    // A manager without users.read (the member directory) can still pick staff.
    const picker = await addMemberWithPermissions(app, t, ['leads.read', 'leads.assign']);
    expect((await picker.client.get('/users')).status).toBe(403);

    const riyadh = await picker.client.get(`/members/assignable?permission=leads.read&branchId=${t.branchId}`);
    expect(riyadh.status, JSON.stringify(riyadh.body)).toBe(200);
    expect(ids(riyadh.body)).toEqual(expect.arrayContaining([repAll.userId, repRiyadh.userId, picker.userId]));
    expect(ids(riyadh.body)).not.toContain(repJeddah.userId);
    // The accountant's role has no leads.read.
    expect(ids(riyadh.body)).not.toContain(accountant.userId);
    for (const r of riyadh.body as Row[]) expect(Object.keys(r).sort()).toEqual(['fullName', 'id']);

    const jed = await picker.client.get(`/members/assignable?permission=leads.read&branchId=${jeddah.id}`);
    expect(ids(jed.body)).toEqual(expect.arrayContaining([repAll.userId, repJeddah.userId]));
    expect(ids(jed.body)).not.toContain(repRiyadh.userId);

    // Without a branch an all-branch caller gets everyone eligible.
    const all = await picker.client.get('/members/assignable?permission=leads.read');
    expect(ids(all.body)).toEqual(expect.arrayContaining([repAll.userId, repRiyadh.userId, repJeddah.userId]));

    // work_orders.manage: the accountant (work_orders.read only) is not offered; the owner is.
    const wo = await picker.client.get(`/members/assignable?permission=work_orders.manage&branchId=${t.branchId}`);
    expect(wo.status).toBe(200);
    expect(ids(wo.body)).not.toContain(accountant.userId);
    expect(ids(wo.body)).not.toContain(repAll.userId);
  });

  it('leaves out suspended members', async () => {
    const temp = await addMember(app, t, 'sales_rep');
    const before = await t.owner.get('/members/assignable?permission=sales.create');
    expect(ids(before.body)).toContain(temp.userId);
    expect((await t.owner.patch(`/users/${temp.membershipId}`, { status: 'suspended' })).status).toBe(200);
    const after = await t.owner.get('/members/assignable?permission=sales.create');
    expect(ids(after.body)).not.toContain(temp.userId);
  });

  it('refuses permissions that are not assignable, and malformed input', async () => {
    for (const p of ['users.manage', 'ledger.post_manual', 'nope']) {
      const res = await t.owner.get(`/members/assignable?permission=${p}`);
      expect(res.status, p).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
    expect((await t.owner.get('/members/assignable')).status).toBe(422);
    expect((await t.owner.get('/members/assignable?permission=leads.read&branchId=not-a-uuid')).status).toBe(422);
  });

  it('branch scope: a branch-limited caller sees only members sharing a branch and cannot ask about other branches', async () => {
    const limited = await addMemberWithPermissions(app, t, ['appointments.manage'], { allBranches: false, branchIds: [t.branchId] });
    const denied = await limited.client.get(`/members/assignable?permission=leads.read&branchId=${jeddah.id}`);
    expect(denied.status).toBe(403);
    const own = await limited.client.get('/members/assignable?permission=leads.read');
    expect(own.status).toBe(200);
    expect(ids(own.body)).toEqual(expect.arrayContaining([repAll.userId, repRiyadh.userId]));
    expect(ids(own.body)).not.toContain(repJeddah.userId);
  });

  it("never lists another company's members; another company's branch is not found", async () => {
    const theirs = await other.owner.get('/members/assignable?permission=leads.read');
    expect(theirs.status).toBe(200);
    expect(ids(theirs.body).some((id) => [repAll.userId, repRiyadh.userId, repJeddah.userId].includes(id))).toBe(false);
    const res = await other.owner.get(`/members/assignable?permission=leads.read&branchId=${t.branchId}`);
    expect(res.status).toBe(404);
  });
});
