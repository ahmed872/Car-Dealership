import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costCategory, createAcquisition, createCashAccount, createSupplier, createVehicle, secondApprover } from './fixtures';
import { addMember, Client, closeApp, createPlatformAdmin, createTenant, getApp, idem, ownerPool, TestTenant } from './helpers';

/** GL balance (debit − credit) for one account, optionally filtered by a dimension column. */
async function gl(pool: Pool, tenantId: string, account: string, dim?: { col: string; id: string }) {
  const r = await pool.query(
    `SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines WHERE tenant_id = $1 AND account_code = $2 ${dim ? `AND ${dim.col} = $3` : ''}`,
    dim ? [tenantId, account, dim.id] : [tenantId, account],
  );
  return r.rows[0].b as string;
}

async function workOrderCosts(pool: Pool, tenantId: string, itemIds: string[]) {
  const r = await pool.query(
    `SELECT id, source_id, status, amount, amount_base, supplier_id FROM vehicle_costs WHERE tenant_id = $1 AND source_type = 'work_order_item' AND source_id = ANY($2::uuid[]) ORDER BY amount`,
    [tenantId, itemIds],
  );
  return r.rows as Array<{ id: string; source_id: string; status: string; amount: string; amount_base: string; supplier_id: string | null }>;
}

async function assertBalancedLedger(pool: Pool, tenantId: string) {
  const tb = await pool.query(`SELECT coalesce(sum(debit), 0)::text AS dr, coalesce(sum(credit), 0)::text AS cr FROM journal_lines WHERE tenant_id = $1`, [tenantId]);
  expect(tb.rows[0].dr).toBe(tb.rows[0].cr);
  const unbalanced = await pool.query(
    `SELECT entry_id FROM journal_lines WHERE tenant_id = $1 GROUP BY entry_id HAVING sum(debit) <> sum(credit)`,
    [tenantId],
  );
  expect(unbalanced.rowCount).toBe(0);
  const book = await pool.query(
    `SELECT coalesce(sum(CASE WHEN direction = 'in' THEN amount_base ELSE -amount_base END), 0)::numeric(18,2)::text AS b FROM cash_transactions WHERE tenant_id = $1`,
    [tenantId],
  );
  expect(book.rows[0].b).toBe(await gl(pool, tenantId, '1100'));
}

interface ItemSpec {
  kind: 'part' | 'labor' | 'service' | 'other';
  description: string;
  quantity: string;
  unitCost: string;
  categoryId: string;
  supplierId?: string | null;
  hours?: string | null;
}

