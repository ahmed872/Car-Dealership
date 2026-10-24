import { z } from 'zod';
import { zIsoDate, zMoneyNonNeg, zMoneyPos, zOptText, zPaginationQuery, zPercent100, zRate, zText, zUuid } from './common';
import { PAYMENT_METHODS } from './purchasing';

export const CUSTOMER_TYPES = ['individual', 'company'] as const;
export const LEAD_SOURCES = ['walk_in', 'phone', 'whatsapp', 'website', 'showroom', 'referral', 'social', 'marketplace', 'campaign', 'other'] as const;
export const LEAD_STATUSES = ['open', 'won', 'lost'] as const;
export const LOST_REASONS = ['price', 'bought_elsewhere', 'financing_rejected', 'no_response', 'vehicle_sold', 'changed_mind', 'not_qualified', 'other'] as const;
export const INTERACTION_TYPES = ['call', 'whatsapp', 'sms', 'email', 'visit', 'meeting', 'note', 'test_drive', 'quote'] as const;
export const WISH_STATUSES = ['active', 'fulfilled', 'cancelled', 'expired'] as const;
export const APPOINTMENT_TYPES = ['visit', 'test_drive', 'follow_up', 'delivery', 'inspection', 'other'] as const;
export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'in_progress', 'completed', 'no_show', 'cancelled'] as const;
export const RESERVATION_STATUSES = ['active', 'converted', 'expired', 'cancelled'] as const;
export const REFUND_STATUSES = ['requested', 'approved', 'paid', 'rejected', 'cancelled'] as const;
export const PAYMENT_PREFERENCES = ['cash', 'bank_finance', 'installments', 'trade_in', 'undecided'] as const;

/** Phone: digits, optional leading +, Arabic-Indic digits accepted (normalised server-side). */
const zPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9٠-٩۰-۹\s()-]{6,30}$/, 'invalid_phone');

export const zCustomerInput = z.object({
  type: z.enum(CUSTOMER_TYPES).default('individual'),
  fullName: zText(200).min(2),
  companyName: zOptText(200),
  phone: zPhone.optional().nullable(),
  phoneAlt: zPhone.optional().nullable(),
  whatsapp: zPhone.optional().nullable(),
  email: z.string().trim().email().max(120).optional().nullable(),
  nationalId: zOptText(40),
  nationality: zOptText(60),
  commercialRegistration: zOptText(60),
  taxNumber: zOptText(40),
  city: zOptText(80),
  address: zOptText(300),
  dateOfBirth: zIsoDate.optional().nullable(),
  preferredLanguage: z.enum(['ar', 'en']).default('ar'),
  source: z.enum(LEAD_SOURCES).optional().nullable(),
  assignedUserId: zUuid.optional().nullable(),
  branchId: zUuid.optional().nullable(),
  marketingConsent: z.boolean().default(false),
  tags: z.array(zText(40)).max(20).default([]),
  notes: zOptText(4000),
});
export type CustomerInput = z.infer<typeof zCustomerInput>;
/** PATCH without defaults (zod .partial() keeps defaults). */
export const zCustomerUpdate = z.object({
  type: z.enum(CUSTOMER_TYPES).optional(),
  fullName: zText(200).min(2).optional(),
  companyName: zOptText(200),
  phone: zPhone.optional().nullable(),
  phoneAlt: zPhone.optional().nullable(),
  whatsapp: zPhone.optional().nullable(),
  email: z.string().trim().email().max(120).optional().nullable(),
  nationalId: zOptText(40),
  nationality: zOptText(60),
  commercialRegistration: zOptText(60),
  taxNumber: zOptText(40),
  city: zOptText(80),
  address: zOptText(300),
  dateOfBirth: zIsoDate.optional().nullable(),
  preferredLanguage: z.enum(['ar', 'en']).optional(),
  source: z.enum(LEAD_SOURCES).optional().nullable(),
  assignedUserId: zUuid.optional().nullable(),
  branchId: zUuid.optional().nullable(),
  marketingConsent: z.boolean().optional(),
  tags: z.array(zText(40)).max(20).optional(),
  notes: zOptText(4000),
  isActive: z.boolean().optional(),
  version: z.number().int().min(1),
});
export const zCustomerListQuery = zPaginationQuery.extend({
  type: z.enum(CUSTOMER_TYPES).optional(),
  assignedUserId: zUuid.optional(),
  mine: z.enum(['true', 'false']).optional(),
  tag: z.string().max(40).optional(),
});

