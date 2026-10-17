import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { EmployeeProfileUpdateInput, money, normalizeCustomerPhone } from '@autohub/shared';
import { hasPermission, TenantContext } from '../../common/context';
import { forbidden, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { commissionPolicies, employeeProfiles, memberships, roles, users } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { CommissionPoliciesService } from './commission-policies.service';

registerUniqueConstraint('employee_profiles_code_uq', 'employee_code_taken', 'Another employee already has this employee code');

/** HR-light employee profiles (targets, commission policy) for members of the company. */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly policies: CommissionPoliciesService,
  ) {}

  private query() {
    return this.dbs.db
      .select({
        userId: users.id,
        fullName: users.fullName,
        email: users.email,
        membershipStatus: memberships.status,
        roleName: roles.name,
        roleKey: roles.key,
        profile: employeeProfiles,
        policyCode: commissionPolicies.code,
        policyName: commissionPolicies.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .leftJoin(employeeProfiles, eq(employeeProfiles.userId, memberships.userId))
      .leftJoin(commissionPolicies, eq(commissionPolicies.id, employeeProfiles.commissionPolicyId));
  }

  async list(ctx: TenantContext) {
    // Explicit tenant filter: RLS also exposes the caller's own memberships in other companies.
    const rows = await this.query().where(eq(memberships.tenantId, ctx.tenant.id)).orderBy(asc(users.fullName));
    return rows.map((r) => ({ ...r, profile: r.profile ?? null }));
  }

  async get(ctx: TenantContext, userId: string) {
    if (userId !== ctx.userId && !hasPermission(ctx, 'users.read')) throw forbidden('You can only view your own employee profile', { permission: 'users.read' });
    const [r] = await this.query().where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.userId, userId)));
    if (!r) throw notFound('Employee');
    const commission = await this.policies.resolveFor(ctx, userId).catch(() => null);
    return { ...r, profile: r.profile ?? null, commissionPolicy: commission?.policy ?? null };
  }

  async upsert(ctx: TenantContext, userId: string, input: EmployeeProfileUpdateInput) {
    const [m] = await this.dbs.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.userId, userId)));
    if (!m) throw notFound('Employee');
    if (input.commissionPolicyId) {
      const p = await this.policies.byId(input.commissionPolicyId);
      if (!p.isActive) throw unprocessable('policy_inactive', 'This commission policy is deactivated', { field: 'commissionPolicyId' });
    }
    const values = {
      ...input,
      phone: input.phone === undefined ? undefined : normalizeCustomerPhone(input.phone, ctx.tenant.market),
      monthlyTargetAmount:
        input.monthlyTargetAmount === undefined ? undefined : input.monthlyTargetAmount === null ? null : money(input.monthlyTargetAmount, ctx.tenant.baseCurrency),
    };
    const [before] = await this.dbs.db.select().from(employeeProfiles).where(eq(employeeProfiles.userId, userId)).for('update');
    const [after] = before
      ? await this.dbs.db
          .update(employeeProfiles)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(employeeProfiles.id, before.id))
          .returning()
      : await this.dbs.db
          .insert(employeeProfiles)
          .values({ ...values, tenantId: ctx.tenant.id, userId })
          .onConflictDoUpdate({ target: [employeeProfiles.tenantId, employeeProfiles.userId], set: { ...values, updatedAt: new Date() } })
          .returning();
    await this.audit.record({
      action: before ? 'employee_profile.updated' : 'employee_profile.created',
      entityType: 'employee_profile',
      entityId: after!.id,
      summary: userId,
      ...diff(before ?? null, after!),
    });
    return after!;
  }
}
