import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS, AssignablePermission, d, Permission } from '@autohub/shared';
import { z } from 'zod';
import { zCreateUser, zRoleInput, zUpdateMembership } from '@autohub/shared';
import { assertBranchAccess, TenantContext } from '../../common/context';
import { AppError, conflict, forbidden, notFound } from '../../common/errors';
import { listWorkingMembers } from '../../common/members';
import { DbService } from '../../db/db.service';
import { branches, membershipBranches, memberships, roles, users } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { SubscriptionService } from '../tenancy/subscription.service';

type CreateUser = z.infer<typeof zCreateUser>;
type UpdateMembership = z.infer<typeof zUpdateMembership>;
type RoleInput = z.infer<typeof zRoleInput>;

/** The branches a membership can reach (`allBranches` wins over the list). */
interface MemberScope {
  allBranches: boolean;
  branchIds: string[];
}

@Injectable()
export class UsersService {
  constructor(
    private readonly dbs: DbService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionService,
    private readonly sessions: SessionService,
  ) {}

  /** Prevents privilege escalation: you can only grant permissions (and discount authority) you hold. */
  private assertCanGrant(ctx: TenantContext, perms: readonly string[], maxDiscountPct: string): void {
    const missing = perms.filter((p) => !ctx.permissions.has(p as Permission));
    if (missing.length) throw forbidden('You cannot grant permissions you do not have', { missing });
    if (d(maxDiscountPct).gt(d(ctx.maxDiscountPct))) {
      throw forbidden('You cannot grant a discount limit above your own');
    }
  }

  /**
   * Branch scope is authority too: a user manager without access to all branches may only grant, and
   * only manage members whose access lies entirely within, their own branches. An all-branch member
   * is therefore out of reach for them.
   */
  private assertScopeCovers(ctx: TenantContext, target: MemberScope): void {
    if (ctx.allBranches) return;
    const own = new Set(ctx.branchIds);
    if (target.allBranches || target.branchIds.some((b) => !own.has(b))) {
      throw new AppError(
        'branch_scope_exceeded',
        403,
        'You can only grant or manage access to branches you can access yourself',
      );
    }
  }

  private async scopeOf(m: { id: string; allBranches: boolean }): Promise<MemberScope> {
    if (m.allBranches) return { allBranches: true, branchIds: [] };
    const rows = await this.dbs.db
      .select({ branchId: membershipBranches.branchId })
      .from(membershipBranches)
      .where(eq(membershipBranches.membershipId, m.id));
    return { allBranches: false, branchIds: rows.map((r) => r.branchId) };
  }

