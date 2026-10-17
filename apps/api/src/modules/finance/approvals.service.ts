import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { TenantContext } from '../../common/context';
import { AppError } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { approvalRequests, auditLogs, users } from '../../db/schema';

export type ApprovalType =
  | 'acquisition'
  | 'vehicle_cost'
  | 'expense'
  | 'work_order'
  | 'sale_discount'
  | 'sale_below_floor'
  | 'refund'
  | 'cash_adjustment';

/**
 * Audit actions whose actors are makers of a document (D-020): everyone who shaped what is being
 * approved. The document's creator and the pending request's requester are makers as well.
 */
export const MAKER_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  acquisition: ['acquisition.created', 'acquisition.updated', 'acquisition.submitted'],
  work_order: ['work_order.created', 'work_order.updated', 'work_order.item_added', 'work_order.item_updated', 'work_order.item_removed', 'work_order.submitted'],
};
const ALL_MAKER_ACTIONS = [...new Set(Object.values(MAKER_ACTIONS).flat())];

/**
 * Approval inbox. Each module owns its own status machine; this service records what is waiting
 * for a decision (and who decided), so approvers have one place to look.
 */
@Injectable()
export class ApprovalsService {
  constructor(private readonly dbs: DbService) {}

  async open(
    ctx: TenantContext,
    r: { type: ApprovalType; entityType: string; entityId: string; requiredPermission: string; summary: string; payload?: unknown; branchId?: string | null },
  ): Promise<void> {
    await this.dbs.db
      .insert(approvalRequests)
      .values({
        tenantId: ctx.tenant.id,
        type: r.type,
        entityType: r.entityType,
        entityId: r.entityId,
        requiredPermission: r.requiredPermission,
        summary: r.summary.slice(0, 500),
        payload: (r.payload ?? null) as object,
        requestedBy: ctx.userId,
        branchId: r.branchId ?? null,
      })
      .onConflictDoNothing();
  }

  async resolve(
    ctx: TenantContext,
    r: { type: ApprovalType; entityType: string; entityId: string; status: 'approved' | 'rejected' | 'cancelled'; note?: string | null },
  ): Promise<void> {
    await this.dbs.db
      .update(approvalRequests)
      .set({ status: r.status, decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: r.note ?? null })
      .where(
        and(
          eq(approvalRequests.type, r.type),
          eq(approvalRequests.entityType, r.entityType),
          eq(approvalRequests.entityId, r.entityId),
          eq(approvalRequests.status, 'pending'),
        ),
      );
  }

