import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import {
  addDays,
  CommissionPolicyCreateInput,
  CommissionPolicyVersionInput,
  CommissionPreviewInput,
  CommissionRule,
  computeCommission,
  todayInZone,
} from '@autohub/shared';
import { assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, forbidden, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { commissionPolicies, employeeProfiles } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

registerUniqueConstraint('commission_policies_version_uq', 'policy_version_conflict', 'Another version of this policy was saved at the same time; reload and try again');

export type CommissionPolicyRow = typeof commissionPolicies.$inferSelect;

/**
 * Versioned commission policies. A version's rule is never edited: a change is a new version
 * that takes effect on a date from today onwards, and the previous version ends the day before.
 * Earned commissions (Phase 5) store the version id and a snapshot of its rule.
 */
@Injectable()
export class CommissionPoliciesService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  private today(ctx: TenantContext): string {
    return todayInZone(ctx.tenant.settings.timezone);
  }

  /** Serialises version changes of one policy code. */
  private async lockCode(ctx: TenantContext, code: string): Promise<void> {
    await this.dbs.query(`SELECT pg_advisory_xact_lock(hashtext('commission_policy:' || $1::text || ':' || $2::text))`, [ctx.tenant.id, code]);
  }

  async byId(id: string): Promise<CommissionPolicyRow> {
    const [p] = await this.dbs.db.select().from(commissionPolicies).where(eq(commissionPolicies.id, id));
    if (!p) throw notFound('Commission policy');
    return p;
  }

  private async versions(code: string): Promise<CommissionPolicyRow[]> {
    return this.dbs.db.select().from(commissionPolicies).where(eq(commissionPolicies.code, code)).orderBy(desc(commissionPolicies.version));
  }

  /** The version of a policy code in effect on `date` (null when none, or deactivated). */
  async versionOn(code: string, date: string): Promise<CommissionPolicyRow | null> {
    const [p] = await this.dbs.db
      .select()
      .from(commissionPolicies)
      .where(
        and(
          eq(commissionPolicies.code, code),
          eq(commissionPolicies.isActive, true),
          lte(commissionPolicies.effectiveFrom, date),
          or(isNull(commissionPolicies.effectiveTo), gte(commissionPolicies.effectiveTo, date)),
        ),
      )
      .orderBy(desc(commissionPolicies.version))
      .limit(1);
    return p ?? null;
  }

  async list(ctx: TenantContext, includeHistory: boolean) {
    const rows = await this.dbs.db.select().from(commissionPolicies).orderBy(asc(commissionPolicies.code), desc(commissionPolicies.version));
    const today = this.today(ctx);
    const byCode = new Map<string, CommissionPolicyRow[]>();
    for (const r of rows) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
    return [...byCode.entries()].map(([code, versions]) => {
      const current = versions.find((v) => v.isActive && v.effectiveFrom <= today && (!v.effectiveTo || v.effectiveTo >= today)) ?? null;
      const scheduled = versions.filter((v) => v.isActive && v.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      return {
        code,
        name: (current ?? versions[0]!).name,
        isActive: versions.some((v) => v.isActive),
        current,
        scheduled,
        latestVersion: versions[0]!.version,
        ...(includeHistory ? { versions } : {}),
      };
    });
  }

  async create(ctx: TenantContext, input: CommissionPolicyCreateInput) {
    const today = this.today(ctx);
    const effectiveFrom = input.effectiveFrom ?? today;
    if (effectiveFrom < today) throw unprocessable('retroactive_change', 'A commission policy cannot start in the past', { field: 'effectiveFrom' });
    await this.lockCode(ctx, input.code);
    if ((await this.versions(input.code)).length) throw conflict('policy_code_taken', 'A commission policy with this code already exists; add a new version instead');
    const [p] = await this.dbs.db
      .insert(commissionPolicies)
      .values({ tenantId: ctx.tenant.id, code: input.code, version: 1, name: input.name, rule: input.rule, effectiveFrom, createdBy: ctx.userId })
      .returning();
    await this.audit.record({ action: 'commission_policy.created', entityType: 'commission_policy', entityId: p!.id, summary: `${p!.code} v1`, after: p });
    return p!;
  }

  /** Adds a version effective from a date (today or later) after the latest version's start. */
  async addVersion(ctx: TenantContext, id: string, input: CommissionPolicyVersionInput) {
    const base = await this.byId(id);
    await this.lockCode(ctx, base.code);
    const [latest] = await this.versions(base.code);
    if (!latest!.isActive) throw conflict('policy_inactive', 'This commission policy is deactivated');
    const today = this.today(ctx);
    if (input.effectiveFrom < today) throw unprocessable('retroactive_change', 'A new version cannot start in the past', { field: 'effectiveFrom' });
    if (input.effectiveFrom <= latest!.effectiveFrom) {
      throw unprocessable('version_overlap', `The new version must start after ${latest!.effectiveFrom}`, { field: 'effectiveFrom', latestEffectiveFrom: latest!.effectiveFrom });
    }
    const [p] = await this.dbs.db
      .insert(commissionPolicies)
      .values({
        tenantId: ctx.tenant.id,
        code: base.code,
        version: latest!.version + 1,
        name: input.name ?? latest!.name,
        rule: input.rule,
        effectiveFrom: input.effectiveFrom,
        createdBy: ctx.userId,
      })
      .returning();
    // Only the validity window of the previous version changes; its rule stays as it was.
    await this.dbs.db
      .update(commissionPolicies)
      .set({ effectiveTo: addDays(input.effectiveFrom, -1), supersededById: p!.id })
      .where(eq(commissionPolicies.id, latest!.id));
    await this.audit.record({
      action: 'commission_policy.versioned',
      entityType: 'commission_policy',
      entityId: p!.id,
      summary: `${p!.code} v${p!.version} from ${p!.effectiveFrom}`,
      before: { id: latest!.id, version: latest!.version, rule: latest!.rule, effectiveTo: latest!.effectiveTo },
      after: { version: p!.version, rule: p!.rule, effectiveFrom: p!.effectiveFrom, reason: input.reason },
    });
    return p!;
  }

  async deactivate(ctx: TenantContext, id: string, reason: string) {
    const base = await this.byId(id);
    await this.lockCode(ctx, base.code);
    const versions = await this.versions(base.code);
    if (!versions.some((v) => v.isActive)) throw conflict('policy_inactive', 'This commission policy is already deactivated');
    const [inUse] = await this.dbs.db
      .select({ userId: employeeProfiles.userId })
      .from(employeeProfiles)
      .innerJoin(commissionPolicies, eq(commissionPolicies.id, employeeProfiles.commissionPolicyId))
      .where(eq(commissionPolicies.code, base.code))
      .limit(1);
    if (inUse) throw conflict('policy_in_use', 'Employees are still on this policy; move them to another policy first');
    await this.dbs.db.update(commissionPolicies).set({ isActive: false }).where(eq(commissionPolicies.code, base.code));
    await this.audit.record({ action: 'commission_policy.deactivated', entityType: 'commission_policy', entityId: base.id, summary: base.code, after: { reason } });
    return { ok: true };
  }

  /** The policy version in effect for an employee on a date (null: no commission policy). */
  async resolveFor(ctx: TenantContext, userId: string, date?: string) {
    if (userId !== ctx.userId && !hasPermission(ctx, 'commissions.read')) {
      throw forbidden("You can only view your own commission policy", { permission: 'commissions.read' });
    }
    const on = date ?? this.today(ctx);
    return { userId, date: on, policy: await this.policyFor(userId, on) };
  }

  /** Internal (no permission check): the policy version in effect for an employee on a date. */
  async policyFor(userId: string, date: string): Promise<CommissionPolicyRow | null> {
    const [profile] = await this.dbs.db.select({ policyId: employeeProfiles.commissionPolicyId }).from(employeeProfiles).where(eq(employeeProfiles.userId, userId));
    if (!profile?.policyId) return null;
    const assigned = await this.byId(profile.policyId);
    return this.versionOn(assigned.code, date);
  }

  preview(ctx: TenantContext, rule: CommissionRule, input: Pick<CommissionPreviewInput, 'saleNet' | 'grossProfit'>) {
    return computeCommission(rule, { saleNet: input.saleNet, grossProfit: input.grossProfit, currency: ctx.tenant.baseCurrency });
  }

  async previewInput(ctx: TenantContext, input: CommissionPreviewInput) {
    if (!hasPermission(ctx, 'commissions.manage_policies')) assertPermission(ctx, 'commissions.read');
    const rule = input.rule ?? ((await this.byId(input.policyId!)).rule as CommissionRule);
    return { rule, result: this.preview(ctx, rule, input) };
  }
}
