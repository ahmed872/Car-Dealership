import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, lte, SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  d,
  money,
  sum,
  UNSOLD_STATUSES,
  VehicleStatus,
  zLeadAssign,
  zLeadBoardQuery,
  zLeadCreate,
  zLeadListQuery,
  zLeadLost,
  zLeadReopen,
  zLeadStageChange,
  zLeadUpdate,
} from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { ownEntry } from '../../common/lookup';
import { assertWorkingMember } from '../../common/members';
import { DbService } from '../../db/db.service';
import {
  branches,
  customerInteractions,
  customers,
  leads,
  leadStageHistory,
  pipelineStages,
  reservations,
  users,
  vehicleMakes,
  vehicleModels,
  vehicles,
} from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { SYSTEM_USER_ID } from '../jobs/system-context';
import { NotificationsService } from '../notifications/notifications.service';
import { NumberingService } from '../numbering/numbering.service';
import { PipelineService, presentStage, StageRow } from './pipeline.service';

registerUniqueConstraint('leads_number_uq', 'lead_number_taken', 'Lead number already exists');

export type LeadRow = typeof leads.$inferSelect;
type LeadCreate = z.infer<typeof zLeadCreate>;
type LeadUpdate = z.infer<typeof zLeadUpdate>;
type LeadStageChange = z.infer<typeof zLeadStageChange>;
type LeadLost = z.infer<typeof zLeadLost>;
type LeadReopen = z.infer<typeof zLeadReopen>;
type LeadAssign = z.infer<typeof zLeadAssign>;
type LeadListQuery = z.infer<typeof zLeadListQuery>;
type LeadBoardQuery = z.infer<typeof zLeadBoardQuery>;

const FOLLOW_UP_JOB = 'leads.follow_up_reminders';

const SORTS = {
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
  nextFollowUpAt: leads.nextFollowUpAt,
  lastActivityAt: leads.lastActivityAt,
  expectedCloseDate: leads.expectedCloseDate,
  budgetMax: leads.budgetMax,
  number: leads.number,
} as const;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Digits only, with Arabic-Indic / Persian digits mapped to ASCII (customers.phone is stored that way). */
function phoneDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
}

/** What a stage-history row records, derived from its from/to stage and status. */
function historyEvent(h: { fromStageId: string | null; toStageId: string; fromStatus: string | null; toStatus: string }) {
  if (h.fromStatus === null) return 'created';
  if (h.fromStatus !== 'open' && h.toStatus === 'open') return 'reopened';
  if (h.toStatus === 'won' && h.fromStatus === 'open') return 'won';
  if (h.toStatus === 'lost' && h.fromStatus === 'open') return 'lost';
  if (h.fromStageId === h.toStageId && h.fromStatus === h.toStatus) return 'reassigned';
  return 'stage_changed';
}