describe('work orders', () => {
  let app: INestApplication;
  let t: TestTenant;
  let pool: Pool;
  let im: { client: Client; userId: string };
  let cats: { parts: string; maintenance: string; detailing: string; purchase: string; rent: string };

  async function openWorkOrder(c: Client, vehicleId: string, body: Record<string, unknown> = {}) {
    const res = await c.post('/work-orders', { vehicleId, type: 'repair', title: 'Pre-sale preparation', ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; number: string; status: string; priority: string };
  }

  async function addItem(c: Client, woId: string, item: ItemSpec) {
    const res = await c.post(`/work-orders/${woId}/items`, item);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; total: string; quantity: string; unitCost: string };
  }

  /** open → items → start → complete, returning the order awaiting approval. */
  async function readyForApproval(c: Client, vehicleId: string, items: ItemSpec[], body: Record<string, unknown> = {}) {
    const wo = await openWorkOrder(c, vehicleId, body);
    const added = [];
    for (const it of items) added.push(await addItem(c, wo.id, it));
    expect((await c.post(`/work-orders/${wo.id}/start`)).status).toBe(200);
    const done = await c.post(`/work-orders/${wo.id}/complete`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('awaiting_approval');
    return { wo, items: added };
  }

  beforeAll(async () => {
    app = await getApp();
    t = await createTenant(app, await createPlatformAdmin(app));
    pool = ownerPool();
    const m = await addMember(app, t, 'inventory_manager');
    im = { client: m.client, userId: m.userId };
    const rent = await pool.query(`SELECT id FROM cost_categories WHERE code = 'rent' AND tenant_id IS NULL`);
    cats = {
      parts: await costCategory(t.owner, 'parts'),
      maintenance: await costCategory(t.owner, 'maintenance'),
      detailing: await costCategory(t.owner, 'detailing'),
      purchase: await costCategory(t.owner, 'purchase'),
      rent: rent.rows[0].id,
    };
  });
  afterAll(async () => {
    await pool.end();
    await closeApp();
  });

  it('open → start → items → complete → approve posts one cost per item, pays supplier-less items, and is final', async () => {
    const owner = t.owner;
    const dealer = await createSupplier(owner);
    const workshop = await createSupplier(owner, { type: 'workshop', name: 'Al-Fahad Workshop' });
    const cash = await createCashAccount(owner, { openingBalance: '50000.00' });
    const acq = await createAcquisition(owner, t.branchId, dealer.id, { price: '80000.00' });
    const vehicleId = acq.vehicleId;
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: vehicleId })).toBe('80000.00');

    // The inventory manager opens and fills the order.
    const wo = await openWorkOrder(im.client, vehicleId, { priority: 'high', assignedUserId: im.userId, estimatedCost: '1500' });
    expect(wo.number).toMatch(/^WO-\d{4}-\d{6}$/);
    expect(wo.status).toBe('open');
    expect(wo).toMatchObject({ priority: 'high', estimatedCost: '1500.00', assignedUserId: im.userId });

    // PATCH without priority keeps it (zWorkOrderPatch has no defaults).
    const patched = await im.client.patch(`/work-orders/${wo.id}`, { title: 'Brakes, labour and detailing' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: 'Brakes, labour and detailing', priority: 'high' });

    const brakes = await addItem(im.client, wo.id, { kind: 'part', description: 'Brake pads (set)', quantity: '2', unitCost: '450.00', categoryId: cats.parts, supplierId: workshop.id });
    expect(brakes.total).toBe('900.00');
    // 2.5 × 10.01 = 25.025 → rounded half-up (tenant default) to 25.03; half-even would give 25.02.
    const labour = await addItem(im.client, wo.id, { kind: 'labor', description: 'Labour', quantity: '2.5', unitCost: '10.01', hours: '2.5', categoryId: cats.maintenance });
    expect(labour.total).toBe('25.03');
    const polish = await addItem(im.client, wo.id, { kind: 'service', description: 'Full detailing', quantity: '1', unitCost: '300.00', categoryId: cats.detailing });
    const warranty = await addItem(im.client, wo.id, { kind: 'other', description: 'Warranty check (free)', quantity: '1', unitCost: '0', categoryId: cats.maintenance });
    expect(warranty.total).toBe('0.00');
    const mistake = await addItem(im.client, wo.id, { kind: 'part', description: 'Wrong part', quantity: '1', unitCost: '99.00', categoryId: cats.parts });

    // Items are working figures before approval: edit (total recomputed) and hard delete.
    const edited = await im.client.patch(`/work-orders/${wo.id}/items/${polish.id}`, { unitCost: '350.00' });
    expect(edited.status).toBe(200);
    expect(edited.body.total).toBe('350.00');
    const qty = await im.client.patch(`/work-orders/${wo.id}/items/${mistake.id}`, { quantity: '3.333', unitCost: '33.33' });
    expect(qty.body.total).toBe('111.09'); // 3.333 × 33.33 = 111.08889 → 111.09
    expect((await im.client.delete(`/work-orders/${wo.id}/items/${mistake.id}`)).status).toBe(200);
    expect((await im.client.delete(`/work-orders/${wo.id}/items/${mistake.id}`)).status).toBe(404);

    // Flow guards.
    const early = await im.client.post(`/work-orders/${wo.id}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('work_order_not_in_progress');
    const started = await im.client.post(`/work-orders/${wo.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('in_progress');
    expect(started.body.startedAt).toBeTruthy();
    expect((await im.client.post(`/work-orders/${wo.id}/start`)).body.error.code).toBe('work_order_not_open');
    const completed = await im.client.post(`/work-orders/${wo.id}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('awaiting_approval');

    // Approval request is in the inbox of approvers only.
    const inbox = await owner.get('/approvals');
    const req = inbox.body.find((a: { entityId: string }) => a.entityId === wo.id);
    expect(req).toMatchObject({ type: 'work_order', entityType: 'work_order' });
    expect(req.payload).toMatchObject({ vehicleId, amountBase: '1275.03', itemCount: 4 });
    expect((await im.client.get('/approvals')).body.some((a: { entityId: string }) => a.entityId === wo.id)).toBe(false);

    // Locked for edits while awaiting approval; the inventory manager cannot approve.
    const locked = await im.client.patch(`/work-orders/${wo.id}/items/${labour.id}`, { quantity: '3' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('work_order_locked');
    expect((await im.client.post(`/work-orders/${wo.id}/approve`, {}, idem())).status).toBe(403);
    expect((await im.client.post(`/work-orders/${wo.id}/reject`, { reason: 'Not allowed' })).status).toBe(403);
    expect(await workOrderCosts(pool, t.tenantId, [brakes.id, labour.id, polish.id, warranty.id])).toHaveLength(0);

    // Owner approves and pays the supplier-less items (labour + detailing) from the cash box.
    const key = idem();
    const approved = await owner.post(`/work-orders/${wo.id}/approve`, { note: 'OK', payNow: { cashAccountId: cash.id, method: 'cash' } }, key);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('completed');
    expect(approved.body.approvedAt).toBeTruthy();
    expect(approved.body.completedAt).toBeTruthy();
    expect(approved.body.costs).toHaveLength(3);
    expect(approved.body.totalBase).toBe('1275.03');
    expect(approved.body.payment).toMatchObject({ supplierId: null, amount: '375.03', amountBase: '375.03' });

    const costs = await workOrderCosts(pool, t.tenantId, [brakes.id, labour.id, polish.id, warranty.id]);
    expect(costs.map((c) => [c.source_id, c.status, c.amount_base, c.supplier_id])).toEqual([
      [labour.id, 'posted', '25.03', null],
      [polish.id, 'posted', '350.00', null],
      [brakes.id, 'posted', '900.00', workshop.id],
    ]);

    // GL: inventory up by the item total; workshop payable open; cash down by the paid items only.
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: vehicleId })).toBe('81275.03');
    expect(await gl(pool, t.tenantId, '2000', { col: 'supplier_id', id: workshop.id })).toBe('-900.00');
    expect((await owner.get(`/cash-accounts/${cash.id}`)).body.balance).toBe('49624.97');
    expect(await gl(pool, t.tenantId, '1100', { col: 'cash_account_id', id: cash.id })).toBe('49624.97');

    const summary = await owner.get(`/vehicles/${vehicleId}/costs`);
    expect(summary.body.totals).toMatchObject({ posted: '81275.03', purchase: '80000.00', additional: '1275.03', pending: '0.00' });

    const detail = await owner.get(`/work-orders/${wo.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.totals).toEqual({ items: '1275.03', posted: '1275.03', paid: '375.03', outstanding: '900.00' });
    const byId = new Map(detail.body.items.map((i: { id: string }) => [i.id, i]));
    expect(byId.get(brakes.id)).toMatchObject({ cost: { status: 'posted', amountBase: '900.00', paidBase: '0.00', outstandingBase: '900.00', supplierId: workshop.id } });
    expect(byId.get(labour.id)).toMatchObject({ cost: { status: 'posted', paidBase: '25.03', outstandingBase: '0.00' } });
    expect(byId.get(warranty.id)).toMatchObject({ costId: null, cost: null });
    expect(detail.body).toMatchObject({ assigneeName: 'inventory_manager user', approvedByName: 'Owner User', status: 'completed' });
    expect(detail.body.payments).toHaveLength(2);
    expect((await owner.get('/approvals')).body.some((a: { entityId: string }) => a.entityId === wo.id)).toBe(false);

    // Replaying the same Idempotency-Key returns the stored response without posting again.
    // (Status is not asserted: the core interceptor stores 201 for @HttpCode(200) POSTs — reported.)
    const replay = await owner.post(`/work-orders/${wo.id}/approve`, { note: 'OK', payNow: { cashAccountId: cash.id, method: 'cash' } }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toMatchObject({ id: wo.id, status: 'completed', totalBase: '1275.03' });
    expect(replay.body.payment.id).toBe(approved.body.payment.id);
    // A new approval attempt is refused: no duplicate costs, no second payment.
    const again = await owner.post(`/work-orders/${wo.id}/approve`, { payNow: { cashAccountId: cash.id, method: 'cash' } }, idem());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('work_order_not_awaiting_approval');
    expect(await workOrderCosts(pool, t.tenantId, [brakes.id, labour.id, polish.id, warranty.id])).toHaveLength(3);
    expect((await owner.get(`/cash-accounts/${cash.id}`)).body.balance).toBe('49624.97');

    // The unique index is the last line of defence against double posting.
    await expect(
      pool.query(
        `INSERT INTO vehicle_costs (tenant_id, vehicle_id, category_id, description, amount, currency, amount_base, cost_date, status, source_type, source_id)
         VALUES ($1, $2, $3, 'dup', 1, 'SAR', 1, '2026-01-20', 'posted', 'work_order_item', $4)`,
        [t.tenantId, vehicleId, cats.maintenance, labour.id],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'vehicle_costs_source_uq' });

    // Approved orders are final.
    for (const res of [
      await owner.patch(`/work-orders/${wo.id}/items/${labour.id}`, { quantity: '3' }),
      await owner.delete(`/work-orders/${wo.id}/items/${labour.id}`),
      await owner.post(`/work-orders/${wo.id}/items`, { kind: 'part', description: 'Late part', quantity: '1', unitCost: '10.00', categoryId: cats.parts }),
      await owner.patch(`/work-orders/${wo.id}`, { title: 'Changed later' }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('work_order_locked');
    }
    const cancelLate = await owner.post(`/work-orders/${wo.id}/cancel`, { reason: 'Too late' });
    expect(cancelLate.status).toBe(409);
    expect(cancelLate.body.error.code).toBe('work_order_approved');
    expect((await owner.post(`/work-orders/${wo.id}/reject`, { reason: 'Too late' })).status).toBe(409);

    // Listing and the vehicle tab carry the joined data and totals.
    const list = await owner.get(`/work-orders?vehicleId=${vehicleId}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      id: wo.id,
      stockNumber: acq.vehicle.stockNumber,
      makeEn: 'Toyota',
      modelEn: 'Camry',
      assigneeName: 'inventory_manager user',
      itemCount: 4,
      itemsTotal: '1275.03',
      postedTotal: '1275.03',
      status: 'completed',
    });
    const byNumber = await owner.get(`/work-orders?q=${wo.number}`);
    expect(byNumber.body.items.map((i: { id: string }) => i.id)).toEqual([wo.id]);
    const tab = await owner.get(`/vehicles/${vehicleId}/work-orders`);
    expect(tab.status).toBe(200);
    expect(tab.body.map((i: { id: string }) => i.id)).toEqual([wo.id]);

    // Every mutation is audited.
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_type = 'work_order' AND entity_id = $2 ORDER BY seq`, [t.tenantId, wo.id]);
    const actions = audit.rows.map((r: { action: string }) => r.action);
    for (const a of ['work_order.created', 'work_order.updated', 'work_order.item_added', 'work_order.item_updated', 'work_order.item_removed', 'work_order.started', 'work_order.submitted', 'work_order.approved']) {
      expect(actions).toContain(a);
    }
    await assertBalancedLedger(pool, t.tenantId);
  });

  it('pay-now with no supplier-less items is refused atomically; order supplier applies to items without one', async () => {
    const owner = t.owner;
    const workshop = await createSupplier(owner, { type: 'workshop' });
    const cash = await createCashAccount(owner, { openingBalance: '1000.00' });
    const v = await createVehicle(owner, t.branchId);
    const { wo, items } = await readyForApproval(owner, v.id, [{ kind: 'labor', description: 'Paint touch-up', quantity: '1', unitCost: '700.00', categoryId: cats.maintenance }], { supplierId: workshop.id });

    const checker = await secondApprover(owner);
    const refused = await checker.post(`/work-orders/${wo.id}/approve`, { payNow: { cashAccountId: cash.id } }, idem());
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('nothing_to_pay_now');
    // The whole request rolled back: still awaiting approval, no cost, no ledger movement.
    expect((await owner.get(`/work-orders/${wo.id}`)).body.status).toBe('awaiting_approval');
    expect(await workOrderCosts(pool, t.tenantId, [items[0]!.id])).toHaveLength(0);
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('0.00');

    const ok = await checker.post(`/work-orders/${wo.id}/approve`, {}, idem());
    expect(ok.status).toBe(200);
    expect(ok.body.payment).toBeNull();
    const costs = await workOrderCosts(pool, t.tenantId, [items[0]!.id]);
    expect(costs).toMatchObject([{ status: 'posted', amount_base: '700.00', supplier_id: workshop.id }]);
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('700.00');
    expect(await gl(pool, t.tenantId, '2000', { col: 'supplier_id', id: workshop.id })).toBe('-700.00');
    expect((await owner.get(`/cash-accounts/${cash.id}`)).body.balance).toBe('1000.00');

    // The cost is now an ordinary payable: it can be paid in full but never overpaid.
    const over = await owner.post(
      '/supplier-payments',
      { supplierId: workshop.id, cashAccountId: cash.id, paidAt: '2026-10-01', method: 'cash', amount: '800.00', allocations: [{ targetType: 'vehicle_cost', targetId: costs[0]!.id, amountBase: '800.00' }] },
      idem(),
    );
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('overpayment');
    await assertBalancedLedger(pool, t.tenantId);
  });

  it('concurrent approvals post each item exactly once', async () => {
    const owner = t.owner;
    const v = await createVehicle(owner, t.branchId);
    const { wo, items } = await readyForApproval(owner, v.id, [
      { kind: 'part', description: 'Headlight', quantity: '2', unitCost: '310.50', categoryId: cats.parts },
      { kind: 'labor', description: 'Fitting', quantity: '1.25', unitCost: '80.00', categoryId: cats.maintenance },
    ]);
    const checker = await secondApprover(owner);
    const results = await Promise.all([1, 2, 3].map(() => checker.post(`/work-orders/${wo.id}/approve`, {}, idem())));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('work_order_not_awaiting_approval');
    expect(await workOrderCosts(pool, t.tenantId, items.map((i) => i.id))).toHaveLength(2);
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('721.00');
    const entries = await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1 AND source_type = 'vehicle_cost' AND source_id IN (SELECT id FROM vehicle_costs WHERE source_type = 'work_order_item' AND source_id = ANY($2::uuid[]))`,
      [t.tenantId, items.map((i) => i.id)],
    );
    expect(entries.rows[0].n).toBe(2);
  });

  it('reject sends the order back for corrections; cancel works only before approval', async () => {
    const owner = t.owner;
    const v = await createVehicle(owner, t.branchId);
    const { wo, items } = await readyForApproval(owner, v.id, [{ kind: 'part', description: 'Battery', quantity: '1', unitCost: '400.00', categoryId: cats.parts }]);

    const rejected = await owner.post(`/work-orders/${wo.id}/reject`, { reason: 'Battery price too high' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('in_progress');
    expect((await owner.get('/approvals')).body.some((a: { entityId: string }) => a.entityId === wo.id)).toBe(false);
    expect((await owner.patch(`/work-orders/${wo.id}/items/${items[0]!.id}`, { unitCost: '350.00' })).body.total).toBe('350.00');
    expect((await owner.post(`/work-orders/${wo.id}/complete`)).status).toBe(200);
    expect((await owner.get('/approvals')).body.some((a: { entityId: string }) => a.entityId === wo.id)).toBe(true);

    // Cancelling while awaiting approval closes the request and posts nothing.
    const cancelled = await owner.post(`/work-orders/${wo.id}/cancel`, { reason: 'Customer bought as-is' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Customer bought as-is' });
    expect((await owner.get('/approvals')).body.some((a: { entityId: string }) => a.entityId === wo.id)).toBe(false);
    const req = await pool.query(`SELECT status FROM approval_requests WHERE entity_id = $1 ORDER BY requested_at`, [wo.id]);
    expect(req.rows.map((r: { status: string }) => r.status)).toEqual(['rejected', 'cancelled']);
    expect((await owner.post(`/work-orders/${wo.id}/cancel`, { reason: 'Again' })).body.error.code).toBe('already_cancelled');
    const approveCancelled = await owner.post(`/work-orders/${wo.id}/approve`, {}, idem());
    expect(approveCancelled.status).toBe(409);
    expect(approveCancelled.body.error.code).toBe('work_order_not_awaiting_approval');
    expect((await owner.post(`/work-orders/${wo.id}/items`, { kind: 'part', description: 'Late', quantity: '1', unitCost: '1.00', categoryId: cats.parts })).status).toBe(409);
    expect(await workOrderCosts(pool, t.tenantId, [items[0]!.id])).toHaveLength(0);

    // An open order can be cancelled directly; cancel needs a reason.
    const open = await openWorkOrder(owner, v.id);
    expect((await owner.post(`/work-orders/${open.id}/cancel`, {})).status).toBe(422);
    expect((await owner.post(`/work-orders/${open.id}/cancel`, { reason: 'Duplicate' })).status).toBe(200);
  });

  it('an approval made from a stale screen is refused (KI-005 version check)', async () => {
    const owner = t.owner;
    const checker = await secondApprover(owner);
    const v = await createVehicle(owner, t.branchId);
    const { wo, items } = await readyForApproval(owner, v.id, [{ kind: 'part', description: 'Battery', quantity: '1', unitCost: '400.00', categoryId: cats.parts }]);
    const seen = (await checker.get(`/work-orders/${wo.id}`)).body.version as number;
    expect(seen).toBeGreaterThanOrEqual(1);
    // While the approver's screen is open the order is sent back, repriced and completed again.
    expect((await owner.post(`/work-orders/${wo.id}/reject`, { reason: 'Re-quote the battery' })).status).toBe(200);
    expect((await owner.patch(`/work-orders/${wo.id}/items/${items[0]!.id}`, { unitCost: '900.00' })).status).toBe(200);
    expect((await owner.post(`/work-orders/${wo.id}/complete`)).status).toBe(200);
    const stale = await checker.post(`/work-orders/${wo.id}/approve`, { version: seen }, idem());
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(await workOrderCosts(pool, t.tenantId, [items[0]!.id])).toHaveLength(0);
    const current = (await checker.get(`/work-orders/${wo.id}`)).body.version as number;
    expect(current).toBeGreaterThan(seen);
    const ok = await checker.post(`/work-orders/${wo.id}/approve`, { version: current }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const posted = await workOrderCosts(pool, t.tenantId, [items[0]!.id]);
    expect(posted).toHaveLength(1);
  });

  it('validates vehicles, categories, quantities, suppliers and assignees', async () => {
    const owner = t.owner;
    const v = await createVehicle(owner, t.branchId);
    const inactive = await createSupplier(owner, { isActive: false });
    const wo = await openWorkOrder(owner, v.id);
    const item = (over: Partial<ItemSpec>) => ({ kind: 'part', description: 'Filter', quantity: '1', unitCost: '50.00', categoryId: cats.parts, ...over });

    const operating = await owner.post(`/work-orders/${wo.id}/items`, item({ categoryId: cats.rent }));
    expect([operating.status, operating.body.error.code]).toEqual([422, 'category_not_vehicle']);
    const purchase = await owner.post(`/work-orders/${wo.id}/items`, item({ categoryId: cats.purchase }));
    expect([purchase.status, purchase.body.error.code]).toEqual([422, 'purchase_via_acquisition']);
    const zero = await owner.post(`/work-orders/${wo.id}/items`, item({ quantity: '0' }));
    expect([zero.status, zero.body.error.code]).toEqual([422, 'invalid_quantity']);
    const negative = await owner.post(`/work-orders/${wo.id}/items`, item({ unitCost: '-5.00' }));
    expect(negative.status).toBe(422);
    const tooPrecise = await owner.post(`/work-orders/${wo.id}/items`, item({ unitCost: '33.335' }));
    expect([tooPrecise.status, tooPrecise.body.error.code]).toEqual([422, 'validation_failed']);
    const badSupplier = await owner.post(`/work-orders/${wo.id}/items`, item({ supplierId: inactive.id }));
    expect([badSupplier.status, badSupplier.body.error.code]).toEqual([422, 'supplier_inactive']);
    const missingCat = await owner.post(`/work-orders/${wo.id}/items`, item({ categoryId: '00000000-0000-4000-8000-000000000000' }));
    expect(missingCat.status).toBe(404);

    // Header validations.
    const inactiveHeader = await owner.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'X job', supplierId: inactive.id });
    expect([inactiveHeader.status, inactiveHeader.body.error.code]).toEqual([422, 'supplier_inactive']);
    const other = await createTenant(app, await createPlatformAdmin(app));
    const outsider = await other.owner.get('/auth/me');
    const outsiderId = outsider.body.user.id as string;
    expect(outsiderId).toMatch(/^[0-9a-f-]{36}$/);
    const foreignAssignee = await owner.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'X job', assignedUserId: outsiderId });
    expect([foreignAssignee.status, foreignAssignee.body.error.code]).toEqual([422, 'assignee_not_member']);
    const badPatch = await owner.patch(`/work-orders/${wo.id}`, { assignedUserId: outsiderId });
    expect(badPatch.body.error.code).toBe('assignee_not_member');
    const missingVehicle = await owner.post('/work-orders', { vehicleId: '00000000-0000-4000-8000-000000000000', type: 'repair', title: 'X job' });
    expect(missingVehicle.status).toBe(404);

    // Completing needs at least one item.
    expect((await owner.post(`/work-orders/${wo.id}/start`)).status).toBe(200);
    const empty = await owner.post(`/work-orders/${wo.id}/complete`);
    expect([empty.status, empty.body.error.code]).toEqual([422, 'work_order_no_items']);

    // A vehicle removed from stock cannot receive new orders or complete existing ones.
    await addItem(owner, wo.id, item({}) as ItemSpec);
    const removed = await owner.post(`/vehicles/${v.id}/status`, { to: 'removed', reason: 'Total loss' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const closed = await owner.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'X job' });
    expect([closed.status, closed.body.error.code]).toEqual([409, 'vehicle_closed']);
    const gone = await owner.post(`/work-orders/${wo.id}/complete`);
    expect([gone.status, gone.body.error.code]).toEqual([409, 'vehicle_removed']);
  });

  it('enforces permissions: read-only roles cannot manage, managers cannot approve, sales reps cannot read', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const accountant = (await addMember(app, t, 'accountant')).client;
    const rep = (await addMember(app, t, 'sales_rep')).client;
    const inspector = (await addMember(app, t, 'inspector')).client;

    expect((await accountant.post('/work-orders', { vehicleId: v.id, type: 'inspection', title: 'Check' })).status).toBe(403);
    expect((await rep.get('/work-orders')).status).toBe(403);
    expect((await rep.get(`/vehicles/${v.id}/work-orders`)).status).toBe(403);

    const { wo } = await readyForApproval(inspector, v.id, [{ kind: 'labor', description: 'Inspection labour', quantity: '1', unitCost: '150.00', categoryId: cats.maintenance }], { type: 'inspection' });
    expect((await accountant.get(`/work-orders/${wo.id}`)).status).toBe(200);
    expect((await accountant.post(`/work-orders/${wo.id}/approve`, {}, idem())).status).toBe(403);
    expect((await inspector.post(`/work-orders/${wo.id}/approve`, {}, idem())).status).toBe(403);
    expect((await im.client.post(`/work-orders/${wo.id}/approve`, {}, idem())).status).toBe(403);

    // A custom approver role: may approve (posting costs) but lacks supplier_payments.create, so
    // pay-now is refused and nothing is posted.
    const role = await t.owner.post('/roles', { name: 'Workshop approver', permissions: ['work_orders.read', 'work_orders.approve'] });
    expect(role.status).toBe(201);
    const email = `woapprover${Date.now()}@autohub.test`;
    const user = await t.owner.post('/users', { email, fullName: 'WO Approver', password: 'TestPassw0rd!', roleId: role.body.id, allBranches: true });
    expect(user.status).toBe(201);
    const approver = await Client.login(app, email);
    const cash = await createCashAccount(t.owner, { openingBalance: '500.00' });
    const noPay = await approver.post(`/work-orders/${wo.id}/approve`, { payNow: { cashAccountId: cash.id } }, idem());
    expect(noPay.status).toBe(403);
    expect((await t.owner.get(`/work-orders/${wo.id}`)).body.status).toBe('awaiting_approval');
    const ok = await approver.post(`/work-orders/${wo.id}/approve`, {}, idem());
    expect(ok.status).toBe(200);
    expect(ok.body.costs).toHaveLength(1);
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v.id })).toBe('150.00');
    // Missing Idempotency-Key on a money-creating route.
    expect((await approver.post(`/work-orders/${wo.id}/approve`, {})).status).toBe(400);
  });

  it('isolates tenants: another company sees 404 for every route', async () => {
    const v = await createVehicle(t.owner, t.branchId);
    const { wo, items } = await readyForApproval(t.owner, v.id, [{ kind: 'part', description: 'Mirror', quantity: '1', unitCost: '120.00', categoryId: cats.parts }]);
    const other = await createTenant(app, await createPlatformAdmin(app));
    const b = other.owner;
    const parts = await costCategory(b, 'parts');

    expect((await b.get(`/work-orders/${wo.id}`)).status).toBe(404);
    expect((await b.patch(`/work-orders/${wo.id}`, { title: 'Hijack' })).status).toBe(404);
    expect((await b.post(`/work-orders/${wo.id}/items`, { kind: 'part', description: 'X1', quantity: '1', unitCost: '1.00', categoryId: parts })).status).toBe(404);
    expect((await b.patch(`/work-orders/${wo.id}/items/${items[0]!.id}`, { unitCost: '1.00' })).status).toBe(404);
    expect((await b.delete(`/work-orders/${wo.id}/items/${items[0]!.id}`)).status).toBe(404);
    expect((await b.post(`/work-orders/${wo.id}/start`)).status).toBe(404);
    expect((await b.post(`/work-orders/${wo.id}/complete`)).status).toBe(404);
    expect((await b.post(`/work-orders/${wo.id}/approve`, {}, idem())).status).toBe(404);
    expect((await b.post(`/work-orders/${wo.id}/reject`, { reason: 'Hijack' })).status).toBe(404);
    expect((await b.post(`/work-orders/${wo.id}/cancel`, { reason: 'Hijack' })).status).toBe(404);
    expect((await b.get(`/vehicles/${v.id}/work-orders`)).status).toBe(404);
    expect((await b.post('/work-orders', { vehicleId: v.id, type: 'repair', title: 'Hijack' })).status).toBe(404);
    expect((await b.get('/work-orders')).body.total).toBe(0);

    const still = await t.owner.get(`/work-orders/${wo.id}`);
    expect(still.body).toMatchObject({ status: 'awaiting_approval', title: 'Pre-sale preparation' });
    expect(still.body.items[0]).toMatchObject({ unitCost: '120.00', costId: null });
  });

  it('enforces branch scope on create, read, list, items, status changes and approval', async () => {
    const owner = t.owner;
    const b2 = await owner.post('/branches', { name: 'Jeddah', code: `WJ${Date.now() % 100000}` });
    expect(b2.status).toBe(201);
    const v2 = await createVehicle(owner, b2.body.id);
    const vMain = await createVehicle(owner, t.branchId);
    const scoped = await addMember(app, t, 'inventory_manager', { allBranches: false, branchIds: [t.branchId] });
    const scopedApprover = (await addMember(app, t, 'branch_manager', { allBranches: false, branchIds: [t.branchId] })).client;

    const { wo: jeddah } = await readyForApproval(owner, v2.id, [{ kind: 'part', description: 'Tyres', quantity: '4', unitCost: '250.00', categoryId: cats.parts }]);
    const mine = await openWorkOrder(scoped.client, vMain.id, { assignedUserId: scoped.userId });

    // The scoped user cannot be assigned work on a branch they cannot access.
    const badAssign = await owner.post('/work-orders', { vehicleId: v2.id, type: 'repair', title: 'Tyres 2', assignedUserId: scoped.userId });
    expect([badAssign.status, badAssign.body.error.code]).toEqual([422, 'assignee_no_branch_access']);

    const c = scoped.client;
    expect((await c.post('/work-orders', { vehicleId: v2.id, type: 'repair', title: 'Other branch' })).status).toBe(403);
    expect((await c.get(`/work-orders/${jeddah.id}`)).status).toBe(403);
    expect((await c.patch(`/work-orders/${jeddah.id}`, { title: 'Other branch' })).status).toBe(403);
    expect((await c.post(`/work-orders/${jeddah.id}/items`, { kind: 'part', description: 'X1', quantity: '1', unitCost: '1.00', categoryId: cats.parts })).status).toBe(403);
    expect((await c.post(`/work-orders/${jeddah.id}/cancel`, { reason: 'Other branch' })).status).toBe(403);
    expect((await c.get(`/vehicles/${v2.id}/work-orders`)).status).toBe(403);
    expect((await c.get(`/work-orders?branchId=${b2.body.id}`)).status).toBe(403);
    expect((await scopedApprover.post(`/work-orders/${jeddah.id}/approve`, {}, idem())).status).toBe(403);
    expect((await scopedApprover.get('/approvals')).body.some((a: { entityId: string }) => a.entityId === jeddah.id)).toBe(false);

    const list = await c.get('/work-orders?pageSize=200');
    expect(list.status).toBe(200);
    const ids = list.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(jeddah.id);
    expect(list.body.items.every((i: { branchId: string }) => i.branchId === t.branchId)).toBe(true);
    expect((await c.get(`/work-orders/${mine.id}`)).status).toBe(200);

    // Unchanged after the refused attempts; a company-wide approver (not its maker) can approve it.
    expect((await owner.get(`/work-orders/${jeddah.id}`)).body.status).toBe('awaiting_approval');
    const approved = await (await secondApprover(owner)).post(`/work-orders/${jeddah.id}/approve`, {}, idem());
    expect(approved.status).toBe(200);
    expect(await gl(pool, t.tenantId, '1300', { col: 'vehicle_id', id: v2.id })).toBe('1000.00');
    const ownerList = await owner.get(`/work-orders?branchId=${b2.body.id}`);
    expect(ownerList.body.items.map((i: { id: string }) => i.id)).toEqual([jeddah.id]);
    await assertBalancedLedger(pool, t.tenantId);
  });
});
