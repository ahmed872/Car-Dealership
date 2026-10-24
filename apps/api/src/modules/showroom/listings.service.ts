import { HttpStatus, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, SQL, sql } from 'drizzle-orm';
import QRCode from 'qrcode';
import { ListingUpdateInput } from '@autohub/shared';
import { assertBranchAccess, assertPermission, TenantContext } from '../../common/context';
import { AppError, conflict } from '../../common/errors';
import { getEnv } from '../../config/env';
import { DbService } from '../../db/db.service';
import { vehicleListings, vehicles } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { AiTextService, templateDescription } from '../integrations/ai-text.service';
import { SubscriptionService } from '../tenancy/subscription.service';
import { companyLocale, listingFacts, publicLinks, visibleStatuses } from './showroom-common';

type ListingRow = typeof vehicleListings.$inferSelect;
type VehicleRow = typeof vehicles.$inferSelect;

/**
 * Staff side of the digital showroom (D-036): public content per vehicle, publish/unpublish,
 * description generation (AI when enabled, template otherwise), share links and QR codes.
 */
@Injectable()
export class ListingsService {
  constructor(
    private readonly dbs: DbService,
    private readonly ai: AiTextService,
    private readonly subscription: SubscriptionService,
    private readonly audit: AuditService,
  ) {}

  private async vehicle(ctx: TenantContext, id: string, lock = false): Promise<VehicleRow> {
    const q = this.dbs.db.select().from(vehicles).where(eq(vehicles.id, id));
    const [v] = lock ? await q.for('update') : await q;
    if (!v) throw new AppError('not_found', HttpStatus.NOT_FOUND, 'Vehicle not found');
    assertBranchAccess(ctx, v.branchId);
    return v;
  }

  private async row(vehicleId: string, lock = false): Promise<ListingRow | null> {
    const q = this.dbs.db.select().from(vehicleListings).where(eq(vehicleListings.vehicleId, vehicleId));
    const [l] = lock ? await q.for('update') : await q;
    return l ?? null;
  }

  private async defaultTitles(vehicleId: string) {
    const f = await listingFacts(this.dbs, vehicleId);
    return {
      titleAr: [f.makeAr, f.modelAr, f.trim, f.modelYear].filter(Boolean).join(' '),
      titleEn: [f.makeEn, f.modelEn, f.trim, f.modelYear].filter(Boolean).join(' '),
    };
  }

  private async present(ctx: TenantContext, v: VehicleRow, l: ListingRow | null) {
    const showroom = ctx.tenant.settings.showroom;
    const reasons: string[] = [];
    if (!showroom.enabled) reasons.push('showroom_disabled');
    if (!(await this.subscription.hasFeature('showroom'))) reasons.push('plan_without_showroom');
    if (!l?.isPublished) reasons.push('not_published');
    if (!visibleStatuses(ctx.tenant.settings).includes(v.status)) reasons.push('status_not_listed');
    const defaults = l?.titleAr && l.titleEn ? { titleAr: l.titleAr, titleEn: l.titleEn } : await this.defaultTitles(v.id);
    const titles = { ar: l?.titleAr ?? defaults.titleAr, en: l?.titleEn ?? defaults.titleEn };
    return {
      vehicleId: v.id,
      stockNumber: v.stockNumber,
      vehicleStatus: v.status,
      listing: l
        ? {
            id: l.id,
            isPublished: l.isPublished,
            titleAr: l.titleAr,
            titleEn: l.titleEn,
            descriptionAr: l.descriptionAr,
            descriptionEn: l.descriptionEn,
            descriptionSource: l.descriptionSource,
            publishedAt: l.publishedAt,
            version: l.version,
          }
        : null,
      visibility: { public: reasons.length === 0, reasons },
      links: l ? publicLinks(getEnv().PUBLIC_WEB_URL, ctx.tenant.slug, l.id, titles, showroom.whatsappNumber, companyLocale(ctx.tenant.settings)) : null,
    };
  }

  async get(ctx: TenantContext, vehicleId: string) {
    const v = await this.vehicle(ctx, vehicleId);
    return this.present(ctx, v, await this.row(vehicleId));
  }

