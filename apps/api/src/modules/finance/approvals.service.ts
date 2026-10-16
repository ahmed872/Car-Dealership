import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { TenantContext } from '../../common/context';
import { AppError } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { approvalRequests, users } from '../../db/schema';

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
    const makers = new Set([...r.makers, pending?.requestedBy].filter((x): x is string => !!x));
    if (makers.has(ctx.userId)) {
      throw new AppError('self_approval_forbidden', 403, 'You cannot approve a request you created or submitted; another approver must decide it');
    }
  }

  private scope(ctx: TenantContext) {
    const perms = [...ctx.permissions];
    const branchCond = ctx.allBranches
      ? undefined
      : or(isNull(approvalRequests.branchId), inArray(approvalRequests.branchId, ctx.branchIds.length ? ctx.branchIds : ['00000000-0000-0000-0000-000000000000']));
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
        branchId: approvalRequests.branchId,
      })
      .from(approvalRequests)
      .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
      .where(where)
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(500);
  }
}
