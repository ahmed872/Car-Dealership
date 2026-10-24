import type {
  COMMISSION_STATUSES,
  FutureInterestPolicy,
  InstallmentMethod,
  PAYMENT_METHODS,
  SALE_DOCUMENT_TYPES,
  SalePaymentType,
  SaleStatus,
  Schedule,
} from '@autohub/shared';
import { useApi } from '@/lib/hooks';

// Response shapes mirror apps/api/src/modules/{sales,finance,cash-closing}/* exactly. Amounts are
// decimal strings in the company base currency unless a `currency` field says otherwise.

export type { SalePaymentType, SaleStatus };
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type SaleDocumentType = (typeof SALE_DOCUMENT_TYPES)[number];
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];
export type PlanStatus = 'scheduled' | 'active' | 'settled' | 'completed' | 'cancelled';
export type InstallmentLineStatus = 'due' | 'partial' | 'overdue' | 'paid' | 'waived' | 'cancelled';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** sales.vehicle_snapshot (frozen at creation, refreshed at confirmation). */
export interface VehicleSnapshot {
  id: string;
  stockNumber: string;
  vin: string | null;
  plateNumber: string | null;
  modelYear: number;
  trim: string | null;
  exteriorColor: string | null;
  bodyType: string | null;
  fuelType: string | null;
  transmission: string | null;
  condition: string;
  odometerValue: number;
  odometerUnit: 'km' | 'mi';
  makeEn: string;
  makeAr: string;
  modelEn: string;
  modelAr: string;
}

/** sales.customer_snapshot */
export interface CustomerSnapshot {
  id: string;
  type: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  nationalIdLast4: string | null;
  commercialRegistration: string | null;
  taxNumber: string | null;
}

/** GET /sales items. */
export interface SaleListItem {
  id: string;
  number: string;
  status: SaleStatus;
  paymentType: SalePaymentType;
  saleDate: string;
  grossAmount: string;
  /** Receipts + trade-in credit + transferred deposit. */
  held: string;
  customerId: string;
  customerName: string;
  vehicleId: string;
  stockNumber: string;
  vehicle: VehicleSnapshot;
  salespersonId: string;
  salespersonName: string | null;
  branchId: string;
  createdAt: string;
  version: number;
}

export interface InstallmentTerms {
  method: InstallmentMethod;
  annualRatePct: string;
  count: number;
  frequencyMonths: 1 | 2 | 3 | 6 | 12;
  firstDueDate: string;
  feesTotal?: string;
}

export interface ExternalFinance {
  provider: string;
  reference?: string | null;
  amount: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string;
  decidedBy?: string;
  note?: string | null;
}

