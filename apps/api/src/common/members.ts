import { and, asc, eq, sql } from 'drizzle-orm';
import type { Permission } from '@autohub/shared';
import type { DbService } from '../db/db.service';
import { membershipBranches, memberships, roles, users } from '../db/schema';
import type { TenantContext } from './context';
import { unprocessable } from './errors';

/**
 * The staff pickers' list (GET /members/assignable), by the same rule as `assertWorkingMember`:
 * active members of THIS company (active membership and account) whose role holds `perm`, id and
 * name only. With `branchId`: those who can access that branch. Without it, a branch-limited caller
 * gets the members who share at least one of the caller's branches; an all-branch caller everyone
 * eligible. The tenant filter matters (RLS also shows a user their own memberships in other
 * companies); correlated subqueries name the outer column literally (memberships.id), see CLAUDE.md.
 */
export async function listWorkingMembers(dbs: DbService, ctx: TenantContext, perm: Permission, branchId: string | null): Promise<Array<{ id: string; fullName: string }>> {
  const reach = branchId
    ? sql`(memberships.all_branches OR EXISTS (SELECT 1 FROM membership_branches mb WHERE mb.membership_id = memberships.id AND mb.branch_id = ${branchId}::uuid))`
    : ctx.allBranches
      ? undefined
      : ctx.branchIds.length
        ? sql`(memberships.all_branches OR EXISTS (SELECT 1 FROM membership_branches mb WHERE mb.membership_id = memberships.id
              AND mb.branch_id IN (${sql.join(ctx.branchIds.map((b) => sql`${b}::uuid`), sql`, `)})))`
        : sql`memberships.all_branches`;
  return dbs.db
    .select({ id: users.id, fullName: users.fullName })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(
      and(
        eq(memberships.tenantId, ctx.tenant.id),
        eq(memberships.status, 'active'),
        eq(users.status, 'active'),
        sql`${perm} = ANY(${roles.permissions})`,
        reach,
      ),
    )
    .orderBy(asc(users.fullName), asc(users.id));
}

/**
 * Checks that `userId` can be given work in `branchId`: an active member of THIS company whose
 * role holds `perm` and who can access the branch. Throws 422 `invalid_assignee` with a reason.
 */
export async function assertWorkingMember(
  dbs: DbService,
  ctx: TenantContext,
  userId: string,
  branchId: string | null,
  perm: Permission,
): Promise<{ id: string; fullName: string }> {
  const [m] = await dbs.db
    .select({
      membershipId: memberships.id,
      allBranches: memberships.allBranches,
      membershipStatus: memberships.status,
      userStatus: users.status,
      fullName: users.fullName,
      permissions: roles.permissions,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    // The tenant filter matters: RLS also lets a user read their own memberships in other companies.
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, ctx.tenant.id)));
  if (!m || m.membershipStatus !== 'active' || m.userStatus !== 'active') {
    throw unprocessable('invalid_assignee', 'The assignee must be an active member of this company', { reason: 'not_active_member' });
  }
  if (!m.permissions.includes(perm)) {
    throw unprocessable('invalid_assignee', "The assignee's role cannot do this work", { reason: 'missing_permission', permission: perm });
  }
  if (branchId && !m.allBranches) {
    const [b] = await dbs.db
      .select({ branchId: membershipBranches.branchId })
      .from(membershipBranches)
      .where(and(eq(membershipBranches.membershipId, m.membershipId), eq(membershipBranches.branchId, branchId)));
    if (!b) throw unprocessable('invalid_assignee', 'The assignee has no access to this branch', { reason: 'no_branch_access' });
  }
  return { id: userId, fullName: m.fullName };
}