/**
 * Sales leads. A lead always sits in exactly one pipeline stage; its status follows the stage
 * kind (open / won / lost) and every move, close, reopen or reassignment appends a row to the
 * immutable lead_stage_history. Writes lock the lead row and check its version (optimistic
 * locking), and every change is audited.
 *
 * Visibility: users holding neither `leads.assign` nor `customers.read_all` (sales reps) see and
 * act only on leads assigned to them — other leads are reported as not found. Branch scope applies
 * to everyone without all-branch access.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly dbs: DbService,
    private readonly pipeline: PipelineService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    jobs: JobsService,
  ) {
    jobs.register({ name: FOLLOW_UP_JOB, everyMs: 15 * 60_000, run: (ctx) => this.remindFollowUps(ctx) });
  }

  // ── Access helpers ────────────────────────────────────────────────────────────────────

  /** Sales reps (no leads.assign, no customers.read_all) only see leads assigned to them. */
  private ownOnly(ctx: TenantContext): boolean {
    return !hasPermission(ctx, 'leads.assign') && !hasPermission(ctx, 'customers.read_all');
  }

  private scope(ctx: TenantContext): SQL[] {
    const conds: SQL[] = [];
    if (!ctx.allBranches) conds.push(ctx.branchIds.length ? inArray(leads.branchId, ctx.branchIds) : sql`false`);
    if (this.ownOnly(ctx)) conds.push(eq(leads.assignedUserId, ctx.userId));
    return conds;
  }

  /** A lead the caller may see; 404 for other tenants (RLS) and for other reps' leads. */
  private async find(ctx: TenantContext, id: string, lock = false): Promise<LeadRow> {
    const q = this.dbs.db.select().from(leads).where(eq(leads.id, id));
    const [l] = lock ? await q.for('update') : await q;
    if (!l || (this.ownOnly(ctx) && l.assignedUserId !== ctx.userId)) throw notFound('Lead');
    assertBranchAccess(ctx, l.branchId);
    return l;
  }

  private checkVersion(l: LeadRow, version: number | undefined): void {
    if (version !== undefined && version !== l.version) {
      throw conflict('version_conflict', 'This lead was changed by someone else. Reload and try again.', { currentVersion: l.version });
    }
  }

  private assertOpen(l: LeadRow): void {
    if (l.status !== 'open') throw conflict('lead_closed', 'This lead is closed; reopen it first', { status: l.status });
  }

  private async branch(ctx: TenantContext, id: string) {
    const [b] = await this.dbs.db.select({ id: branches.id, isActive: branches.isActive }).from(branches).where(eq(branches.id, id));
    if (!b) throw notFound('Branch');
    assertBranchAccess(ctx, b.id);
    if (!b.isActive) throw unprocessable('branch_inactive', 'This branch is inactive');
    return b;
  }

  private async customer(id: string) {
    const [c] = await this.dbs.db.select({ id: customers.id, fullName: customers.fullName, isActive: customers.isActive }).from(customers).where(eq(customers.id, id));
    if (!c) throw notFound('Customer');
    if (!c.isActive) throw unprocessable('customer_inactive', 'This customer is inactive');
    return c;
  }

  /** The vehicle of interest must be visible (tenant + branch) and still for sale. */
  private async vehicle(ctx: TenantContext, id: string) {
    const [v] = await this.dbs.db.select({ id: vehicles.id, branchId: vehicles.branchId, status: vehicles.status }).from(vehicles).where(eq(vehicles.id, id));
    if (!v) throw notFound('Vehicle');
    assertBranchAccess(ctx, v.branchId);
    if (!UNSOLD_STATUSES.includes(v.status as VehicleStatus)) {
      throw unprocessable('vehicle_not_for_sale', 'This vehicle is no longer for sale', { vehicleStatus: v.status });
    }
    return v;
  }

  /** An assignee must be an active member of this company, work with leads, and reach the branch. */
  private async assertAssignable(ctx: TenantContext, userId: string, branchId: string): Promise<{ id: string; fullName: string }> {
    return assertWorkingMember(this.dbs, ctx, userId, branchId, 'leads.read');
  }

  private budget(ctx: TenantContext, v: string | null | undefined): string | null | undefined {
    return v === undefined ? undefined : v === null ? null : money(v, ctx.tenant.baseCurrency);
  }

  private assertBudget(min: string | null, max: string | null): void {
    if (min !== null && max !== null && d(min).gt(max)) {
      throw unprocessable('invalid_budget_range', 'The minimum budget cannot exceed the maximum budget');
    }
  }

  private async openStage(id: string): Promise<StageRow> {
    const s = await this.pipeline.resolve(id);
    if (!s.isActive) throw unprocessable('stage_inactive', 'This pipeline stage is inactive');
    if (s.kind !== 'open') throw unprocessable('stage_not_open', 'Choose an open (non-terminal) pipeline stage');
    return s;
  }

  private async history(
    ctx: TenantContext,
    e: { leadId: string; fromStageId: string | null; toStageId: string; fromStatus: string | null; toStatus: string; note?: string | null },
  ): Promise<void> {
    await this.dbs.db.insert(leadStageHistory).values({ tenantId: ctx.tenant.id, ...e, note: e.note ?? null, changedBy: ctx.userId });
  }

  private async notifyAssigned(ctx: TenantContext, l: LeadRow): Promise<void> {
    if (!l.assignedUserId || l.assignedUserId === ctx.userId) return;
    const [c] = await this.dbs.db.select({ name: customers.fullName }).from(customers).where(eq(customers.id, l.customerId));
    await this.notifications.notify(ctx, {
      userIds: [l.assignedUserId],
      type: 'lead.assigned',
      titleAr: `تم إسناد الفرصة البيعية ${l.number} إليك`,
      titleEn: `Lead ${l.number} was assigned to you`,
      bodyAr: c?.name ?? null,
      bodyEn: c?.name ?? null,
      link: `/app/leads/${l.id}`,
      entityType: 'lead',
      entityId: l.id,
      dedupeKey: `lead.assigned:${l.id}:${l.version}`,
    });
  }

  // ── Commands ──────────────────────────────────────────────────────────────────────────

  async create(ctx: TenantContext, input: LeadCreate) {
    await this.pipeline.lockStages('shared');
    const branch = await this.branch(ctx, input.branchId);
    const cust = await this.customer(input.customerId);
    if (input.vehicleId) await this.vehicle(ctx, input.vehicleId);
    let stage: StageRow | null;
    if (input.stageId) stage = await this.openStage(input.stageId);
    else stage = await this.pipeline.firstActive('open');
    if (!stage) throw conflict('no_open_stage', 'The sales pipeline has no active open stage');

    // Default owner is the creator (scheduled/system work creates unassigned leads).
    const assignee = input.assignedUserId === undefined ? (ctx.userId === SYSTEM_USER_ID ? null : ctx.userId) : input.assignedUserId;
    if (assignee !== ctx.userId) assertPermission(ctx, 'leads.assign');
    if (assignee) await this.assertAssignable(ctx, assignee, branch.id);

    const budgetMin = this.budget(ctx, input.budgetMin) ?? null;
    const budgetMax = this.budget(ctx, input.budgetMax) ?? null;
    this.assertBudget(budgetMin, budgetMax);

    const number = await this.numbering.next('lead');
    const now = new Date();
    const [l] = await this.dbs.db
      .insert(leads)
      .values({
        tenantId: ctx.tenant.id,
        number,
        customerId: cust.id,
        branchId: branch.id,
        source: input.source,
        stageId: stage.id,
        status: 'open',
        assignedUserId: assignee,
        vehicleId: input.vehicleId ?? null,
        interestNotes: input.interestNotes ?? null,
        budgetMin,
        budgetMax,
        paymentPreference: input.paymentPreference ?? null,
        expectedCloseDate: input.expectedCloseDate ?? null,
        nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
        lastActivityAt: now,
        createdBy: ctx.userId,
      })
      .returning();
    await this.history(ctx, { leadId: l!.id, fromStageId: null, toStageId: stage.id, fromStatus: null, toStatus: 'open' });
    await this.audit.record({ action: 'lead.created', entityType: 'lead', entityId: l!.id, summary: `${number}: ${cust.fullName} (${input.source})`, after: l });
    await this.notifyAssigned(ctx, l!);
    return l!;
  }

  async update(ctx: TenantContext, id: string, input: LeadUpdate) {
    const before = await this.find(ctx, id, true);
    this.checkVersion(before, input.version);
    this.assertOpen(before);
    const set: Partial<typeof leads.$inferInsert> = {};
    if (input.vehicleId !== undefined && input.vehicleId !== before.vehicleId) {
      if (input.vehicleId) await this.vehicle(ctx, input.vehicleId);
      set.vehicleId = input.vehicleId;
    }
    if (input.interestNotes !== undefined) set.interestNotes = input.interestNotes;
    if (input.budgetMin !== undefined) set.budgetMin = this.budget(ctx, input.budgetMin);
    if (input.budgetMax !== undefined) set.budgetMax = this.budget(ctx, input.budgetMax);
    this.assertBudget(set.budgetMin !== undefined ? set.budgetMin : before.budgetMin, set.budgetMax !== undefined ? set.budgetMax : before.budgetMax);
    if (input.paymentPreference !== undefined) set.paymentPreference = input.paymentPreference;
    if (input.expectedCloseDate !== undefined) set.expectedCloseDate = input.expectedCloseDate;
    if (input.nextFollowUpAt !== undefined) set.nextFollowUpAt = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null;
    let reassignedTo: { id: string; fullName: string } | null | undefined;
    if (input.assignedUserId !== undefined && input.assignedUserId !== before.assignedUserId) {
      // Taking ownership yourself is part of managing the lead; giving it to anyone else (or to
      // nobody) is an assignment.
      if (input.assignedUserId !== ctx.userId) assertPermission(ctx, 'leads.assign');
      reassignedTo = input.assignedUserId ? await this.assertAssignable(ctx, input.assignedUserId, before.branchId) : null;
      set.assignedUserId = input.assignedUserId;
    }
    if (!Object.keys(set).length) return before;
    const [after] = await this.dbs.db
      .update(leads)
      .set({ ...set, version: before.version + 1, updatedAt: new Date() })
      .where(and(eq(leads.id, id), eq(leads.version, before.version)))
      .returning();
    if (!after) throw conflict('version_conflict', 'This lead was changed by someone else. Reload and try again.');
    if (reassignedTo !== undefined) {
      await this.history(ctx, {
        leadId: id,
        fromStageId: before.stageId,
        toStageId: before.stageId,
        fromStatus: before.status,
        toStatus: before.status,
        note: reassignedTo ? `Assigned to ${reassignedTo.fullName}` : 'Unassigned',
      });
      await this.notifyAssigned(ctx, after);
    }
    await this.audit.record({ action: 'lead.updated', entityType: 'lead', entityId: id, ...diff(before, after) });
    return after;
  }

  /** Moves an open lead to another stage; a won stage closes it as won. Lost uses markLost. */
  async changeStage(ctx: TenantContext, id: string, input: LeadStageChange) {
    await this.pipeline.lockStages('shared');
    const l = await this.find(ctx, id, true);
    this.checkVersion(l, input.version);
    this.assertOpen(l);
    const to = await this.pipeline.resolve(input.stageId);
    if (!to.isActive) throw unprocessable('stage_inactive', 'This pipeline stage is inactive');
    if (to.kind === 'lost') throw unprocessable('use_lost_endpoint', 'Mark the lead as lost instead (a lost reason is required)');
    if (to.id === l.stageId) throw unprocessable('stage_unchanged', 'The lead is already in this stage');
    const won = to.kind === 'won';
    const now = new Date();
    const [after] = await this.dbs.db
      .update(leads)
      .set({
        stageId: to.id,
        status: won ? 'won' : 'open',
        closedAt: won ? now : null,
        lastActivityAt: now,
        version: l.version + 1,
        updatedAt: now,
      })
      .where(eq(leads.id, id))
      .returning();
    await this.history(ctx, { leadId: id, fromStageId: l.stageId, toStageId: to.id, fromStatus: l.status, toStatus: after!.status, note: input.note ?? null });
    await this.audit.record({
      action: won ? 'lead.won' : 'lead.stage_changed',
      entityType: 'lead',
      entityId: id,
      summary: `${l.number} → ${to.code}`,
      before: { stageId: l.stageId, status: l.status },
      after: { stageId: to.id, stageCode: to.code, status: after!.status, note: input.note ?? null },
    });
    return after!;
  }

  /**
   * Called by the sales workflow when a sale for this lead is confirmed: the lead is won and
   * linked to the sale (no visibility check — the sale's own checks already apply).
   */
  async markWonBySale(ctx: TenantContext, leadId: string, saleId: string): Promise<void> {
    await this.pipeline.lockStages('shared');
    const [l] = await this.dbs.db.select().from(leads).where(eq(leads.id, leadId)).for('update');
    if (!l || l.status === 'won') return;
    const won = await this.pipeline.firstActive('won');
    if (!won) return;
    const now = new Date();
    await this.dbs.db
      .update(leads)
      .set({ stageId: won.id, status: 'won', wonSaleId: saleId, closedAt: now, lastActivityAt: now, version: l.version + 1, updatedAt: now })
      .where(eq(leads.id, leadId));
    await this.history(ctx, { leadId, fromStageId: l.stageId, toStageId: won.id, fromStatus: l.status, toStatus: 'won', note: 'Sale confirmed' });
    await this.audit.record({ action: 'lead.won', entityType: 'lead', entityId: leadId, summary: `${l.number} won by sale`, before: { status: l.status }, after: { status: 'won', saleId } });
  }

  async markLost(ctx: TenantContext, id: string, input: LeadLost) {
    await this.pipeline.lockStages('shared');
    const l = await this.find(ctx, id, true);
    this.checkVersion(l, input.version);
    this.assertOpen(l);
    const lost = await this.pipeline.firstActive('lost');
    if (!lost) throw conflict('no_lost_stage', 'The sales pipeline has no active lost stage');
    const now = new Date();
    const [after] = await this.dbs.db
      .update(leads)
      .set({
        stageId: lost.id,
        status: 'lost',
        lostReason: input.reason,
        lostNotes: input.notes ?? null,
        closedAt: now,
        lastActivityAt: now,
        version: l.version + 1,
        updatedAt: now,
      })
      .where(eq(leads.id, id))
      .returning();
    await this.history(ctx, {
      leadId: id,
      fromStageId: l.stageId,
      toStageId: lost.id,
      fromStatus: l.status,
      toStatus: 'lost',
      note: input.notes ? `${input.reason}: ${input.notes}` : input.reason,
    });
    await this.audit.record({
      action: 'lead.lost',
      entityType: 'lead',
      entityId: id,
      summary: `${l.number} lost (${input.reason})`,
      before: { stageId: l.stageId, status: l.status },
      after: { stageId: lost.id, status: 'lost', lostReason: input.reason, lostNotes: input.notes ?? null },
    });
    return after!;
  }

  /** Re-opens a won or lost lead into an open stage (default: 'new', else the first open stage). */
  async reopen(ctx: TenantContext, id: string, input: LeadReopen) {
    await this.pipeline.lockStages('shared');
    const l = await this.find(ctx, id, true);
    this.checkVersion(l, input.version);
    if (l.status === 'open') throw conflict('lead_open', 'This lead is already open');
    if (l.wonSaleId) throw conflict('lead_has_sale', 'This lead was won by a sale; cancel or return the sale instead');
    const to = input.stageId ? await this.openStage(input.stageId) : await this.pipeline.firstActive('open', 'new');
    if (!to) throw conflict('no_open_stage', 'The sales pipeline has no active open stage');
    const now = new Date();
    const [after] = await this.dbs.db
      .update(leads)
      .set({ stageId: to.id, status: 'open', closedAt: null, lostReason: null, lostNotes: null, lastActivityAt: now, version: l.version + 1, updatedAt: now })
      .where(eq(leads.id, id))
      .returning();
    await this.history(ctx, { leadId: id, fromStageId: l.stageId, toStageId: to.id, fromStatus: l.status, toStatus: 'open', note: input.note ?? null });
    await this.audit.record({
      action: 'lead.reopened',
      entityType: 'lead',
      entityId: id,
      summary: `${l.number} reopened in ${to.code}`,
      before: { stageId: l.stageId, status: l.status, lostReason: l.lostReason, lostNotes: l.lostNotes, closedAt: l.closedAt },
      after: { stageId: to.id, status: 'open', note: input.note ?? null },
    });
    return after!;
  }

  async assign(ctx: TenantContext, id: string, input: LeadAssign) {
    const l = await this.find(ctx, id, true);
    this.checkVersion(l, input.version);
    if (l.assignedUserId === input.userId) throw conflict('already_assigned', 'The lead is already assigned to this user');
    const user = await this.assertAssignable(ctx, input.userId, l.branchId);
    const [after] = await this.dbs.db
      .update(leads)
      .set({ assignedUserId: user.id, version: l.version + 1, updatedAt: new Date() })
      .where(eq(leads.id, id))
      .returning();
    await this.history(ctx, {
      leadId: id,
      fromStageId: l.stageId,
      toStageId: l.stageId,
      fromStatus: l.status,
      toStatus: l.status,
      note: `Assigned to ${user.fullName}${input.note ? `: ${input.note}` : ''}`,
    });
    await this.audit.record({
      action: 'lead.assigned',
      entityType: 'lead',
      entityId: id,
      summary: `${l.number} assigned to ${user.fullName}`,
      before: { assignedUserId: l.assignedUserId },
      after: { assignedUserId: user.id, note: input.note ?? null },
    });
    await this.notifyAssigned(ctx, after!);
    return after!;
  }

  // ── Queries ───────────────────────────────────────────────────────────────────────────

  /** Card/list columns (stage names in both languages, customer, owner, vehicle). */
  private async cards(where: SQL | undefined, orderBy: SQL[], limit: number, offset = 0) {
    return this.dbs.db
      .select({
        id: leads.id,
        number: leads.number,
        status: leads.status,
        source: leads.source,
        stageId: leads.stageId,
        stageCode: pipelineStages.code,
        stageNameEn: pipelineStages.nameEn,
        stageNameAr: pipelineStages.nameAr,
        stageKind: pipelineStages.kind,
        branchId: leads.branchId,
        branchName: branches.name,
        customerId: leads.customerId,
        customerName: customers.fullName,
        customerPhone: customers.phone,
        assignedUserId: leads.assignedUserId,
        assigneeName: users.fullName,
        vehicleId: leads.vehicleId,
        vehicleStockNumber: vehicles.stockNumber,
        vehicleModelYear: vehicles.modelYear,
        vehicleMakeEn: vehicleMakes.nameEn,
        vehicleMakeAr: vehicleMakes.nameAr,
        vehicleModelEn: vehicleModels.nameEn,
        vehicleModelAr: vehicleModels.nameAr,
        budgetMin: leads.budgetMin,
        budgetMax: leads.budgetMax,
        paymentPreference: leads.paymentPreference,
        expectedCloseDate: leads.expectedCloseDate,
        nextFollowUpAt: leads.nextFollowUpAt,
        lastActivityAt: leads.lastActivityAt,
        lostReason: leads.lostReason,
        createdAt: leads.createdAt,
        closedAt: leads.closedAt,
        version: leads.version,
      })
      .from(leads)
      .innerJoin(customers, eq(customers.id, leads.customerId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
      .innerJoin(branches, eq(branches.id, leads.branchId))
      .leftJoin(users, eq(users.id, leads.assignedUserId))
      .leftJoin(vehicles, eq(vehicles.id, leads.vehicleId))
      .leftJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
      .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
      .where(where)
      .orderBy(...orderBy, asc(leads.id))
      .limit(limit)
      .offset(offset);
  }

  async list(ctx: TenantContext, q: LeadListQuery) {
    const conds = this.scope(ctx);
    if (q.status) conds.push(eq(leads.status, q.status));
    if (q.customerId) conds.push(eq(leads.customerId, q.customerId));
    if (q.stageId) conds.push(eq(leads.stageId, q.stageId));
    if (q.assignedUserId) conds.push(eq(leads.assignedUserId, q.assignedUserId));
    if (q.source) conds.push(eq(leads.source, q.source));
    if (q.branchId) conds.push(eq(leads.branchId, q.branchId));
    if (q.mine === 'true') conds.push(eq(leads.assignedUserId, ctx.userId));
    if (q.followUpDue === 'true') conds.push(eq(leads.status, 'open'), isNotNull(leads.nextFollowUpAt), sql`${leads.nextFollowUpAt} <= now()`);
    let joinCustomer = false;
    if (q.q) {
      joinCustomer = true;
      const like = `%${escapeLike(q.q)}%`;
      const digits = phoneDigits(q.q);
      conds.push(
        sql`(${leads.number} ILIKE ${like} OR ${customers.fullName} ILIKE ${like} OR ${customers.companyName} ILIKE ${like}${
          digits.length >= 3 ? sql` OR ${customers.phone} LIKE ${`%${digits}%`} OR ${customers.whatsapp} LIKE ${`%${digits}%`}` : sql``
        })`,
      );
    }
    let orderBy: SQL[] = [sql`${leads.createdAt} DESC`];
    if (q.sort) {
      const key = q.sort.replace(/^-/, '');
      const col = ownEntry(SORTS, key);
      if (!col) throw unprocessable('invalid_sort', `Unsupported sort field "${key}"`, { allowed: Object.keys(SORTS) });
      orderBy = [q.sort.startsWith('-') ? sql`${col} DESC NULLS LAST` : sql`${col} ASC NULLS LAST`];
    }
    const where = conds.length ? and(...conds) : undefined;
    const items = await this.cards(where, orderBy, q.pageSize, (q.page - 1) * q.pageSize);
    const countQ = this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(leads);
    const [c] = joinCustomer ? await countQ.innerJoin(customers, eq(customers.id, leads.customerId)).where(where) : await countQ.where(where);
    return { items, total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(ctx: TenantContext, id: string) {
    const l = await this.find(ctx, id);
    const db = this.dbs.db;
    const [customer] = await db
      .select({
        id: customers.id,
        type: customers.type,
        fullName: customers.fullName,
        companyName: customers.companyName,
        phone: customers.phone,
        whatsapp: customers.whatsapp,
        email: customers.email,
        preferredLanguage: customers.preferredLanguage,
      })
      .from(customers)
      .where(eq(customers.id, l.customerId));
    const [assignee] = l.assignedUserId
      ? await db.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.id, l.assignedUserId))
      : [];
    const stage = (await this.pipeline.byIds([l.stageId])).get(l.stageId);

    const fromStage = alias(pipelineStages, 'from_stage');
    const toStage = alias(pipelineStages, 'to_stage');
    const history = await db
      .select({
        id: leadStageHistory.id,
        fromStageId: leadStageHistory.fromStageId,
        fromStageCode: fromStage.code,
        fromStageNameEn: fromStage.nameEn,
        fromStageNameAr: fromStage.nameAr,
        toStageId: leadStageHistory.toStageId,
        toStageCode: toStage.code,
        toStageNameEn: toStage.nameEn,
        toStageNameAr: toStage.nameAr,
        fromStatus: leadStageHistory.fromStatus,
        toStatus: leadStageHistory.toStatus,
        note: leadStageHistory.note,
        changedBy: leadStageHistory.changedBy,
        changedByName: users.fullName,
        changedAt: leadStageHistory.changedAt,
      })
      .from(leadStageHistory)
      .leftJoin(fromStage, eq(fromStage.id, leadStageHistory.fromStageId))
      .leftJoin(toStage, eq(toStage.id, leadStageHistory.toStageId))
      .leftJoin(users, eq(users.id, leadStageHistory.changedBy))
      .where(eq(leadStageHistory.leadId, id))
      .orderBy(asc(leadStageHistory.changedAt));

    const interactions = await db
      .select({
        id: customerInteractions.id,
        type: customerInteractions.type,
        direction: customerInteractions.direction,
        summary: customerInteractions.summary,
        outcome: customerInteractions.outcome,
        occurredAt: customerInteractions.occurredAt,
        nextFollowUpAt: customerInteractions.nextFollowUpAt,
        vehicleId: customerInteractions.vehicleId,
        userId: customerInteractions.userId,
        userName: users.fullName,
      })
      .from(customerInteractions)
      .leftJoin(users, eq(users.id, customerInteractions.userId))
      .where(eq(customerInteractions.leadId, id))
      .orderBy(desc(customerInteractions.occurredAt))
      .limit(100);

    const [vehicle] = l.vehicleId
      ? await db
          .select({
            id: vehicles.id,
            stockNumber: vehicles.stockNumber,
            status: vehicles.status,
            branchId: vehicles.branchId,
            modelYear: vehicles.modelYear,
            exteriorColor: vehicles.exteriorColor,
            odometerValue: vehicles.odometerValue,
            odometerUnit: vehicles.odometerUnit,
            askingPrice: vehicles.askingPrice,
            makeEn: vehicleMakes.nameEn,
            makeAr: vehicleMakes.nameAr,
            modelEn: vehicleModels.nameEn,
            modelAr: vehicleModels.nameAr,
          })
          .from(vehicles)
          .innerJoin(vehicleMakes, eq(vehicleMakes.id, vehicles.makeId))
          .innerJoin(vehicleModels, eq(vehicleModels.id, vehicles.modelId))
          .where(eq(vehicles.id, l.vehicleId))
      : [];

    const leadReservations = await db
      .select({
        id: reservations.id,
        number: reservations.number,
        status: reservations.status,
        vehicleId: reservations.vehicleId,
        stockNumber: vehicles.stockNumber,
        reservedAt: reservations.reservedAt,
        expiresAt: reservations.expiresAt,
        depositAmount: reservations.depositAmount,
        agreedPrice: reservations.agreedPrice,
      })
      .from(reservations)
      .innerJoin(vehicles, eq(vehicles.id, reservations.vehicleId))
      .where(eq(reservations.leadId, id))
      .orderBy(desc(reservations.reservedAt));

    return {
      ...l,
      stage: stage ? presentStage(stage) : null,
      customer: customer ?? null,
      assignee: assignee ?? null,
      vehicle: vehicle ?? null,
      history: history.map((h) => ({ ...h, event: historyEvent(h) })),
      interactions,
      reservations: leadReservations,
    };
  }

  /** Kanban: open leads per active open stage, with counts, budget totals and the top cards. */
  async board(ctx: TenantContext, q: LeadBoardQuery) {
    const conds = [...this.scope(ctx), eq(leads.status, 'open')];
    if (q.branchId) conds.push(eq(leads.branchId, q.branchId));
    if (q.assignedUserId) conds.push(eq(leads.assignedUserId, q.assignedUserId));
    if (q.source) conds.push(eq(leads.source, q.source));
    if (q.mine === 'true') conds.push(eq(leads.assignedUserId, ctx.userId));
    const where = and(...conds);
    const db = this.dbs.db;
    const agg = await db
      .select({
        stageId: leads.stageId,
        count: sql<number>`count(*)::int`,
        budgetMaxTotal: sql<string>`coalesce(sum(${leads.budgetMax}), 0)::numeric(18,2)::text`,
      })
      .from(leads)
      .where(where)
      .groupBy(leads.stageId);

    const cardOrder = [sql`${leads.nextFollowUpAt} ASC NULLS LAST`, sql`${leads.createdAt} DESC`];
    let cards: Awaited<ReturnType<LeadsService['cards']>> = [];
    if (q.perStage > 0 && agg.length) {
      const ranked = db
        .select({
          id: leads.id,
          rn: sql<number>`row_number() OVER (PARTITION BY ${leads.stageId} ORDER BY ${leads.nextFollowUpAt} ASC NULLS LAST, ${leads.createdAt} DESC, ${leads.id})`.as('rn'),
        })
        .from(leads)
        .where(where)
        .as('ranked');
      const ids = (await db.select({ id: ranked.id }).from(ranked).where(lte(ranked.rn, q.perStage))).map((r) => r.id);
      if (ids.length) cards = await this.cards(inArray(leads.id, ids), cardOrder, ids.length);
    }

    const stages = (await this.pipeline.effective()).filter((s) => s.kind === 'open');
    // Open leads in a stage that is no longer on the board (e.g. deactivated by the platform) stay visible.
    const known = new Set(stages.map((s) => s.id));
    const extra = agg.map((a) => a.stageId).filter((sid) => !known.has(sid));
    if (extra.length) stages.push(...(await this.pipeline.byIds(extra)).values());
    const byStage = new Map(agg.map((a) => [a.stageId, a]));
    const columns = stages.map((s) => ({
      stage: presentStage(s),
      count: byStage.get(s.id)?.count ?? 0,
      budgetMaxTotal: byStage.get(s.id)?.budgetMaxTotal ?? '0.00',
      leads: cards.filter((c) => c.stageId === s.id),
    }));
    return {
      columns,
      totals: {
        count: columns.reduce((n, c) => n + c.count, 0),
        budgetMaxTotal: sum(columns.map((c) => c.budgetMaxTotal)).toFixed(2),
      },
    };
  }

  /** The caller's open leads whose follow-up is overdue or due before the end of today (tenant zone). */
  async followUps(ctx: TenantContext, q: { limit: number }) {
    const tz = ctx.tenant.settings.timezone;
    const endOfToday = sql`((date_trunc('day', now() AT TIME ZONE ${tz}) + interval '1 day') AT TIME ZONE ${tz})`;
    const conds = [
      ...this.scope(ctx),
      eq(leads.assignedUserId, ctx.userId),
      eq(leads.status, 'open'),
      isNotNull(leads.nextFollowUpAt),
      sql`${leads.nextFollowUpAt} < ${endOfToday}`,
    ];
    const where = and(...conds);
    const [counts] = await this.dbs.db
      .select({
        overdue: sql<number>`(count(*) FILTER (WHERE ${leads.nextFollowUpAt} < now()))::int`,
        dueToday: sql<number>`(count(*) FILTER (WHERE ${leads.nextFollowUpAt} >= now()))::int`,
        now: sql<Date>`now()`,
        dueBefore: sql<Date>`${endOfToday}`,
      })
      .from(leads)
      .where(where);
    const items = await this.cards(where, [sql`${leads.nextFollowUpAt} ASC`], q.limit);
    const now = new Date(counts!.now);
    return {
      overdue: counts?.overdue ?? 0,
      dueToday: counts?.dueToday ?? 0,
      dueBefore: new Date(counts!.dueBefore),
      items: items.map((i) => ({ ...i, overdue: !!i.nextFollowUpAt && i.nextFollowUpAt < now })),
    };
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────────────────

  /**
   * Job: notify the assignee once per (lead, follow-up time, assignee) when a follow-up is due.
   * The dedupe key is built in SQL so the "already notified" filter and the key always agree;
   * the notifications unique index makes re-runs (or concurrent runs) exactly-once regardless.
   */
  async remindFollowUps(ctx: TenantContext): Promise<{ notified: number }> {
    const key = sql<string>`('lead.follow_up:' || leads.id::text || ':' || to_char(leads.next_follow_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
    const due = await this.dbs.db
      .select({
        id: leads.id,
        number: leads.number,
        assignedUserId: leads.assignedUserId,
        customerName: customers.fullName,
        dedupeKey: key,
      })
      .from(leads)
      .innerJoin(customers, eq(customers.id, leads.customerId))
      .where(
        and(
          eq(leads.status, 'open'),
          isNotNull(leads.assignedUserId),
          lte(leads.nextFollowUpAt, sql`now()`),
          sql`NOT EXISTS (SELECT 1 FROM notifications n WHERE n.tenant_id = leads.tenant_id AND n.dedupe_key = ${key} || ':' || leads.assigned_user_id::text)`,
        ),
      )
      .orderBy(asc(leads.nextFollowUpAt))
      .limit(1000);
    let notified = 0;
    for (const l of due) {
      notified += await this.notifications.notify(ctx, {
        userIds: [l.assignedUserId],
        type: 'lead.follow_up',
        titleAr: `موعد متابعة الفرصة البيعية ${l.number}`,
        titleEn: `Follow-up due for lead ${l.number}`,
        bodyAr: l.customerName,
        bodyEn: l.customerName,
        link: `/app/leads/${l.id}`,
        entityType: 'lead',
        entityId: l.id,
        dedupeKey: l.dedupeKey,
        severity: 'warning',
      });
    }
    return { notified };
  }
}
