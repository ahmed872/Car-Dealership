import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_TYPES,
  CUSTOMER_TYPES,
  INTERACTION_TYPES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  PAYMENT_METHODS,
  REFUND_STATUSES,
  RESERVATION_STATUSES,
  WISH_STATUSES,
} from '@autohub/shared';
import { createdAt, inList, money, pct, pk, rate, tenantId, ts, updatedAt } from './_columns';
import { cashAccounts } from './purchasing';
import { branches, tenants } from './tenancy';
import { vehicleMakes, vehicleModels, vehicles } from './vehicles';

// ── Customers ───────────────────────────────────────────────────────────────────────────────

export const customers = pgTable(
  'customers',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    type: text('type').notNull().default('individual'),
    fullName: text('full_name').notNull(),
    companyName: text('company_name'),
    /** Digits only (Arabic-Indic normalised), with country code when known — used for dedupe. */
    phone: text('phone'),
    phoneAlt: text('phone_alt'),
    whatsapp: text('whatsapp'),
    email: text('email'),
    /** National ID / Iqama / Emirates ID: encrypted at rest, HMAC for exact-match dedupe, last 4 for display. */
    nationalIdEnc: text('national_id_enc'),
    nationalIdHash: text('national_id_hash'),
    nationalIdLast4: text('national_id_last4'),
    nationality: text('nationality'),
    commercialRegistration: text('commercial_registration'),
    taxNumber: text('tax_number'),
    city: text('city'),
    address: text('address'),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    preferredLanguage: text('preferred_language').notNull().default('ar'),
    source: text('source'),
    assignedUserId: uuid('assigned_user_id'),
    branchId: uuid('branch_id').references(() => branches.id),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('customers_tenant_name_idx').on(t.tenantId, t.fullName),
    index('customers_phone_idx').on(t.tenantId, t.phone),
    index('customers_assigned_idx').on(t.tenantId, t.assignedUserId),
    uniqueIndex('customers_national_id_uq').on(t.tenantId, t.nationalIdHash).where(sql`national_id_hash IS NOT NULL`),
    check('customers_type_chk', inList('type', CUSTOMER_TYPES)),
    check('customers_lang_chk', inList('preferred_language', ['ar', 'en'])),
  ],
);

// ── Pipeline & leads ────────────────────────────────────────────────────────────────────────

