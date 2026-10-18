import { FileText, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pagination } from '@/components/ui/DataTable';
import { EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Select } from '@/components/ui/Field';
import { Toolbar } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { DateRange, Money, Stat, useLedgerText } from '@/features/cash/finance-ui';
import { AccountStatement, ledgerName, useLedgerAccounts } from './api';
import { AccountTypeBadge, Amt, BranchFilter, ReportTable, Td, Th, useMemoLabel } from './components';
import { useSourceLabel } from './JournalTab';

type LP = ReturnType<typeof useListParams>;

/**
 * Lines of one GL account with opening, running and closing balances. The API returns
 * debit − credit; credit-normal accounts are presented on their credit side (sign flipped).
 */
export function StatementTab({ lp }: { lp: LP }) {
  const { t, i18n } = useTranslation();
  const { currency } = useAuth();
  const label = useSourceLabel();
  const memo = useMemoLabel();
  const text = useLedgerText();
  const accounts = useLedgerAccounts();
  const code = lp.get('account');
  const branchId = lp.get('branch');
  const pageSize = 100;
  const q = useApi<AccountStatement>(
    ['ledger', 'statement', code],
    code ? `/ledger/accounts/${code}/statement` : null,
    {
      from: lp.get('from') || undefined,
      to: lp.get('to') || undefined,
      branchId: branchId || undefined,
      page: lp.page,
      pageSize,
    },
    { placeholderData: (p) => p },
  );
  const s = q.data && q.data.account.code === code ? q.data : undefined;
  const flip = s?.normalSide === 'credit';
  const show = (v: string) => (flip ? d(v).negated().toFixed(2) : v);

  return (
    <Card>
      <Toolbar>
        <Select
          className="w-full sm:w-auto sm:min-w-[240px]"
          value={code}
          onChange={(e) => lp.set({ account: e.target.value })}
          aria-label={t('accounting.statement.chooseAccount')}
        >
          <option value="">{t('accounting.statement.chooseAccount')}</option>
          {(accounts.data?.items ?? []).map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} — {ledgerName(a, i18n.language)}
            </option>
          ))}
        </Select>
        <DateRange from={lp.get('from')} to={lp.get('to')} onChange={(v) => lp.set(v)} />
        <BranchFilter value={branchId} onChange={(v) => lp.set({ branch: v })} />
        {(lp.get('from') || lp.get('to') || branchId) && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={() => lp.set({ from: null, to: null, branch: null })}
          >
            {t('common.clearFilters')}
          </Button>
        )}
      </Toolbar>
      {!code ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title={t('accounting.statement.pickAccount')}
          description={t('accounting.statement.pickAccountHint')}
        />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !s ? (
        <PageLoader />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <span className="num text-sm font-semibold">{s.account.code}</span>
            <span className="text-sm font-semibold text-ink">{ledgerName(s.account, i18n.language)}</span>
            <AccountTypeBadge type={s.account.type} />
            <Badge tone="neutral" dot={false}>
              {t(`accounting.normal.${s.normalSide}`)}
            </Badge>
            <span className="text-[13px] text-muted ms-auto">
              {s.from
                ? t('accounting.common.periodRange', { from: fmtDate(s.from), to: fmtDate(s.to) })
                : t('accounting.common.periodUntil', { to: fmtDate(s.to) })}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 border-b border-line px-5 py-4 md:grid-cols-4">
            <Stat label={t('accounting.statement.opening')}>
              <Money value={show(s.opening)} currency={currency} toneNegative />
            </Stat>
            <Stat label={t('accounting.statement.totalDebit')}>
              <Money value={s.totalDebit} currency={currency} />
            </Stat>
            <Stat label={t('accounting.statement.totalCredit')}>
              <Money value={s.totalCredit} currency={currency} />
            </Stat>
            <Stat label={t('accounting.statement.closing')}>
              <Money value={show(s.closing)} currency={currency} toneNegative className="font-semibold" />
            </Stat>
          </div>
          <p className="px-5 pt-3 text-xs text-muted">
            {t('accounting.statement.signNote', {
              side: flip ? t('accounting.statement.sideCredit') : t('accounting.statement.sideDebit'),
            })}
            {branchId && ` ${t('accounting.statement.branchNote')}`}
          </p>
          {s.rows.length === 0 ? (
            <EmptyState icon={<FileText className="h-5 w-5" />} title={t('accounting.statement.empty')} />
          ) : (
            <div className={q.isFetching ? 'opacity-70 transition-opacity' : undefined}>
              <ReportTable minWidth={760}>
                <thead>
                  <tr>
                    <Th>{t('common.date')}</Th>
                    <Th>{t('accounting.common.entry')}</Th>
                    <Th>{t('common.description')}</Th>
                    <Th end>{t('accounting.common.debit')}</Th>
                    <Th end>{t('accounting.common.credit')}</Th>
                    <Th end>{t('accounting.statement.running')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={`${r.entryId}-${r.lineNo}`} className="border-b border-line">
                      <Td className="num whitespace-nowrap">{fmtDate(r.entryDate)}</Td>
                      <Td>
                        <Link
                          to={`/app/accounting/entries/${r.entryId}`}
                          className="num font-medium whitespace-nowrap text-brand-strong hover:underline"
                        >
                          #{r.entryNo}
                        </Link>
                      </Td>
                      <Td>
                        <div className="min-w-[200px] max-w-[420px]">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-muted">{label(r.sourceType)}</span>
                            {r.isReversal && <Badge tone="danger">{t('accounting.common.reversal')}</Badge>}
                          </div>
                          <p className="text-[13px] break-words">{text(r.description)}</p>
                          {r.memo && memo(r.memo) !== label(r.sourceType) && (
                            <p className="text-xs text-subtle">{memo(r.memo)}</p>
                          )}
                        </div>
                      </Td>
                      <Td end>
                        <Amt value={r.debit} />
                      </Td>
                      <Td end>
                        <Amt value={r.credit} />
                      </Td>
                      <Td end>
                        <Money
                          value={show(r.runningBalance)}
                          currency={currency}
                          toneNegative
                          className="font-medium"
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
              <Pagination
                page={lp.page}
                pageSize={pageSize}
                total={s.total}
                onPage={(p) => lp.set({ page: p }, false)}
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
