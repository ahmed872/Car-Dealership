import { DbService } from '../../db/db.service';
import { SYSTEM_USER_ID } from '../jobs/system-context';
import { LegacyNationalIdOutcome, SuppliersService } from './suppliers.service';

export type SupplierIdBackfillCounts = Record<LegacyNationalIdOutcome, number>;

export interface SupplierIdBackfillResult {
  /** Companies processed (all of them, whatever their status, unless one was named). */
  tenants: Array<{ tenantId: string; slug: string } & SupplierIdBackfillCounts>;
  totals: SupplierIdBackfillCounts;
}

/**
 * `cli.js encrypt-supplier-ids` (D-047): moves the plain-text supplier national IDs written before
 * migration 0018 into the encrypted columns. Runs company by company, each in its own transaction
 * under that company's RLS context as the system user, through the app role (the encryption key
 * lives in the application, not in SQL). Idempotent: a second run finds nothing to do.
 */
export async function encryptSupplierNationalIds(
  dbs: DbService,
  suppliers: SuppliersService,
  opts: { tenantId?: string; batchSize?: number } = {},
): Promise<SupplierIdBackfillResult> {
  const all = await dbs.runInTenant(
    { tenantId: null, userId: null },
    () => dbs.query<{ id: string; slug: string }>('SELECT id, slug FROM app_platform_tenants()'),
    { write: false },
  );
  const targets = opts.tenantId ? all.filter((t) => t.id === opts.tenantId) : all;
  if (opts.tenantId && !targets.length) throw new Error(`Company ${opts.tenantId} not found`);
  const result: SupplierIdBackfillResult = {
    tenants: [],
    totals: { encrypted: 0, unrecognised: 0, cleared: 0 },
  };
  for (const t of targets) {
    const counts = await dbs.runInTenant({ tenantId: t.id, userId: SYSTEM_USER_ID }, () =>
      suppliers.encryptLegacyNationalIds(opts.batchSize),
    );
    result.tenants.push({ tenantId: t.id, slug: t.slug, ...counts });
    for (const k of Object.keys(counts) as LegacyNationalIdOutcome[]) result.totals[k] += counts[k];
  }
  return result;
}
