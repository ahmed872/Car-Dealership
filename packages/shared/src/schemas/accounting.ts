import { z } from 'zod';
import { zIsoDate, zUuid } from './common';
import { zLedgerQuery } from './purchasing';

/**
 * Accounting module: cash transfers, cash-book views, general-ledger reports and sub-ledger
 * reconciliation. Transfer creation itself uses `zCashTransfer` (schemas/purchasing) and reversal
 * uses `zReasonRequired`. All amounts in responses are decimal strings; GL figures are in the
 * company base currency.
 */

const zPage = z.coerce.number().int().min(1).max(100000).default(1);

/** GET /cash/transfers */
export const zCashTransferListQuery = z.object({
  /** Transfers where this account is the source or the destination. */
  cashAccountId: zUuid.optional(),
  status: z.enum(['posted', 'reversed']).optional(),
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  page: zPage,
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type CashTransferListQuery = z.infer<typeof zCashTransferListQuery>;

/** GET /cash/accounts/:id/book */
export const zCashBookQuery = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  page: zPage,
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type CashBookQuery = z.infer<typeof zCashBookQuery>;

/** GET /ledger/accounts */
export const zLedgerAccountsQuery = z.object({ asOf: zIsoDate.optional() });

/** GET /ledger/trial-balance and GET /ledger/income-statement */
export const zLedgerPeriodQuery = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  /** Restricts to journal entries recorded by this branch (entry-level branch). */
  branchId: zUuid.optional(),
});
export type LedgerPeriodQuery = z.infer<typeof zLedgerPeriodQuery>;

/** GET /ledger/balance-sheet and GET /ledger/reconciliation */
export const zLedgerAsOfQuery = z.object({ asOf: zIsoDate.optional() });

/** GET /ledger/entries */
export const zLedgerEntriesQuery = zLedgerQuery.extend({
  branchId: zUuid.optional(),
  saleId: zUuid.optional(),
});
export type LedgerEntriesQuery = z.infer<typeof zLedgerEntriesQuery>;

/** GET /ledger/accounts/:code/statement */
export const zLedgerStatementQuery = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  branchId: zUuid.optional(),
  vehicleId: zUuid.optional(),
  supplierId: zUuid.optional(),
  customerId: zUuid.optional(),
  cashAccountId: zUuid.optional(),
  saleId: zUuid.optional(),
  page: zPage,
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type LedgerStatementQuery = z.infer<typeof zLedgerStatementQuery>;

// ── Response shapes ─────────────────────────────────────────────────────────────────────────

export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface CashTransferLeg {
  cashAccountId: string;
  cashAccountName: string;
  cashAccountType: 'cashbox' | 'bank';
  currency: string;
  branchId: string | null;
  amount: string;
  exchangeRate: string;
}

