import type {
  AccountStatement,
  BalanceSheet,
  IncomeStatement,
  LedgerAccountBalance,
  LedgerAccountType,
  LedgerEntry,
  Reconciliation,
  TrialBalance,
} from '@autohub/shared';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { FEATURE_MODULES } from '@/features/modules';

export type {
  AccountStatement,
  BalanceSheet,
  IncomeStatement,
  LedgerAccountBalance,
  LedgerAccountType,
  LedgerEntry,
  Reconciliation,
  TrialBalance,
};

export interface LedgerAccounts {
  currency: string;
  asOf: string | null;
  items: LedgerAccountBalance[];
}

export interface LedgerEntries {
  currency: string;
  items: LedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export const ACCOUNT_TYPES: LedgerAccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

/** Journal source types the API posts (see apps/api ledger postings). */
export const SOURCE_TYPES = [
  'acquisition',
  'vehicle_cost',
  'allocation',
  'work_order_item',
  'trade_in',
  'vehicle',
  'expense',
  'supplier_payment',
  'cash_account',
  'cash_transfer',
  'cash_closing',
  'sale',
  'receipt',
  'refund',
  'reservation',
  'installment_plan',
  'commission',
  'manual',
] as const;

/** GL reports need ledger.read and access to every branch (the API answers 403 company_scope_required otherwise). */
export function useLedgerAccess() {
  const { can, me } = useAuth();
  return {
    read: can('ledger.read'),
    companyWide: !!me?.allBranches,
    ok: can('ledger.read') && !!me?.allBranches,
  };
}

export function useLedgerAccounts(asOf?: string) {
  const { ok } = useLedgerAccess();
  return useApi<LedgerAccounts>(
    ['ledger', 'accounts'],
    ok ? '/ledger/accounts' : null,
    { asOf: asOf || undefined },
    { staleTime: 30_000 },
  );
}

export function useJournalEntry(id: string | undefined) {
  return useApi<LedgerEntry & { currency: string }>(
    ['ledger', 'entry', id],
    id ? `/ledger/entries/${id}` : null,
  );
}

/** Display name of a ledger account in the current language. */
export function ledgerName(
  a: { nameAr: string; nameEn: string } | { accountNameAr: string; accountNameEn: string },
  lang: string,
): string {
  if ('nameAr' in a) return lang === 'en' ? a.nameEn : a.nameAr;
  return lang === 'en' ? a.accountNameEn : a.accountNameAr;
}

/** Route segment of the page showing a journal source document, when one exists. */
const SOURCE_SEGMENT: Partial<Record<string, string>> = {
  expense: 'expenses',
  cash_transfer: 'cash/transfers',
  cash_account: 'cash/accounts',
  supplier_payment: 'purchasing/payments',
  acquisition: 'purchasing/acquisitions',
  sale: 'sales',
  receipt: 'receipts',
  refund: 'refunds',
  reservation: 'reservations',
  installment_plan: 'installments',
  commission: 'commissions',
};

/** Detail routes registered by the app (paths relative to /app), read lazily to avoid an import cycle at load. */
function registeredPaths(): string[] {
  const out = ['vehicles/:id'];
  for (const m of FEATURE_MODULES)
    for (const r of m.routes ?? []) if (r.path) out.push(r.path.replace(/^\//, ''));
  return out;
}

/** `/app/<segment>/<id>` when some feature registered `<…/>segment/:param`, else null (no dead links). */
export function detailRoute(segment: string, id: string): string | null {
  const re = new RegExp(`(^|/)${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/:[A-Za-z]+$`);
  const path = registeredPaths().find((p) => re.test(p));
  return path ? `/app/${path.replace(/:[A-Za-z]+$/, id)}` : null;
}

/** Link to the source document of a journal entry (or the vehicle it concerns), when the app has that page. */
export function sourceLink(
  e: Pick<LedgerEntry, 'sourceType' | 'sourceId'> & { lines?: LedgerEntry['lines'] },
): string | null {
  const seg = SOURCE_SEGMENT[e.sourceType];
  if (seg) return detailRoute(seg, e.sourceId);
  if (e.sourceType === 'vehicle') return detailRoute('vehicles', e.sourceId);
  const vehicleId = e.lines?.find((l) => l.vehicleId)?.vehicleId;
  if ((e.sourceType === 'vehicle_cost' || e.sourceType === 'trade_in') && vehicleId)
    return detailRoute('vehicles', vehicleId);
  return null;
}
