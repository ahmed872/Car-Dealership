import type { COST_STATUSES, PAYMENT_METHODS } from '@autohub/shared';
import { useApi } from '@/lib/hooks';

export type ExpenseStatus = (typeof COST_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /expense-categories (operating categories, platform + tenant). */
export interface ExpenseCategory {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  kind: 'operating';
  isActive: boolean;
}

/** GET /expenses row. */
export interface ExpenseListItem {
  id: string;
  number: string;
  status: ExpenseStatus;
  expenseDate: string;
  description: string;
  amount: string;
  currency: string;
  exchangeRate: string;
  amountBase: string;
  branchId: string;
  branchName: string;
  categoryId: string;
  categoryCode: string;
  categoryEn: string;
  categoryAr: string;
  supplierId: string | null;
  supplierName: string | null;
  createdAt: string;
  paidBase: string;
  /** Only for posted expenses. */
  outstandingBase: string | null;
}

/** Supplier payment allocated to the expense (SupplierPaymentsService.forTargets). */
export interface ExpensePayment {
  paymentId: string;
  number: string;
  paidAt: string;
  status: 'posted' | 'voided';
  method: PaymentMethod;
  targetId: string;
  amountBase: string;
}

/** GET /expenses/:id and the result of every expense mutation. */
export interface ExpenseDetail {
  id: string;
  number: string;
  branchId: string;
  categoryId: string;
  description: string;
  amount: string;
  currency: string;
  exchangeRate: string;
  amountBase: string;
  expenseDate: string;
  supplierId: string | null;
  status: ExpenseStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  categoryCode: string;
  categoryEn: string;
  categoryAr: string;
  branchName: string;
  supplierName: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  paidBase: string;
  outstandingBase: string | null;
  payments: ExpensePayment[];
  journalEntries: Array<{ id: string; entryNo: number; entryDate: string; event: string }>;
}

/** GET /expenses/summary */
export interface ExpenseSummary {
  currency: string;
  from: string | null;
  to: string | null;
  branchId: string | null;
  totalBase: string;
  count: number;
  byCategory: Array<{
    categoryId: string;
    code: string;
    nameEn: string;
    nameAr: string;
    count: number;
    totalBase: string;
  }>;
  byMonth: Array<{ month: string; count: number; totalBase: string }>;
}

export function useExpenseCategories() {
  return useApi<ExpenseCategory[]>(['expense-categories'], '/expense-categories', undefined, {
    staleTime: 5 * 60_000,
  });
}

export function useExpense(id: string | undefined) {
  return useApi<ExpenseDetail>(['expense', id], id ? `/expenses/${id}` : null);
}

export const categoryName = (
  c: { nameAr?: string; nameEn?: string; categoryAr?: string; categoryEn?: string },
  lang: string,
): string => (lang === 'en' ? (c.nameEn ?? c.categoryEn) : (c.nameAr ?? c.categoryAr)) ?? '';

/** Every query an expense mutation can change (lists, summary, detail, approvals inbox, payables, cash and ledger). */
export const EXPENSE_KEYS: unknown[][] = [
  ['expenses'],
  ['expense'],
  ['approvals'],
  ['approvals-summary'],
  ['payables-open'],
  ['payables-summary'],
  ['supplier'],
  ['supplier-statement'],
  ['supplier-payments'],
  ['cash-accounts'],
  ['cash-book'],
  ['ledger'],
];
