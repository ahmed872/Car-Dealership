import type { CashBook, CashTransfer } from '@autohub/shared';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

export type { CashBook, CashBookRow, CashTransfer } from '@autohub/shared';

export type CashAccountType = 'cashbox' | 'bank';

/** GET /cash-accounts row (balances derived from the cash book). */
export interface CashAccountListItem {
  id: string;
  type: CashAccountType;
  name: string;
  currency: string;
  branchId: string | null;
  branchName: string | null;
  bankName: string | null;
  accountNumber: string | null;
  iban: string | null;
  isActive: boolean;
  createdAt: string;
  balance: string;
  balanceBase: string;
}

/** GET /cash-accounts/:id */
export interface CashAccountDetail {
  id: string;
  type: CashAccountType;
  name: string;
  currency: string;
  branchId: string | null;
  bankName: string | null;
  accountNumber: string | null;
  iban: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  balance: string;
  balanceBase: string;
}

/** GET /cash-accounts/options (any signed-in member; active accounts only). */
export interface CashAccountOption {
  id: string;
  type: CashAccountType;
  name: string;
  currency: string;
  branchId: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function useCashAccounts(includeInactive = false) {
  const { can } = useAuth();
  return useApi<CashAccountListItem[]>(
    ['cash-accounts', 'list'],
    can('cash.read') ? '/cash-accounts' : null,
    { includeInactive: includeInactive ? 'true' : undefined },
  );
}

export function useCashAccountOptions() {
  return useApi<CashAccountOption[]>(['cash-accounts', 'options'], '/cash-accounts/options', undefined, {
    staleTime: 60_000,
  });
}

export function useCashAccount(id: string | undefined) {
  return useApi<CashAccountDetail>(['cash-accounts', 'detail', id], id ? `/cash-accounts/${id}` : null);
}

export function useCashBook(
  id: string | undefined,
  query: { from?: string; to?: string; page: number; pageSize: number },
) {
  return useApi<CashBook>(['cash-book', id], id ? `/cash/accounts/${id}/book` : null, query, {
    placeholderData: (p) => p,
  });
}

export function useCashTransfer(id: string | undefined) {
  return useApi<CashTransfer>(['cash-transfer', id], id ? `/cash/transfers/${id}` : null);
}
