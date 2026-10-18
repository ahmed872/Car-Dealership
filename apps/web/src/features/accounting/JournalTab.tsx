import { BookOpen, ExternalLink, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pagination } from '@/components/ui/DataTable';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Select } from '@/components/ui/Field';
import { Toolbar } from '@/components/ui/Layout';
import { fmtDate } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { DateRange, useLedgerText } from '@/features/cash/finance-ui';
import { LedgerEntries, LedgerEntry, ledgerName, SOURCE_TYPES, sourceLink, useLedgerAccounts } from './api';
import { Amt, BranchFilter, ReportTable, Td, Th, useMemoLabel } from './components';

type LP = ReturnType<typeof useListParams>;

/** Translated label of a journal source type (raw value when unknown). */
export function useSourceLabel() {
  const { t } = useTranslation();
  return (sourceType: string) => t(`accounting.source.${sourceType}`, { defaultValue: sourceType });
}

/** One journal entry with its lines, reversal links and a link to its source document. */
export function EntryCard({ e }: { e: LedgerEntry }) {
  const { t, i18n } = useTranslation();
  const label = useSourceLabel();
  const memo = useMemoLabel();
  const text = useLedgerText();
  const src = sourceLink(e);
  return (
    <article className="border-b border-line last:border-0">
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/app/accounting/entries/${e.id}`}
              className="num text-sm font-semibold text-brand-strong hover:underline"
            >
              {t('accounting.common.entryNo', { no: e.entryNo })}
            </Link>
            <span className="num text-[13px] text-muted">{fmtDate(e.entryDate)}</span>
            <Badge tone="neutral" dot={false}>
              {label(e.sourceType)}
            </Badge>
            {e.reversalOfId && <Badge tone="danger">{t('accounting.common.reversal')}</Badge>}
            {e.reversedById && <Badge tone="warning">{t('accounting.common.reversed')}</Badge>}
          </div>
          <p className="mt-1 text-[13px] break-words text-ink">{text(e.description)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {e.reversalOfId && (
            <Link
              to={`/app/accounting/entries/${e.reversalOfId}`}
              className="font-medium text-brand-strong hover:underline"
            >
              {t('accounting.journal.reversalOf')}
            </Link>
          )}
          {e.reversedById && (
            <Link
              to={`/app/accounting/entries/${e.reversedById}`}
              className="font-medium text-brand-strong hover:underline"
            >
              {t('accounting.journal.reversedBy')}
            </Link>
          )}
          {src && (
            <Link
              to={src}
              className="inline-flex items-center gap-1 font-medium text-brand-strong hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              {t('accounting.journal.openSource')}
            </Link>
          )}
        </div>
      </header>
      <div className="px-4 pb-3">
        <div className="overflow-hidden rounded-lg border border-line">
          <ReportTable minWidth={560}>
            <thead>
              <tr>
                <Th>{t('accounting.common.account')}</Th>
                <Th>{t('accounting.journal.memo')}</Th>
                <Th end>{t('accounting.common.debit')}</Th>
                <Th end>{t('accounting.common.credit')}</Th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-0">
                  <Td className="py-1.5">
                    <span className="num me-2 text-xs text-muted">{l.accountCode}</span>
                    <span className={d(l.debit).isZero() ? 'ps-4' : undefined}>
                      {ledgerName(l, i18n.language)}
                    </span>
                  </Td>
                  <Td className="py-1.5 text-xs text-muted">{memo(l.memo) ?? ''}</Td>
                  <Td end className="py-1.5">
                    <Amt value={l.debit} />
                  </Td>
                  <Td end className="py-1.5">
                    <Amt value={l.credit} />
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line bg-surface-2/40 text-[13px] font-semibold">
                <Td colSpan={2} className="py-1.5">
                  {t('accounting.journal.totals')}
                </Td>
                <Td end className="py-1.5">
                  <Amt value={e.totalDebit} strong />
                </Td>
                <Td end className="py-1.5">
                  <Amt value={e.totalCredit} strong />
                </Td>
              </tr>
            </tfoot>
          </ReportTable>
        </div>
      </div>
    </article>
  );
}

export function JournalTab({ lp }: { lp: LP }) {
  const { t, i18n } = useTranslation();
  const label = useSourceLabel();
  const accounts = useLedgerAccounts();
  const filters = {
    from: lp.get('from') || undefined,
    to: lp.get('to') || undefined,
    accountCode: lp.get('account') || undefined,
    sourceType: lp.get('source') || undefined,
    branchId: lp.get('branch') || undefined,
  };
  const pageSize = 20;
  const q = useApi<LedgerEntries>(
    ['ledger', 'entries'],
    '/ledger/entries',
    { ...filters, page: lp.page, pageSize },
    { placeholderData: (p) => p },
  );
  const filtered = Object.values(filters).some(Boolean);

  return (
    <Card>
      <Toolbar>
        <DateRange from={lp.get('from')} to={lp.get('to')} onChange={(v) => lp.set(v)} />
        <Select
          className="w-full sm:w-auto sm:min-w-[200px]"
          value={lp.get('account')}
          onChange={(e) => lp.set({ account: e.target.value })}
          aria-label={t('accounting.journal.account')}
        >
          <option value="">{t('accounting.journal.allAccounts')}</option>
          {(accounts.data?.items ?? []).map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} — {ledgerName(a, i18n.language)}
            </option>
          ))}
        </Select>
        <Select
          className="w-full sm:w-auto sm:min-w-[170px]"
          value={lp.get('source')}
          onChange={(e) => lp.set({ source: e.target.value })}
          aria-label={t('accounting.journal.source')}
        >
          <option value="">{t('accounting.journal.allSources')}</option>
          {SOURCE_TYPES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </Select>
        <BranchFilter value={lp.get('branch')} onChange={(v) => lp.set({ branch: v })} />
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={() => lp.set({ from: null, to: null, account: null, source: null, branch: null })}
          >
            {t('common.clearFilters')}
          </Button>
        )}
      </Toolbar>
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading && !q.data ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : !q.data || q.data.items.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-5 w-5" />}
          title={t('accounting.journal.empty')}
          description={filtered ? undefined : t('accounting.journal.emptyHint')}
        />
      ) : (
        <>
          <div className={q.isFetching ? 'opacity-70 transition-opacity' : undefined}>
            {q.data.items.map((e) => (
              <EntryCard key={e.id} e={e} />
            ))}
          </div>
          <Pagination
            page={lp.page}
            pageSize={pageSize}
            total={q.data.total}
            onPage={(p) => lp.set({ page: p }, false)}
          />
        </>
      )}
    </Card>
  );
}
