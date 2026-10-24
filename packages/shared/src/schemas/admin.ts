import { z } from 'zod';
import { ALL_PERMISSIONS, Permission } from '../permissions';
import { MARKETS, MarketCode } from '../markets';
import { DEFAULT_FX_MAX_DEVIATION_PCT, zLocale, zMarket, zOptText, zPercent100, zPhone, zText, zUuid, TenantSettings } from './common';

export const PASSWORD_MIN_LENGTH = 10;
export const zPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, 'password_too_short')
  .max(128)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'password_needs_letter_and_digit');

export const zEmail = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

export const zLogin = z.object({
  email: zEmail,
  password: z.string().min(1).max(128),
  tenantSlug: z.string().trim().max(60).optional(),
});
export type LoginInput = z.infer<typeof zLogin>;

export const zChangePassword = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: zPassword,
});

export const zSwitchTenant = z.object({ tenantId: zUuid });

export const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, 'invalid_slug');

export const zProvisionTenant = z.object({
  name: zText(200).min(2),
  slug: zSlug,
  market: zMarket,
  locale: zLocale.optional(),
  branchName: zText(120).min(2),
  owner: z.object({
    email: zEmail,
    fullName: zText(120).min(2),
    password: zPassword,
  }),
  planCode: z.string().max(40).optional(),
});
export type ProvisionTenantInput = z.infer<typeof zProvisionTenant>;

export const zBranchInput = z.object({
  name: zText(120).min(2),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{1,12}$/),
  city: zOptText(80),
  address: zOptText(300),
  phone: zOptText(30),
  timezone: zOptText(64),
  isActive: z.boolean().default(true),
});

export const zRoleInput = z.object({
  name: zText(80).min(2),
  description: zOptText(300),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(ALL_PERMISSIONS.length),
  maxDiscountPct: zPercent100.default('0'),
});

export const zCreateUser = z.object({
  email: zEmail,
  fullName: zText(120).min(2),
  phone: zPhone.optional().nullable(),
  password: zPassword,
  roleId: zUuid,
  allBranches: z.boolean().default(false),
  branchIds: z.array(zUuid).max(100).default([]),
});

export const zUpdateMembership = z.object({
  roleId: zUuid.optional(),
  allBranches: z.boolean().optional(),
  branchIds: z.array(zUuid).max(100).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  fullName: zText(120).min(2).optional(),
  phone: zPhone.optional().nullable(),
});

export const zResetPassword = z.object({ newPassword: zPassword });

/**
 * Permissions that define who can be given a kind of work, for the staff pickers
 * (GET /members/assignable). Each matches the rule the API applies when the work is assigned:
 * customers.read — customer owner; leads.read — lead assignee; appointments.manage — appointment
 * assignee; sales.create — salesperson; work_orders.manage — work-order assignee.
 */
export const ASSIGNABLE_PERMISSIONS = ['customers.read', 'leads.read', 'appointments.manage', 'sales.create', 'work_orders.manage'] as const satisfies readonly Permission[];
export type AssignablePermission = (typeof ASSIGNABLE_PERMISSIONS)[number];
export const zAssignableMembersQuery = z.object({
  permission: z.enum(ASSIGNABLE_PERMISSIONS),
  branchId: zUuid.optional(),
});

export function defaultTenantSettings(market: MarketCode, locale?: 'ar' | 'en'): TenantSettings {
  const m = MARKETS[market];
  return {
    locale: locale ?? m.defaultLocale,
    timezone: m.timezone,
    rounding: 'half_up',
    tax: {
      mode: m.taxDefaults.mode,
      ratePct: m.taxDefaults.ratePct,
      pricesIncludeTax: m.taxDefaults.pricesIncludeTax,
      labelEn: m.taxDefaults.labelEn,
      labelAr: m.taxDefaults.labelAr,
      taxNumber: null,
    },
    revenueRecognition: 'on_delivery',
    reservation: { defaultDays: 7, defaultRefundPolicy: 'refundable', defaultRefundablePct: '100' },
    inventory: { staleDaysWarning: 60, staleDaysCritical: 90, requireInspectionBeforeListing: true },
    installments: {
      enabled: false,
      defaultMethod: 'flat',
      allocationOrder: ['fees', 'interest', 'principal'],
      futureInterestPolicyFlat: 'charge_all',
      futureInterestPolicyReducing: 'charge_current_period',
      lateFeePolicy: 'none',
      reminderDaysBefore: 3,
    },
    documents: {
      legalNameEn: null,
      legalNameAr: null,
      commercialRegistration: null,
      addressEn: null,
      addressAr: null,
      phone: null,
      email: null,
      logoFileId: null,
      defaultLocale: locale ?? m.defaultLocale,
      contractTermsAr: null,
      contractTermsEn: null,
      invoiceFooterAr: null,
      invoiceFooterEn: null,
    },
    showroom: {
      enabled: false,
      showReserved: false,
      showPrices: true,
      acknowledgeInquiries: false,
      whatsappNumber: null,
      headlineAr: null,
      headlineEn: null,
    },
    statusLabels: {},
    // No reference rates: foreign-currency amounts are refused until an administrator sets them.
    fx: { referenceRates: {}, maxDeviationPct: DEFAULT_FX_MAX_DEVIATION_PCT },
  };
}
