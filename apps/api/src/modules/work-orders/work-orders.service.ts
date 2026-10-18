import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  d,
  money,
  sum,
  todayInZone,
  WORK_ORDER_SORT_KEYS,
  WorkOrderApproveInput,
  WorkOrderCreateInput,
  WorkOrderItemInput,
  WorkOrderItemUpdateInput,
  WorkOrderListFilter,
  WorkOrderPatchInput,
  WorkOrderSortKey,
} from '@autohub/shared';
import { assertBranchAccess, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import {
  costCategories,
  membershipBranches,
  memberships,
  suppliers,
  users,
  vehicleCosts,
  vehicleMakes,
  vehicleModels,
  vehicles,
  workOrderItems,
  workOrders,
} from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { ApprovalsService } from '../finance/approvals.service';
import { SupplierPaymentsService } from '../finance/supplier-payments.service';
import { NumberingService } from '../numbering/numbering.service';
import { CostsService } from '../purchasing/costs.service';
import { VehiclesService, VehicleRow } from '../vehicles/vehicles.service';

registerUniqueConstraint('work_orders_number_uq', 'work_order_number_taken', 'A work order with this number already exists');

type WorkOrderRow = typeof workOrders.$inferSelect;
type WorkOrderItemRow = typeof workOrderItems.$inferSelect;
type CostRow = typeof vehicleCosts.$inferSelect;

const NO_BRANCH = '00000000-0000-0000-0000-000000000000';
/** Items (and the order header) can change only before the order is submitted for approval. */
const EDITABLE: ReadonlySet<string> = new Set(['open', 'in_progress']);
const MAX_ITEMS = 200;

const assignee = alias(users, 'assignee');
const approver = alias(users, 'approver');

// Correlated subqueries reference the outer row by its literal qualified name (see CLAUDE.md).
const itemsTotalSql = sql<string>`(SELECT coalesce(sum(woi.total), 0) FROM work_order_items woi WHERE woi.work_order_id = work_orders.id)::numeric(18,2)::text`;
const itemCountSql = sql<number>`(SELECT count(*) FROM work_order_items woi WHERE woi.work_order_id = work_orders.id)::int`;
const postedTotalSql = sql<string>`(SELECT coalesce(sum(vc.amount_base), 0) FROM work_order_items woi JOIN vehicle_costs vc ON vc.id = woi.cost_id WHERE woi.work_order_id = work_orders.id AND vc.status = 'posted')::numeric(18,2)::text`;
const itemPaidSql = sql<string>`(SELECT coalesce(sum(spa.amount_base), 0) FROM supplier_payment_allocations spa JOIN supplier_payments sp ON sp.id = spa.payment_id WHERE spa.target_type = 'vehicle_cost' AND spa.target_id = work_order_items.cost_id AND sp.status = 'posted')::numeric(18,2)::text`;

const SORTS: Record<WorkOrderSortKey, SQL> = {
  createdAt: sql`${workOrders.createdAt}`,
  updatedAt: sql`${workOrders.updatedAt}`,
  number: sql`${workOrders.number}`,
  priority: sql`CASE ${workOrders.priority} WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END`,
  status: sql`${workOrders.status}`,
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Workshop / preparation work orders. Items are working figures (freely editable, hard-deletable)
 * until the order is approved; approval turns every item with a total > 0 into exactly one posted
 * vehicle cost (Dr 1300 Inventory / Cr 2000 Payables, via CostsService) whose source is the item.
 * The unique index vehicle_costs_source_uq (tenant, source_type, source_id) makes double posting
 * impossible even if two approvals raced past the row lock.
 *
 * Status flow: open → in_progress → awaiting_approval → completed (= approved, final), with
 * awaiting_approval → in_progress on reject and cancel allowed from any pre-approval state.
 */
@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly dbs: DbService,
    private readonly vehicles: VehiclesService,
    private readonly costs: CostsService,
    private readonly approvals: ApprovalsService,
    private readonly payments: SupplierPaymentsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  // ── Guards ─────────────────────────────────────────────────────────────────────────────
  /** SELECT … FOR UPDATE: serialises every change to a work order (status, items, approval). */
  async lock(id: string): Promise<WorkOrderRow> {
    const [wo] = await this.dbs.db.select().from(workOrders).where(eq(workOrders.id, id)).for('update');
    if (!wo) throw notFound('Work order');
    return wo;
  }

  /** Locks the work order and checks the caller may act on its vehicle's branch. */
  private async lockScoped(ctx: TenantContext, id: string): Promise<{ wo: WorkOrderRow; vehicle: VehicleRow }> {
    const wo = await this.lock(id);
    const vehicle = await this.vehicles.get(wo.vehicleId);
    assertBranchAccess(ctx, vehicle.branchId);
    return { wo, vehicle };
  }

  private assertEditable(wo: WorkOrderRow) {
    if (!EDITABLE.has(wo.status)) {
      throw conflict('work_order_locked', 'Only open or in-progress work orders can be changed', { status: wo.status });
    }
  }

  private async assertSupplier(id: string) {
    const [s] = await this.dbs.db.select({ id: suppliers.id, isActive: suppliers.isActive }).from(suppliers).where(eq(suppliers.id, id));
    if (!s) throw notFound('Supplier');
    if (!s.isActive) throw unprocessable('supplier_inactive', 'This supplier is inactive');
  }

  /** The assignee must be an active member of THIS company with access to the vehicle's branch. */
  private async assertAssignee(ctx: TenantContext, userId: string, branchId: string) {
    const [m] = await this.dbs.db
      .select({ id: memberships.id, allBranches: memberships.allBranches })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          // Explicit tenant filter: the own_membership_read policy also exposes the caller's
          // memberships in other companies.
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          eq(users.status, 'active'),
        ),
      );
    if (!m) throw unprocessable('assignee_not_member', 'The assigned user is not an active member of this company');
    if (m.allBranches) return;
    const [b] = await this.dbs.db
      .select({ branchId: membershipBranches.branchId })
      .from(membershipBranches)
      .where(and(eq(membershipBranches.membershipId, m.id), eq(membershipBranches.branchId, branchId)));
    if (!b) throw unprocessable('assignee_no_branch_access', "The assigned user has no access to the vehicle's branch");
  }

  private async assertCategory(id: string) {
    const [cat] = await this.dbs.db.select().from(costCategories).where(eq(costCategories.id, id));
    if (!cat || !cat.isActive) throw notFound('Cost category');
    if (cat.kind !== 'vehicle') throw unprocessable('category_not_vehicle', 'Use a vehicle cost category');
    if (cat.code === 'purchase') throw unprocessable('purchase_via_acquisition', 'The purchase price is recorded through the acquisition');
    return cat;
  }

  /** quantity × unit cost, rounded once to the base currency's minor units (tenant rounding mode). */
  private lineTotal(ctx: TenantContext, quantity: string, unitCost: string): string {
    if (d(quantity).lte(0)) throw unprocessable('invalid_quantity', 'Quantity must be greater than zero');
    return money(d(quantity).times(d(unitCost)), ctx.tenant.baseCurrency, ctx.tenant.settings.rounding);
  }

  private async touch(id: string) {
    await this.dbs.db.update(workOrders).set({ updatedAt: new Date() }).where(eq(workOrders.id, id));
  }

  private async lockItem(workOrderId: string, itemId: string): Promise<WorkOrderItemRow> {
    const [item] = await this.dbs.db
      .select()
      .from(workOrderItems)
      .where(and(eq(workOrderItems.id, itemId), eq(workOrderItems.workOrderId, workOrderId)))
      .for('update');
    if (!item) throw notFound('Work order item');
    return item;
  }

  // ── Header ─────────────────────────────────────────────────────────────────────────────
  async create(ctx: TenantContext, input: WorkOrderCreateInput) {
    const v = await this.vehicles.lock(input.vehicleId);
    assertBranchAccess(ctx, v.branchId);
    if (v.status === 'delivered' || v.status === 'removed') {
      throw conflict('vehicle_closed', 'Work orders cannot be opened for delivered or removed vehicles', { vehicleStatus: v.status });
    }
    if (input.supplierId) await this.assertSupplier(input.supplierId);
    if (input.assignedUserId) await this.assertAssignee(ctx, input.assignedUserId, v.branchId);
    const number = await this.numbering.next('work_order');
    const [wo] = await this.dbs.db
      .insert(workOrders)
      .values({
        tenantId: ctx.tenant.id,
        number,
        vehicleId: v.id,
        type: input.type,
        priority: input.priority,
        title: input.title,
        description: input.description ?? null,
        assignedUserId: input.assignedUserId ?? null,
        supplierId: input.supplierId ?? null,
        status: 'open',
        estimatedCost: input.estimatedCost != null ? money(input.estimatedCost, ctx.tenant.baseCurrency) : null,
        createdBy: ctx.userId,
      })
      .returning();
    await this.audit.record({
      action: 'work_order.created',
      entityType: 'work_order',
      entityId: wo!.id,
      summary: `${number}: ${v.stockNumber} ${input.title}`,
      after: wo,
      metadata: { vehicleId: v.id },
    });
    return wo!;
  }

  async update(ctx: TenantContext, id: string, input: WorkOrderPatchInput) {
    const { wo: before, vehicle } = await this.lockScoped(ctx, id);
    this.assertEditable(before);
    const patch: Partial<typeof workOrders.$inferInsert> = {};
    if (input.type !== undefined) patch.type = input.type;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.estimatedCost !== undefined) {
      patch.estimatedCost = input.estimatedCost === null ? null : money(input.estimatedCost, ctx.tenant.baseCurrency);
    }
    if (input.supplierId !== undefined) {
      if (input.supplierId && input.supplierId !== before.supplierId) await this.assertSupplier(input.supplierId);
      patch.supplierId = input.supplierId;
    }
    if (input.assignedUserId !== undefined) {
      if (input.assignedUserId && input.assignedUserId !== before.assignedUserId) {
        await this.assertAssignee(ctx, input.assignedUserId, vehicle.branchId);
      }
      patch.assignedUserId = input.assignedUserId;
    }
    if (!Object.keys(patch).length) return before;
    const [after] = await this.dbs.db
      .update(workOrders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workOrders.id, id))
      .returning();
    await this.audit.record({ action: 'work_order.updated', entityType: 'work_order', entityId: id, ...diff(before, after!) });
    return after!;
  }

  // ── Items ──────────────────────────────────────────────────────────────────────────────
  async addItem(ctx: TenantContext, id: string, input: WorkOrderItemInput) {
    const { wo } = await this.lockScoped(ctx, id);
    this.assertEditable(wo);
    const [c] = await this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(workOrderItems).where(eq(workOrderItems.workOrderId, id));
    if ((c?.n ?? 0) >= MAX_ITEMS) throw unprocessable('too_many_items', `A work order can have at most ${MAX_ITEMS} items`);
    await this.assertCategory(input.categoryId);
    if (input.supplierId) await this.assertSupplier(input.supplierId);
    const total = this.lineTotal(ctx, input.quantity, input.unitCost);
    const [item] = await this.dbs.db
      .insert(workOrderItems)
      .values({
        tenantId: ctx.tenant.id,
        workOrderId: id,
        kind: input.kind,
        description: input.description,
        quantity: input.quantity,
        unitCost: money(input.unitCost, ctx.tenant.baseCurrency),
        total,
        hours: input.hours ?? null,
        supplierId: input.supplierId ?? null,
        categoryId: input.categoryId,
      })
      .returning();
    await this.touch(id);
    await this.audit.record({
      action: 'work_order.item_added',
      entityType: 'work_order',
      entityId: id,
      summary: `${wo.number}: ${input.description} ${input.quantity} × ${input.unitCost} = ${total}`,
      after: item,
    });
    return item!;
  }

  async updateItem(ctx: TenantContext, id: string, itemId: string, input: WorkOrderItemUpdateInput) {
    const { wo } = await this.lockScoped(ctx, id);
    this.assertEditable(wo);
    const before = await this.lockItem(id, itemId);
    if (before.costId) throw conflict('item_posted', 'This item has already been posted as a vehicle cost');
    if (input.categoryId && input.categoryId !== before.categoryId) await this.assertCategory(input.categoryId);
    if (input.supplierId && input.supplierId !== before.supplierId) await this.assertSupplier(input.supplierId);
    const quantity = input.quantity ?? before.quantity;
    const unitCost = input.unitCost !== undefined ? money(input.unitCost, ctx.tenant.baseCurrency) : before.unitCost;
    const [after] = await this.dbs.db
      .update(workOrderItems)
      .set({
        kind: input.kind ?? before.kind,
        description: input.description ?? before.description,
        quantity,
        unitCost,
        total: this.lineTotal(ctx, quantity, unitCost),
        hours: input.hours !== undefined ? input.hours : before.hours,
        supplierId: input.supplierId !== undefined ? input.supplierId : before.supplierId,
        categoryId: input.categoryId ?? before.categoryId,
      })
      .where(eq(workOrderItems.id, itemId))
      .returning();
    await this.touch(id);
    await this.audit.record({ action: 'work_order.item_updated', entityType: 'work_order', entityId: id, ...diff(before, after!), metadata: { itemId } });
    return after!;
  }

  /** Items are working figures until approval, so they may be hard-deleted while editable. */
  async removeItem(ctx: TenantContext, id: string, itemId: string) {
    const { wo } = await this.lockScoped(ctx, id);
    this.assertEditable(wo);
    const item = await this.lockItem(id, itemId);
    if (item.costId) throw conflict('item_posted', 'This item has already been posted as a vehicle cost');
    await this.dbs.db.delete(workOrderItems).where(eq(workOrderItems.id, itemId));
    await this.touch(id);
    await this.audit.record({ action: 'work_order.item_removed', entityType: 'work_order', entityId: id, before: item, metadata: { itemId } });
    return { id: itemId, deleted: true };
  }

  // ── Status flow ────────────────────────────────────────────────────────────────────────
  async start(ctx: TenantContext, id: string) {
    const { wo } = await this.lockScoped(ctx, id);
    if (wo.status !== 'open') throw conflict('work_order_not_open', 'Only open work orders can be started', { status: wo.status });
    const [after] = await this.dbs.db
      .update(workOrders)
      .set({ status: 'in_progress', startedAt: new Date(), updatedAt: new Date() })
      .where(eq(workOrders.id, id))
      .returning();
    await this.audit.record({ action: 'work_order.started', entityType: 'work_order', entityId: id, before: { status: wo.status }, after: { status: 'in_progress' } });
    return after!;
  }

  /** Work finished: submits the items for approval (opens an approval-inbox request). */
  async complete(ctx: TenantContext, id: string) {
    const { wo, vehicle } = await this.lockScoped(ctx, id);
    if (wo.status !== 'in_progress') {
      throw conflict('work_order_not_in_progress', 'Only work orders in progress can be completed', { status: wo.status });
    }
    if (vehicle.status === 'removed') throw conflict('vehicle_removed', 'The vehicle was removed from stock');
    const items = await this.dbs.db.select({ total: workOrderItems.total }).from(workOrderItems).where(eq(workOrderItems.workOrderId, id));
    if (!items.length) throw unprocessable('work_order_no_items', 'Add at least one item before completing the work order');
    const totalBase = money(sum(items.map((i) => i.total)), ctx.tenant.baseCurrency);
    const [after] = await this.dbs.db
      .update(workOrders)
      .set({ status: 'awaiting_approval', updatedAt: new Date() })
      .where(eq(workOrders.id, id))
      .returning();
    await this.approvals.open(ctx, {
      type: 'work_order',
      entityType: 'work_order',
      entityId: id,
      requiredPermission: 'work_orders.approve',
      summary: `${wo.number} · ${vehicle.stockNumber}: ${wo.title} ${totalBase} ${ctx.tenant.baseCurrency}`,
      payload: { vehicleId: vehicle.id, amountBase: totalBase, itemCount: items.length },
      branchId: vehicle.branchId,
    });
    await this.audit.record({
      action: 'work_order.submitted',
      entityType: 'work_order',
      entityId: id,
      before: { status: wo.status },
      after: { status: 'awaiting_approval', totalBase, itemCount: items.length },
    });
    return after!;
  }

  /**
   * Approves the work: each item with a total > 0 becomes one posted vehicle cost (supplier =
   * item supplier ?? order supplier, base currency, dated today). With payNow, the costs that have
   * NO supplier (direct purchases) are paid together in one supplier payment; supplier costs stay
   * payable. The order ends in `completed`.
   */
  async approve(ctx: TenantContext, id: string, input: WorkOrderApproveInput) {
    const { wo, vehicle } = await this.lockScoped(ctx, id);
    if (wo.status !== 'awaiting_approval') {
      throw conflict('work_order_not_awaiting_approval', 'This work order is not awaiting approval', { status: wo.status });
    }
    // The approver decides on what they reviewed: any change to the order or its items since then
    // makes the decision stale.
    if (input.version !== undefined && input.version !== wo.version) {
      throw conflict('version_conflict', 'This work order was changed after you opened it. Reload and review it again.', { currentVersion: wo.version });
    }
    await this.approvals.assertNotSelfApproval(ctx, { type: 'work_order', entityType: 'work_order', entityId: wo.id, makers: [wo.createdBy] });
    const db = this.dbs.db;
    const items = await db.select().from(workOrderItems).where(eq(workOrderItems.workOrderId, id)).orderBy(asc(workOrderItems.createdAt), asc(workOrderItems.id)).for('update');
    const today = todayInZone(ctx.tenant.settings.timezone);
    const base = ctx.tenant.baseCurrency;
    const created: CostRow[] = [];
    for (const item of items) {
      if (d(item.total).lte(0)) continue; // zero-value lines (e.g. warranty work) carry no cost
      if (item.costId) throw conflict('already_posted', 'This document has already been posted as a cost', { itemId: item.id });
      const cost = await this.costs.create(
        ctx,
        {
          vehicleId: wo.vehicleId,
          categoryId: item.categoryId,
          description: `${wo.number}: ${item.description}`.slice(0, 300),
          amount: item.total,
          currency: base,
          costDate: today,
          supplierId: item.supplierId ?? wo.supplierId ?? null,
          notes: `Work order ${wo.number} · ${item.kind} ${item.quantity} × ${item.unitCost}`,
          payNow: null,
        },
        { sourceType: 'work_order_item', sourceId: item.id, forceStatus: 'posted', skipPayNow: true },
      );
      await db.update(workOrderItems).set({ costId: cost.id }).where(eq(workOrderItems.id, item.id));
      created.push(cost);
    }
    const now = new Date();
    const [after] = await db
      .update(workOrders)
      .set({ status: 'completed', approvedBy: ctx.userId, approvedAt: now, completedAt: now, updatedAt: now })
      .where(eq(workOrders.id, id))
      .returning();
    let payment: Awaited<ReturnType<CostsService['payNow']>> | null = null;
    if (input.payNow) {
      const direct = created.filter((c) => !c.supplierId);
      if (!direct.length) {
        throw unprocessable('nothing_to_pay_now', 'Only items without a supplier can be paid on approval, and this work order has none');
      }
      payment = await this.costs.payNow(ctx, direct, input.payNow, today);
    }
    await this.approvals.resolve(ctx, { type: 'work_order', entityType: 'work_order', entityId: id, status: 'approved', note: input.note });
    const totalBase = money(sum(created.map((c) => c.amountBase)), base);
    await this.audit.record({
      action: 'work_order.approved',
      entityType: 'work_order',
      entityId: id,
      summary: `${wo.number} · ${vehicle.stockNumber}: ${created.length} cost(s) ${totalBase} ${base}`,
      before: { status: wo.status },
      after: {
        status: 'completed',
        totalBase,
        costIds: created.map((c) => c.id),
        paymentId: payment?.id ?? null,
        note: input.note ?? null,
      },
    });
    return { ...after!, costs: created, totalBase, payment };
  }

  /** Sends a submitted work order back to in_progress so its items can be corrected. */
  async reject(ctx: TenantContext, id: string, reason: string) {
    const { wo } = await this.lockScoped(ctx, id);
    if (wo.status !== 'awaiting_approval') {
      throw conflict('work_order_not_awaiting_approval', 'This work order is not awaiting approval', { status: wo.status });
    }
    const [after] = await this.dbs.db
      .update(workOrders)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(workOrders.id, id))
      .returning();
    await this.approvals.resolve(ctx, { type: 'work_order', entityType: 'work_order', entityId: id, status: 'rejected', note: reason });
    await this.audit.record({ action: 'work_order.rejected', entityType: 'work_order', entityId: id, before: { status: wo.status }, after: { status: 'in_progress', reason } });
    return after!;
  }

  /** Cancels a work order before approval. Approved orders are final: reverse their costs instead. */
  async cancel(ctx: TenantContext, id: string, reason: string) {
    const { wo } = await this.lockScoped(ctx, id);
    if (wo.status === 'cancelled') throw conflict('already_cancelled', 'This work order is already cancelled');
    if (wo.status === 'completed') {
      throw conflict('work_order_approved', 'An approved work order cannot be cancelled; reverse its vehicle costs instead');
    }
    const [after] = await this.dbs.db
      .update(workOrders)
      .set({ status: 'cancelled', cancelReason: reason, updatedAt: new Date() })
      .where(eq(workOrders.id, id))
      .returning();
    await this.approvals.resolve(ctx, { type: 'work_order', entityType: 'work_order', entityId: id, status: 'cancelled', note: reason });
    await this.audit.record({ action: 'work_order.cancelled', entityType: 'work_order', entityId: id, before: { status: wo.status }, after: { status: 'cancelled', reason } });
    return after!;
  }

  // ── Queries ────────────────────────────────────────────────────────────────────────────
  private listSelect() {
    return this.dbs.db
      .select({
        id: workOrders.id,
        number: workOrders.number,
        type: workOrders.type,
        priority: workOrders.priority,
        title: workOrders.title,
        status: workOrders.status,
        estimatedCost: workOrders.estimatedCost,
        startedAt: workOrders.startedAt,
        completedAt: workOrders.completedAt,
        approvedAt: workOrders.approvedAt,
        createdAt: workOrders.createdAt,
        updatedAt: workOrders.updatedAt,
        vehicleId: workOrders.vehicleId,
        branchId: vehicles.branchId,
        stockNumber: vehicles.stockNumber,
        vin: vehicles.vin,
        vehicleStatus: vehicles.status,
        modelYear: vehicles.modelYear,
        makeEn: vehicleMakes.nameEn,
        makeAr: vehicleMakes.nameAr,
        modelEn: vehicleModels.nameEn,
        modelAr: vehicleModels.nameAr,
        assignedUserId: workOrders.assignedUserId,
        assigneeName: assignee.fullName,
        supplierId: workOrders.supplierId,
        supplierName: suppliers.name,
        itemCount: itemCountSql,
        itemsTotal: itemsTotalSql,
        postedTotal: postedTotalSql,
      })
      .from(workOrders)
      .innerJoin(vehicles, eq(vehicles.id, workOrders.vehicleId))
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .leftJoin(assignee, eq(assignee.id, workOrders.assignedUserId))
      .leftJoin(suppliers, eq(suppliers.id, workOrders.supplierId));
  }

  private branchScope(ctx: TenantContext): SQL | undefined {
    if (ctx.allBranches) return undefined;
    return inArray(vehicles.branchId, ctx.branchIds.length ? ctx.branchIds : [NO_BRANCH]);
  }

  async list(ctx: TenantContext, q: WorkOrderListFilter) {
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(workOrders.status, q.status));
    if (q.vehicleId) conds.push(eq(workOrders.vehicleId, q.vehicleId));
    if (q.assignedUserId) conds.push(eq(workOrders.assignedUserId, q.assignedUserId));
    if (q.supplierId) conds.push(eq(workOrders.supplierId, q.supplierId));
    if (q.type) conds.push(eq(workOrders.type, q.type));
    if (q.priority) conds.push(eq(workOrders.priority, q.priority));
    if (q.branchId) {
      assertBranchAccess(ctx, q.branchId);
      conds.push(eq(vehicles.branchId, q.branchId));
    }
    const scope = this.branchScope(ctx);
    if (scope) conds.push(scope);
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      conds.push(sql`(${workOrders.number} ILIKE ${like} OR ${workOrders.title} ILIKE ${like} OR ${vehicles.stockNumber} ILIKE ${like} OR ${vehicles.vin} ILIKE ${like})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const sortKey = (q.sort?.replace(/^-/, '') ?? 'createdAt') as WorkOrderSortKey;
    if (!(WORK_ORDER_SORT_KEYS as readonly string[]).includes(sortKey)) {
      throw unprocessable('invalid_sort', 'Unsupported sort key', { allowed: WORK_ORDER_SORT_KEYS });
    }
    const dir = q.sort && !q.sort.startsWith('-') ? asc : desc;
    const items = await this.listSelect()
      .where(where)
      .orderBy(dir(SORTS[sortKey]), desc(workOrders.createdAt), desc(workOrders.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [c] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workOrders)
      .innerJoin(vehicles, eq(vehicles.id, workOrders.vehicleId))
      .where(where);
    return { items, total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  /** All work orders of one vehicle (newest first). */
  async forVehicle(ctx: TenantContext, vehicleId: string) {
    const v = await this.vehicles.get(vehicleId);
    assertBranchAccess(ctx, v.branchId);
    return this.listSelect().where(eq(workOrders.vehicleId, vehicleId)).orderBy(desc(workOrders.createdAt), desc(workOrders.id)).limit(500);
  }

  async get(ctx: TenantContext, id: string) {
    const [row] = await this.dbs.db
      .select({
        wo: workOrders,
        branchId: vehicles.branchId,
        vehicle: {
          id: vehicles.id,
          stockNumber: vehicles.stockNumber,
          vin: vehicles.vin,
          status: vehicles.status,
          modelYear: vehicles.modelYear,
          makeEn: vehicleMakes.nameEn,
          makeAr: vehicleMakes.nameAr,
          modelEn: vehicleModels.nameEn,
          modelAr: vehicleModels.nameAr,
        },
        assigneeName: assignee.fullName,
        approvedByName: approver.fullName,
        supplierName: suppliers.name,
      })
      .from(workOrders)
      .innerJoin(vehicles, eq(vehicles.id, workOrders.vehicleId))
      .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .leftJoin(assignee, eq(assignee.id, workOrders.assignedUserId))
      .leftJoin(approver, eq(approver.id, workOrders.approvedBy))
      .leftJoin(suppliers, eq(suppliers.id, workOrders.supplierId))
      .where(eq(workOrders.id, id));
    if (!row) throw notFound('Work order');
    assertBranchAccess(ctx, row.branchId);
    const itemRows = await this.dbs.db
      .select({
        item: workOrderItems,
        categoryCode: costCategories.code,
        categoryEn: costCategories.nameEn,
        categoryAr: costCategories.nameAr,
        supplierName: suppliers.name,
        costStatus: vehicleCosts.status,
        costAmountBase: vehicleCosts.amountBase,
        costSupplierId: vehicleCosts.supplierId,
        paidBase: itemPaidSql,
      })
      .from(workOrderItems)
      .innerJoin(costCategories, eq(costCategories.id, workOrderItems.categoryId))
      .leftJoin(suppliers, eq(suppliers.id, workOrderItems.supplierId))
      .leftJoin(vehicleCosts, eq(vehicleCosts.id, workOrderItems.costId))
      .where(eq(workOrderItems.workOrderId, id))
      .orderBy(asc(workOrderItems.createdAt), asc(workOrderItems.id));
    const base = ctx.tenant.baseCurrency;
    const items = itemRows.map((r) => ({
      ...r.item,
      categoryCode: r.categoryCode,
      categoryEn: r.categoryEn,
      categoryAr: r.categoryAr,
      supplierName: r.supplierName,
      cost: r.item.costId
        ? {
            id: r.item.costId,
            status: r.costStatus,
            amountBase: r.costAmountBase,
            supplierId: r.costSupplierId,
            paidBase: r.paidBase,
            outstandingBase: r.costStatus === 'posted' ? money(d(r.costAmountBase ?? 0).minus(r.paidBase), base) : '0.00',
          }
        : null,
    }));
    const posted = items.filter((i) => i.cost?.status === 'posted');
    const costIds = items.flatMap((i) => (i.cost ? [i.cost.id] : []));
    const payments = await this.payments.forTargets('vehicle_cost', costIds);
    return {
      ...row.wo,
      branchId: row.branchId,
      vehicle: row.vehicle,
      assigneeName: row.assigneeName,
      approvedByName: row.approvedByName,
      supplierName: row.supplierName,
      currency: base,
      totals: {
        items: money(sum(items.map((i) => i.total)), base),
        posted: money(sum(posted.map((i) => i.cost!.amountBase ?? 0)), base),
        paid: money(sum(posted.map((i) => i.cost!.paidBase)), base),
        outstanding: money(sum(posted.map((i) => i.cost!.outstandingBase)), base),
      },
      items,
      payments,
    };
  }
}
