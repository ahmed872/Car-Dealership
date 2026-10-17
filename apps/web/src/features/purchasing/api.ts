import type {
  ACQUISITION_SOURCES,
  ACQUISITION_STATUSES,
  OpenPayable,
  OWNERSHIP_TRANSFER_STATUSES,
  PAYMENT_METHODS,
  PayablesSummary,
  Permission,
  SUPPLIER_TYPES,
  SupplierDuplicate,
  SupplierFinancialSummary,
  SupplierStatement,
} from '@autohub/shared';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

// Response shapes mirror apps/api/src/modules/{purchasing,finance}/* exactly (amounts are strings).

export type SupplierType = (typeof SUPPLIER_TYPES)[number];
export type AcquisitionStatus = (typeof ACQUISITION_STATUSES)[number];
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];
export type OwnershipTransferStatus = (typeof OWNERSHIP_TRANSFER_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PayableTargetType = 'acquisition' | 'vehicle_cost' | 'expense';
export type SupplierPaymentStatus = 'posted' | 'voided';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** A row of the `suppliers` table (GET /suppliers items, POST/PATCH /suppliers responses). */
export interface Supplier {
  id: string;
  type: SupplierType;
  name: string;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
  nationalId: string | null;
  address: string | null;
  city: string | null;
  notes: string | null;
  customerId: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /suppliers/:id — `summary` is null unless the caller holds payments.read. */
export interface SupplierDetail extends Supplier {
  summary: SupplierFinancialSummary | null;
}

export type { OpenPayable, PayablesSummary, SupplierDuplicate, SupplierStatement };

/** GET /acquisitions items. */
export interface AcquisitionListItem {
  id: string;
  number: string;
  status: AcquisitionStatus;
  purchaseDate: string;
  purchasePrice: string;
  currency: string;
  purchasePriceBase: string;
  dueDate: string | null;
  sourceType: AcquisitionSource;
  ownershipTransferStatus: OwnershipTransferStatus;
  branchId: string;
  branchName: string;
  supplierId: string;
  supplierName: string;
  vehicleId: string;
  stockNumber: string;
  vin: string | null;
  vehicleStatus: string;
  modelYear: number;
  makeEn: string;
  makeAr: string;
  modelEn: string;
  modelAr: string;
  paidBase: string;
  /** Only for approved purchases (null otherwise). */
  outstandingBase: string | null;
}

/** A row of the `acquisitions` table (PATCH / submit / reject / cancel / ownership responses). */
export interface Acquisition {
  id: string;
  number: string;
  branchId: string;
  supplierId: string;
  vehicleId: string;
  sourceType: AcquisitionSource;
  purchaseDate: string;
  purchasePrice: string;
  currency: string;
  exchangeRate: string;
  purchasePriceBase: string;
  paymentMethod: PaymentMethod | null;
  dueDate: string | null;
  ownershipTransferStatus: OwnershipTransferStatus;
  status: AcquisitionStatus;
  notes: string | null;
  tradeInId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Payments allocated to a document (SupplierPaymentsService.forTargets). */
export interface DocumentPayment {
  paymentId: string;
  number: string;
  paidAt: string;
  status: SupplierPaymentStatus;
  method: PaymentMethod;
  targetId: string;
  /** Carrying base amount relieved from the document. */
  amountBase: string;
}

/** GET /acquisitions/:id */
export interface AcquisitionDetail extends Acquisition {
  /** Contact/identity fields are null when the caller lacks suppliers.read. */
  supplier: Supplier | undefined;
  vehicle:
    | {
        id: string;
        stockNumber: string;
        vin: string | null;
        status: string;
        modelYear: number;
        makeEn: string;
        makeAr: string;
        modelEn: string;
        modelAr: string;
      }
    | undefined;
  paidBase: string;
  outstandingBase: string;
  payments: DocumentPayment[];
}

/** POST /acquisitions */
export interface AcquisitionCreated extends Acquisition {
  vehicle: { id: string; stockNumber: string; warnings: string[] };
}

/** GET /cash-accounts/options */
export interface CashAccountOption {
  id: string;
  type: 'cashbox' | 'bank';
  name: string;
  currency: string;
  branchId: string | null;
}

/** GET /approvals items. */
export interface ApprovalItem {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  summary: string;
  requestedAt: string;
  requestedBy: string | null;
  requestedById: string | null;
  branchId: string | null;
  canDecide: boolean;
}

/** GET /supplier-payments items. */
export interface SupplierPaymentListItem {
  id: string;
  number: string;
  supplierId: string | null;
  supplierName: string | null;
  cashAccountId: string;
  cashAccountName: string;
  amount: string;
  currency: string;
  amountBase: string;
  paidAt: string;
  method: PaymentMethod;
  reference: string | null;
  status: SupplierPaymentStatus;
  voidReason: string | null;
}

/** A row of `supplier_payment_allocations` (GET /supplier-payments/:id). */
export interface SupplierPaymentAllocation {
  id: string;
  paymentId: string;
  targetType: PayableTargetType;
  targetId: string;
  /** Base carrying amount relieved from the document. */
  amountBase: string;
  /** This allocation's share of the payment at the payment's rate. */
  paymentBase: string;
  amountDoc: string | null;
}

/** GET /supplier-payments/:id and POST /supplier-payments/:id/void (without allocations). */
export interface SupplierPayment {
  id: string;
  number: string;
  supplierId: string | null;
  cashAccountId: string;
  amount: string;
  currency: string;
  exchangeRate: string;
  amountBase: string;
  paidAt: string;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  status: SupplierPaymentStatus;
  voidedAt: string | null;
  voidReason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SupplierPaymentDetail extends SupplierPayment {
  allocations: SupplierPaymentAllocation[];
}

/** POST /supplier-payments */
export interface SupplierPaymentCreated extends SupplierPayment {
  allocations: Array<{ targetType: PayableTargetType; targetId: string; amountBase: string; settledBase: string; amountDoc: string; currency: string }>;
}

/** POST /acquisitions/:id/approve */
export interface AcquisitionApproved extends Acquisition {
  payment: SupplierPaymentCreated | null;
}

/** GET /payables/open */
export interface OpenPayablesResponse {
  currency: string;
  items: OpenPayable[];
  totals: { totalBase: string; paidBase: string; outstandingBase: string };
}

/** GET /audit-logs items (subset used here). */
export interface AuditEntry {
  id: string;
  action: string;
  summary: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  actorUserId: string | null;
  actorName: string | null;
}

/** GET /vehicle-costs/:id (row subset). */
interface VehicleCostRow {
  id: string;
  vehicleId: string;
  description: string;
  amount: string;
  currency: string;
  exchangeRate: string;
  amountBase: string;
  status: string;
}

/** GET /expenses/:id (subset). */
interface ExpenseRow {
  id: string;
  number: string;
  description: string;
  amount: string;
  currency: string;
  exchangeRate: string;
  amountBase: string;
  status: string;
}

// ── Hooks ────────────────────────────────────────────────────────────────────────────────

export const useSupplier = (id: string | null | undefined) =>
  useApi<SupplierDetail>(['supplier', id], id ? `/suppliers/${id}` : null);

export const useAcquisition = (id: string | undefined) =>
  useApi<AcquisitionDetail>(['acquisition', id], id ? `/acquisitions/${id}` : null);

export const useSupplierPayment = (id: string | undefined) =>
  useApi<SupplierPaymentDetail>(['supplier-payment', id], id ? `/supplier-payments/${id}` : null);

export const useCashAccountOptions = () =>
  useApi<CashAccountOption[]>(['cash-accounts', 'options'], '/cash-accounts/options', undefined, { staleTime: 60_000 });

export const useApprovals = (enabled: boolean) => useApi<ApprovalItem[]>(['approvals'], enabled ? '/approvals' : null);

/** Every query that shows payable/paid figures; invalidated after any money movement. */
export const PAYABLE_KEYS: unknown[][] = [
  ['acquisitions'],
  ['acquisition'],
  ['supplier'],
  ['supplier-statement'],
  ['supplier-acquisitions'],
  ['payables-open'],
  ['payables-summary'],
  ['supplier-payments'],
  ['supplier-payment'],
  ['approvals'],
  ['cash-accounts'],
  ['expense'],
  ['vehicle-cost'],
];

/**
 * Accounts-payable access as the API enforces it: GET /payables/open needs supplier_payments.create
 * or suppliers.read + payments.read; summaries, statements and payment history need the latter.
 */
export function useApAccess() {
  const { can } = useAuth();
  const read = can('suppliers.read', 'payments.read');
  const pay = can('supplier_payments.create');
  return { read, pay, open: read || pay };
}

/** Document currency and amounts of a payable document (when the caller may read it). */
export interface DocInfo {
  currency: string;
  totalDoc: string;
  totalBase: string;
  label: string;
}

const DOC_READ_PERM: Record<PayableTargetType, Permission> = {
  acquisition: 'acquisitions.read',
  vehicle_cost: 'costs.read',
  expense: 'expenses.read',
};

/**
 * Looks up a payable document's own currency. GET /payables/open only carries base amounts, so the
 * payment form reads the document itself (needs the document module's read permission).
 */
export function useDocInfo(targetType: PayableTargetType, targetId: string, enabled = true) {
  const { can } = useAuth();
  const allowed = enabled && can(DOC_READ_PERM[targetType]);
  const acq = useApi<AcquisitionDetail>(['acquisition', targetId], allowed && targetType === 'acquisition' ? `/acquisitions/${targetId}` : null, undefined, {
    staleTime: 30_000,
  });
  const cost = useApi<VehicleCostRow>(['vehicle-cost', targetId], allowed && targetType === 'vehicle_cost' ? `/vehicle-costs/${targetId}` : null, undefined, {
    staleTime: 30_000,
  });
  const exp = useApi<ExpenseRow>(['expense', targetId], allowed && targetType === 'expense' ? `/expenses/${targetId}` : null, undefined, {
    staleTime: 30_000,
  });
  let info: DocInfo | null = null;
  if (targetType === 'acquisition' && acq.data) {
    info = { currency: acq.data.currency, totalDoc: acq.data.purchasePrice, totalBase: acq.data.purchasePriceBase, label: acq.data.number };
  } else if (targetType === 'vehicle_cost' && cost.data) {
    info = { currency: cost.data.currency, totalDoc: cost.data.amount, totalBase: cost.data.amountBase, label: cost.data.description };
  } else if (targetType === 'expense' && exp.data) {
    info = { currency: exp.data.currency, totalDoc: exp.data.amount, totalBase: exp.data.amountBase, label: exp.data.number };
  }
  const q = targetType === 'acquisition' ? acq : targetType === 'vehicle_cost' ? cost : exp;
  return { info, allowed, loading: allowed && q.isLoading, error: q.error };
}
