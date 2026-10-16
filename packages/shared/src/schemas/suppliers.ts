import { z } from 'zod';
import { parseIsoDate } from '../finance/dates';
import { zIsoDate, zOptText, zPaginationQuery, zUuid } from './common';
import { SUPPLIER_TYPES, zSupplierInput } from './purchasing';

// Inputs and response shapes owned by the suppliers / accounts-payable module.

/** A real calendar date ("2026-02-30" is rejected), not just the YYYY-MM-DD shape. */
export const zCalendarDate = zIsoDate.refine((v) => {
  try {
    parseIsoDate(v);
    return true;
  } catch {
    return false;
  }
}, 'invalid_date');

/** Phone: digits (any script), spaces and + ( ) - . separators, at least 6 digits. */
const zSupplierPhone = zOptText(30).refine(
  (v) => v == null || (/^\+?[\p{Nd}\s().-]+$/u.test(v) && (v.match(/\p{Nd}/gu)?.length ?? 0) >= 6),
  'invalid_phone',
);
const zSupplierEmail = zOptText(120).refine((v) => v == null || z.email().safeParse(v).success, 'invalid_email');

export const zSupplierCreate = zSupplierInput.extend({ phone: zSupplierPhone, email: zSupplierEmail });
export type SupplierCreateInput = z.infer<typeof zSupplierCreate>;

/**
 * Partial update. `isActive` has NO default here: a partial of zSupplierInput would re-apply its
 * `default(true)` and silently reactivate a deactivated supplier on any edit.
 */
export const zSupplierUpdate = zSupplierCreate
  .omit({ isActive: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'empty_update' });
export type SupplierUpdateInput = z.infer<typeof zSupplierUpdate>;

export const zSupplierListQuery = zPaginationQuery.extend({
  type: z.enum(SUPPLIER_TYPES).optional(),
  active: z.enum(['true', 'false']).optional(),
});

export const zSupplierDuplicateQuery = z.object({
  phone: z.string().trim().max(30).optional(),
  taxNumber: z.string().trim().max(40).optional(),
  nationalId: z.string().trim().max(40).optional(),
  name: z.string().trim().max(200).optional(),
  /** Ignore this supplier (the one being edited). */
  excludeId: zUuid.optional(),
});
export type SupplierDuplicateQuery = z.infer<typeof zSupplierDuplicateQuery>;

export const zSupplierStatementQuery = z
  .object({ from: zCalendarDate.optional(), to: zCalendarDate.optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ['to'], message: 'to_before_from' });
export type SupplierStatementQuery = z.infer<typeof zSupplierStatementQuery>;

export const PAYABLE_TARGET_TYPES = ['acquisition', 'vehicle_cost', 'expense'] as const;
export type PayableTargetType = (typeof PAYABLE_TARGET_TYPES)[number];

export const zPayablesOpenQuery = z.object({
  /** A supplier id, or "none" for direct purchases (documents without a supplier). Omit for all. */
  supplierId: z.union([zUuid, z.literal('none')]).optional(),
  targetType: z.enum(PAYABLE_TARGET_TYPES).optional(),
});
export type PayablesOpenQuery = z.infer<typeof zPayablesOpenQuery>;

export const zPayablesSummaryQuery = z.object({ asOf: zCalendarDate.optional() });
export type PayablesSummaryQuery = z.infer<typeof zPayablesSummaryQuery>;

// ── Response shapes (amounts are base-currency decimal strings) ────────────────────────────

export interface SupplierDuplicate {
  id: string;
  name: string;
  type: string;
  phone: string | null;
  isActive: boolean;
  matchedOn: Array<'phone' | 'taxNumber' | 'nationalId' | 'name'>;
}

export interface SupplierFinancialSummary {
  currency: string;
  outstandingBase: string;
  /** Approved acquisitions + posted supplier costs + posted expenses. */
  totalPurchasedBase: string;
  /** Allocations of non-voided payments to those documents. */
  totalPaidBase: string;
  lastPaymentDate: string | null;
  openDocuments: number;
}

export interface SupplierStatementRow {
  date: string;
  entryId: string;
  entryNo: number;
  event: string;
  isReversal: boolean;
  sourceType: string;
  sourceId: string;
  /** The business document behind the entry (purchase costs resolve to their acquisition). */
  documentType: 'acquisition' | 'vehicle_cost' | 'expense' | 'supplier_payment' | null;
  documentId: string | null;
  documentNumber: string | null;
  vehicleStockNumber: string | null;
  label: string;
  description: string;
  debit: string;
  credit: string;
  /** Amount owed to the supplier after this line (credit-positive). */
  runningBalance: string;
}

export interface SupplierStatement {
  supplierId: string;
  supplierName: string;
  currency: string;
  account: '2000';
  /** Balances are "amount owed to the supplier": credit − debit on account 2000. */
  balanceSide: 'payable';
  from: string | null;
  to: string | null;
  openingBalance: string;
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  rows: SupplierStatementRow[];
}

export interface OpenPayable {
  targetType: PayableTargetType;
  targetId: string;
  supplierId: string | null;
  supplierName: string | null;
  branchId: string;
  number: string | null;
  label: string;
  description: string | null;
  docDate: string;
  dueDate: string | null;
  vehicleId: string | null;
  vehicleStockNumber: string | null;
  totalBase: string;
  paidBase: string;
  outstandingBase: string;
}

export const AGING_BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export type AgingBuckets = Record<AgingBucket, string>;

export interface PayablesAgingRow {
  /** null = direct purchases (documents recorded without a supplier). */
  supplierId: string | null;
  supplierName: string | null;
  isDirect: boolean;
  documents: number;
  outstandingBase: string;
  buckets: AgingBuckets;
}

export interface PayablesSummary {
  asOf: string;
  currency: string;
  /** 'all' = company-wide; 'branches' = limited to the caller's branches (no GL reconciliation). */
  scope: 'all' | 'branches';
  rows: PayablesAgingRow[];
  totals: { documents: number; outstandingBase: string; buckets: AgingBuckets };
  reconciliation: null | {
    subledgerTotal: string;
    /** Credit-positive balance of GL 2000 for entries dated on or before asOf. */
    glPayablesBalance: string;
    /** glPayablesBalance − subledgerTotal; must be 0.00. */
    difference: string;
    mismatches: Array<{ supplierId: string | null; supplierName: string | null; subledgerBase: string; glBase: string; difference: string }>;
  };
}
