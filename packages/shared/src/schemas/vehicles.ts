import { z } from 'zod';
import { VEHICLE_STATUSES } from '../vehicle-lifecycle';
import { zIsoDate, zMoneyNonNeg, zOptText, zPaginationQuery, zPercent, zText, zUuid, patchOf } from './common';

export const BODY_TYPES = ['sedan', 'suv', 'crossover', 'hatchback', 'coupe', 'convertible', 'pickup', 'van', 'wagon', 'bus', 'truck', 'other'] as const;
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'plugin_hybrid', 'electric', 'lpg', 'cng', 'other'] as const;
export const TRANSMISSIONS = ['automatic', 'manual', 'cvt', 'dct', 'other'] as const;
export const DRIVETRAINS = ['fwd', 'rwd', 'awd', '4wd'] as const;
export const CONDITIONS = ['new', 'used', 'certified'] as const;
export const SPEC_REGIONS = ['gcc', 'local_agent', 'american', 'european', 'japanese', 'korean', 'chinese', 'canadian', 'other'] as const;
export const OWNERSHIP_STATUSES = ['owned', 'consignment', 'pending_transfer', 'financed'] as const;
export const DOCUMENTS_STATUSES = ['complete', 'incomplete', 'pending'] as const;
export const WARRANTY_TYPES = ['none', 'manufacturer', 'dealer', 'extended'] as const;
export const FEATURE_CATEGORIES = ['comfort', 'safety', 'technology', 'exterior', 'interior', 'performance', 'warranty', 'modification', 'other'] as const;
export const DOC_TYPES = ['ownership', 'registration', 'insurance', 'inspection', 'customs', 'purchase', 'service_history', 'warranty', 'other'] as const;
export const MEDIA_CATEGORIES = ['general', 'damage', 'inspection', 'before', 'after', 'document'] as const;
export const INSPECTION_TYPES = ['acquisition', 'pre_sale', 'periodic', 'trade_in', 'return', 'other'] as const;
export const INSPECTION_RESULTS = ['ok', 'attention', 'fail', 'na', 'not_checked'] as const;
export const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'] as const;
export const PANEL_CONDITIONS = ['original', 'repainted', 'filler', 'repaired', 'damaged', 'replaced', 'scratched', 'dented', 'not_inspected'] as const;
export const PANEL_CODES = [
  'front_bumper', 'hood', 'roof', 'trunk', 'rear_bumper',
  'fl_fender', 'fr_fender', 'fl_door', 'fr_door', 'rl_door', 'rr_door', 'rl_quarter', 'rr_quarter',
] as const;
export const ODOMETER_SOURCES = ['acquisition', 'inspection', 'manual', 'test_drive', 'delivery', 'transfer', 'return'] as const;
export type PanelCode = (typeof PANEL_CODES)[number];
export type PanelCondition = (typeof PANEL_CONDITIONS)[number];

const intOpt = (min: number, max: number) => z.coerce.number().int().min(min).max(max).optional().nullable();

