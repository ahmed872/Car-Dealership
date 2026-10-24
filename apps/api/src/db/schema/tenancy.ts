import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { TenantSettings } from '@autohub/shared';
import { createdAt, inList, money, pct, pk, tenantId, ts, updatedAt } from './_columns';

export const tenants = pgTable(
  'tenants',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    market: text('market').notNull(),
    baseCurrency: text('base_currency').notNull(),
    status: text('status').notNull().default('active'),
    settings: jsonb('settings').$type<TenantSettings>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tenants_slug_uq').on(t.slug),
    check('tenants_status_chk', inList('status', ['active', 'suspended'])),
    check('tenants_market_chk', inList('market', ['EG', 'SA', 'AE'])),
    check('tenants_currency_chk', inList('base_currency', ['EGP', 'SAR', 'AED', 'USD', 'EUR'])),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    city: text('city'),
    address: text('address'),
    phone: text('phone'),
    timezone: text('timezone'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('branches_tenant_code_uq').on(t.tenantId, t.code),
    index('branches_tenant_idx').on(t.tenantId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    status: text('status').notNull().default('active'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    passwordChangedAt: ts('password_changed_at'),
    lastLoginAt: ts('last_login_at'),
    preferredLocale: text('preferred_locale'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    check('users_email_lower_chk', sql`email = lower(email)`),
    check('users_status_chk', inList('status', ['active', 'disabled'])),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    key: text('key'),
    name: text('name').notNull(),
    description: text('description'),
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    maxDiscountPct: pct('max_discount_pct').notNull().default('0'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('roles_tenant_name_uq').on(t.tenantId, t.name),
    uniqueIndex('roles_tenant_key_uq')
      .on(t.tenantId, t.key)
      .where(sql`key IS NOT NULL`),
    check('roles_discount_chk', sql`max_discount_pct >= 0 AND max_discount_pct <= 100`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    allBranches: boolean('all_branches').notNull().default(false),
    /**
     * active | suspended | invited. An EXISTING account added by a company starts as `invited`: it
     * grants no access until the person accepts it themselves (security review F1/F4).
     */
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('memberships_tenant_user_uq').on(t.tenantId, t.userId),
    index('memberships_user_idx').on(t.userId),
    check('memberships_status_chk', inList('status', ['active', 'suspended', 'invited'])),
  ],
);

export const membershipBranches = pgTable(
  'membership_branches',
  {
    tenantId: tenantId().references(() => tenants.id),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.branchId] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    seq: bigint('seq', { mode: 'number' }).notNull().default(0), // set by trigger
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    summary: text('summary'),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
    prevHash: text('prev_hash').notNull().default(''), // set by trigger
    hash: text('hash').notNull().default(''), // set by trigger
  },
  (t) => [
    uniqueIndex('audit_logs_tenant_seq_uq').on(t.tenantId, t.seq),
    index('audit_logs_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    index('audit_logs_created_idx').on(t.tenantId, t.createdAt),
  ],
);

export const auditChainHeads = pgTable('audit_chain_heads', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
  lastHash: text('last_hash').notNull(),
});

export const numberSequences = pgTable(
  'number_sequences',
  {
    tenantId: tenantId().references(() => tenants.id),
    key: text('key').notNull(),
    nextValue: bigint('next_value', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenantId: tenantId().references(() => tenants.id),
    key: text('key').notNull(),
    userId: uuid('user_id').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export const files = pgTable(
  'files',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    storageKey: text('storage_key').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    purpose: text('purpose').notNull(),
    uploadedBy: uuid('uploaded_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('files_storage_key_uq').on(t.storageKey), index('files_tenant_idx').on(t.tenantId)],
);

export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: pk(),
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    maxUsers: integer('max_users'),
    maxBranches: integer('max_branches'),
    maxVehicles: integer('max_vehicles'),
    features: text('features')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    priceMonthly: money('price_monthly'),
    currency: text('currency'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('subscription_plans_code_uq').on(t.code)],
);

export const tenantSubscriptions = pgTable(
  'tenant_subscriptions',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    planId: uuid('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id),
    status: text('status').notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    trialEndsAt: ts('trial_ends_at'),
    currentPeriodEnd: ts('current_period_end'),
    cancelledAt: ts('cancelled_at'),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('tenant_subscriptions_current_uq')
      .on(t.tenantId)
      .where(sql`status IN ('trial', 'active', 'past_due')`),
    check('tenant_subscriptions_status_chk', inList('status', ['trial', 'active', 'past_due', 'cancelled'])),
  ],
);
