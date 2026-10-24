import { z } from 'zod';
import { ISO_DATE_REGEX } from '../finance/dates';
import { CURRENCY_CODES, d, MONEY_REGEX, PERCENT_REGEX, RATE_REGEX, ROUNDING_MODES } from '../money';
import { MARKET_CODES, TAX_MODES } from '../markets';
import { FUTURE_INTEREST_POLICIES, INSTALLMENT_METHODS } from '../finance/installments';
import { ALLOCATION_COMPONENTS } from '../finance/installments';

export const zUuid = z.uuid();
export const zMoney = z.string().trim().regex(MONEY_REGEX, 'invalid_amount');
export const zMoneyNonNeg = zMoney.refine((v) => !v.startsWith('-'), 'must_be_non_negative');
export const zMoneyPos = zMoney.refine(
  (v) => !v.startsWith('-') && !/^0+(\.0+)?$/.test(v),
  'must_be_positive',
);
export const zRate = z.string().trim().regex(RATE_REGEX, 'invalid_rate');
export const zPercent = z.string().trim().regex(PERCENT_REGEX, 'invalid_percent');
export const zIsoDate = z.string().regex(ISO_DATE_REGEX, 'invalid_date');
export const zDateTime = z.iso.datetime({ offset: true });
export const zCurrency = z.enum(CURRENCY_CODES);
export const zMarket = z.enum(MARKET_CODES);
export const zLocale = z.enum(['ar', 'en']);
export const zText = (max = 200) => z.string().trim().max(max);
export const zOptText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v));
export const zPhone = z.string().trim().min(6).max(25);

export const zPaginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z
    .string()
    .regex(/^-?[a-zA-Z_]{1,40}$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
});
export type PaginationQuery = z.infer<typeof zPaginationQuery>;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Foreign-currency fields shared by costs, expenses and acquisitions. */
export const zFxFields = z.object({
  currency: zCurrency,
  exchangeRate: zRate.optional(),
});

/** Default tolerance (percent) between a stated exchange rate and the company reference rate. */
export const DEFAULT_FX_MAX_DEVIATION_PCT = '2';

/**
 * Company reference exchange rates (base-currency units per one unit of the currency) and how far
 * a rate stated on a transaction may deviate from them. A foreign-currency amount can only be
 * recorded for a currency that has a reference rate. The base currency must not be a key (the
 * API refuses it: it knows the base currency, this schema does not).
 */
export const zFxSettings = z.object({
  referenceRates: z
    .partialRecord(
      zCurrency,
      zRate.refine((v) => d(v).gt(0), 'must_be_positive'),
    )
    .default({}),
  maxDeviationPct: zPercent
    .refine((v) => d(v).gte(0) && d(v).lte(100), 'must_be_between_0_and_100')
    .default(DEFAULT_FX_MAX_DEVIATION_PCT),
});
export type FxSettings = z.infer<typeof zFxSettings>;

