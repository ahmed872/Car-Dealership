import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { zBranchInput, zTenantSettings, TenantSettings } from '@autohub/shared';
import { Ctx, RequirePermissions, TenantContext, Authenticated } from '../../common/context';
import { AppError, notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { branches, journalEntries, tenants } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { SubscriptionService } from './subscription.service';

class BranchDto extends createZodDto(zBranchInput) {}
class BranchUpdateDto extends createZodDto(zBranchInput.partial()) {}

const zSettingsUpdate = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  settings: zTenantSettings.partial().optional(),
});
class SettingsUpdateDto extends createZodDto(zSettingsUpdate) {}

/** Settings whose change would rewrite how existing financial history is interpreted. */
const LOCKED_AFTER_POSTING: Array<keyof TenantSettings> = ['revenueRecognition', 'rounding'];

@ApiTags('company')
@Controller()
export class TenancyController {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  @Get('company')
  @Authenticated()
  async company(@Ctx() ctx: TenantContext) {
    const [t] = await this.dbs.db.select().from(tenants).where(eq(tenants.id, ctx.tenant.id));
    if (!t) throw notFound('Company');
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      market: t.market,
      baseCurrency: t.baseCurrency,
      settings: t.settings,
      subscription: await this.subscriptions.current(),
      usage: await this.subscriptions.usage(),
    };
  }

  @Patch('company')
  @RequirePermissions('settings.manage')
  async updateCompany(@Ctx() ctx: TenantContext, @Body() body: SettingsUpdateDto) {
    const db = this.dbs.db;
    const [current] = await db.select().from(tenants).where(eq(tenants.id, ctx.tenant.id)).for('update');
    if (!current) throw notFound('Company');
    const merged: TenantSettings = { ...current.settings };
    if (body.settings) {
      for (const [k, v] of Object.entries(body.settings)) {
        if (v === undefined) continue;
        const key = k as keyof TenantSettings;
        const prev = current.settings[key];
        (merged as Record<string, unknown>)[key] =
          prev && typeof prev === 'object' && !Array.isArray(prev) && typeof v === 'object' && !Array.isArray(v) ? { ...prev, ...v } : v;
      }
    }
    const validated = zTenantSettings.parse(merged);
    const changedLocked = LOCKED_AFTER_POSTING.filter((k) => JSON.stringify(validated[k]) !== JSON.stringify(current.settings[k]));
    if (changedLocked.length) {
      const [posted] = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
      if ((posted?.n ?? 0) > 0) {
        throw new AppError('setting_locked', 409, 'These settings cannot change after financial transactions exist', {
          settings: changedLocked,
        });
      }
    }
    const [updated] = await db
      .update(tenants)
      .set({ name: body.name ?? current.name, settings: validated, updatedAt: new Date() })
      .where(eq(tenants.id, ctx.tenant.id))
      .returning();
    const changes = diff({ name: current.name, settings: current.settings }, { name: updated!.name, settings: updated!.settings });
    await this.audit.record({ action: 'company.updated', entityType: 'tenant', entityId: ctx.tenant.id, ...changes });
    return { id: updated!.id, name: updated!.name, settings: updated!.settings };
  }

  @Get('branches')
  @Authenticated()
  async listBranches() {
    return this.dbs.db.select().from(branches).orderBy(asc(branches.name));
  }

  @Post('branches')
  @RequirePermissions('branches.manage')
  async createBranch(@Ctx() ctx: TenantContext, @Body() body: BranchDto) {
    await this.subscriptions.assertWithinLimit('branches');
    const [b] = await this.dbs.db
      .insert(branches)
      .values({ ...body, tenantId: ctx.tenant.id })
      .returning();
    await this.audit.record({ action: 'branch.created', entityType: 'branch', entityId: b!.id, after: b });
    return b;
  }

  @Put('branches/:id')
  @RequirePermissions('branches.manage')
  async updateBranch(@Param('id', ParseUUIDPipe) id: string, @Body() body: BranchUpdateDto) {
    const db = this.dbs.db;
    const [before] = await db.select().from(branches).where(eq(branches.id, id)).for('update');
    if (!before) throw notFound('Branch');
    if (body.isActive === false && before.isActive) {
      const [active] = await db.select({ n: sql<number>`count(*)::int` }).from(branches).where(and(eq(branches.isActive, true)));
      if ((active?.n ?? 0) <= 1) throw new AppError('last_branch', 409, 'At least one branch must remain active');
    }
    const [after] = await db
      .update(branches)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(branches.id, id))
      .returning();
    await this.audit.record({ action: 'branch.updated', entityType: 'branch', entityId: id, ...diff(before, after!) });
    return after;
  }

}
