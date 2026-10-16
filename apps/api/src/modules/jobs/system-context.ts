import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS, CurrencyCode, MarketCode, Permission, TenantSettings } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { DbService } from '../../db/db.service';
import { tenants } from '../../db/schema';

/** Non-loginable system actor (seeded in migration 0007) used to attribute scheduled work. */
export const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Tenant context for scheduled jobs. Must be called inside dbs.runInTenant({ tenantId, userId:
 * SYSTEM_USER_ID }); RLS still confines every query to that tenant.
 */
export async function systemContext(dbs: DbService, tenantId: string): Promise<TenantContext> {
  const [t] = await dbs.db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!t) throw new Error(`tenant ${tenantId} not found`);
  return {
    sessionId: 'system',
    userId: SYSTEM_USER_ID,
    email: 'system@autohub.internal',
    fullName: 'AutoHub System',
    isPlatformAdmin: false,
    tenant: {
      id: t.id,
      name: t.name,
      slug: t.slug,
      market: t.market as MarketCode,
      baseCurrency: t.baseCurrency as CurrencyCode,
      settings: t.settings as TenantSettings,
    },
    membershipId: SYSTEM_USER_ID,
    roleId: null,
    roleName: 'system',
    permissions: new Set<Permission>(ALL_PERMISSIONS),
    allBranches: true,
    branchIds: [],
    maxDiscountPct: '0',
  };
}
