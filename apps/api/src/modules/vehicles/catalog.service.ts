import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { zFeatureInput, zMakeInput, zModelInput } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { notFound, registerUniqueConstraint } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { features, vehicleMakes, vehicleModels } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

registerUniqueConstraint('vehicle_makes_name_uq', 'make_exists', 'This make already exists');
registerUniqueConstraint('vehicle_models_name_uq', 'model_exists', 'This model already exists for the make');
registerUniqueConstraint('features_code_uq', 'feature_exists', 'A feature with this code already exists');

/** Makes, models and features: platform catalog (read-only) plus tenant-specific additions. */
@Injectable()
export class CatalogService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  makes() {
    return this.dbs.db
      .select({ id: vehicleMakes.id, nameEn: vehicleMakes.nameEn, nameAr: vehicleMakes.nameAr, custom: vehicleMakes.tenantId })
      .from(vehicleMakes)
      .where(eq(vehicleMakes.isActive, true))
      .orderBy(asc(vehicleMakes.nameEn));
  }

  models(makeId?: string) {
    return this.dbs.db
      .select({ id: vehicleModels.id, makeId: vehicleModels.makeId, nameEn: vehicleModels.nameEn, nameAr: vehicleModels.nameAr, bodyType: vehicleModels.bodyType })
      .from(vehicleModels)
      .where(makeId ? and(eq(vehicleModels.makeId, makeId), eq(vehicleModels.isActive, true)) : eq(vehicleModels.isActive, true))
      .orderBy(asc(vehicleModels.nameEn));
  }

  features() {
    return this.dbs.db.select().from(features).where(eq(features.isActive, true)).orderBy(asc(features.category), asc(features.nameEn));
  }

  async addMake(ctx: TenantContext, input: z.infer<typeof zMakeInput>) {
    const [m] = await this.dbs.db.insert(vehicleMakes).values({ ...input, tenantId: ctx.tenant.id }).returning();
    await this.audit.record({ action: 'catalog.make_added', entityType: 'vehicle_make', entityId: m!.id, after: input });
    return m;
  }

  async addModel(ctx: TenantContext, input: z.infer<typeof zModelInput>) {
    const [make] = await this.dbs.db.select({ id: vehicleMakes.id }).from(vehicleMakes).where(eq(vehicleMakes.id, input.makeId));
    if (!make) throw notFound('Make');
    const [m] = await this.dbs.db.insert(vehicleModels).values({ ...input, tenantId: ctx.tenant.id }).returning();
    await this.audit.record({ action: 'catalog.model_added', entityType: 'vehicle_model', entityId: m!.id, after: input });
    return m;
  }

  async addFeature(ctx: TenantContext, input: z.infer<typeof zFeatureInput>) {
    const [f] = await this.dbs.db.insert(features).values({ ...input, tenantId: ctx.tenant.id }).returning();
    await this.audit.record({ action: 'catalog.feature_added', entityType: 'feature', entityId: f!.id, after: input });
    return f;
  }
}
