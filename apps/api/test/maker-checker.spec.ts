import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costCategory, createSupplier, createVehicle, secondApprover } from './fixtures';
import { Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, PASSWORD, TestTenant, uniq } from './helpers';

/**
 * B-016 maker-checker: whoever created or submitted a request may not approve it, even when they
 * hold the approval permission. Another approver must decide.
 */
describe('maker-checker (no self-approval)', () => {
  let app: INestApplication;
  let t: TestTenant;
  let checker: Client;

  /** A member with a custom role; returns the client and the role id so permissions can change. */
  async function member(permissions: string[]) {
    const role = await t.owner.post('/roles', { name: uniq('Role '), permissions, maxDiscountPct: '0' });
    expect(role.status).toBe(201);
    const email = `${uniq('mc')}@autohub.test`;
    const res = await t.owner.post('/users', { email, fullName: 'Clerk', password: PASSWORD, roleId: role.body.id, allBranches: true, branchIds: [] });
    expect(res.status).toBe(201);
    return { client: await Client.login(app, email), roleId: role.body.id as string, name: role.body.name as string };
  }

  async function grant(roleId: string, name: string, permissions: string[]) {
    const r = await t.owner.put(`/roles/${roleId}`, { name, permissions, maxDiscountPct: '0' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    checker = await secondApprover(t.owner);
  });
  afterAll(closeApp);

  it('work orders: the creator/completer cannot approve; another approver can', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const wo = await t.owner.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'Brake pads' });
    expect(wo.status).toBe(201);
    const item = await t.owner.post(`/work-orders/${wo.body.id}/items`, {
      kind: 'part',
      description: 'Brake pads',
      quantity: '1',
      unitCost: '450.00',
      categoryId: await costCategory(t.owner, 'parts'),
    });
    expect(item.status).toBe(201);
    expect((await t.owner.post(`/work-orders/${wo.body.id}/start`)).status).toBe(200);
    expect((await t.owner.post(`/work-orders/${wo.body.id}/complete`)).status).toBe(200);
    const self = await t.owner.post(`/work-orders/${wo.body.id}/approve`, {}, idem());
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval_forbidden');
    expect((await t.owner.get(`/work-orders/${wo.body.id}`)).body.status).toBe('awaiting_approval');
    expect((await checker.post(`/work-orders/${wo.body.id}/approve`, {}, idem())).status).toBe(200);
  });

  it('vehicle costs: a clerk later granted approval rights still cannot approve their own pending cost', async () => {
    const perms = ['vehicles.read', 'costs.read', 'costs.create'];
    const clerk = await member(perms);
    const v = await createVehicle(t.owner, t.branchId);
    const cost = await clerk.client.post(
      '/vehicle-costs',
      { vehicleId: v.id, categoryId: await costCategory(t.owner, 'transport'), description: 'Tow truck', amount: '350.00', currency: 'SAR', costDate: '2026-02-01', supplierId: (await createSupplier(t.owner)).id },
      idem(),
    );
    expect(cost.status).toBe(201);
    expect(cost.body.status).toBe('pending_approval');
    await grant(clerk.roleId, clerk.name, [...perms, 'costs.approve']);
    const self = await clerk.client.post(`/vehicle-costs/${cost.body.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval_forbidden');
    const ok = await t.owner.post(`/vehicle-costs/${cost.body.id}/approve`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('posted');
  });

  it('expenses: the recorder cannot approve their own pending expense', async () => {
    const perms = ['expenses.read', 'expenses.create'];
    const clerk = await member(perms);
    const cats = (await t.owner.get('/expense-categories')).body as Array<{ id: string; code: string }>;
    const rent = cats.find((c) => c.code === 'rent')!;
    const exp = await clerk.client.post(
      '/expenses',
      { branchId: t.branchId, categoryId: rent.id, description: 'Showroom rent', amount: '12000.00', currency: 'SAR', expenseDate: '2026-02-01' },
      idem(),
    );
    expect(exp.status).toBe(201);
    expect(exp.body.status).toBe('pending_approval');
    await grant(clerk.roleId, clerk.name, [...perms, 'expenses.approve']);
    const self = await clerk.client.post(`/expenses/${exp.body.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_approval_forbidden');
    expect((await t.owner.post(`/expenses/${exp.body.id}/approve`, {})).status).toBe(200);
  });
});
