import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { patchOf, privacySettings, zBranchInput, zTenantSettings, zTenantSettingsPatch, TenantSettings } from '@autohub/shared';
import { assertPermission, Ctx, RequirePermissions, TenantContext, Authenticated } from '../../common/context';
import { AppError, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { branches, journalEntries, tenants } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { fxSettings } from '../finance/fx';
import { SubscriptionService } from './subscription.service';

class BranchDto extends createZodDto(zBranchInput) {}
class BranchUpdateDto extends createZodDto(patchOf(zBranchInput)) {}

const zSettingsUpdate = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  // Field-by-field inside each section too (never `.partial()`): a PATCH of `fx` keeps the other
  // sections, and a PATCH of one fx field keeps the other.
  settings: zTenantSettingsPatch.optional(),
});
class SettingsUpdateDto extends createZodDto(zSettingsUpdate) {}

/** JSON with object keys sorted (jsonb does not keep key order), for change detection. */
function canonicalJson(v: unknown): string | undefined {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

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
      // Settings stored before the fx and privacy sections existed read with their defaults.
      settings: { ...t.settings, fx: fxSettings(t.settings), privacy: privacySettings(t.settings) },
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
          prev &&
          typeof prev === 'object' &&
          !Array.isArray(prev) &&
          typeof v === 'object' &&
          !Array.isArray(v)
            ? { ...prev, ...v }
            : v;
      }
    }
    const validated = zTenantSettings.parse(merged);
    if (validated.fx.referenceRates[current.baseCurrency as keyof typeof validated.fx.referenceRates] !== undefined) {
      throw unprocessable('fx_reference_base_currency', `${current.baseCurrency} is the base currency; it always converts at 1 and takes no reference rate`, {
        currency: current.baseCurrency,
      });
    }
    // The privacy section drives the retention job, which redacts personal data irreversibly
    // (D-053): changing it needs privacy.manage and company-wide scope, not only settings.manage (D-054).
    if (canonicalJson(privacySettings(validated)) !== canonicalJson(privacySettings(current.settings))) {
      assertPermission(ctx, 'privacy.manage');
      if (!ctx.allBranches) {
        throw new AppError(
          'company_scope_required',
          403,
          'Data-retention settings cover the whole company; they require access to all branches',
        );
      }
    }
    const changedLocked = LOCKED_AFTER_POSTING.filter(
      (k) => JSON.stringify(validated[k]) !== JSON.stringify(current.settings[k]),
    );
    if (changedLocked.length) {
      // Any financial document counts, not only journal entries: a pending acquisition or expense
      // already stores base amounts rounded with the current rule (F-009).
      const [posted] = await this.dbs.query<{ n: number }>(
        `SELECT ((SELECT count(*) FROM journal_entries) + (SELECT count(*) FROM acquisitions) + (SELECT count(*) FROM vehicle_costs)
               + (SELECT count(*) FROM expenses) + (SELECT count(*) FROM supplier_payments) + (SELECT count(*) FROM cash_transactions))::int AS n`,
      );
      void journalEntries;
      if ((posted?.n ?? 0) > 0) {
        throw new AppError(
          'setting_locked',
          409,
          'These settings cannot change after financial transactions exist',
          {
            settings: changedLocked,
          },
        );
      }
    }
    const [updated] = await db
      .update(tenants)
      .set({ name: body.name ?? current.name, settings: validated, updatedAt: new Date() })
      .where(eq(tenants.id, ctx.tenant.id))
      .returning();
    const changes = diff(
      { name: current.name, settings: current.settings },
      { name: updated!.name, settings: updated!.settings },
    );
    // Reference rates and the FX tolerance decide which rates money can be booked at: the audit
    // keeps the full before/after of every changed section (diff of name + settings).
    const changedSettings = Object.keys(validated).filter(
      (k) => canonicalJson(validated[k as keyof TenantSettings]) !== canonicalJson(current.settings[k as keyof TenantSettings]),
    );
    await this.audit.record({
      action: 'company.updated',
      entityType: 'tenant',
      entityId: ctx.tenant.id,
      summary: changedSettings.length ? `Settings changed: ${changedSettings.join(', ')}` : undefined,
      ...changes,
    });
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
      const [active] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(branches)
        .where(and(eq(branches.isActive, true)));
      if ((active?.n ?? 0) <= 1)
        throw new AppError('last_branch', 409, 'At least one branch must remain active');
    }
    const [after] = await db
      .update(branches)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(branches.id, id))
      .returning();
    await this.audit.record({
      action: 'branch.updated',
      entityType: 'branch',
      entityId: id,
      ...diff(before, after!),
    });
    return after;
  }
}