/** Sales pipeline stages; tenant_id NULL rows are the global defaults (catalog RLS). */
export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: pk(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** open stages move forward; won/lost are terminal. */
    kind: text('kind').notNull().default('open'),
    probabilityPct: integer('probability_pct').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('pipeline_stages_code_uq').on(sql`coalesce(${t.tenantId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.code),
    check('pipeline_stages_kind_chk', inList('kind', ['open', 'won', 'lost'])),
    check('pipeline_stages_prob_chk', sql`probability_pct BETWEEN 0 AND 100`),
  ],
);

export const leads = pgTable(
  'leads',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    source: text('source').notNull(),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id),
    status: text('status').notNull().default('open'),
    assignedUserId: uuid('assigned_user_id'),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    interestNotes: text('interest_notes'),
    budgetMin: money('budget_min'),
    budgetMax: money('budget_max'),
    paymentPreference: text('payment_preference'),
    expectedCloseDate: date('expected_close_date', { mode: 'string' }),
    lostReason: text('lost_reason'),
    lostNotes: text('lost_notes'),
    wonSaleId: uuid('won_sale_id'),
    lastActivityAt: ts('last_activity_at'),
    nextFollowUpAt: ts('next_follow_up_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: ts('closed_at'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('leads_number_uq').on(t.tenantId, t.number),
    index('leads_assigned_idx').on(t.tenantId, t.assignedUserId, t.status),
    index('leads_customer_idx').on(t.tenantId, t.customerId),
    index('leads_followup_idx').on(t.tenantId, t.nextFollowUpAt),
    check('leads_status_chk', inList('status', LEAD_STATUSES)),
    check('leads_source_chk', inList('source', LEAD_SOURCES)),
    check('leads_payment_pref_chk', sql`payment_preference IS NULL OR payment_preference IN ('cash', 'bank_finance', 'installments', 'trade_in', 'undecided')`),
    check('leads_budget_chk', sql`budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max`),
  ],
);

/** Append-only stage history (also records status changes won/lost/reopened). */
export const leadStageHistory = pgTable(
  'lead_stage_history',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    fromStageId: uuid('from_stage_id'),
    toStageId: uuid('to_stage_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    note: text('note'),
    changedBy: uuid('changed_by'),
    changedAt: ts('changed_at').notNull().defaultNow(),
  },
  (t) => [index('lead_stage_history_lead_idx').on(t.leadId, t.changedAt)],
);

export const customerInteractions = pgTable(
  'customer_interactions',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    leadId: uuid('lead_id').references(() => leads.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    type: text('type').notNull(),
    direction: text('direction'),
    summary: text('summary').notNull(),
    outcome: text('outcome'),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    userId: uuid('user_id'),
    nextFollowUpAt: ts('next_follow_up_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('customer_interactions_customer_idx').on(t.tenantId, t.customerId, t.occurredAt),
    check('customer_interactions_type_chk', inList('type', INTERACTION_TYPES)),
    check('customer_interactions_dir_chk', sql`direction IS NULL OR direction IN ('inbound', 'outbound')`),
  ],
);

// ── Wishes & matching ───────────────────────────────────────────────────────────────────────

export const customerWishes = pgTable(
  'customer_wishes',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    leadId: uuid('lead_id').references(() => leads.id),
    makeId: uuid('make_id').references(() => vehicleMakes.id),
    modelId: uuid('model_id').references(() => vehicleModels.id),
    yearFrom: integer('year_from'),
    yearTo: integer('year_to'),
    maxPrice: money('max_price'),
    maxOdometerKm: integer('max_odometer_km'),
    bodyType: text('body_type'),
    fuelType: text('fuel_type'),
    transmission: text('transmission'),
    color: text('color'),
    notes: text('notes'),
    status: text('status').notNull().default('active'),
    expiresAt: date('expires_at', { mode: 'string' }),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('customer_wishes_active_idx').on(t.tenantId, t.status),
    check('customer_wishes_status_chk', inList('status', WISH_STATUSES)),
    check('customer_wishes_years_chk', sql`year_from IS NULL OR year_to IS NULL OR year_from <= year_to`),
  ],
);

/** One row per (wish, vehicle): the unique index makes matching notifications exactly-once. */
export const wishMatches = pgTable(
  'wish_matches',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    wishId: uuid('wish_id')
      .notNull()
      .references(() => customerWishes.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    matchedAt: ts('matched_at').notNull().defaultNow(),
    dismissedAt: ts('dismissed_at'),
  },
  (t) => [uniqueIndex('wish_matches_uq').on(t.wishId, t.vehicleId)],
);

// ── Appointments & test drives ──────────────────────────────────────────────────────────────

export const appointments = pgTable(
  'appointments',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    type: text('type').notNull(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    customerId: uuid('customer_id').references(() => customers.id),
    leadId: uuid('lead_id').references(() => leads.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    assignedUserId: uuid('assigned_user_id'),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    status: text('status').notNull().default('scheduled'),
    title: text('title'),
    notes: text('notes'),
    outcome: text('outcome'),
    cancelReason: text('cancel_reason'),
    /** Test-drive specifics (license, odometer out/in). */
    driverLicenseNumber: text('driver_license_number'),
    driverLicenseExpiry: date('driver_license_expiry', { mode: 'string' }),
    odometerOut: integer('odometer_out'),
    odometerIn: integer('odometer_in'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('appointments_time_idx').on(t.tenantId, t.startsAt),
    index('appointments_assigned_idx').on(t.tenantId, t.assignedUserId, t.startsAt),
    index('appointments_vehicle_idx').on(t.tenantId, t.vehicleId, t.startsAt),
    check('appointments_type_chk', inList('type', APPOINTMENT_TYPES)),
    check('appointments_status_chk', inList('status', APPOINTMENT_STATUSES)),
    check('appointments_time_chk', sql`ends_at > starts_at`),
    check('appointments_odometer_chk', sql`odometer_in IS NULL OR odometer_out IS NULL OR odometer_in >= odometer_out`),
  ],
);

// ── Reservations, receipts, refunds ─────────────────────────────────────────────────────────

export const reservations = pgTable(
  'reservations',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    leadId: uuid('lead_id').references(() => leads.id),
    salesUserId: uuid('sales_user_id'),
    status: text('status').notNull().default('active'),
    /** Vehicle status before reservation (restored on cancel/expiry). */
    priorVehicleStatus: text('prior_vehicle_status').notNull(),
    reservedAt: ts('reserved_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    agreedPrice: money('agreed_price'),
    /** Deposit required (base currency); the money actually received is in receipts. */
    depositAmount: money('deposit_amount').notNull().default('0'),
    /** Part of the received deposit kept by the dealership on cancellation (Dr 2100 / Cr 4200). */
    forfeitedBase: money('forfeited_base').notNull().default('0'),
    refundPolicy: text('refund_policy').notNull(),
    refundablePct: pct('refundable_pct').notNull().default('100'),
    notes: text('notes'),
    extendedCount: integer('extended_count').notNull().default(0),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: uuid('cancelled_by'),
    cancelReason: text('cancel_reason'),
    expiredAt: ts('expired_at'),
    convertedAt: ts('converted_at'),
    saleId: uuid('sale_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('reservations_number_uq').on(t.tenantId, t.number),
    // The hard guarantee behind "one vehicle, one active reservation".
    uniqueIndex('reservations_vehicle_active_uq').on(t.vehicleId).where(sql`status = 'active'`),
    index('reservations_expiry_idx').on(t.tenantId, t.status, t.expiresAt),
    index('reservations_customer_idx').on(t.tenantId, t.customerId),
    check('reservations_status_chk', inList('status', RESERVATION_STATUSES)),
    check('reservations_policy_chk', inList('refund_policy', ['refundable', 'non_refundable', 'partial'])),
    check('reservations_pct_chk', sql`refundable_pct BETWEEN 0 AND 100`),
    check('reservations_deposit_chk', sql`deposit_amount >= 0 AND (agreed_price IS NULL OR agreed_price > 0)`),
    check('reservations_expiry_chk', sql`expires_at > reserved_at`),
  ],
);

/** Money received from customers (deposits, sale payments, installments). Append-only except status. */
export const receipts = pgTable(
  'receipts',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    cashAccountId: uuid('cash_account_id')
      .notNull()
      .references(() => cashAccounts.id),
    branchId: uuid('branch_id').references(() => branches.id),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    amountBase: money('amount_base').notNull(),
    receivedAt: date('received_at', { mode: 'string' }).notNull(),
    method: text('method').notNull(),
    reference: text('reference'),
    notes: text('notes'),
    status: text('status').notNull().default('posted'),
    voidedAt: ts('voided_at'),
    voidedBy: uuid('voided_by'),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('receipts_number_uq').on(t.tenantId, t.number),
    index('receipts_customer_idx').on(t.tenantId, t.customerId),
    check('receipts_status_chk', inList('status', ['posted', 'voided'])),
    check('receipts_amount_chk', sql`amount > 0 AND amount_base > 0 AND exchange_rate > 0`),
    check('receipts_method_chk', inList('method', PAYMENT_METHODS)),
  ],
);

/** What a receipt pays for (base currency). Append-only. */
export const receiptAllocations = pgTable(
  'receipt_allocations',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => receipts.id),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    amountBase: money('amount_base').notNull(),
  },
  (t) => [
    index('receipt_allocations_target_idx').on(t.tenantId, t.targetType, t.targetId),
    check('receipt_allocations_type_chk', inList('target_type', ['reservation', 'sale', 'installment', 'customer_credit'])),
    check('receipt_allocations_amount_chk', sql`amount_base > 0`),
  ],
);

/** Refunds to customers: requested → approved → paid (cash out through CashService). */
export const refunds = pgTable(
  'refunds',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    branchId: uuid('branch_id').references(() => branches.id),
    amountBase: money('amount_base').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('requested'),
    requestedBy: uuid('requested_by'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    cashAccountId: uuid('cash_account_id').references(() => cashAccounts.id),
    method: text('method'),
    reference: text('reference'),
    paidAt: date('paid_at', { mode: 'string' }),
    paidBy: uuid('paid_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refunds_number_uq').on(t.tenantId, t.number),
    index('refunds_source_idx').on(t.tenantId, t.sourceType, t.sourceId),
    check('refunds_status_chk', inList('status', REFUND_STATUSES)),
    check('refunds_source_chk', inList('source_type', ['reservation', 'sale', 'customer_credit'])),
    check('refunds_amount_chk', sql`amount_base > 0`),
  ],
);

// ── Notifications ───────────────────────────────────────────────────────────────────────────

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    titleAr: text('title_ar').notNull(),
    titleEn: text('title_en').notNull(),
    bodyAr: text('body_ar'),
    bodyEn: text('body_en'),
    link: text('link'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    /** Unique per tenant: re-running a job never duplicates a notification. */
    dedupeKey: text('dedupe_key').notNull(),
    severity: text('severity').notNull().default('info'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_uq').on(t.tenantId, t.dedupeKey),
    index('notifications_user_idx').on(t.tenantId, t.userId, t.readAt, t.createdAt),
    check('notifications_severity_chk', inList('severity', ['info', 'success', 'warning', 'danger'])),
  ],
);

// ── Employees & commission policies ─────────────────────────────────────────────────────────

export const employeeProfiles = pgTable(
  'employee_profiles',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    employeeCode: text('employee_code'),
    jobTitle: text('job_title'),
    phone: text('phone'),
    hireDate: date('hire_date', { mode: 'string' }),
    monthlyTargetUnits: integer('monthly_target_units'),
    monthlyTargetAmount: money('monthly_target_amount'),
    commissionPolicyId: uuid('commission_policy_id'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('employee_profiles_user_uq').on(t.tenantId, t.userId),
    uniqueIndex('employee_profiles_code_uq').on(t.tenantId, t.employeeCode).where(sql`employee_code IS NOT NULL`),
  ],
);

/**
 * Versioned commission policies: a policy is never edited once used — a new version is created.
 * Earned commissions (Phase 5) store the policy version and a snapshot of the rule.
 */
export const commissionPolicies = pgTable(
  'commission_policies',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    code: text('code').notNull(),
    version: integer('version').notNull().default(1),
    name: text('name').notNull(),
    rule: jsonb('rule').notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    isActive: boolean('is_active').notNull().default(true),
    supersededById: uuid('superseded_by_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('commission_policies_version_uq').on(t.tenantId, t.code, t.version),
    check('commission_policies_dates_chk', sql`effective_to IS NULL OR effective_to >= effective_from`),
  ],
);
