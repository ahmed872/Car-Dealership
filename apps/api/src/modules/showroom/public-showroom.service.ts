import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { LEAD_SOURCES, normalizeCustomerPhone, ShowroomInquiryInput, TenantSettings, zCustomerCreate, zShowroomVehicleQuery } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { hmacHex } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { getEnv } from '../../config/env';
import { DbService } from '../../db/db.service';
import { showroomInquiries } from '../../db/schema';
import { CustomersService } from '../customers/customers.service';
import { FilesService } from '../files/files.service';
import { MessagingService } from '../integrations/messaging.service';
import { SYSTEM_USER_ID, systemContext } from '../jobs/system-context';
import { LeadsService } from '../leads/leads.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscriptionService } from '../tenancy/subscription.service';
import { publicLinks, visibleStatuses } from './showroom-common';

type PublicRow = {
  listing_id: string;
  vehicle_id: string;
  stock_number: string;
  title_ar: string | null;
  title_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  make_en: string;
  make_ar: string;
  model_en: string;
  model_ar: string;
  model_year: number;
  trim: string | null;
  body_type: string | null;
  fuel_type: string | null;
  transmission: string | null;
  exterior_color: string | null;
  interior_color: string | null;
  odometer_value: number | null;
  odometer_unit: string;
  condition: string;
  spec_region: string | null;
  status: string;
  asking_price: string | null;
  branch_id: string;
  branch_name: string;
  branch_city: string | null;
  primary_media_id: string | null;
};

/**
 * The public digital showroom (D-036). No session: the company is resolved from its slug through
 * a narrow SECURITY DEFINER helper that answers only for active companies with the showroom
 * enabled, and every query then runs under that company's RLS context. Only published listings of
 * vehicles in a listable status are visible, and only an explicit allow-list of fields leaves:
 * never cost, floor price, VIN, plate, notes, supplier or internal status.
 */
@Injectable()
export class PublicShowroomService {
  private readonly logger = new Logger(PublicShowroomService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly subscription: SubscriptionService,
    private readonly files: FilesService,
    private readonly customers: CustomersService,
    private readonly leads: LeadsService,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
  ) {}

  private async inTenant<T>(slug: string, fn: (ctx: TenantContext) => Promise<T>, write = false): Promise<T> {
    const [r] = await this.dbs.runInTenant({ tenantId: null, userId: null }, () => this.dbs.query<{ id: string | null }>(`SELECT app_showroom_tenant_id($1) AS id`, [slug]), {
      write: false,
    });
    if (!r?.id) throw notFound('Showroom');
    const tenantId = r.id;
    return this.dbs.runInTenant(
      { tenantId, userId: SYSTEM_USER_ID },
      async () => {
        if (!(await this.subscription.hasFeature('showroom'))) throw notFound('Showroom');
        return fn(await systemContext(this.dbs, tenantId));
      },
      { write },
    );
  }

  private baseSelect(settings: TenantSettings) {
    return `SELECT l.id AS listing_id, v.id AS vehicle_id, v.stock_number, l.title_ar, l.title_en, l.description_ar, l.description_en,
                   mk.name_en AS make_en, mk.name_ar AS make_ar, md.name_en AS model_en, md.name_ar AS model_ar, v.model_year, v.trim,
                   v.body_type, v.fuel_type, v.transmission, v.exterior_color, v.interior_color, v.odometer_value, v.odometer_unit,
                   v.condition, v.spec_region, v.status, ${settings.showroom.showPrices ? 'v.asking_price::text' : 'NULL::text'} AS asking_price,
                   b.id AS branch_id, b.name AS branch_name, b.city AS branch_city,
                   (SELECT m.id FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.is_public AND m.kind = 'photo' AND m.category = 'general'
                     ORDER BY m.is_primary DESC, m.sort_order, m.created_at LIMIT 1) AS primary_media_id
              FROM vehicle_listings l
              JOIN vehicles v ON v.id = l.vehicle_id
              JOIN vehicle_makes mk ON mk.id = v.make_id
              JOIN vehicle_models md ON md.id = v.model_id
              JOIN branches b ON b.id = v.branch_id
             WHERE l.is_published AND v.status = ANY($1::text[])`;
  }

