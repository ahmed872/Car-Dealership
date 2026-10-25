import { z } from 'zod';
import { FUTURE_INTEREST_POLICIES, INSTALLMENT_METHODS } from '../finance/installments';
import { patchOf, zIsoDate, zMoneyNonNeg, zMoneyPos, zOptText, zPaginationQuery, zRate, zText, zUuid } from './common';
import { PAYMENT_METHODS } from './purchasing';
import { zVehicleCreate } from './vehicles';

export const SALE_STATUSES = ['draft', 'pending_approval', 'approved', 'confirmed', 'delivered', 'cancelled', 'returned'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];
export const SALE_PAYMENT_TYPES = ['cash', 'installments', 'external_finance'] as const;
export type SalePaymentType = (typeof SALE_PAYMENT_TYPES)[number];
export const SALE_DOCUMENT_TYPES = ['contract', 'invoice', 'delivery_note', 'credit_note'] as const;
export type SaleDocumentType = (typeof SALE_DOCUMENT_TYPES)[number];
export const COMMISSION_STATUSES = ['expected', 'earned', 'approved', 'paid', 'reversed', 'clawback'] as const;

const zRatePctString = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'invalid_percent');

/** The trade-in vehicle (branch comes from the sale; it enters stock as "incoming"). */
export const zTradeInVehicle = zVehicleCreate.omit({ branchId: true, initialStatus: true, featureIds: true });
export const zTradeInInput = z.object({
  agreedValue: zMoneyPos,
  vehicle: zTradeInVehicle,
  notes: zOptText(500),
});
export type TradeInInput = z.infer<typeof zTradeInInput>;

export const zInstallmentTerms = z.object({
  method: z.enum(INSTALLMENT_METHODS),
  annualRatePct: zRatePctString,
  count: z.number().int().min(1).max(360),
  frequencyMonths: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(6), z.literal(12)]),
  firstDueDate: zIsoDate,
  feesTotal: zMoneyNonNeg.optional(),
});
export type InstallmentTermsInput = z.infer<typeof zInstallmentTerms>;

export const zExternalFinanceInput = z.object({
  provider: zText(120).min(2),
  reference: zOptText(80),
  /** Amount the finance provider will pay the dealer. */
  amount: zMoneyPos,
});

const zSaleFields = z.object({
  vehicleId: zUuid,
  customerId: zUuid,
  leadId: zUuid.optional().nullable(),
  /** Defaults to the creator; selling on behalf of someone else needs leads.assign. */
  salespersonId: zUuid.optional(),
  paymentType: z.enum(SALE_PAYMENT_TYPES).default('cash'),
  /** Agreed price of the vehicle, tax-inclusive or not per the company's tax settings. */
  agreedPrice: zMoneyPos,
  saleDate: zIsoDate.optional(),
  /** Installment sales: what the customer pays before delivery (cash + trade-in + deposit). */
  downPayment: zMoneyNonNeg.optional().nullable(),
  installmentTerms: zInstallmentTerms.optional().nullable(),
  externalFinance: zExternalFinanceInput.optional().nullable(),
  tradeIns: z.array(zTradeInInput).max(3).default([]),
  notes: zOptText(2000),
});

function paymentTermsConsistent(
  v: { paymentType?: SalePaymentType; downPayment?: string | null; installmentTerms?: unknown; externalFinance?: unknown },
  ctx: z.RefinementCtx,
) {
  if (v.paymentType === 'installments') {
    if (v.downPayment == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['downPayment'], message: 'required_for_installments' });
    if (!v.installmentTerms) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['installmentTerms'], message: 'required_for_installments' });
  } else if (v.paymentType !== undefined && v.installmentTerms) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['installmentTerms'], message: 'only_for_installments' });
  }
  if (v.paymentType === 'external_finance' && !v.externalFinance) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['externalFinance'], message: 'required_for_external_finance' });
  }
}

export const zSaleCreate = zSaleFields.superRefine(paymentTermsConsistent);
export type SaleCreateInput = z.infer<typeof zSaleCreate>;