export const zLeadCreate = z.object({
  customerId: zUuid,
  branchId: zUuid,
  source: z.enum(LEAD_SOURCES),
  stageId: zUuid.optional(),
  assignedUserId: zUuid.optional().nullable(),
  vehicleId: zUuid.optional().nullable(),
  interestNotes: zOptText(2000),
  budgetMin: zMoneyNonNeg.optional().nullable(),
  budgetMax: zMoneyNonNeg.optional().nullable(),
  paymentPreference: z.enum(PAYMENT_PREFERENCES).optional().nullable(),
  expectedCloseDate: zIsoDate.optional().nullable(),
  nextFollowUpAt: z.string().datetime({ offset: true }).optional().nullable(),
});
export const zLeadUpdate = z.object({
  assignedUserId: zUuid.optional().nullable(),
  vehicleId: zUuid.optional().nullable(),
  interestNotes: zOptText(2000),
  budgetMin: zMoneyNonNeg.optional().nullable(),
  budgetMax: zMoneyNonNeg.optional().nullable(),
  paymentPreference: z.enum(PAYMENT_PREFERENCES).optional().nullable(),
  expectedCloseDate: zIsoDate.optional().nullable(),
  nextFollowUpAt: z.string().datetime({ offset: true }).optional().nullable(),
  version: z.number().int().min(1),
});
export const zLeadStageChange = z.object({ stageId: zUuid, note: zOptText(500), version: z.number().int().min(1) });
export const zLeadLost = z.object({ reason: z.enum(LOST_REASONS), notes: zOptText(1000), version: z.number().int().min(1) });
export const zLeadListQuery = zPaginationQuery.extend({
  status: z.enum(LEAD_STATUSES).optional(),
  stageId: zUuid.optional(),
  assignedUserId: zUuid.optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  branchId: zUuid.optional(),
  mine: z.enum(['true', 'false']).optional(),
  followUpDue: z.enum(['true', 'false']).optional(),
});

export const zInteractionCreate = z.object({
  customerId: zUuid,
  leadId: zUuid.optional().nullable(),
  vehicleId: zUuid.optional().nullable(),
  type: z.enum(INTERACTION_TYPES),
  direction: z.enum(['inbound', 'outbound']).optional().nullable(),
  summary: zText(2000).min(2),
  outcome: zOptText(500),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  nextFollowUpAt: z.string().datetime({ offset: true }).optional().nullable(),
});

export const zWishInput = z.object({
  customerId: zUuid,
  leadId: zUuid.optional().nullable(),
  makeId: zUuid.optional().nullable(),
  modelId: zUuid.optional().nullable(),
  yearFrom: z.number().int().min(1950).max(2100).optional().nullable(),
  yearTo: z.number().int().min(1950).max(2100).optional().nullable(),
  maxPrice: zMoneyPos.optional().nullable(),
  maxOdometerKm: z.number().int().min(0).max(2_000_000).optional().nullable(),
  bodyType: zOptText(30),
  fuelType: zOptText(30),
  transmission: zOptText(30),
  color: zOptText(40),
  notes: zOptText(1000),
  expiresAt: zIsoDate.optional().nullable(),
});

export const zAppointmentCreate = z.object({
  type: z.enum(APPOINTMENT_TYPES),
  branchId: zUuid,
  customerId: zUuid.optional().nullable(),
  leadId: zUuid.optional().nullable(),
  vehicleId: zUuid.optional().nullable(),
  assignedUserId: zUuid.optional().nullable(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  title: zOptText(200),
  notes: zOptText(2000),
  driverLicenseNumber: zOptText(40),
  driverLicenseExpiry: zIsoDate.optional().nullable(),
});
export const zAppointmentListQuery = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  branchId: zUuid.optional(),
  assignedUserId: zUuid.optional(),
  vehicleId: zUuid.optional(),
  customerId: zUuid.optional(),
  leadId: zUuid.optional(),
  type: z.enum(APPOINTMENT_TYPES).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  mine: z.enum(['true', 'false']).optional(),
});
export const zTestDriveStart = z.object({ odometerOut: z.number().int().min(0), driverLicenseNumber: zText(40).min(3), driverLicenseExpiry: zIsoDate });
export const zTestDriveFinish = z.object({ odometerIn: z.number().int().min(0), outcome: zOptText(1000) });