  private card(ctx: TenantContext, slug: string, r: PublicRow) {
    const settings = ctx.tenant.settings;
    const titleEn = r.title_en ?? `${r.make_en} ${r.model_en} ${r.model_year}`;
    return {
      id: r.listing_id,
      titleAr: r.title_ar ?? `${r.make_ar} ${r.model_ar} ${r.model_year}`,
      titleEn,
      make: { en: r.make_en, ar: r.make_ar },
      model: { en: r.model_en, ar: r.model_ar },
      modelYear: r.model_year,
      trim: r.trim,
      bodyType: r.body_type,
      fuelType: r.fuel_type,
      transmission: r.transmission,
      exteriorColor: r.exterior_color,
      odometer: r.odometer_value === null ? null : { value: r.odometer_value, unit: r.odometer_unit },
      condition: r.condition,
      specRegion: r.spec_region,
      status: r.status === 'reserved' ? 'reserved' : 'available',
      price: r.asking_price ? { amount: r.asking_price, currency: ctx.tenant.baseCurrency } : null,
      branch: { name: r.branch_name, city: r.branch_city },
      photoUrl: r.primary_media_id ? `/api/v1/public/showroom/${encodeURIComponent(slug)}/media/${r.primary_media_id}` : null,
      share: publicLinks(getEnv().PUBLIC_WEB_URL, slug, r.listing_id, titleEn, settings.showroom.whatsappNumber),
    };
  }

  async company(slug: string) {
    return this.inTenant(slug, async (ctx) => {
      const s = ctx.tenant.settings;
      const branches = await this.dbs.query<{ name: string; city: string | null }>(`SELECT name, city FROM branches WHERE is_active ORDER BY created_at`);
      return {
        name: ctx.tenant.name,
        legalNameAr: s.documents.legalNameAr ?? null,
        legalNameEn: s.documents.legalNameEn ?? null,
        headlineAr: s.showroom.headlineAr ?? null,
        headlineEn: s.showroom.headlineEn ?? null,
        whatsappNumber: s.showroom.whatsappNumber ?? null,
        phone: s.documents.phone ?? null,
        currency: ctx.tenant.baseCurrency,
        showPrices: s.showroom.showPrices,
        branches,
      };
    });
  }

