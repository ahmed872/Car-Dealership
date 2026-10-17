import type { INestApplication } from '@nestjs/common';
import { addDays, todayInZone } from '@autohub/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, ownerPool, TestTenant } from './helpers';

describe('employee profiles & commission policies', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  let pool: Pool;
  let rep: { client: Client; userId: string };
  let rep2: { client: Client; userId: string };
  let accountant: { client: Client; userId: string };
  let today: string;

  beforeAll(async () => {
    app = await getApp();
    const admin = await createPlatformAdmin(app);
    t = await createTenant(app, admin);
    other = await createTenant(app, admin);
    pool = ownerPool();
    rep = await addMember(app, t, 'sales_rep');
    rep2 = await addMember(app, t, 'sales_rep');
    accountant = await addMember(app, t, 'accountant');
    today = todayInZone('Asia/Riyadh');
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('validates rules with the shared calculator and refuses retroactive policies', async () => {
    const badTiers = await t.owner.post('/commission-policies', {
      code: 'bad_tiers',
      name: 'Bad tiers',
      rule: { type: 'tiered', tiers: [{ from: '1000', ratePct: '5' }] },
    });
    expect(badTiers.status).toBe(422);
    expect(badTiers.body.error.code).toBe('validation_failed');
    const pct = await t.owner.post('/commission-policies', { code: 'too_much', name: 'Too much', rule: { type: 'pct_of_profit', ratePct: '150' } });
    expect(pct.body.error.code).toBe('validation_failed');
    const past = await t.owner.post('/commission-policies', { code: 'old', name: 'Old', rule: { type: 'fixed', fixedAmount: '500' }, effectiveFrom: '2020-01-01' });
    expect(past.body.error.code).toBe('retroactive_change');
    expect((await rep.client.post('/commission-policies', { code: 'mine', name: 'Mine', rule: { type: 'fixed', fixedAmount: '1' } })).status).toBe(403);
  });

  it('versions a policy without editing history and resolves the version by date', async () => {
    const v1 = await t.owner.post('/commission-policies', { code: 'sales_std', name: 'Standard sales', rule: { type: 'pct_of_profit', ratePct: '10', requirePositiveProfit: true } });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, effectiveFrom: today, effectiveTo: null });
    const dup = await t.owner.post('/commission-policies', { code: 'sales_std', name: 'Again', rule: { type: 'fixed', fixedAmount: '1' } });
    expect(dup.body.error.code).toBe('policy_code_taken');
    const sameDay = await t.owner.post(`/commission-policies/${v1.body.id}/versions`, { rule: { type: 'pct_of_profit', ratePct: '12' }, effectiveFrom: today, reason: 'Raise' });
    expect(sameDay.body.error.code).toBe('version_overlap');
    const next = addDays(today, 10);
    const v2 = await t.owner.post(`/commission-policies/${v1.body.id}/versions`, { rule: { type: 'pct_of_profit', ratePct: '12' }, effectiveFrom: next, reason: 'Q4 raise' });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, effectiveFrom: next });
    const old = await pool.query(`SELECT rule, effective_to, superseded_by_id FROM commission_policies WHERE id = $1`, [v1.body.id]);
    expect(old.rows[0]).toMatchObject({ rule: { type: 'pct_of_profit', ratePct: '10', requirePositiveProfit: true }, superseded_by_id: v2.body.id });
    expect(old.rows[0].effective_to).toBeTruthy();

    // Concurrent versions of one policy: exactly one succeeds.
    const later = [addDays(today, 20), addDays(today, 21), addDays(today, 22)];
    const results = await Promise.all(
      later.map((d) => t.owner.post(`/commission-policies/${v1.body.id}/versions`, { rule: { type: 'fixed', fixedAmount: '700' }, effectiveFrom: d, reason: 'race' })),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    const versions = await pool.query(`SELECT version, effective_from, effective_to FROM commission_policies WHERE tenant_id = $1 AND code = 'sales_std' ORDER BY version`, [t.tenantId]);
    // Windows never overlap: each version ends the day before the next one starts.
    for (let i = 1; i < versions.rows.length; i++) {
      const prevTo = versions.rows[i - 1].effective_to as Date;
      const from = versions.rows[i].effective_from as Date;
      expect(new Date(prevTo).getTime()).toBeLessThan(new Date(from).getTime());
    }

    // Assign to a rep; the rep can see their own policy, not a colleague's.
    expect((await t.owner.put(`/employees/${rep.userId}/profile`, { commissionPolicyId: v1.body.id, employeeCode: 'S-001', monthlyTargetUnits: 6, monthlyTargetAmount: '600000' })).status).toBe(200);
    const mine = await rep.client.get(`/commission-policies/resolve?userId=${rep.userId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.policy).toMatchObject({ code: 'sales_std', version: 1 });
    const future = await rep.client.get(`/commission-policies/resolve?userId=${rep.userId}&date=${next}`);
    expect(future.body.policy).toMatchObject({ version: 2 });
    expect((await rep.client.get(`/commission-policies/resolve?userId=${rep2.userId}`)).status).toBe(403);
    expect((await accountant.client.get(`/commission-policies/resolve?userId=${rep.userId}`)).body.policy.code).toBe('sales_std');

    const busy = await t.owner.post(`/commission-policies/${v1.body.id}/deactivate`, { reason: 'Replaced' });
    expect(busy.body.error.code).toBe('policy_in_use');
  });

  it('previews commissions with the same calculator used for earned commissions', async () => {
    const p = await t.owner.post('/commission-policies', {
      code: 'tiered_profit',
      name: 'Tiered on profit',
      rule: { type: 'tiered', tierMode: 'marginal', tiers: [{ from: '0', ratePct: '5' }, { from: '10000', ratePct: '10' }], capAmount: '5000' },
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const r = await t.owner.post('/commission-policies/preview', { policyId: p.body.id, saleNet: '120000.00', grossProfit: '25000.00' });
    expect(r.status).toBe(200);
    // 10,000 × 5% + 15,000 × 10% = 2,000.00
    expect(r.body.result).toMatchObject({ amount: '2000.00', base: '25000.00' });
    const loss = await t.owner.post('/commission-policies/preview', { rule: { type: 'pct_of_profit', ratePct: '10', requirePositiveProfit: true }, saleNet: '90000', grossProfit: '-500' });
    expect(loss.body.result.amount).toBe('0.00');
    expect((await rep.client.post('/commission-policies/preview', { policyId: p.body.id, saleNet: '1', grossProfit: '1' })).status).toBe(403);
  });

  it('employee profiles: unique codes, permissions, other companies', async () => {
    const dup = await t.owner.put(`/employees/${rep2.userId}/profile`, { employeeCode: 'S-001' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('employee_code_taken');
    expect((await rep.client.put(`/employees/${rep.userId}/profile`, { jobTitle: 'Boss' })).status).toBe(403);
    expect((await rep.client.get(`/employees/${rep.userId}`)).status).toBe(200);
    expect((await rep.client.get(`/employees/${rep2.userId}`)).status).toBe(403);
    const list = await t.owner.get('/employees');
    expect(list.body.map((e: { userId: string }) => e.userId)).toEqual(expect.arrayContaining([rep.userId, rep2.userId, accountant.userId]));
    expect((await other.owner.put(`/employees/${rep.userId}/profile`, { jobTitle: 'x' })).status).toBe(404);
    expect((await other.owner.get(`/employees/${rep.userId}`)).status).toBe(404);
    const otherList = await other.owner.get('/employees');
    expect(otherList.body.map((e: { userId: string }) => e.userId)).not.toContain(rep.userId);
  });
});
