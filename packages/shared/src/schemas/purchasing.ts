import { z } from 'zod';
import { zCurrency, zIsoDate, zMoney, zMoneyNonNeg, zMoneyPos, zOptText, zPaginationQuery, zRate, zText, zUuid } from './common';
import { zVehicleCreate } from './vehicles';

export const SUPPLIER_TYPES = ['individual', 'company', 'auction', 'importer', 'dealer', 'workshop', 'other'] as const;
export const ACQUISITION_SOURCES = ['individual', 'company', 'auction', 'import', 'trade_in', 'other'] as const;
export const ACQUISITION_STATUSES = ['draft', 'pending_approval', 'approved', 'cancelled'] as const;
export const COST_STATUSES = ['pending_approval', 'posted', 'reversed', 'rejected'] as const;
export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'cheque', 'finance_company', 'other'] as const;
export const OWNERSHIP_TRANSFER_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export const ALLOCATION_METHODS = ['equal', 'by_purchase_price', 'manual'] as const;
export const WORK_ORDER_TYPES = ['inspection', 'repair', 'maintenance', 'detailing', 'parts', 'bodywork', 'other'] as const;
export const WORK_ORDER_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const WORK_ORDER_STATUSES = ['open', 'in_progress', 'awaiting_approval', 'completed', 'cancelled'] as const;
export const WORK_ORDER_ITEM_KINDS = ['part', 'labor', 'service', 'other'] as const;
export const CASH_ACCOUNT_TYPES = ['cashbox', 'bank'] as const;

export const zSupplierInput = z.object({
  type: z.enum(SUPPLIER_TYPES),
  name: zText(200).min(2),
  phone: zOptText(30),
  email: zOptText(120),
  taxNumber: zOptText(40),
  nationalId: zOptText(40),
  address: zOptText(300),
  city: zOptText(80),
  notes: zOptText(2000),
  isActive: z.boolean().default(true),
});
export type SupplierInput = z.infer<typeof zSupplierInput>;

/** Immediate payment of a newly recorded cost/expense from a cash or bank account. */
export const zPayNow = z.object({
  cashAccountId: zUuid,
  method: z.enum(PAYMENT_METHODS).default('cash'),
  reference: zOptText(80),
});
export type PayNowInput = z.infer<typeof zPayNow>;

const fx = {
  currency: zCurrency,
  /** Base-currency units per 1 unit of `currency`. Required when currency ≠ company base currency. */
  exchangeRate: zRate.optional(),
};

export const zAcquisitionCreate = z.object({
  branchId: zUuid,
  supplierId: zUuid,
  sourceType: z.enum(ACQUISITION_SOURCES).default('individual'),
  purchaseDate: zIsoDate,
  purchasePrice: zMoneyPos,
  ...fx,
  paymentMethod: z.enum(PAYMENT_METHODS).optional().nullable(),
  dueDate: zIsoDate.optional().nullable(),
  notes: zOptText(2000),
  /** Request approval immediately (otherwise stays a draft). */
  submit: z.boolean().default(false),
  vehicle: zVehicleCreate.omit({ branchId: true, initialStatus: true }),
});
export type AcquisitionCreateInput = z.infer<typeof zAcquisitionCreate>;

export const zAcquisitionUpdate = z.object({
  supplierId: zUuid.optional(),
  sourceType: z.enum(ACQUISITION_SOURCES).optional(),
  purchaseDate: zIsoDate.optional(),
  purchasePrice: zMoneyPos.optional(),
  currency: zCurrency.optional(),
  exchangeRate: zRate.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional().nullable(),
  dueDate: zIsoDate.optional().nullable(),
  notes: zOptText(2000),
  version: z.number().int().min(1),
});

export const zAcquisitionListQuery = zPaginationQuery.extend({
  status: z.enum(ACQUISITION_STATUSES).optional(),
  supplierId: zUuid.optional(),
  branchId: zUuid.optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
});

export const zOwnershipTransfer = z.object({ status: z.enum(OWNERSHIP_TRANSFER_STATUSES) });
export const zDecisionNote = z.object({ note: zOptText(500) });
/** Approving a purchase can settle it immediately from a base-currency cash/bank account. */
export const zAcquisitionApprove = z.object({ note: zOptText(500), payNow: zPayNow.optional().nullable() });
export type AcquisitionApproveInput = z.infer<typeof zAcquisitionApprove>;
export type AcquisitionUpdateInput = z.infer<typeof zAcquisitionUpdate>;
export type AcquisitionListQuery = z.infer<typeof zAcquisitionListQuery>;
export const zReasonRequired = z.object({ reason: zText(500).min(3) });

export const zVehicleCostCreate = z.object({
  vehicleId: zUuid,
  categoryId: zUuid,
  description: zText(300).min(2),
  amount: zMoneyPos,
  ...fx,
  costDate: zIsoDate,
  supplierId: zUuid.optional().nullable(),
  notes: zOptText(1000),
  payNow: zPayNow.optional().nullable(),
});
export type VehicleCostCreateInput = z.infer<typeof zVehicleCostCreate>;

