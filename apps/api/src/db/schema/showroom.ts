import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, pk, tenantId, ts, updatedAt } from './_columns';
import { customers, leads } from './crm';
import { tenants } from './tenancy';
import { vehicles } from './vehicles';

export const INTEGRATION_PROVIDERS = ['vin_decoder', 'ai_text', 'messaging', 'ocr'] as const;
export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email'] as const;

/**
 * Public showroom content of a vehicle, kept apart from the internal vehicle record so nothing
 * internal (cost, floor price, notes, VIN) can leak through the public pages. One per vehicle.
 */
export const vehicleListings = pgTable(
  'vehicle_listings',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    isPublished: boolean('is_published').notNull().default(false),
    titleAr: text('title_ar'),
    titleEn: text('title_en'),
    descriptionAr: text('description_ar'),
    descriptionEn: text('description_en'),
    /** Where the description text came from: typed by staff, the AI adapter, or the template. */
    descriptionSource: text('description_source').notNull().default('manual'),
    publishedAt: ts('published_at'),
    publishedBy: uuid('published_by'),
    unpublishedAt: ts('unpublished_at'),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('vehicle_listings_vehicle_uq').on(t.tenantId, t.vehicleId),
    index('vehicle_listings_published_idx').on(t.tenantId, t.isPublished),
    check('vehicle_listings_source_chk', inList('description_source', ['manual', 'ai', 'template'])),
  ],
);

/** Per-company integration settings. Secrets are stored encrypted and never returned. */
export const integrationSettings = pgTable(
  'integration_settings',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    provider: text('provider').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    secretEncrypted: text('secret_encrypted'),
    secretLast4: text('secret_last4'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('integration_settings_provider_uq').on(t.tenantId, t.provider),
    check('integration_settings_provider_chk', inList('provider', INTEGRATION_PROVIDERS)),
  ],
);

/** Outbound message log (append-only; personal fields can only be redacted, D-053). The development adapter only logs; nothing is delivered. */
export const messageLog = pgTable(
  'message_log',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    channel: text('channel').notNull(),
    recipient: text('recipient').notNull(),
    body: text('body').notNull(),
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    relatedType: text('related_type'),
    relatedId: uuid('related_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    /** Set only by app_redact_contact() (D-053): recipient, body and error were overwritten. */
    redactedAt: ts('redacted_at'),
    redactedBy: uuid('redacted_by'),
  },
  (t) => [
    index('message_log_tenant_idx').on(t.tenantId, t.createdAt),
    check('message_log_channel_chk', inList('channel', MESSAGE_CHANNELS)),
    check('message_log_status_chk', inList('status', ['logged', 'sent', 'failed'])),
  ],
);

/** Inquiries and test-drive requests from the public showroom (append-only; personal fields can only be redacted, D-053). */
export const showroomInquiries = pgTable(
  'showroom_inquiries',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    kind: text('kind').notNull(),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    /** The phone in the company's normalised form (repeat detection). */
    phoneNormalized: text('phone_normalized'),
    email: text('email'),
    message: text('message'),
    preferredDate: date('preferred_date', { mode: 'string' }),
    /** When the visitor ticked the consent box (inquiries are only accepted with consent). */
    consentAt: ts('consent_at').notNull(),
    customerId: uuid('customer_id').references(() => customers.id),
    leadId: uuid('lead_id').references(() => leads.id),
    /**
     * Why the inquiry was stored without creating or linking records: `repeat` (same phone within
     * a day), or a code for staff triage (e.g. `customer_inactive`).
     */
    unlinkedReason: text('unlinked_reason'),
    /** Keyed hash of the client address, for abuse review without storing the address. */
    clientHash: text('client_hash'),
    createdAt: createdAt(),
    /** Set only by app_redact_contact() (D-053): the personal fields were overwritten. */
    redactedAt: ts('redacted_at'),
    redactedBy: uuid('redacted_by'),
  },
  (t) => [
    index('showroom_inquiries_tenant_idx').on(t.tenantId, t.createdAt),
    index('showroom_inquiries_phone_idx').on(t.tenantId, t.phoneNormalized, t.createdAt),
    check('showroom_inquiries_kind_chk', inList('kind', ['inquiry', 'test_drive'])),
  ],
);