/** Price/tax/schedule preview without saving (same fields as create). */
export const zSalePreview = zSaleFields.omit({ tradeIns: true }).extend({ tradeInTotal: zMoneyNonNeg.optional() }).superRefine(paymentTermsConsistent);
export type SalePreviewInput = z.infer<typeof zSalePreview>;

/** Draft edits (vehicle and customer are fixed; cancel and start again instead). Resets price approval. */
export const zSaleUpdate = patchOf(zSaleFields.omit({ vehicleId: true, customerId: true, tradeIns: true }))
  .extend({ version: z.number().int().min(1) })
  .superRefine(paymentTermsConsistent);
export type SaleUpdateInput = z.infer<typeof zSaleUpdate>;

export const zSaleVersion = z.object({ version: z.number().int().min(1) });
/** Price decisions name the sale version the approver saw (the inbox reads it from the approval payload, D-054). */
export const zSaleDecision = z.object({ note: zOptText(500), version: z.number().int().min(1) });
export const zSaleReject = z.object({ reason: zText(500).min(3), version: z.number().int().min(1) });
export const zSaleDeliver = z.object({
  version: z.number().int().min(1),
  /** Delivering with an unpaid balance needs sales.deliver_with_balance and a reason (B-012). */
  overrideReason: zText(500).min(5).optional(),
  odometer: z.number().int().min(0).max(3_000_000).optional(),
});
export const zSaleCancel = z.object({ reason: zText(500).min(3), version: z.number().int().min(1) });
export const zSaleReturn = zSaleCancel;
export const zExternalFinanceDecision = z.object({
  status: z.enum(['approved', 'rejected']),
  reference: zOptText(80),
  note: zOptText(500),
});
export const zSaleListQuery = zPaginationQuery.extend({
  status: z.enum(SALE_STATUSES).optional(),
  customerId: zUuid.optional(),
  vehicleId: zUuid.optional(),
  salespersonId: zUuid.optional(),
  branchId: zUuid.optional(),
  paymentType: z.enum(SALE_PAYMENT_TYPES).optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  mine: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
});
export type SaleListQuery = z.infer<typeof zSaleListQuery>;

export const zIssueDocument = z.object({
  type: z.enum(['contract', 'invoice', 'delivery_note']),
  locale: z.enum(['ar', 'en']).optional(),
});
export const zVoidDocument = z.object({ reason: zText(500).min(3) });

export const zEarlySettlement = z.object({
  cashAccountId: zUuid,
  method: z.enum(PAYMENT_METHODS),
  exchangeRate: zRate.optional(),
  reference: zOptText(80),
  paidAt: zIsoDate.optional(),
  /** Override of the company's future-interest policy for this settlement (needs installments.settle). */
  futureInterestPolicy: z.enum(FUTURE_INTEREST_POLICIES).optional(),
  /** The quote total the cashier saw; refused if the amount changed since (409). */
  expectedTotal: zMoneyPos,
});
export const zSettlementQuoteQuery = z.object({ asOf: zIsoDate.optional(), futureInterestPolicy: z.enum(FUTURE_INTEREST_POLICIES).optional() });
export const zInstallmentListQuery = zPaginationQuery.extend({
  status: z.enum(['scheduled', 'active', 'settled', 'completed', 'cancelled']).optional(),
  customerId: zUuid.optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

export const zCommissionListQuery = zPaginationQuery.extend({
  status: z.enum(COMMISSION_STATUSES).optional(),
  userId: zUuid.optional(),
  saleId: zUuid.optional(),
  mine: z.enum(['true', 'false']).optional(),
});
export const zCommissionPay = z.object({
  cashAccountId: zUuid,
  method: z.enum(PAYMENT_METHODS),
  reference: zOptText(80),
  paidAt: zIsoDate.optional(),
});

export const zCashClosing = z.object({
  businessDate: zIsoDate,
  /** Physically counted balance in the account's currency. */
  countedBalance: zMoneyNonNeg,
  notes: zOptText(500),
});
export const zCashReopen = z.object({ reason: zText(500).min(5) });
