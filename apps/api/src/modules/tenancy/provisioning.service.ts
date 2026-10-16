import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  defaultTenantSettings,
  MARKETS,
  ProvisionTenantInput,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLES,
} from '@autohub/shared';
import { conflict, notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import {
  branches,
  ledgerAccounts,
  memberships,
  roles,
  subscriptionPlans,
  tenants,
  tenantSubscriptions,
  users,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { CHART } from '../ledger/chart';

export interface ProvisionResult {
  tenantId: string;
  branchId: string;
  ownerUserId: string;
  ownerCreated: boolean;
}

/**
 * Creates a fully isolated tenant: company, main branch, system roles, owner membership,
 * chart of accounts, and a trial subscription. Runs in one transaction under the new
 * tenant's RLS context, so it cannot write into any other tenant.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly dbs: DbService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async provision(input: ProvisionTenantInput, actorUserId: string | null): Promise<ProvisionResult> {
    const tenantId = randomUUID();
    const passwordHash = await this.passwords.hash(input.owner.password);

    return this.dbs.runInTenant({ tenantId, userId: actorUserId }, async () => {
      const db = this.dbs.db;
      const [taken] = await this.dbs.query<{ taken: boolean }>('SELECT app_slug_taken($1) AS taken', [
        input.slug,
      ]);
      if (taken?.taken) throw conflict('slug_taken', 'This company identifier is already in use');

      const market = MARKETS[input.market];
      await db.insert(tenants).values({
        id: tenantId,
        name: input.name,
        slug: input.slug,
        market: input.market,
        baseCurrency: market.currency,
        settings: defaultTenantSettings(input.market, input.locale),
      });
      const [branch] = await db
        .insert(branches)
        .values({ tenantId, name: input.branchName, code: 'MAIN', timezone: market.timezone })
        .returning({ id: branches.id });

      const roleIds: Record<string, string> = {};
      for (const key of SYSTEM_ROLE_KEYS) {
        const tpl = SYSTEM_ROLES[key];
        const [r] = await db
          .insert(roles)
          .values({
            tenantId,
            key,
            name: input.locale === 'en' ? tpl.nameEn : tpl.nameAr,
            permissions: [...new Set(tpl.permissions)],
            maxDiscountPct: tpl.maxDiscountPct,
            isSystem: true,
          })
          .returning({ id: roles.id });
        roleIds[key] = r!.id;
      }

      // Owner: reuse an existing platform user with this email, otherwise create one.
      let ownerCreated = false;
      let [owner] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.owner.email))
        .limit(1);
      if (!owner) {
        [owner] = await db
          .insert(users)
          .values({
            email: input.owner.email,
            fullName: input.owner.fullName,
            passwordHash,
            passwordChangedAt: new Date(),
          })
          .returning({ id: users.id });
        ownerCreated = true;
      }
      await db
        .insert(memberships)
        .values({ tenantId, userId: owner!.id, roleId: roleIds.owner!, allBranches: true });

      await db.insert(ledgerAccounts).values(CHART.map((a) => ({ tenantId, ...a, isSystem: true })));

      const [plan] = await db
        .select({ id: subscriptionPlans.id })
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.code, input.planCode ?? 'starter'))
        .limit(1);
      if (!plan) throw notFound('Subscription plan');
      await db.insert(tenantSubscriptions).values({
        tenantId,
        planId: plan.id,
        status: 'trial',
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });

      await this.audit.record({
        action: 'tenant.provisioned',
        entityType: 'tenant',
        entityId: tenantId,
        summary: `Company ${input.name} (${input.slug}) created`,
        after: { name: input.name, slug: input.slug, market: input.market, ownerEmail: input.owner.email },
      });
      return { tenantId, branchId: branch!.id, ownerUserId: owner!.id, ownerCreated };
    });
  }
}