export interface CashTransfer {
  transferId: string;
  businessDate: string;
  amountBase: string;
  baseCurrency: string;
  from: CashTransferLeg;
  to: CashTransferLeg;
  reference: string | null;
  description: string;
  status: 'posted' | 'reversed';
  journalEntryId: string | null;
  reversal: { businessDate: string; description: string; journalEntryId: string | null; createdAt: string } | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface CashBookRow {
  id: string;
  businessDate: string;
  direction: 'in' | 'out';
  kind: string;
  amount: string;
  amountBase: string;
  exchangeRate: string;
  /** Signed movement in the account currency (+ in, − out). */
  signedAmount: string;
  runningBalance: string;
  runningBalanceBase: string;
  sourceType: string;
  sourceId: string;
  /** Number of the source document when one exists (e.g. supplier payment SPY-…). */
  documentNumber: string | null;
  /** For transfers: the other account. */
  counterpartAccountId: string | null;
  counterpartAccountName: string | null;
  reference: string | null;
  description: string;
  /** This row reverses another row. */
  isReversal: boolean;
  reversalOfId: string | null;
  /** This row was later reversed by that row. */
  reversedById: string | null;
  journalEntryId: string | null;
  createdAt: string;
}

export interface CashBook {
  account: { id: string; name: string; type: 'cashbox' | 'bank'; currency: string; branchId: string | null; isActive: boolean };
  baseCurrency: string;
  from: string | null;
  to: string;
  opening: { amount: string; amountBase: string };
  totals: { in: string; out: string; inBase: string; outBase: string };
  closing: { amount: string; amountBase: string };
  rows: CashBookRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LedgerAccountBalance {
  code: string;
  nameEn: string;
  nameAr: string;
  type: LedgerAccountType;
  isActive: boolean;
  debit: string;
  credit: string;
  /** debit − credit */
  balance: string;
  /** Balance on the account's normal side (debit for assets/expenses, credit otherwise). */
  naturalBalance: string;
}

export interface TrialBalanceRow {
  code: string;
  nameEn: string;
  nameAr: string;
  type: LedgerAccountType;
  /** All balances are debit − credit. */
  opening: string;
  periodDebit: string;
  periodCredit: string;
  closing: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalance {
  currency: string;
  from: string | null;
  to: string;
  branchId: string | null;
  rows: TrialBalanceRow[];
  totals: {
    opening: string;
    periodDebit: string;
    periodCredit: string;
    closing: string;
    closingDebit: string;
    closingCredit: string;
  };
  isBalanced: boolean;
}

export interface LedgerLine {
  id: string;
  lineNo: number;
  accountCode: string;
  accountNameEn: string;
  accountNameAr: string;
  debit: string;
  credit: string;
  branchId: string | null;
  vehicleId: string | null;
  customerId: string | null;
  supplierId: string | null;
  cashAccountId: string | null;
  saleId: string | null;
  userId: string | null;
  memo: string | null;
}

export interface LedgerEntry {
  id: string;
  entryNo: number;
  entryDate: string;
  sourceType: string;
  sourceId: string;
  event: string;
  description: string;
  branchId: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  totalDebit: string;
  totalCredit: string;
  lines: LedgerLine[];
}

export interface AccountStatementRow {
  entryId: string;
  entryNo: number;
  entryDate: string;
  sourceType: string;
  sourceId: string;
  event: string;
  isReversal: boolean;
  description: string;
  lineNo: number;
  memo: string | null;
  debit: string;
  credit: string;
  /** Running debit − credit balance. */
  runningBalance: string;
}

export interface AccountStatement {
  account: { code: string; nameEn: string; nameAr: string; type: LedgerAccountType };
  currency: string;
  from: string | null;
  to: string;
  filters: Record<string, string>;
  /** debit − credit; flip the sign for credit-normal accounts when presenting. */
  normalSide: 'debit' | 'credit';
  opening: string;
  totalDebit: string;
  totalCredit: string;
  closing: string;
  rows: AccountStatementRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StatementLine {
  code: string;
  nameEn: string;
  nameAr: string;
  amount: string;
}

export interface IncomeStatement {
  currency: string;
  from: string;
  to: string;
  branchId: string | null;
  revenue: { lines: StatementLine[]; total: string };
  costOfSales: { lines: StatementLine[]; total: string };
  grossProfit: string;
  expenses: { lines: StatementLine[]; total: string };
  netIncome: string;
}

export interface BalanceSheet {
  currency: string;
  asOf: string;
  assets: { lines: StatementLine[]; total: string };
  liabilities: { lines: StatementLine[]; total: string };
  equity: { lines: StatementLine[]; earnings: string; total: string };
  liabilitiesAndEquity: string;
  check: { difference: string; isBalanced: boolean };
}

export interface ReconciliationMismatch {
  key: string | null;
  label: string;
  subledgerBase: string;
  glBase: string;
  difference: string;
  [extra: string]: unknown;
}

export interface ReconciliationSection {
  name: 'cash' | 'inventory' | 'payables';
  account: string;
  subledgerTotal: string;
  glTotal: string;
  /** glTotal − subledgerTotal */
  difference: string;
  mismatchCount: number;
  mismatches: ReconciliationMismatch[];
  ok: boolean;
}

export interface Reconciliation {
  asOf: string;
  currency: string;
  sections: ReconciliationSection[];
  trialBalance: { totalDebit: string; totalCredit: string; difference: string; isBalanced: boolean };
  ok: boolean;
}
