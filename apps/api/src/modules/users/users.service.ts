import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS, d, Permission } from '@autohub/shared';
import { z } from 'zod';
import { zCreateUser, zRoleInput, zUpdateMembership } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { AppError, conflict, forbidden, notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { branches, membershipBranches, memberships, roles, users } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { SubscriptionService } from '../tenancy/subscription.service';

type CreateUser = z.infer<typeof zCreateUser>;
type UpdateMembership = z.infer<typeof zUpdateMembership>;
type RoleInput = z.infer<typeof zRoleInput>;

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

  async list() {
    const db = this.dbs.db;
    const rows = await db
      .select({
        membershipId: memberships.id,
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        phone: users.phone,
        status: memberships.status,
        allBranches: memberships.allBranches,
        lastLoginAt: users.lastLoginAt,
        role: { id: roles.id, name: roles.name, key: roles.key },
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .orderBy(asc(users.fullName));
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
    await this.assertBranches(input.branchIds);
    const db = this.dbs.db;

    let [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    let created = false;
    if (!user) {
      [user] = await db
        .insert(users)
        .values({
          email: input.email,
          fullName: input.fullName,
          phone: input.phone ?? null,
          passwordHash: await this.passwords.hash(input.password),
          passwordChangedAt: new Date(),
        })
        .returning({ id: users.id });
      created = true;
    }
    const [m] = await db
      .insert(memberships)
      .values({ tenantId: ctx.tenant.id, userId: user!.id, roleId: role.id, allBranches: input.allBranches })
      .returning();
    if (!input.allBranches) {
      await db
        .insert(membershipBranches)
        .values(
          input.branchIds.map((branchId) => ({ tenantId: ctx.tenant.id, membershipId: m!.id, branchId })),
        );
    }
    await this.audit.record({
      action: 'user.added',
      entityType: 'membership',
      entityId: m!.id,
      summary: `${input.email} added with role ${role.name}`,
      after: {
        email: input.email,
        roleId: role.id,
        allBranches: input.allBranches,
        branchIds: input.branchIds,
        newAccount: created,
      },
    });
    // An existing account keeps its own password; we never overwrite another tenant's user credentials.
    return { membershipId: m!.id, userId: user!.id, accountCreated: created };
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
    const currentRole = await this.getRole(m.roleId);
    // Managing a user whose role exceeds your own authority is also escalation.
    this.assertCanGrant(ctx, currentRole.permissions, currentRole.maxDiscountPct);
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
      await this.assertSoleTenant(m.userId);
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

  /** Global user records may only be edited by a tenant that exclusively owns the account. */
  private async assertSoleTenant(userId: string): Promise<void> {
    // RLS hides other tenants' memberships, so a narrow definer function returns only the count.
    const [row] = await this.dbs.query<{ n: number }>(`SELECT app_user_membership_count($1) AS n`, [userId]);
    if ((row?.n ?? 0) > 1) {
      throw forbidden('This account is shared with another company; the user must change it themselves');
    }
  }

  async resetPassword(ctx: TenantContext, membershipId: string, newPassword: string) {
    const db = this.dbs.db;
    const [m] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    if (!m) throw notFound('User');
    const role = await this.getRole(m.roleId);
    this.assertCanGrant(ctx, role.permissions, role.maxDiscountPct);
    await this.assertSoleTenant(m.userId);
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