/** trade_ins row. `vehicleInput` is the trade-in vehicle as entered (zTradeInVehicle). */
export interface TradeIn {
  id: string;
  saleId: string;
  customerId: string;
  agreedValue: string;
  vehicleInput: {
    makeId?: string;
    modelId?: string;
    modelYear?: number;
    vin?: string | null;
    odometerValue?: number;
    odometerUnit?: 'km' | 'mi';
    exteriorColor?: string | null;
    specRegion?: string | null;
  };
  vehicleId: string | null;
  costId: string | null;
  status: 'pending' | 'received' | 'cancelled';
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SalePayment {
  receiptId: string;
  number: string;
  receivedAt: string;
  method: PaymentMethod;
  status: 'posted' | 'voided';
  /** Amount allocated to this sale (base currency). */
  amountBase: string;
}

export interface SaleDocument {
  id: string;
  type: SaleDocumentType;
  number: string;
  issueDate: string;
  status: 'issued' | 'voided';
  issuedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

/** commissions row (GET /commissions/:id adds saleNumber/saleStatus). */
export interface Commission {
  id: string;
  saleId: string;
  userId: string;
  policyId: string;
  ruleSnapshot: Record<string, unknown>;
  earnOn: 'delivery' | 'full_payment';
  baseAmount: string;
  amount: string;
  explanation: string | null;
  status: CommissionStatus;
  earnedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  paidFromAccountId: string | null;
  reversedAt: string | null;
  reverseReason: string | null;
  version: number;
  createdAt: string;
}

export interface CommissionListItem extends Commission {
  saleNumber: string;
  saleStatus: SaleStatus;
  saleDate: string;
  employeeName: string | null;
}

export interface CommissionList extends Paged<CommissionListItem> {
  totalAmount: string;
}

export interface DeliveryBlocker {
  code: 'invoice_required' | 'balance_due' | 'down_payment_due' | 'finance_not_approved' | string;
  amount?: string;
}

/** GET /sales/:id (and every sale action response). */
export interface SaleDetail {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  leadId: string | null;
  reservationId: string | null;
  vehicleId: string;
  salespersonId: string;
  salespersonName: string | null;
  status: SaleStatus;
  paymentType: SalePaymentType;
  saleDate: string;
  askingPrice: string | null;
  floorPrice: string | null;
  agreedPrice: string;
  discountAmount: string;
  discountPct: string;
  taxMode: string;
  taxRatePct: string;
  pricesIncludeTax: boolean;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  downPayment: string | null;
  financedAmount: string | null;
  installmentTerms: InstallmentTerms | null;
  tradeInCredit: string;
  depositTransferred: string;
  externalFinance: ExternalFinance | null;
  approvalPermission: 'sales.approve_discount' | 'sales.approve_below_floor' | null;
  approvedBy: string | null;
  approvedAt: string | null;
  vehicleSnapshot: VehicleSnapshot;
  customerSnapshot: CustomerSnapshot;
  /** Null unless the caller holds vehicles.view_cost. */
  costAtConfirmation: string | null;
  cogsAmount: string | null;
  grossProfit: string | null;
  recognizedAt: string | null;
  recognitionDate: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  deliveredAt: string | null;
  deliveredBy: string | null;
  deliveryOverrideReason: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  returnedAt: string | null;
  returnedBy: string | null;
  returnReason: string | null;
  notes: string | null;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  money: {
    held: string;
    dueBeforeDelivery: string;
    outstandingBeforeDelivery: string;
    refundable: string;
    /** Only after recognition (null before). */
    receivable: string | null;
  };
  payments: SalePayment[];
  tradeIns: TradeIn[];
  installmentPlan: { id: string; status: PlanStatus; totalAmount: string; count: number; method: InstallmentMethod } | null;
  commission: Commission | null;
  documents: SaleDocument[];
  deliveryBlockers: DeliveryBlocker[];
}

/** POST /sales/preview */
export interface SalePreview {
  askingPrice: string | null;
  floorPrice: string | null;
  agreedPrice: string;
  discountAmount: string;
  discountPct: string;
  taxMode: string;
  taxRatePct: string;
  pricesIncludeTax: boolean;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  downPayment: string | null;
  financedAmount: string | null;
  approvalPermission: 'sales.approve_discount' | 'sales.approve_below_floor' | null;
  requiresApproval: boolean;
  dueBeforeDelivery: string;
  schedule: Schedule | null;
}

/** GET /cash-accounts/options */
export interface CashAccountOption {
  id: string;
  type: 'cashbox' | 'bank';
  name: string;
  currency: string;
  branchId: string | null;
}

/** GET /refunds items (refunds row + customer name). */
export interface Refund {
  id: string;
  number: string;
  customerId: string;
  customerName?: string;
  sourceType: 'reservation' | 'sale' | 'customer_credit';
  sourceId: string;
  amountBase: string;
  reason: string;
  status: 'requested' | 'approved' | 'paid' | 'rejected' | 'cancelled';
  requestedAt: string;
  decidedAt: string | null;
  paidAt: string | null;
}

// ── Installment plans ────────────────────────────────────────────────────────────────────

export interface InstallmentPlan {
  id: string;
  saleId: string;
  customerId: string;
  method: InstallmentMethod;
  annualRatePct: string;
  periodicRatePct: string;
  count: number;
  frequencyMonths: number;
  firstDueDate: string;
  principal: string;
  interestTotal: string;
  feesTotal: string;
  totalAmount: string;
  allocationOrder: string[];
  futureInterestPolicy: FutureInterestPolicy;
  status: PlanStatus;
  activatedAt: string | null;
  settledAt: string | null;
  waivedInterest: string;
  cancelledAt: string | null;
  createdBy: string | null;
  createdAt: string;
  version: number;
}

/** GET /installment-plans items. */
export interface InstallmentPlanListItem extends InstallmentPlan {
  saleNumber: string;
  customerName: string;
  overdueAmount: string;
}

export interface InstallmentLine {
  id: string;
  seq: number;
  dueDate: string;
  principalDue: string;
  interestDue: string;
  feesDue: string;
  principalPaid: string;
  interestPaid: string;
  feesPaid: string;
  totalDue: string;
  paid: string;
  remaining: string;
  waived: string;
  status: InstallmentLineStatus;
}

/** GET /installment-plans/:id */
export interface InstallmentPlanDetail extends InstallmentPlan {
  saleNumber: string;
  customerName: string | null;
  outstanding: string;
  overdueAmount: string;
  lines: InstallmentLine[];
  payments: Array<{ receiptId: string; number: string; receivedAt: string; status: 'posted' | 'voided'; amount: string }>;
}

/** GET /installment-plans/:id/settlement-quote */
export interface SettlementQuote {
  asOf: string;
  policy: FutureInterestPolicy;
  principal: string;
  interest: string;
  fees: string;
  total: string;
  waivedInterest: string;
  lines: Array<{ installmentId: string; seq: number; principal: string; interest: string; fees: string; total: string }>;
}

// ── Cash closing ─────────────────────────────────────────────────────────────────────────

/** GET /cash-accounts items (cash.read). */
export interface CashAccountRow {
  id: string;
  type: 'cashbox' | 'bank';
  name: string;
  currency: string;
  branchId: string | null;
  branchName: string | null;
  bankName: string | null;
  isActive: boolean;
  balance: string;
  balanceBase: string;
}

/** cash_day_closings row. */
export interface CashClosing {
  id: string;
  cashAccountId: string;
  businessDate: string;
  expectedBalance: string;
  countedBalance: string;
  difference: string;
  status: 'closed' | 'reopened';
  notes: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string;
  reopenedBy: string | null;
  reopenedByName: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
}

export interface ExpectedBalance {
  cashAccountId: string;
  currency: string;
  businessDate: string;
  expectedBalance: string;
}

// ── Hooks ────────────────────────────────────────────────────────────────────────────────

export const useSale = (id: string | undefined) => useApi<SaleDetail>(['sale', id], id ? `/sales/${id}` : null);

export const useCashAccountOptions = () =>
  useApi<CashAccountOption[]>(['cash-accounts', 'options'], '/cash-accounts/options', undefined, { staleTime: 60_000 });

/** Every query showing sale, plan, commission or cash figures; invalidated after money moves. */
export const SALES_MONEY_KEYS: unknown[][] = [
  ['sales'],
  ['sale'],
  ['installment-plans'],
  ['installment-plan'],
  ['commissions'],
  ['refunds'],
  ['cash-accounts'],
  ['cash-closings'],
  ['vehicle'],
];