const vehicleCore = {
  vin: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().max(17))
    .optional()
    .nullable()
    // Absent stays absent (PATCH must not wipe a stored VIN); empty string means "clear it".
    .transform((v) => (v === undefined ? undefined : v ? v : null)),
  /** Old or locally-registered vehicles may carry a non-ISO chassis number. */
  vinNonStandard: z.boolean().default(false),
  engineNumber: zOptText(40),
  plateNumber: zOptText(30),
  plateRegion: zOptText(40),
  makeId: zUuid,
  modelId: zUuid,
  trim: zOptText(80),
  modelYear: z.coerce.number().int().min(1950).max(2100),
  registrationYear: intOpt(1950, 2100),
  condition: z.enum(CONDITIONS).default('used'),
  bodyType: z.enum(BODY_TYPES).optional().nullable(),
  exteriorColor: zOptText(40),
  interiorColor: zOptText(40),
  doors: intOpt(1, 8),
  seats: intOpt(1, 60),
  fuelType: z.enum(FUEL_TYPES).optional().nullable(),
  engineCapacityCc: intOpt(0, 20000),
  cylinders: intOpt(0, 16),
  horsepower: intOpt(0, 3000),
  transmission: z.enum(TRANSMISSIONS).optional().nullable(),
  drivetrain: z.enum(DRIVETRAINS).optional().nullable(),
  originCountry: zOptText(60),
  specRegion: z.enum(SPEC_REGIONS).optional().nullable(),
  ownershipStatus: z.enum(OWNERSHIP_STATUSES).default('owned'),
  documentsStatus: z.enum(DOCUMENTS_STATUSES).default('pending'),
  warrantyType: z.enum(WARRANTY_TYPES).default('none'),
  warrantyUntil: zIsoDate.optional().nullable(),
  warrantyNotes: zOptText(500),
  locationLabel: zOptText(80),
  acquiredAt: zIsoDate.optional().nullable(),
  internalNotes: zOptText(4000),
};

export const zVehicleCreate = z.object({
  ...vehicleCore,
  branchId: zUuid,
  odometerValue: z.coerce.number().int().min(0).max(3_000_000),
  odometerUnit: z.enum(['km', 'mi']).default('km'),
  initialStatus: z.enum(['incoming', 'awaiting_inspection', 'in_preparation']).default('incoming'),
  featureIds: z.array(zUuid).max(200).default([]),
});
export type VehicleCreateInput = z.infer<typeof zVehicleCreate>;

export const zVehicleUpdate = patchOf(z.object(vehicleCore)).extend({ version: z.number().int().min(1) });
export type VehicleUpdateInput = z.infer<typeof zVehicleUpdate>;

export const zVehicleStatusChange = z.object({
  to: z.enum(VEHICLE_STATUSES),
  reason: zOptText(500),
});

export const zVehiclePricing = z
  .object({
    askingPrice: zMoneyNonNeg.nullable(),
    minPrice: zMoneyNonNeg.nullable(),
    targetMarginPct: zPercent.nullable().optional(),
    reason: zOptText(300),
  })
  .refine((v) => !v.askingPrice || !v.minPrice || Number(v.minPrice) <= Number(v.askingPrice), {
    path: ['minPrice'],
    message: 'min_price_above_asking',
  });

export const zOdometerReading = z.object({
  value: z.coerce.number().int().min(0).max(3_000_000),
  unit: z.enum(['km', 'mi']),
  source: z.enum(ODOMETER_SOURCES).default('manual'),
  notes: zOptText(300),
});

export const zVehicleFeatures = z.object({ featureIds: z.array(zUuid).max(200) });

const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)))
    .pipe(z.array(item).optional());

export const zVehicleListQuery = zPaginationQuery.extend({
  status: csv(z.enum(VEHICLE_STATUSES)),
  branchId: zUuid.optional(),
  makeId: zUuid.optional(),
  modelId: zUuid.optional(),
  yearFrom: z.coerce.number().int().optional(),
  yearTo: z.coerce.number().int().optional(),
  priceFrom: zMoneyNonNeg.optional(),
  priceTo: zMoneyNonNeg.optional(),
  fuelType: z.enum(FUEL_TYPES).optional(),
  transmission: z.enum(TRANSMISSIONS).optional(),
  bodyType: z.enum(BODY_TYPES).optional(),
  condition: z.enum(CONDITIONS).optional(),
  featureIds: csv(zUuid),
  stale: z.enum(['warning', 'critical']).optional(),
  scope: z.enum(['stock', 'sold', 'all']).default('stock'),
});
export type VehicleListQuery = z.infer<typeof zVehicleListQuery>;