  /** Assignee picker list: see `listWorkingMembers`. The branch must exist and be within the caller's scope. */
  async assignable(ctx: TenantContext, perm: AssignablePermission, branchId: string | null) {
    if (branchId) {
      const [b] = await this.dbs.db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId));
      if (!b) throw notFound('Branch');
      assertBranchAccess(ctx, branchId);
    }
    return listWorkingMembers(this.dbs, ctx, perm, branchId);
  }

  async list(ctx: TenantContext) {
    const db = this.dbs.db;
    // An invited person's account is not the company's until they accept: the company sees only the
    // email it typed, never the account's global name, phone or sign-in activity.
    const invited = sql`(${memberships.status} = 'invited')`;
    const rows = await db
      .select({
        membershipId: memberships.id,
        userId: users.id,
        email: users.email,
        fullName: sql<string | null>`CASE WHEN ${invited} THEN NULL ELSE ${users.fullName} END`,
        phone: sql<string | null>`CASE WHEN ${invited} THEN NULL ELSE ${users.phone} END`,
        status: memberships.status,
        allBranches: memberships.allBranches,
        lastLoginAt: sql<Date | null>`CASE WHEN ${invited} THEN NULL ELSE ${users.lastLoginAt} END`.mapWith(
          users.lastLoginAt,
        ),
        role: { id: roles.id, name: roles.name, key: roles.key },
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      // Explicit tenant filter: RLS also exposes the caller's own memberships in other companies.
      .where(eq(memberships.tenantId, ctx.tenant.id))
      .orderBy(invited, sql`CASE WHEN ${invited} THEN ${users.email} ELSE ${users.fullName} END`);
    const links = await db.select().from(membershipBranches);
    return rows.map((r) => ({
      ...r,
      branchIds: links.filter((l) => l.membershipId === r.membershipId).map((l) => l.branchId),
    }));
  }

  private async getRole(roleId: string) {
    const [role] = await this.dbs.db.select().from(roles).where(eq(roles.id, roleId));
    if (!role) throw notFound('Role');
    return role;
  }

  private async assertBranches(ids: string[]) {
    if (!ids.length) return;
    const found = await this.dbs.db
      .select({ id: branches.id })
      .from(branches)
      .where(inArray(branches.id, ids));
    if (found.length !== new Set(ids).size) throw notFound('Branch');
  }

  /**
   * Adds a member. A new email gets a new account with the given password and an ACTIVE membership.
   * An email that already has an account (possibly another company's user, or a platform
   * administrator) is only INVITED: the membership grants nothing until the person accepts it
   * themselves (`/me/invitations`), and the supplied name, phone and password are ignored — a company
   * never takes over or changes an account it did not create.
   */
  async create(ctx: TenantContext, input: CreateUser) {
    await this.subscriptions.assertWithinLimit('users');
    const role = await this.getRole(input.roleId);
    this.assertCanGrant(ctx, role.permissions, role.maxDiscountPct);
    if (!input.allBranches && input.branchIds.length === 0) {
      throw new AppError(
        'branch_required',
        422,
        'Assign at least one branch or grant access to all branches',
      );
    }
    this.assertScopeCovers(ctx, { allBranches: input.allBranches, branchIds: input.branchIds });
    await this.assertBranches(input.branchIds);
    const db = this.dbs.db;

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    let userId: string;
    let status: 'active' | 'invited';
    if (existing) {
      userId = existing.id;
      status = 'invited';
    } else {
      const [user] = await db
        .insert(users)
        .values({
          email: input.email,
          fullName: input.fullName,
          phone: input.phone ?? null,
          passwordHash: await this.passwords.hash(input.password),
          passwordChangedAt: new Date(),
        })
        .returning({ id: users.id });
      userId = user!.id;
      status = 'active';
    }
    const [m] = await db
      .insert(memberships)
      .values({ tenantId: ctx.tenant.id, userId, roleId: role.id, allBranches: input.allBranches, status })
      .returning();
    if (!input.allBranches) {
      await db
        .insert(membershipBranches)
        .values(
          input.branchIds.map((branchId) => ({ tenantId: ctx.tenant.id, membershipId: m!.id, branchId })),
        );
    }
    await this.audit.record({
      action: status === 'invited' ? 'user.invited' : 'user.added',
      entityType: 'membership',
      entityId: m!.id,
      summary:
        status === 'invited'
          ? `${input.email} invited with role ${role.name}`
          : `${input.email} added with role ${role.name}`,
      after: {
        email: input.email,
        roleId: role.id,
        allBranches: input.allBranches,
        branchIds: input.branchIds,
        status,
      },
    });
    // The same shape for a new and an existing account (only `status` differs).
    return { membershipId: m!.id, userId, status };
  }

  private async ownerCount(): Promise<number> {
    const [row] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(roles.key, 'owner'), eq(memberships.status, 'active')));
    return row?.n ?? 0;
  }

  async update(ctx: TenantContext, membershipId: string, input: UpdateMembership) {
    const db = this.dbs.db;
    const [m] = await db.select().from(memberships).where(eq(memberships.id, membershipId)).for('update');
    if (!m) throw notFound('User');
    if (
      m.userId === ctx.userId &&
      (input.roleId || input.status || input.allBranches !== undefined || input.branchIds)
    ) {
      throw forbidden('You cannot change your own role, status or branch access');
    }
    // A pending invitation becomes active only when the invitee accepts it, and the account is not the
    // company's to edit: only the offered role and branches can still change.
    if (m.status === 'invited' && (input.status !== undefined || input.fullName !== undefined || input.phone !== undefined)) {
      throw conflict(
        'invitation_pending',
        'This person has not accepted the invitation yet; only the offered role and branches can change',
      );
    }
    const currentRole = await this.getRole(m.roleId);
    // Managing a user whose role exceeds your own authority is also escalation.
    this.assertCanGrant(ctx, currentRole.permissions, currentRole.maxDiscountPct);
    const currentScope = await this.scopeOf(m);
    this.assertScopeCovers(ctx, currentScope);
    let newRole = currentRole;
    if (input.roleId && input.roleId !== m.roleId) {
      newRole = await this.getRole(input.roleId);
      this.assertCanGrant(ctx, newRole.permissions, newRole.maxDiscountPct);
    }
    const losingOwner =
      currentRole.key === 'owner' &&
      m.status === 'active' &&
      (newRole.key !== 'owner' || input.status === 'suspended');
    if (losingOwner && (await this.ownerCount()) <= 1) {
      throw conflict('last_owner', 'The company must keep at least one active owner');
    }
    const allBranches = input.allBranches ?? m.allBranches;
    if (input.branchIds || input.allBranches !== undefined) {
      this.assertScopeCovers(ctx, { allBranches, branchIds: allBranches ? [] : (input.branchIds ?? []) });
    }
    if (input.branchIds) await this.assertBranches(input.branchIds);

    const [after] = await db
      .update(memberships)
      .set({ roleId: newRole.id, allBranches, status: input.status ?? m.status, updatedAt: new Date() })
      .where(eq(memberships.id, membershipId))
      .returning();
    if (input.branchIds || input.allBranches !== undefined) {
      await db.delete(membershipBranches).where(eq(membershipBranches.membershipId, membershipId));
      if (!allBranches) {
        const ids = input.branchIds ?? [];
        if (!ids.length) throw new AppError('branch_required', 422, 'Assign at least one branch');
        await db
          .insert(membershipBranches)
          .values(ids.map((branchId) => ({ tenantId: ctx.tenant.id, membershipId, branchId })));
      }
    }
    if (input.fullName || input.phone !== undefined) {
      await this.assertAccountManageable(m);
      await db
        .update(users)
        .set({
          fullName: input.fullName ?? undefined,
          phone: input.phone === undefined ? undefined : input.phone,
          updatedAt: new Date(),
        })
        .where(eq(users.id, m.userId));
    }
    await this.audit.record({
      action: 'user.updated',
      entityType: 'membership',
      entityId: membershipId,
      ...diff(m, after!),
    });
    return after;
  }

  /**
   * A company may change the global account (password, name, phone) only of an ACTIVE member whose
   * account it exclusively owns, and never a platform administrator's account.
   */
  private async assertAccountManageable(m: { userId: string; status: string }): Promise<void> {
    if (m.status !== 'active') {
      throw conflict('membership_not_active', "Only an active member's account can be changed by the company");
    }
    const [u] = await this.dbs.db
      .select({ isPlatformAdmin: users.isPlatformAdmin })
      .from(users)
      .where(eq(users.id, m.userId));
    if (!u || u.isPlatformAdmin) {
      throw new AppError(
        'platform_admin_account',
        403,
        'A platform administrator account can only be changed by its owner',
      );
    }
    await this.assertSoleTenant(m.userId);
  }

  /** Global user records may only be edited by a tenant that exclusively owns the account. */
  private async assertSoleTenant(userId: string): Promise<void> {
    // RLS hides other tenants' memberships, so a narrow definer function returns only the count
    // (of accepted memberships: a pending invitation elsewhere does not make the account shared).
    const [row] = await this.dbs.query<{ n: number }>(`SELECT app_user_membership_count($1) AS n`, [userId]);
    if ((row?.n ?? 0) > 1) {
      throw new AppError(
        'account_shared',
        403,
        'This account is shared with another company; the user must change it themselves',
      );
    }
  }

  async resetPassword(ctx: TenantContext, membershipId: string, newPassword: string) {
    const db = this.dbs.db;
    const [m] = await db.select().from(memberships).where(eq(memberships.id, membershipId)).for('update');
    if (!m) throw notFound('User');
    const role = await this.getRole(m.roleId);
    this.assertCanGrant(ctx, role.permissions, role.maxDiscountPct);
    this.assertScopeCovers(ctx, await this.scopeOf(m));
    await this.assertAccountManageable(m);
    await db
      .update(users)
      .set({
        passwordHash: await this.passwords.hash(newPassword),
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, m.userId));
    await this.sessions.revokeAllForUser(m.userId);
    await this.audit.record({
      action: 'user.password_reset',
      entityType: 'membership',
      entityId: membershipId,
    });
    return { ok: true };
  }

  // ── Roles ─────────────────────────────────────────────────────────────────────────────
  async listRoles() {
    const db = this.dbs.db;
    const rows = await db.select().from(roles).orderBy(asc(roles.name));
    const counts = await db
      .select({ roleId: memberships.roleId, n: sql<number>`count(*)::int` })
      .from(memberships)
      .groupBy(memberships.roleId);
    return rows.map((r) => ({ ...r, memberCount: counts.find((c) => c.roleId === r.id)?.n ?? 0 }));
  }

  async createRole(ctx: TenantContext, input: RoleInput) {
    this.assertCanGrant(ctx, input.permissions, input.maxDiscountPct);
    const [r] = await this.dbs.db
      .insert(roles)
      .values({
        tenantId: ctx.tenant.id,
        name: input.name,
        description: input.description ?? null,
        permissions: [...new Set(input.permissions)],
        maxDiscountPct: input.maxDiscountPct,
      })
      .returning();
    await this.audit.record({ action: 'role.created', entityType: 'role', entityId: r!.id, after: r });
    return r;
  }

  async updateRole(ctx: TenantContext, roleId: string, input: RoleInput) {
    const db = this.dbs.db;
    const [before] = await db.select().from(roles).where(eq(roles.id, roleId)).for('update');
    if (!before) throw notFound('Role');
    if (before.key === 'owner') throw forbidden('The owner role always has every permission');
    if (before.id === ctx.roleId) throw forbidden('You cannot modify your own role');
    this.assertCanGrant(ctx, before.permissions, before.maxDiscountPct);
    this.assertCanGrant(ctx, input.permissions, input.maxDiscountPct);
    const [after] = await db
      .update(roles)
      .set({
        name: input.name,
        description: input.description ?? null,
        permissions: [...new Set(input.permissions)],
        maxDiscountPct: input.maxDiscountPct,
        updatedAt: new Date(),
      })
      .where(eq(roles.id, roleId))
      .returning();
    await this.audit.record({
      action: 'role.updated',
      entityType: 'role',
      entityId: roleId,
      ...diff(before, after!),
    });
    return after;
  }

  async deleteRole(roleId: string) {
    const db = this.dbs.db;
    const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
    if (!role) throw notFound('Role');
    if (role.isSystem) throw forbidden('System roles cannot be deleted');
    const [used] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.roleId, roleId));
    if ((used?.n ?? 0) > 0) throw conflict('role_in_use', 'Reassign users before deleting this role');
    await db.delete(roles).where(and(eq(roles.id, roleId), ne(roles.isSystem, true)));
    await this.audit.record({ action: 'role.deleted', entityType: 'role', entityId: roleId, before: role });
    return { ok: true };
  }

  permissionCatalog() {
    return ALL_PERMISSIONS;
  }
}
