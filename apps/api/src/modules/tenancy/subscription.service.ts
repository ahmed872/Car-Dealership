import { Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { branches, memberships, subscriptionPlans, tenantSubscriptions } from '../../db/schema';

export type LimitKind = 'users' | 'branches' | 'vehicles';

@Injectable()
export class SubscriptionService {
  /** Vehicle counting is registered by the vehicles module to avoid a circular dependency. */
  static vehicleCounter: ((dbs: DbService) => Promise<number>) | null = null;

  constructor(private readonly dbs: DbService) {}

  async current() {
    const [row] = await this.dbs.db
      .select({
        id: tenantSubscriptions.id,
        status: tenantSubscriptions.status,
        trialEndsAt: tenantSubscriptions.trialEndsAt,
        currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
        plan: {
          code: subscriptionPlans.code,
          nameEn: subscriptionPlans.nameEn,
          nameAr: subscriptionPlans.nameAr,
          maxUsers: subscriptionPlans.maxUsers,
          maxBranches: subscriptionPlans.maxBranches,
          maxVehicles: subscriptionPlans.maxVehicles,
          features: subscriptionPlans.features,
        },
      })
      .from(tenantSubscriptions)
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, tenantSubscriptions.planId))
      .where(inArray(tenantSubscriptions.status, ['trial', 'active', 'past_due']))
      .limit(1);
    return row ?? null;
  }

  async usage() {
    const [[u], [b]] = await Promise.all([
      this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.status, 'active')),
      this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(branches).where(eq(branches.isActive, true)),
    ]);
    const vehicles = SubscriptionService.vehicleCounter ? await SubscriptionService.vehicleCounter(this.dbs) : 0;
    return { users: u?.n ?? 0, branches: b?.n ?? 0, vehicles };
  }

  /** Throws when adding one more `kind` would exceed the plan limit. NULL limits mean unlimited. */
  async assertWithinLimit(kind: LimitKind): Promise<void> {
    const sub = await this.current();
    if (!sub) throw new AppError('subscription_inactive', 402, 'Your subscription is not active');
    const limit = kind === 'users' ? sub.plan.maxUsers : kind === 'branches' ? sub.plan.maxBranches : sub.plan.maxVehicles;
    if (limit === null || limit === undefined) return;
    const usage = await this.usage();
    if (usage[kind] >= limit) {
      throw new AppError('plan_limit_reached', 402, `Your plan allows up to ${limit} ${kind}. Upgrade to add more.`, {
        kind,
        limit,
        usage: usage[kind],
      });
    }
  }

  async hasFeature(feature: string): Promise<boolean> {
    const sub = await this.current();
    return !!sub?.plan.features.includes(feature);
  }
}