export const zTenantSettings = z.object({
  locale: zLocale.default('ar'),
  timezone: z.string().min(3).max(64),
  rounding: z.enum(ROUNDING_MODES).default('half_up'),
  tax: z.object({
    mode: z.enum(TAX_MODES),
    ratePct: zPercent,
    pricesIncludeTax: z.boolean(),
    labelEn: zText(40),
    labelAr: zText(40),
    taxNumber: zOptText(40),
  }),
  revenueRecognition: z.enum(['on_delivery', 'on_confirmation']).default('on_delivery'),
  reservation: z.object({
    defaultDays: z.number().int().min(1).max(90).default(7),
    defaultRefundPolicy: z.enum(['refundable', 'non_refundable', 'partial']).default('refundable'),
    defaultRefundablePct: zPercent.default('100'),
  }),
  inventory: z.object({
    staleDaysWarning: z.number().int().min(1).max(3650).default(60),
    staleDaysCritical: z.number().int().min(1).max(3650).default(90),
    requireInspectionBeforeListing: z.boolean().default(true),
  }),
  installments: z.object({
    enabled: z.boolean().default(false),
    defaultMethod: z.enum(INSTALLMENT_METHODS).default('flat'),
    allocationOrder: z
      .array(z.enum(ALLOCATION_COMPONENTS))
      .length(3)
      .default(['fees', 'interest', 'principal']),
    futureInterestPolicyFlat: z.enum(FUTURE_INTEREST_POLICIES).default('charge_all'),
    futureInterestPolicyReducing: z.enum(FUTURE_INTEREST_POLICIES).default('charge_current_period'),
    lateFeePolicy: z.literal('none').default('none'),
    reminderDaysBefore: z.number().int().min(0).max(30).default(3),
  }),
  documents: z.object({
    legalNameEn: zOptText(200),
    legalNameAr: zOptText(200),
    commercialRegistration: zOptText(60),
    addressEn: zOptText(300),
    addressAr: zOptText(300),
    phone: zOptText(30),
    email: zOptText(120),
    logoFileId: zUuid.nullable().optional(),
    defaultLocale: zLocale.default('ar'),
    contractTermsAr: zOptText(10000),
    contractTermsEn: zOptText(10000),
    invoiceFooterAr: zOptText(1000),
    invoiceFooterEn: zOptText(1000),
  }),
  showroom: z.object({
    enabled: z.boolean().default(false),
    showReserved: z.boolean().default(false),
    showPrices: z.boolean().default(true),
    /** Send an automatic acknowledgement to the phone number an online inquiry gave (unverified). */
    acknowledgeInquiries: z.boolean().default(false),
    whatsappNumber: zOptText(20),
    headlineAr: zOptText(200),
    headlineEn: zOptText(200),
  }),
  statusLabels: z.record(z.string(), z.object({ ar: zText(40), en: zText(40) })).default({}),
  fx: zFxSettings.default({ referenceRates: {}, maxDeviationPct: DEFAULT_FX_MAX_DEVIATION_PCT }),
});
export type TenantSettings = z.infer<typeof zTenantSettings>;

type StripDefault<S> = S extends z.ZodDefault<infer I> ? I : S;

function stripDefault(f: z.ZodType): z.ZodType {
  let cur = f;
  while (cur._zod.def.type === 'default' || cur._zod.def.type === 'prefault') {
    cur = (cur._zod.def as unknown as { innerType: z.ZodType }).innerType;
  }
  return cur;
}

/**
 * PATCH schema from a create schema: every field optional, and an ABSENT field stays absent.
 * Zod 4's `.partial()` still applies field defaults (e.g. `isActive` → true, `priority` →
 * 'normal'), which silently overwrites stored values on edit. Here each field loses its default
 * before being made optional. Field transforms must map `undefined` to `undefined` (see `vin`).
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, f] of Object.entries(schema.shape)) shape[k] = stripDefault(f as z.ZodType).optional();
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<StripDefault<T[K]>> }>;
}

/**
 * PATCH schema for an object made of sections (company settings): `patchOf` at the top level AND
 * inside every nested object section, so `{ fx: { maxDeviationPct: '5' } }` parses to exactly
 * that and never re-applies the section's other defaults. The schema only makes fields optional;
 * PATCH /company merges the result one level deep, so a value inside a section
 * (`fx.referenceRates`, `installments.allocationOrder`) replaces the stored one whole.
 */
export function sectionPatchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, f] of Object.entries(schema.shape)) {
    const inner = stripDefault(f as z.ZodType);
    shape[k] = (inner instanceof z.ZodObject ? patchOf(inner) : inner).optional();
  }
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof T]: z.ZodOptional<z.ZodType<Partial<z.output<StripDefault<T[K]>>>>> }>;
}

/** Company settings PATCH body (`PATCH /company` → `settings`). */
export const zTenantSettingsPatch = sectionPatchOf(zTenantSettings);
export type TenantSettingsPatch = z.infer<typeof zTenantSettingsPatch>;