  async list(slug: string, q: z.infer<typeof zShowroomVehicleQuery>) {
    return this.inTenant(slug, async (ctx) => {
      const params: unknown[] = [visibleStatuses(ctx.tenant.settings)];
      const add = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const where: string[] = [];
      if (q.q) {
        const like = add(`%${q.q.replace(/[%_\\]/g, '')}%`);
        where.push(`(mk.name_en ILIKE ${like} OR mk.name_ar ILIKE ${like} OR md.name_en ILIKE ${like} OR md.name_ar ILIKE ${like} OR l.title_ar ILIKE ${like} OR l.title_en ILIKE ${like})`);
      }
      if (q.makeId) where.push(`v.make_id = ${add(q.makeId)}::uuid`);
      if (q.modelId) where.push(`v.model_id = ${add(q.modelId)}::uuid`);
      if (q.yearFrom) where.push(`v.model_year >= ${add(q.yearFrom)}::int`);
      if (q.yearTo) where.push(`v.model_year <= ${add(q.yearTo)}::int`);
      if (q.priceMax && ctx.tenant.settings.showroom.showPrices) where.push(`v.asking_price <= ${add(q.priceMax)}::numeric`);
      const filter = where.length ? ` AND ${where.join(' AND ')}` : '';
      const base = this.baseSelect(ctx.tenant.settings) + filter;
      const [{ n }] = (await this.dbs.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${base}) x`, params)) as [{ n: number }];
      const rows = await this.dbs.query<PublicRow>(`${base} ORDER BY l.published_at DESC, v.stock_number LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, params);
      return { items: rows.map((r) => this.card(ctx, slug, r)), total: n, page: q.page, pageSize: q.pageSize };
    });
  }

  private async visibleRow(ctx: TenantContext, listingId: string): Promise<PublicRow> {
    const [r] = await this.dbs.query<PublicRow>(`${this.baseSelect(ctx.tenant.settings)} AND l.id = $2::uuid`, [visibleStatuses(ctx.tenant.settings), listingId]);
    if (!r) throw notFound('Vehicle');
    return r;
  }

  async detail(slug: string, listingId: string) {
    return this.inTenant(slug, async (ctx) => {
      const r = await this.visibleRow(ctx, listingId);
      const photos = await this.dbs.query<{ id: string; caption: string | null }>(
        `SELECT id, caption FROM vehicle_media WHERE vehicle_id = $1 AND is_public AND kind = 'photo' AND category = 'general' ORDER BY is_primary DESC, sort_order, created_at`,
        [r.vehicle_id],
      );
      const features = await this.dbs.query<{ en: string; ar: string }>(
        `SELECT f.name_en AS en, f.name_ar AS ar FROM vehicle_feature_links fl JOIN features f ON f.id = fl.feature_id WHERE fl.vehicle_id = $1 ORDER BY f.name_en`,
        [r.vehicle_id],
      );
      return {
        ...this.card(ctx, slug, r),
        interiorColor: r.interior_color,
        descriptionAr: r.description_ar,
        descriptionEn: r.description_en,
        features,
        photos: photos.map((p) => ({ url: `/api/v1/public/showroom/${encodeURIComponent(slug)}/media/${p.id}`, caption: p.caption })),
      };
    });
  }

  /** Streams a public photo of a visible vehicle (nothing else is reachable through this route). */
  async media(slug: string, mediaId: string): Promise<{ stream: Readable; mimeType: string; size: number }> {
    return this.inTenant(slug, async (ctx) => {
      const [m] = await this.dbs.query<{ storage_key: string; mime_type: string; size_bytes: number }>(
        `SELECT f.storage_key, f.mime_type, f.size_bytes
           FROM vehicle_media m JOIN files f ON f.id = m.file_id
           JOIN vehicle_listings l ON l.vehicle_id = m.vehicle_id AND l.is_published
           JOIN vehicles v ON v.id = m.vehicle_id AND v.status = ANY($2::text[])
          WHERE m.id = $1::uuid AND m.is_public AND m.kind = 'photo' AND m.category = 'general'`,
        [mediaId, visibleStatuses(ctx.tenant.settings)],
      );
      if (!m) throw notFound('Photo');
      return { stream: await this.files.open(m.storage_key), mimeType: m.mime_type, size: Number(m.size_bytes) };
    });
  }

  /**
   * Inquiry or test-drive request from the public showroom (D-036). The visitor always gets the
   * same answer, so the endpoint reveals nothing about existing customers. Intake is bounded: a
   * daily per-company limit, and a repeat from the same phone about the same vehicle within a day
   * is attached to what the first one created instead of creating more records.
   *
   * Linking: one ACTIVE customer matching the phone is reused, none creates a customer (source
   * `showroom`, unassigned); the customer's open lead for the vehicle is reused, else an unassigned
   * showroom lead is created. Anything else (an inactive or ambiguous match, a business rule that
   * refuses the lead) stores the inquiry unlinked for staff triage. Managers who can assign leads
   * are notified. An acknowledgement to the (unverified) phone is sent only when the company
   * enabled it, only for new inquiries, and only after the transaction committed.
   */
  async inquiry(slug: string, input: ShowroomInquiryInput, clientAddress: string | undefined) {
    const received = { status: 'received' as const };
    if (input.website) return received; // honeypot: bots fill hidden fields
    return this.inTenant(
      slug,
      async (ctx) => {
        const [{ n }] = (await this.dbs.query<{ n: number }>(`SELECT count(*)::int AS n FROM showroom_inquiries WHERE created_at > now() - interval '1 day'`)) as [
          { n: number },
        ];
        if (n >= getEnv().SHOWROOM_DAILY_INQUIRY_LIMIT) {
          this.logger.warn(`showroom inquiry limit reached for tenant ${ctx.tenant.id}; inquiry not stored`);
          return received;
        }
        let vehicleId: string | null = null;
        let branchId: string | null = null;
        let title: string | null = null;
        if (input.listingId) {
          const r = await this.visibleRow(ctx, input.listingId);
          vehicleId = r.vehicle_id;
          branchId = r.branch_id;
          title = r.title_ar ?? `${r.make_ar} ${r.model_ar} ${r.model_year}`;
        } else {
          const [b] = await this.dbs.query<{ id: string }>(`SELECT id FROM branches WHERE is_active ORDER BY created_at LIMIT 1`);
          branchId = b?.id ?? null;
        }
        const phoneNormalized = normalizeCustomerPhone(input.phone, ctx.tenant.market);
        const what = input.kind === 'test_drive' ? `test drive requested${input.preferredDate ? ` for ${input.preferredDate}` : ''}` : 'inquiry';
        const summary = [`Online showroom ${what} (unverified contact) from “${input.name}”`, input.message ? `“${input.message}”` : null]
          .filter(Boolean)
          .join(' — ')
          .slice(0, 1000);
        const link = await this.linkInquiry(ctx, { phone: input.phone, email: input.email ?? null, name: input.name, phoneNormalized, vehicleId, branchId, summary });
        const [row] = await this.dbs.db
          .insert(showroomInquiries)
          .values({
            tenantId: ctx.tenant.id,
            kind: input.kind,
            vehicleId,
            name: input.name,
            phone: input.phone,
            phoneNormalized,
            email: input.email ?? null,
            message: input.message ?? null,
            preferredDate: input.preferredDate ?? null,
            consentAt: new Date(),
            customerId: link.customerId,
            leadId: link.leadId,
            unlinkedReason: link.reason,
            clientHash: clientAddress ? hmacHex(`client:${clientAddress}`) : null,
          })
          .returning({ id: showroomInquiries.id });
        const managers = await this.dbs.query<{ user_id: string }>(
          `SELECT m.user_id FROM memberships m JOIN roles r ON r.id = m.role_id
            WHERE m.status = 'active' AND 'leads.assign' = ANY(r.permissions)
              AND (m.all_branches OR $1::uuid IS NULL OR EXISTS (SELECT 1 FROM membership_branches mb WHERE mb.membership_id = m.id AND mb.branch_id = $1))`,
          [branchId],
        );
        const triage = link.reason !== null && link.reason !== 'repeat';
        await this.notifications.notify(ctx, {
          userIds: managers.map((m) => m.user_id),
          type: 'showroom.inquiry',
          titleAr: triage
            ? `استفسار من المعرض الإلكتروني يحتاج مراجعة: ${input.name}`
            : input.kind === 'test_drive'
              ? `طلب تجربة قيادة من المعرض الإلكتروني: ${input.name}`
              : `استفسار جديد من المعرض الإلكتروني: ${input.name}`,
          titleEn: triage
            ? `Online showroom inquiry needs review: ${input.name}`
            : input.kind === 'test_drive'
              ? `Online test-drive request: ${input.name}`
              : `New online showroom inquiry: ${input.name}`,
          bodyAr: title,
          bodyEn: title,
          link: link.leadId ? `/app/leads/${link.leadId}` : '/app/showroom/inquiries',
          entityType: link.leadId ? 'lead' : 'showroom_inquiry',
          entityId: link.leadId ?? row!.id,
          dedupeKey: `showroom.inquiry:${row!.id}`,
        });
        if (link.reason === null && ctx.tenant.settings.showroom.acknowledgeInquiries) {
          await this.messaging.send(ctx.tenant, {
            channel: 'whatsapp',
            to: input.phone,
            text: `${ctx.tenant.name}: شكرًا لتواصلك معنا، سيتصل بك أحد ممثلينا قريبًا. / Thank you for contacting us; a representative will call you soon.`,
            relatedType: 'showroom_inquiry',
            relatedId: row!.id,
          });
        }
        return received;
      },
      true,
    );
  }

  /** Finds or creates the customer and lead for an inquiry; see `inquiry` for the rules. */
  private async linkInquiry(
    ctx: TenantContext,
    a: { phone: string; email: string | null; name: string; phoneNormalized: string | null; vehicleId: string | null; branchId: string | null; summary: string },
  ): Promise<{ customerId: string | null; leadId: string | null; reason: string | null }> {
    if (a.phoneNormalized) {
      const [prev] = await this.dbs.query<{ customer_id: string | null; lead_id: string | null }>(
        `SELECT customer_id, lead_id FROM showroom_inquiries
          WHERE phone_normalized = $1 AND vehicle_id IS NOT DISTINCT FROM $2::uuid AND created_at > now() - interval '1 day'
          ORDER BY created_at DESC LIMIT 1`,
        [a.phoneNormalized, a.vehicleId],
      );
      if (prev) {
        if (prev.customer_id && prev.lead_id) {
          await this.customers.appendInteraction(ctx, { customerId: prev.customer_id, leadId: prev.lead_id, vehicleId: a.vehicleId, type: 'note', summary: a.summary });
        }
        return { customerId: prev.customer_id, leadId: prev.lead_id, reason: 'repeat' };
      }
    }
    if (!a.branchId) return { customerId: null, leadId: null, reason: 'no_branch' };
    const dup = await this.customers.checkDuplicates(ctx, { phone: a.phone });
    const byPhone = dup.candidates.filter((c) => c.matchedOn.includes('phone'));
    const active = byPhone.filter((c) => c.isActive);
    if (active.length > 1) return { customerId: null, leadId: null, reason: 'ambiguous_customer' };
    if (!active.length && byPhone.length) return { customerId: null, leadId: null, reason: 'customer_inactive' };
    // A business rule refusing the customer or lead (e.g. an inactive branch) must not lose the
    // inquiry or tell the visitor anything: undo just this part and keep the inquiry for triage.
    await this.dbs.query('SAVEPOINT showroom_inquiry_link');
    try {
      const customerId =
        active[0]?.id ??
        (await this.customers.create(ctx, zCustomerCreate.parse({ fullName: a.name, phone: a.phone, email: a.email, source: 'showroom', branchId: a.branchId }))).id;
      const [open] = await this.dbs.query<{ id: string }>(
        `SELECT id FROM leads WHERE customer_id = $1 AND status = 'open' AND vehicle_id IS NOT DISTINCT FROM $2::uuid ORDER BY created_at DESC LIMIT 1`,
        [customerId, a.vehicleId],
      );
      const leadId =
        open?.id ??
        (await this.leads.create(ctx, { customerId, branchId: a.branchId, source: 'showroom' as (typeof LEAD_SOURCES)[number], vehicleId: a.vehicleId, interestNotes: a.summary })).id;
      await this.customers.appendInteraction(ctx, { customerId, leadId, vehicleId: a.vehicleId, type: 'note', summary: a.summary });
      await this.dbs.query('RELEASE SAVEPOINT showroom_inquiry_link');
      return { customerId, leadId, reason: null };
    } catch (e) {
      await this.dbs.query('ROLLBACK TO SAVEPOINT showroom_inquiry_link');
      if (!(e instanceof AppError)) this.logger.error(`showroom inquiry could not be linked: ${(e as Error).message}`);
      return { customerId: null, leadId: null, reason: e instanceof AppError ? e.code : 'error' };
    }
  }

}