  /**
   * Maker-checker (B-016): whoever created or submitted a request may not approve it. `makers` are
   * the document's creator(s); the pending request's requester is added automatically.
   */
  async assertNotSelfApproval(
    ctx: TenantContext,
    r: { type: ApprovalType; entityType: string; entityId: string; makers: Array<string | null | undefined> },
  ): Promise<void> {
    const [pending] = await this.dbs.db
      .select({ requestedBy: approvalRequests.requestedBy })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.type, r.type),
          eq(approvalRequests.entityType, r.entityType),
          eq(approvalRequests.entityId, r.entityId),
          eq(approvalRequests.status, 'pending'),
        ),
      );
    const actions = MAKER_ACTIONS[r.entityType];
    const editors = actions
      ? await this.dbs.db
          .selectDistinct({ actor: auditLogs.actorUserId })
          .from(auditLogs)
          .where(and(eq(auditLogs.entityType, r.entityType), eq(auditLogs.entityId, r.entityId), inArray(auditLogs.action, [...actions])))
      : [];
    const makers = new Set([...r.makers, pending?.requestedBy, ...editors.map((e) => e.actor)].filter((x): x is string => !!x));
    if (makers.has(ctx.userId)) {
      throw new AppError('self_approval_forbidden', 403, 'You cannot approve a request you created or submitted; another approver must decide it');
    }
  }

  /**
   * The branch that decides who may approve: for vehicle-bound requests the vehicle's CURRENT
   * branch (a pending cost follows its vehicle when it is transferred), else the stored branch.
   * Literal outer column names: see the correlated-subquery rule in CLAUDE.md.
   */
  private readonly effectiveBranch = sql<string | null>`coalesce(
    CASE approval_requests.entity_type
      WHEN 'vehicle_cost' THEN (SELECT v.branch_id FROM vehicle_costs c JOIN vehicles v ON v.id = c.vehicle_id WHERE c.id = approval_requests.entity_id)
      WHEN 'work_order' THEN (SELECT v.branch_id FROM work_orders w JOIN vehicles v ON v.id = w.vehicle_id WHERE w.id = approval_requests.entity_id)
    END,
    approval_requests.branch_id)`;

  /** SQL: is the caller a maker of the request's document (so they may not decide it)? */
  private isMaker(ctx: TenantContext) {
    const me = ctx.userId;
    return sql<boolean>`(
      approval_requests.requested_by = ${me}
      OR CASE approval_requests.entity_type
        WHEN 'acquisition' THEN EXISTS (SELECT 1 FROM acquisitions a WHERE a.id = approval_requests.entity_id AND a.created_by = ${me})
        WHEN 'vehicle_cost' THEN EXISTS (SELECT 1 FROM vehicle_costs c WHERE c.id = approval_requests.entity_id AND c.created_by = ${me})
        WHEN 'expense' THEN EXISTS (SELECT 1 FROM expenses e WHERE e.id = approval_requests.entity_id AND e.created_by = ${me})
        WHEN 'work_order' THEN EXISTS (SELECT 1 FROM work_orders w WHERE w.id = approval_requests.entity_id AND w.created_by = ${me})
        WHEN 'refund' THEN EXISTS (SELECT 1 FROM refunds r WHERE r.id = approval_requests.entity_id AND r.requested_by = ${me})
        ELSE false
      END
      OR EXISTS (SELECT 1 FROM audit_logs l
                  WHERE l.entity_type = approval_requests.entity_type AND l.entity_id = approval_requests.entity_id::text
                    AND l.actor_user_id = ${me} AND l.action IN (${sql.join(ALL_MAKER_ACTIONS.map((a) => sql`${a}`), sql`, `)}))
    )`;
  }

  private scope(ctx: TenantContext) {
    const perms = [...ctx.permissions];
    const branchCond = ctx.allBranches
      ? undefined
      : ctx.branchIds.length
        ? sql`(${this.effectiveBranch} IS NULL OR ${this.effectiveBranch} IN (${sql.join(ctx.branchIds.map((b) => sql`${b}::uuid`), sql`, `)}))`
        : sql`${this.effectiveBranch} IS NULL`;
    return { perms, where: and(eq(approvalRequests.status, 'pending'), inArray(approvalRequests.requiredPermission, perms.length ? perms : ['-']), branchCond) };
  }

  /** Exact pending counts by type (no row cap), for inbox badges. */
  async countPendingFor(ctx: TenantContext): Promise<Record<string, number>> {
    const { perms, where } = this.scope(ctx);
    if (!perms.length) return {};
    const rows = await this.dbs.db
      .select({ type: approvalRequests.type, n: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(where)
      .groupBy(approvalRequests.type);
    return Object.fromEntries(rows.map((r) => [r.type, r.n]));
  }

  /** Pending items the caller is allowed to decide (by permission and branch). */
  async pendingFor(ctx: TenantContext) {
    const { perms, where } = this.scope(ctx);
    if (!perms.length) return [];
    return this.dbs.db
      .select({
        id: approvalRequests.id,
        type: approvalRequests.type,
        entityType: approvalRequests.entityType,
        entityId: approvalRequests.entityId,
        summary: approvalRequests.summary,
        payload: approvalRequests.payload,
        requestedAt: approvalRequests.requestedAt,
        requestedBy: users.fullName,
        requestedById: approvalRequests.requestedBy,
        branchId: this.effectiveBranch,
        // Same maker rule as the decision routes, so the inbox never offers a refused decision.
        canDecide: sql<boolean>`NOT ${this.isMaker(ctx)}`,
      })
      .from(approvalRequests)
      .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
      .where(where)
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(500);
  }
}
