import { z } from 'zod';
import { zIsoDate, zUuid } from './common';
import { zExpenseListQuery } from './purchasing';

// Operating expenses (P&L). zExpenseCreate / zExpenseListQuery live with the Phase 3 core schemas
// in ./purchasing; the schemas below are owned by the expenses module.

/** Sort keys accepted by GET /expenses (prefix with "-" for descending). */
export const EXPENSE_SORT_KEYS = ['expenseDate', 'amountBase', 'number', 'createdAt'] as const;
export type ExpenseSortKey = (typeof EXPENSE_SORT_KEYS)[number];

export type ExpenseListQuery = z.infer<typeof zExpenseListQuery>;

/** GET /expenses/summary — posted expenses totalled by category and by month (base currency). */
export const zExpenseSummaryQuery = z
  .object({
    from: zIsoDate.optional(),
    to: zIsoDate.optional(),
    branchId: zUuid.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ['to'], message: 'to_before_from' });
export type ExpenseSummaryQuery = z.infer<typeof zExpenseSummaryQuery>;