export const zDepositInput = z.object({
  cashAccountId: zUuid,
  amount: zMoneyPos,
  exchangeRate: zRate.optional(),
  method: z.enum(PAYMENT_METHODS),
  reference: zOptText(80),
  receivedAt: zIsoDate.optional(),
});
export const zReservationCreate = z.object({
  vehicleId: zUuid,
  customerId: zUuid,
  leadId: zUuid.optional().nullable(),
  days: z.number().int().min(1).max(90).optional(),
  agreedPrice: zMoneyPos.optional().nullable(),
  depositAmount: zMoneyNonNeg.default('0'),
  refundPolicy: z.enum(['refundable', 'non_refundable', 'partial']).optional(),
  refundablePct: zPercent100.optional(),
  notes: zOptText(1000),
  /** Deposit received now (optional; can be recorded later). */
  deposit: zDepositInput.optional().nullable(),
});
export const zReservationExtend = z.object({ days: z.number().int().min(1).max(90), reason: zText(500).min(3) });
export const zReservationCancel = z.object({ reason: zText(500).min(3), refund: z.enum(['per_policy', 'full', 'none']).default('per_policy') });
export const zReservationListQuery = zPaginationQuery.extend({
  status: z.enum(RESERVATION_STATUSES).optional(),
  customerId: zUuid.optional(),
  vehicleId: zUuid.optional(),
  branchId: zUuid.optional(),
  expiringWithinHours: z.coerce.number().int().min(1).max(720).optional(),
});

export const zRefundDecision = z.object({ note: zOptText(500) });
export const zRefundPay = z.object({ cashAccountId: zUuid, method: z.enum(PAYMENT_METHODS), reference: zOptText(80), paidAt: zIsoDate.optional() });

export const zEmployeeProfileInput = z.object({
  employeeCode: zOptText(30),
  jobTitle: zOptText(80),
  phone: zPhone.optional().nullable(),
  hireDate: zIsoDate.optional().nullable(),
  monthlyTargetUnits: z.number().int().min(0).max(10_000).optional().nullable(),
  monthlyTargetAmount: zMoneyNonNeg.optional().nullable(),
  commissionPolicyId: zUuid.optional().nullable(),
  notes: zOptText(1000),
});

export const RECEIPT_TARGET_TYPES = ['reservation', 'sale', 'installment', 'customer_credit'] as const;
export const zReceiptCreate = z.object({
  customerId: zUuid,
  cashAccountId: zUuid,
  /** Amount received, in the cash account's currency. */
  amount: zMoneyPos,
  exchangeRate: zRate.optional(),
  method: z.enum(PAYMENT_METHODS),
  reference: zOptText(80),
  notes: zOptText(500),
  receivedAt: zIsoDate.optional(),
  /** Base-currency split; omitted → the whole amount is held as customer credit (advance). */
  allocations: z
    .array(z.object({ targetType: z.enum(RECEIPT_TARGET_TYPES), targetId: zUuid, amountBase: zMoneyPos }))
    .max(50)
    .optional(),
});
export type ReceiptCreateInput = z.infer<typeof zReceiptCreate>;
export const zReceiptListQuery = zPaginationQuery.extend({
  customerId: zUuid.optional(),
  cashAccountId: zUuid.optional(),
  status: z.enum(['posted', 'voided']).optional(),
});

export const REFUND_SOURCE_TYPES = ['reservation', 'sale', 'customer_credit'] as const;
export const zRefundRequest = z.object({
  sourceType: z.enum(REFUND_SOURCE_TYPES),
  /** Reservation id, or the customer id for customer credit. */
  sourceId: zUuid,
  amountBase: zMoneyPos,
  reason: zText(500).min(3),
});
export const zRefundListQuery = zPaginationQuery.extend({
  status: z.enum(REFUND_STATUSES).optional(),
  customerId: zUuid.optional(),
  sourceType: z.enum(REFUND_SOURCE_TYPES).optional(),
  sourceId: zUuid.optional(),
});