export const zMakeInput = z.object({ nameEn: zText(60).min(1), nameAr: zText(60).min(1) });
export const zModelInput = z.object({ makeId: zUuid, nameEn: zText(60).min(1), nameAr: zText(60).min(1), bodyType: z.enum(BODY_TYPES).optional().nullable() });
export const zFeatureInput = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,40}$/),
  nameEn: zText(80).min(1),
  nameAr: zText(80).min(1),
  category: z.enum(FEATURE_CATEGORIES),
});

export const zDocumentInput = z.object({
  docType: z.enum(DOC_TYPES),
  docNumber: zOptText(80),
  issuedAt: zIsoDate.optional().nullable().or(z.literal('').transform(() => null)),
  expiresAt: zIsoDate.optional().nullable().or(z.literal('').transform(() => null)),
  isSensitive: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).default(false),
  notes: zOptText(500),
});

export const zMediaUpdate = z.object({
  caption: zOptText(200),
  isPublic: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
  category: z.enum(MEDIA_CATEGORIES).optional(),
});
export const zMediaOrder = z.object({ mediaIds: z.array(zUuid).min(1).max(200) });

const zTemplateItem = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  en: zText(120).min(1),
  ar: zText(120).min(1),
  unit: z.string().max(10).optional(),
  required: z.boolean().default(true),
});
export const zTemplateSections = z
  .array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), en: zText(80).min(1), ar: zText(80).min(1), items: z.array(zTemplateItem).min(1).max(60) }))
  .min(1)
  .max(30);
export type TemplateSections = z.infer<typeof zTemplateSections>;
export const zTemplateInput = z.object({
  name: zText(120).min(2),
  vehicleCategory: z.string().max(40).default('all'),
  sections: zTemplateSections,
  isDefault: z.boolean().default(false),
});

export const zInspectionStart = z.object({ templateId: zUuid.optional(), type: z.enum(INSPECTION_TYPES).default('acquisition') });

export const zInspectionSave = z.object({
  odometerValue: z.coerce.number().int().min(0).max(3_000_000).optional().nullable(),
  odometerUnit: z.enum(['km', 'mi']).optional().nullable(),
  overallResult: z.enum(['pass', 'pass_with_notes', 'fail']).optional().nullable(),
  summary: zOptText(4000),
  recommendations: zOptText(4000),
  accidentHistory: zOptText(2000),
  items: z
    .array(
      z.object({
        sectionKey: z.string().max(40),
        itemKey: z.string().max(40),
        result: z.enum(INSPECTION_RESULTS),
        severity: z.enum(SEVERITIES).default('none'),
        measuredValue: z.string().regex(/^-?\d{1,9}(\.\d{1,3})?$/).optional().nullable(),
        measuredUnit: z.string().max(10).optional().nullable(),
        measuredText: zOptText(120),
        isMeasured: z.boolean().default(false),
        notes: zOptText(1000),
      }),
    )
    .max(500)
    .default([]),
  panels: z
    .array(
      z.object({
        panelCode: z.enum(PANEL_CODES),
        condition: z.enum(PANEL_CONDITIONS),
        paintThicknessMicrons: z.coerce.number().int().min(0).max(5000).optional().nullable(),
        notes: zOptText(500),
      }),
    )
    .max(PANEL_CODES.length)
    .default([]),
});
export type InspectionSaveInput = z.infer<typeof zInspectionSave>;

export const zTransferCreate = z.object({ toBranchId: zUuid, notes: zOptText(500) });
export const zReason = z.object({ reason: zText(500).min(3) });
export const zStockCountCreate = z.object({ branchId: zUuid, notes: zOptText(500) });
export const zStockCountScan = z.object({ code: zText(40).min(3), location: zOptText(80), notes: zOptText(300) });
export const zStockCountReconcile = z.object({
  lines: z
    .array(
      z.object({
        lineId: zUuid,
        resolution: z.enum(['confirmed', 'location_updated', 'investigate', 'written_off', 'unexpected_noted']),
        notes: zOptText(500),
      }),
    )
    .max(2000),
});
