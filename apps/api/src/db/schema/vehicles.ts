import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CONDITIONS,
  DOC_TYPES,
  DOCUMENTS_STATUSES,
  FEATURE_CATEGORIES,
  INSPECTION_RESULTS,
  INSPECTION_TYPES,
  MEDIA_CATEGORIES,
  OWNERSHIP_STATUSES,
  PANEL_CONDITIONS,
  SEVERITIES,
  VEHICLE_STATUSES,
  WARRANTY_TYPES,
} from '@autohub/shared';
import { createdAt, inList, money, pct, pk, tenantId, ts, updatedAt } from './_columns';
import { branches, files, tenants } from './tenancy';

export const STATUS_SOURCES = ['manual', 'acquisition', 'reservation', 'sale', 'delivery', 'return', 'transfer', 'stock_count', 'system'] as const;

export const vehicleMakes = pgTable(
  'vehicle_makes',
  {
    id: pk(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('vehicle_makes_name_uq').on(sql`coalesce(${t.tenantId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.nameEn})`)],
);

export const vehicleModels = pgTable(
  'vehicle_models',
  {
    id: pk(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    makeId: uuid('make_id')
      .notNull()
      .references(() => vehicleMakes.id),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    bodyType: text('body_type'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('vehicle_models_name_uq').on(
      sql`coalesce(${t.tenantId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.makeId,
      sql`lower(${t.nameEn})`,
    ),
  ],
);

export const features = pgTable(
  'features',
  {
    id: pk(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    category: text('category').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('features_code_uq').on(sql`coalesce(${t.tenantId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.code),
    check('features_category_chk', inList('category', FEATURE_CATEGORIES)),
  ],
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    stockNumber: text('stock_number').notNull(),
    vin: text('vin'),
    engineNumber: text('engine_number'),
    plateNumber: text('plate_number'),
    plateRegion: text('plate_region'),
    makeId: uuid('make_id')
      .notNull()
      .references(() => vehicleMakes.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => vehicleModels.id),
    trim: text('trim'),
    modelYear: integer('model_year').notNull(),
    registrationYear: integer('registration_year'),
    condition: text('condition').notNull().default('used'),
    bodyType: text('body_type'),
    exteriorColor: text('exterior_color'),
    interiorColor: text('interior_color'),
    doors: integer('doors'),
    seats: integer('seats'),
    fuelType: text('fuel_type'),
    engineCapacityCc: integer('engine_capacity_cc'),
    cylinders: integer('cylinders'),
    horsepower: integer('horsepower'),
    transmission: text('transmission'),
    drivetrain: text('drivetrain'),
    odometerValue: integer('odometer_value').notNull().default(0),
    odometerUnit: text('odometer_unit').notNull().default('km'),
    originCountry: text('origin_country'),
    specRegion: text('spec_region'),
    ownershipStatus: text('ownership_status').notNull().default('owned'),
    documentsStatus: text('documents_status').notNull().default('pending'),
    warrantyType: text('warranty_type').notNull().default('none'),
    warrantyUntil: date('warranty_until', { mode: 'string' }),
    warrantyNotes: text('warranty_notes'),
    locationLabel: text('location_label'),
    acquisitionId: uuid('acquisition_id'),
    supplierId: uuid('supplier_id'),
    acquiredAt: date('acquired_at', { mode: 'string' }),
    stockedAt: ts('stocked_at').notNull().defaultNow(),
    status: text('status').notNull().default('incoming'),
    statusChangedAt: ts('status_changed_at').notNull().defaultNow(),
    askingPrice: money('asking_price'),
    minPrice: money('min_price'),
    targetMarginPct: pct('target_margin_pct'),
    priceUpdatedAt: ts('price_updated_at'),
    internalNotes: text('internal_notes'),
    costLockedAt: ts('cost_locked_at'),
    removedReason: text('removed_reason'),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vehicles_stock_number_uq').on(t.tenantId, t.stockNumber),
    // The same VIN may return later (sold, then traded back in) but only once among vehicles still on the books.
    uniqueIndex('vehicles_active_vin_uq')
      .on(t.tenantId, t.vin)
      .where(sql`vin IS NOT NULL AND status NOT IN ('delivered', 'removed')`),
    index('vehicles_status_idx').on(t.tenantId, t.status),
    index('vehicles_branch_idx').on(t.tenantId, t.branchId),
    index('vehicles_make_model_idx').on(t.tenantId, t.makeId, t.modelId),
    index('vehicles_stocked_idx').on(t.tenantId, t.stockedAt),
    check('vehicles_status_chk', inList('status', VEHICLE_STATUSES)),
    check('vehicles_condition_chk', inList('condition', CONDITIONS)),
    check('vehicles_year_chk', sql`model_year BETWEEN 1950 AND 2100`),
    check('vehicles_odometer_chk', sql`odometer_value >= 0 AND odometer_unit IN ('km', 'mi')`),
    check('vehicles_prices_chk', sql`(asking_price IS NULL OR asking_price >= 0) AND (min_price IS NULL OR min_price >= 0)`),
    check('vehicles_ownership_chk', inList('ownership_status', OWNERSHIP_STATUSES)),
    check('vehicles_documents_chk', inList('documents_status', DOCUMENTS_STATUSES)),
    check('vehicles_warranty_chk', inList('warranty_type', WARRANTY_TYPES)),
    // Strict ISO 3779 rules are applied in the service per market/age; the DB guards the basic shape.
    check('vehicles_vin_chk', sql`vin IS NULL OR vin ~ '^[A-Z0-9]{5,17}$'`),
  ],
);

export const vehicleStatusHistory = pgTable(
  'vehicle_status_history',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    source: text('source').notNull(),
    sourceId: uuid('source_id'),
    actorUserId: uuid('actor_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('vehicle_status_history_vehicle_idx').on(t.vehicleId, t.createdAt), check('vsh_source_chk', inList('source', STATUS_SOURCES))],
);

export const vehiclePriceHistory = pgTable(
  'vehicle_price_history',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('vehicle_price_history_vehicle_idx').on(t.vehicleId, t.createdAt)],
);

export const odometerReadings = pgTable(
  'odometer_readings',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    value: integer('value').notNull(),
    unit: text('unit').notNull(),
    readAt: ts('read_at').notNull().defaultNow(),
    source: text('source').notNull(),
    isCorrection: boolean('is_correction').notNull().default(false),
    notes: text('notes'),
    recordedBy: uuid('recorded_by'),
    createdAt: createdAt(),
  },
  (t) => [index('odometer_readings_vehicle_idx').on(t.vehicleId, t.readAt), check('odometer_readings_chk', sql`value >= 0 AND unit IN ('km', 'mi')`)],
);

export const vehicleFeatureLinks = pgTable(
  'vehicle_feature_links',
  {
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id, { onDelete: 'cascade' }),
    featureId: uuid('feature_id')
      .notNull()
      .references(() => features.id),
    notes: text('notes'),
  },
  (t) => [primaryKey({ columns: [t.vehicleId, t.featureId] }), index('vehicle_feature_links_feature_idx').on(t.tenantId, t.featureId)],
);

export const vehicleMedia = pgTable(
  'vehicle_media',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    kind: text('kind').notNull(),
    category: text('category').notNull().default('general'),
    sortOrder: integer('sort_order').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    isPublic: boolean('is_public').notNull().default(true),
    caption: text('caption'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('vehicle_media_vehicle_idx').on(t.vehicleId, t.sortOrder),
    uniqueIndex('vehicle_media_primary_uq').on(t.vehicleId).where(sql`is_primary`),
    check('vehicle_media_kind_chk', inList('kind', ['photo', 'video'])),
    check('vehicle_media_category_chk', inList('category', MEDIA_CATEGORIES)),
  ],
);

export const vehicleDocuments = pgTable(
  'vehicle_documents',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    fileId: uuid('file_id').references(() => files.id),
    docType: text('doc_type').notNull(),
    docNumber: text('doc_number'),
    issuedAt: date('issued_at', { mode: 'string' }),
    expiresAt: date('expires_at', { mode: 'string' }),
    isSensitive: boolean('is_sensitive').notNull().default(false),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('vehicle_documents_vehicle_idx').on(t.vehicleId),
    index('vehicle_documents_expiry_idx').on(t.tenantId, t.expiresAt).where(sql`deleted_at IS NULL AND expires_at IS NOT NULL`),
    check('vehicle_documents_type_chk', inList('doc_type', DOC_TYPES)),
  ],
);

/** Generic attachments for acquisitions, expenses, work orders, sales, payments. */
export const attachments = pgTable(
  'attachments',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    category: text('category'),
    caption: text('caption'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('attachments_entity_idx').on(t.tenantId, t.entityType, t.entityId)],
);

export const inspectionTemplates = pgTable(
  'inspection_templates',
  {
    id: pk(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    name: text('name').notNull(),
    vehicleCategory: text('vehicle_category').notNull().default('all'),
    sections: jsonb('sections').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('inspection_templates_tenant_idx').on(t.tenantId)],
);


export const vehicleInspections = pgTable(
  'vehicle_inspections',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    templateId: uuid('template_id').references(() => inspectionTemplates.id),
    templateSnapshot: jsonb('template_snapshot').notNull(),
    versionNo: integer('version_no').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('draft'),
    inspectorUserId: uuid('inspector_user_id'),
    startedAt: ts('started_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    odometerValue: integer('odometer_value'),
    odometerUnit: text('odometer_unit'),
    overallResult: text('overall_result'),
    summary: text('summary'),
    recommendations: text('recommendations'),
    accidentHistory: text('accident_history'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vehicle_inspections_version_uq').on(t.vehicleId, t.versionNo),
    index('vehicle_inspections_vehicle_idx').on(t.tenantId, t.vehicleId),
    check('vehicle_inspections_status_chk', inList('status', ['draft', 'completed', 'cancelled'])),
    check('vehicle_inspections_type_chk', inList('type', INSPECTION_TYPES)),
    check('vehicle_inspections_result_chk', sql`overall_result IS NULL OR overall_result IN ('pass', 'pass_with_notes', 'fail')`),
  ],
);

export const inspectionItems = pgTable(
  'inspection_items',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    inspectionId: uuid('inspection_id')
      .notNull()
      .references(() => vehicleInspections.id, { onDelete: 'cascade' }),
    sectionKey: text('section_key').notNull(),
    itemKey: text('item_key').notNull(),
    labelEn: text('label_en').notNull(),
    labelAr: text('label_ar').notNull(),
    result: text('result').notNull().default('not_checked'),
    severity: text('severity').notNull().default('none'),
    measuredValue: numeric('measured_value', { precision: 12, scale: 3 }),
    measuredUnit: text('measured_unit'),
    measuredText: text('measured_text'),
    /** true = instrument measurement; false = technician's estimate/observation. */
    isMeasured: boolean('is_measured').notNull().default(false),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('inspection_items_key_uq').on(t.inspectionId, t.sectionKey, t.itemKey),
    check('inspection_items_result_chk', inList('result', INSPECTION_RESULTS)),
    check('inspection_items_severity_chk', inList('severity', SEVERITIES)),
  ],
);

export const inspectionPanels = pgTable(
  'inspection_panels',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    inspectionId: uuid('inspection_id')
      .notNull()
      .references(() => vehicleInspections.id, { onDelete: 'cascade' }),
    panelCode: text('panel_code').notNull(),
    condition: text('condition').notNull().default('not_inspected'),
    paintThicknessMicrons: integer('paint_thickness_microns'),
    notes: text('notes'),
  },
  (t) => [uniqueIndex('inspection_panels_uq').on(t.inspectionId, t.panelCode), check('inspection_panels_condition_chk', inList('condition', PANEL_CONDITIONS))],
);

export const inspectionMedia = pgTable(
  'inspection_media',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    inspectionId: uuid('inspection_id')
      .notNull()
      .references(() => vehicleInspections.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    itemKey: text('item_key'),
    panelCode: text('panel_code'),
    caption: text('caption'),
    createdAt: createdAt(),
  },
  (t) => [index('inspection_media_inspection_idx').on(t.inspectionId)],
);

export const vehicleTransfers = pgTable(
  'vehicle_transfers',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    fromBranchId: uuid('from_branch_id')
      .notNull()
      .references(() => branches.id),
    toBranchId: uuid('to_branch_id')
      .notNull()
      .references(() => branches.id),
    status: text('status').notNull().default('in_transit'),
    notes: text('notes'),
    requestedBy: uuid('requested_by'),
    shippedAt: ts('shipped_at').notNull().defaultNow(),
    receivedAt: ts('received_at'),
    receivedBy: uuid('received_by'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('vehicle_transfers_number_uq').on(t.tenantId, t.number),
    uniqueIndex('vehicle_transfers_active_uq').on(t.vehicleId).where(sql`status = 'in_transit'`),
    check('vehicle_transfers_status_chk', inList('status', ['in_transit', 'received', 'cancelled'])),
    check('vehicle_transfers_branches_chk', sql`from_branch_id <> to_branch_id`),
  ],
);

export const stockCounts = pgTable(
  'stock_counts',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    status: text('status').notNull().default('open'),
    notes: text('notes'),
    startedBy: uuid('started_by'),
    startedAt: ts('started_at').notNull().defaultNow(),
    submittedAt: ts('submitted_at'),
    reconciledBy: uuid('reconciled_by'),
    reconciledAt: ts('reconciled_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('stock_counts_number_uq').on(t.tenantId, t.number),
    uniqueIndex('stock_counts_open_uq').on(t.branchId).where(sql`status IN ('open', 'submitted')`),
    check('stock_counts_status_chk', inList('status', ['open', 'submitted', 'reconciled', 'cancelled'])),
  ],
);

export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    stockCountId: uuid('stock_count_id')
      .notNull()
      .references(() => stockCounts.id),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    expected: boolean('expected').notNull(),
    found: boolean('found'),
    scannedCode: text('scanned_code'),
    scannedAt: ts('scanned_at'),
    locationFound: text('location_found'),
    notes: text('notes'),
    resolution: text('resolution').notNull().default('none'),
    resolutionNotes: text('resolution_notes'),
  },
  (t) => [
    index('stock_count_lines_count_idx').on(t.stockCountId),
    uniqueIndex('stock_count_lines_vehicle_uq').on(t.stockCountId, t.vehicleId).where(sql`vehicle_id IS NOT NULL`),
    check(
      'stock_count_lines_resolution_chk',
      inList('resolution', ['none', 'confirmed', 'location_updated', 'investigate', 'written_off', 'unexpected_noted']),
    ),
  ],
);