export const zCostAllocation = z
  .object({
    vehicleIds: z.array(zUuid).min(2).max(100),
    method: z.enum(ALLOCATION_METHODS),
    /** Per-vehicle amounts (transaction currency) when method = manual; same order as vehicleIds. */
    manualAmounts: z.array(zMoneyPos).optional(),
    categoryId: zUuid,
    description: zText(300).min(2),
    totalAmount: zMoneyPos,
    ...fx,
    costDate: zIsoDate,
    supplierId: zUuid.optional().nullable(),
    payNow: zPayNow.optional().nullable(),
  })
  .refine((v) => new Set(v.vehicleIds).size === v.vehicleIds.length, { path: ['vehicleIds'], message: 'duplicate_vehicle' })
  .refine((v) => v.method !== 'manual' || v.manualAmounts?.length === v.vehicleIds.length, {
    path: ['manualAmounts'],
    message: 'manual_amounts_required',
  });
export type CostAllocationInput = z.infer<typeof zCostAllocation>;

export const zExpenseCreate = z.object({
  branchId: zUuid,
  categoryId: zUuid,
  description: zText(300).min(2),
  amount: zMoneyPos,
  ...fx,
  expenseDate: zIsoDate,
  supplierId: zUuid.optional().nullable(),
  notes: zOptText(1000),
  payNow: zPayNow.optional().nullable(),
});
export type ExpenseCreateInput = z.infer<typeof zExpenseCreate>;

export const zExpenseListQuery = zPaginationQuery.extend({
  status: z.enum(COST_STATUSES).optional(),
  branchId: zUuid.optional(),
  categoryId: zUuid.optional(),
  supplierId: zUuid.optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
});

export const zCashAccountCreate = z.object({
  type: z.enum(CASH_ACCOUNT_TYPES),
  name: zText(120).min(2),
  currency: zCurrency,
  branchId: zUuid.optional().nullable(),
  bankName: zOptText(120),
  accountNumber: zOptText(60),
  iban: zOptText(40),
  openingBalance: zMoneyNonNeg.optional(),
  /** Base-currency rate for a foreign-currency opening balance. */
  exchangeRate: zRate.optional(),
  openingDate: zIsoDate.optional(),
});
export const zCashAccountUpdate = z.object({
  name: zText(120).min(2).optional(),
  branchId: zUuid.optional().nullable(),
  bankName: zOptText(120),
  accountNumber: zOptText(60),
  iban: zOptText(40),
  isActive: z.boolean().optional(),
});

export const zCashTransfer = z.object({
  fromAccountId: zUuid,
  toAccountId: zUuid,
  /** Amount leaving the source account (source currency). */
  amount: zMoneyPos,
  /** Amount arriving (destination currency); required when currencies differ. */
  amountTo: zMoneyPos.optional(),
  exchangeRate: zRate.optional(),
  date: zIsoDate,
  reference: zOptText(80),
  notes: zOptText(500),
});

export const zSupplierPaymentCreate = z.object({
  supplierId: zUuid.optional().nullable(),
  cashAccountId: zUuid,
  paidAt: zIsoDate,
  method: z.enum(PAYMENT_METHODS),
  reference: zOptText(80),
  notes: zOptText(500),
  /** Amount leaving the cash account, in the account's currency. */
  amount: zMoneyPos,
  exchangeRate: zRate.optional(),
  /** Base-currency amounts settled per payable document; must sum to the payment's base amount. */
  allocations: z
    .array(
      z.object({
        targetType: z.enum(['acquisition', 'vehicle_cost', 'expense']),
        targetId: zUuid,
        amountBase: zMoneyPos,
      }),
    )
    .min(1)
    .max(200),
});
export type SupplierPaymentInput = z.infer<typeof zSupplierPaymentCreate>;

export const zWorkOrderCreate = z.object({
  vehicleId: zUuid,
  type: z.enum(WORK_ORDER_TYPES),
  priority: z.enum(WORK_ORDER_PRIORITIES).default('normal'),
  title: zText(200).min(2),
  description: zOptText(4000),
  assignedUserId: zUuid.optional().nullable(),
  supplierId: zUuid.optional().nullable(),
  estimatedCost: zMoneyNonNeg.optional().nullable(),
});
export const zWorkOrderUpdate = zWorkOrderCreate.omit({ vehicleId: true }).partial();
export const zWorkOrderItem = z.object({
  kind: z.enum(WORK_ORDER_ITEM_KINDS),
  description: zText(300).min(2),
  quantity: z.string().regex(/^\d{1,6}(\.\d{1,3})?$/),
  unitCost: zMoneyNonNeg,
  hours: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/).optional().nullable(),
  supplierId: zUuid.optional().nullable(),
  categoryId: zUuid,
});
export const zWorkOrderApprove = z.object({
  /** Pays items that have no supplier (direct purchases) from this account. */
  payNow: zPayNow.optional().nullable(),
  note: zOptText(500),
});
export const zWorkOrderListQuery = zPaginationQuery.extend({
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  vehicleId: zUuid.optional(),
  assignedUserId: zUuid.optional(),
});

export const zLedgerQuery = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  accountCode: z.string().regex(/^\d{4}$/).optional(),
  sourceType: z.string().max(40).optional(),
  vehicleId: zUuid.optional(),
  supplierId: zUuid.optional(),
  customerId: zUuid.optional(),
  cashAccountId: zUuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export const zMoneySigned = zMoney;