  private async upsert(ctx: TenantContext, vehicleId: string, values: Partial<ListingRow>, version?: number): Promise<ListingRow> {
    const before = await this.row(vehicleId, true);
    if (before && version !== undefined && version !== before.version) {
      throw conflict('version_conflict', 'This listing was changed by someone else. Reload and try again.', { currentVersion: before.version });
    }
    if (!before) {
      const [created] = await this.dbs.db
        .insert(vehicleListings)
        .values({ tenantId: ctx.tenant.id, vehicleId, ...(await this.defaultTitles(vehicleId)), ...values, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning();
      return created!;
    }
    const [after] = await this.dbs.db
      .update(vehicleListings)
      .set({ ...values, updatedBy: ctx.userId, updatedAt: new Date(), version: before.version + 1 })
      .where(eq(vehicleListings.id, before.id))
      .returning();
    return after!;
  }

  async update(ctx: TenantContext, vehicleId: string, input: ListingUpdateInput) {
    assertPermission(ctx, 'showroom.manage');
    const v = await this.vehicle(ctx, vehicleId);
    const touchesDescription = input.descriptionAr !== undefined || input.descriptionEn !== undefined;
    const values: Partial<ListingRow> = {
      ...(input.titleAr !== undefined ? { titleAr: input.titleAr } : {}),
      ...(input.titleEn !== undefined ? { titleEn: input.titleEn } : {}),
      ...(input.descriptionAr !== undefined ? { descriptionAr: input.descriptionAr } : {}),
      ...(input.descriptionEn !== undefined ? { descriptionEn: input.descriptionEn } : {}),
      ...(touchesDescription ? { descriptionSource: input.descriptionSource ?? 'manual' } : {}),
    };
    const l = await this.upsert(ctx, vehicleId, values, input.version);
    await this.audit.record({ action: 'listing.updated', entityType: 'vehicle', entityId: vehicleId, summary: v.stockNumber, after: values });
    return this.present(ctx, v, l);
  }

  async publish(ctx: TenantContext, vehicleId: string) {
    assertPermission(ctx, 'showroom.manage');
    await this.subscription.assertFeature('showroom');
    const v = await this.vehicle(ctx, vehicleId, true);
    if (!['available', 'reserved'].includes(v.status)) {
      throw conflict('vehicle_not_listable', 'Only available (or reserved) vehicles can be published', { vehicleStatus: v.status });
    }
    if (ctx.tenant.settings.showroom.showPrices && !v.askingPrice) {
      throw conflict('price_required', 'Set an asking price before publishing (the showroom shows prices)');
    }
    const l = await this.upsert(ctx, vehicleId, { isPublished: true, publishedAt: new Date(), publishedBy: ctx.userId, unpublishedAt: null });
    await this.audit.record({ action: 'listing.published', entityType: 'vehicle', entityId: vehicleId, summary: v.stockNumber });
    return this.present(ctx, v, l);
  }

  async unpublish(ctx: TenantContext, vehicleId: string) {
    assertPermission(ctx, 'showroom.manage');
    const v = await this.vehicle(ctx, vehicleId);
    const existing = await this.row(vehicleId, true);
    if (!existing?.isPublished) return this.present(ctx, v, existing);
    const l = await this.upsert(ctx, vehicleId, { isPublished: false, unpublishedAt: new Date() });
    await this.audit.record({ action: 'listing.unpublished', entityType: 'vehicle', entityId: vehicleId, summary: v.stockNumber });
    return this.present(ctx, v, l);
  }

  /** Writes a description with the AI adapter (if enabled) or the template, and saves it. */
  /**
   * A suggested description (AI or template) that staff review and then save with `update`; nothing
   * is written to the listing here, so generated text never goes live unreviewed. The route runs
   * without a request transaction: settings and facts are read first, the provider is called with
   * no transaction open (it may take seconds, and a write transaction would hold the company's
   * write lock), and the attempt is audited in a short write afterwards. When the platform's key is
   * used, a company gets AI_PLATFORM_DAILY_LIMIT generations per 24 hours, then the template.
   */
  async generateDescription(ctx: TenantContext, vehicleId: string) {
    assertPermission(ctx, 'showroom.manage');
    const tx = { tenantId: ctx.tenant.id, userId: ctx.userId };
    const { v, facts, cfg, usedToday } = await this.dbs.runInTenant(
      tx,
      async () => {
        const v = await this.vehicle(ctx, vehicleId);
        const cfg = await this.ai.config();
        const [{ n }] = (await this.dbs.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE action = 'listing.description_generated' AND after->>'source' = 'ai' AND after->>'platformKey' = 'true'
              AND created_at > now() - interval '1 day'`,
        )) as [{ n: number }];
        return { v, facts: await listingFacts(this.dbs, vehicleId), cfg, usedToday: n };
      },
      { write: false },
    );
    const text =
      cfg.enabled && cfg.platformKey && usedToday >= getEnv().AI_PLATFORM_DAILY_LIMIT
        ? { ...templateDescription(facts), source: 'template' as const, fallbackReason: 'daily_limit' }
        : await this.ai.listingDescription(facts, cfg);
    const generation = { source: text.source, model: text.model ?? null, fallbackReason: text.fallbackReason ?? null };
    await this.dbs.runInTenant(
      tx,
      () =>
        this.audit.record({
          action: 'listing.description_generated',
          entityType: 'vehicle',
          entityId: vehicleId,
          summary: `${v.stockNumber} (${text.source})`,
          after: { ...generation, platformKey: text.source === 'ai' && cfg.platformKey },
        }),
      { write: true },
    );
    return { suggestion: { descriptionAr: text.ar, descriptionEn: text.en }, generation };
  }

  /** QR code of the public listing link; `filename` names the download after the stock number. */
  async qr(ctx: TenantContext, vehicleId: string, format: 'svg' | 'png'): Promise<{ contentType: string; body: Buffer; filename: string }> {
    const p = await this.get(ctx, vehicleId);
    if (!p.links) throw conflict('listing_missing', 'Create the listing first');
    const filename = `listing-${p.stockNumber}-qr.${format}`;
    if (format === 'png') return { contentType: 'image/png', filename, body: await QRCode.toBuffer(p.links.url, { margin: 1, width: 512, errorCorrectionLevel: 'M' }) };
    return { contentType: 'image/svg+xml', filename, body: Buffer.from(await QRCode.toString(p.links.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })) };
  }

  /**
   * Online inquiries for staff. Branch-limited users see inquiries about vehicles of their branches;
   * general inquiries (no vehicle) are shown to all-branch users only.
   */
  async inquiries(ctx: TenantContext, q: { unlinked?: 'true' | 'false'; page: number; pageSize: number }) {
    assertPermission(ctx, 'leads.assign');
    const where = [
      ctx.allBranches ? 'true' : 'v.branch_id = ANY($1::uuid[])',
      q.unlinked === 'true' ? 'i.lead_id IS NULL' : q.unlinked === 'false' ? 'i.lead_id IS NOT NULL' : 'true',
    ].join(' AND ');
    const params = ctx.allBranches ? [] : [ctx.branchIds];
    const from = `FROM showroom_inquiries i LEFT JOIN vehicles v ON v.id = i.vehicle_id WHERE ${where}`;
    const [{ n }] = (await this.dbs.query<{ n: number }>(`SELECT count(*)::int AS n ${from}`, params)) as [{ n: number }];
    const items = await this.dbs.query(
      `SELECT i.id, i.kind, i.name, i.phone, i.email, i.message, i.preferred_date AS "preferredDate", i.customer_id AS "customerId",
              i.lead_id AS "leadId", i.unlinked_reason AS "unlinkedReason", i.created_at AS "createdAt",
              i.vehicle_id AS "vehicleId", v.stock_number AS "stockNumber"
         ${from} ORDER BY i.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      params,
    );
    return { items, total: n, page: q.page, pageSize: q.pageSize };
  }

  async list(ctx: TenantContext, q: { published?: 'true' | 'false'; page: number; pageSize: number }) {
    assertPermission(ctx, 'showroom.manage');
    const conds: SQL[] = [];
    if (!ctx.allBranches) conds.push(ctx.branchIds.length ? inArray(vehicles.branchId, ctx.branchIds) : sql`false`);
    if (q.published) conds.push(eq(vehicleListings.isPublished, q.published === 'true'));
    const where = conds.length ? and(...conds) : undefined;
    const visible = visibleStatuses(ctx.tenant.settings);
    const items = await this.dbs.db
      .select({
        id: vehicleListings.id,
        vehicleId: vehicles.id,
        stockNumber: vehicles.stockNumber,
        vehicleStatus: vehicles.status,
        titleAr: vehicleListings.titleAr,
        titleEn: vehicleListings.titleEn,
        isPublished: vehicleListings.isPublished,
        // A listing without any description text has no description source to report.
        descriptionSource: sql<string | null>`CASE WHEN coalesce(${vehicleListings.descriptionAr}, '') = '' AND coalesce(${vehicleListings.descriptionEn}, '') = '' THEN NULL ELSE ${vehicleListings.descriptionSource} END`,
        publishedAt: vehicleListings.publishedAt,
        publicPhotos: sql<number>`(SELECT count(*)::int FROM vehicle_media m WHERE m.vehicle_id = vehicles.id AND m.is_public AND m.kind = 'photo')`,
      })
      .from(vehicleListings)
      .innerJoin(vehicles, eq(vehicles.id, vehicleListings.vehicleId))
      .where(where)
      .orderBy(desc(vehicleListings.updatedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [total] = await this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(vehicleListings).innerJoin(vehicles, eq(vehicles.id, vehicleListings.vehicleId)).where(where);
    return {
      items: items.map((i) => ({ ...i, publiclyVisible: i.isPublished && visible.includes(i.vehicleStatus) && ctx.tenant.settings.showroom.enabled })),
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }
}
