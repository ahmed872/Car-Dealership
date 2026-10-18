import { FileText } from 'lucide-react';
import { Fragment, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { d, sum } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Input } from '@/components/ui/Field';
import { Toolbar } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { DateRange, Money } from '@/features/cash/finance-ui';
import {
  ACCOUNT_TYPES,
  BalanceSheet,
  IncomeStatement,
  ledgerName,
  TrialBalance,
  useLedgerAccounts,
} from './api';
import { AccountTypeBadge, Amt, BalanceCheck, BranchFilter, ReportTable, Td, Th } from './components';

type LP = ReturnType<typeof useListParams>;

function AsOfInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted">
      <span className="whitespace-nowrap">{t('accounting.common.asOf')}</span>
      <Input
        type="date"
        className="w-auto min-w-[150px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Loading({
  q,
  children,
}: {
  q: { isLoading: boolean; error: unknown; refetch: () => unknown; data: unknown };
  children: () => ReactNode;
}) {
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <>{children()}</>;
}

// ── Chart of accounts ──────────────────────────────────────────────────────────────────────

export function AccountsTab({ lp }: { lp: LP }) {
  const { t, i18n } = useTranslation();
  const asOf = lp.get('asOf');
  const q = useLedgerAccounts(asOf);
  return (
    <Card>
      <Toolbar className="justify-between">
        <AsOfInput value={asOf} onChange={(v) => lp.set({ asOf: v })} />
        <span className="text-xs text-muted">{t('accounting.common.asOfHint')}</span>
      </Toolbar>
      <Loading q={q}>
        {() => {
          const items = q.data!.items;
          return (
            <ReportTable minWidth={720}>
              <thead>
                <tr>
                  <Th>{t('accounting.common.code')}</Th>
                  <Th>{t('accounting.common.account')}</Th>
                  <Th end>{t('accounting.accounts.totalDebit')}</Th>
                  <Th end>{t('accounting.accounts.totalCredit')}</Th>
                  <Th end>{t('accounting.accounts.naturalBalance')}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {ACCOUNT_TYPES.map((type) => {
                  const rows = items.filter((a) => a.type === type);
                  if (!rows.length) return null;
                  const total = sum(rows.map((r) => r.naturalBalance)).toFixed(2);
                  return (
                    <Fragment key={type}>
                      <tr className="border-b border-line bg-surface-2/30">
                        <Td colSpan={6} className="py-2">
                          <AccountTypeBadge type={type} />
                        </Td>
                      </tr>
                      {rows.map((a) => (
                        <tr key={a.code} className="border-b border-line hover:bg-surface-2/50">
                          <Td className="num font-medium">{a.code}</Td>
                          <Td>
                            <span className="font-medium text-ink">{ledgerName(a, i18n.language)}</span>
                            {!a.isActive && (
                              <span className="ms-2 text-xs text-subtle">
                                ({t('accounting.accounts.inactive')})
                              </span>
                            )}
                          </Td>
                          <Td end>
                            <Amt value={a.debit} />
                          </Td>
                          <Td end>
                            <Amt value={a.credit} />
                          </Td>
                          <Td end>
                            <Amt value={a.naturalBalance} strong signedTone />
                          </Td>
                          <Td end>
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={<FileText className="h-3.5 w-3.5" />}
                              onClick={() => lp.set({ tab: 'statement', account: a.code })}
                            >
                              {t('accounting.common.viewStatement')}
                            </Button>
                          </Td>
                        </tr>
                      ))}
                      <tr className="border-b border-line-strong">
                        <Td colSpan={4} className="text-[13px] font-semibold text-muted">
                          {t('accounting.accounts.typeTotal', { type: t(`accounting.type.${type}`) })}
                        </Td>
                        <Td end>
                          <Amt value={total} strong signedTone />
                        </Td>
                        <Td />
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </ReportTable>
          );
        }}
      </Loading>
    </Card>
  );
}

// ── Trial balance ──────────────────────────────────────────────────────────────────────────

export function TrialBalanceTab({ lp }: { lp: LP }) {
  const { t, i18n } = useTranslation();
  const showAll = lp.get('all') === '1';
  const branchId = lp.get('branch');
  const q = useApi<TrialBalance>(['ledger', 'trial-balance'], '/ledger/trial-balance', {
    from: lp.get('from') || undefined,
    to: lp.get('to') || undefined,
    branchId: branchId || undefined,
  });
  return (
    <Card>
      <Toolbar>
        <DateRange from={lp.get('from')} to={lp.get('to')} onChange={(v) => lp.set(v)} />
        <BranchFilter value={branchId} onChange={(v) => lp.set({ branch: v })} />
        <Checkbox
          className="sm:ms-auto"
          label={t('accounting.common.hideZero')}
          checked={!showAll}
          onChange={(e) => lp.set({ all: e.target.checked ? null : '1' })}
        />
      </Toolbar>
      <Loading q={q}>
        {() => {
          const tb = q.data!;
          const rows = showAll
            ? tb.rows
            : tb.rows.filter(
                (r) =>
                  !(
                    d(r.opening).isZero() &&
                    d(r.periodDebit).isZero() &&
                    d(r.periodCredit).isZero() &&
                    d(r.closing).isZero()
                  ),
              );
          return (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 text-[13px]">
                <span className="text-muted">
                  {tb.from
                    ? t('accounting.common.periodRange', { from: fmtDate(tb.from), to: fmtDate(tb.to) })
                    : t('accounting.common.periodUntil', { to: fmtDate(tb.to) })}
                </span>
                <BalanceCheck
                  ok={tb.isBalanced}
                  okLabel={t('accounting.trial.balancedHint')}
                  badLabel={t('accounting.trial.unbalancedHint')}
                />
              </div>
              {branchId && (
                <Alert tone="info" className="m-4">
                  {t('accounting.common.branchNote')}
                </Alert>
              )}
              {rows.length === 0 ? (
                <EmptyState icon={<FileText className="h-5 w-5" />} title={t('accounting.trial.empty')} />
              ) : (
                <ReportTable minWidth={900}>
                  <thead>
                    <tr>
                      <Th>{t('accounting.common.code')}</Th>
                      <Th>{t('accounting.common.account')}</Th>
                      {tb.from && <Th end>{t('accounting.trial.opening')}</Th>}
                      <Th end>{t('accounting.trial.periodDebit')}</Th>
                      <Th end>{t('accounting.trial.periodCredit')}</Th>
                      <Th end>{t('accounting.trial.closingDebit')}</Th>
                      <Th end>{t('accounting.trial.closingCredit')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.code}
                        className="cursor-pointer border-b border-line hover:bg-surface-2/50"
                        onClick={() => lp.set({ tab: 'statement', account: r.code })}
                      >
                        <Td className="num font-medium">{r.code}</Td>
                        <Td>
                          <span className="font-medium text-ink">{ledgerName(r, i18n.language)}</span>
                        </Td>
                        {tb.from && (
                          <Td end>
                            <Amt value={r.opening} signedTone />
                          </Td>
                        )}
                        <Td end>
                          <Amt value={r.periodDebit} />
                        </Td>
                        <Td end>
                          <Amt value={r.periodCredit} />
                        </Td>
                        <Td end>
                          <Amt value={r.closingDebit} strong />
                        </Td>
                        <Td end>
                          <Amt value={r.closingCredit} strong />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-line-strong bg-surface-2/40 font-semibold">
                      <Td colSpan={2}>{t('accounting.common.total')}</Td>
                      {tb.from && (
                        <Td end>
                          <Amt value={tb.totals.opening} strong />
                        </Td>
                      )}
                      <Td end>
                        <Amt value={tb.totals.periodDebit} strong />
                      </Td>
                      <Td end>
                        <Amt value={tb.totals.periodCredit} strong />
                      </Td>
                      <Td end>
                        <Amt value={tb.totals.closingDebit} strong />
                      </Td>
                      <Td end>
                        <Amt value={tb.totals.closingCredit} strong />
                      </Td>
                    </tr>
                  </tfoot>
                </ReportTable>
              )}
            </>
          );
        }}
      </Loading>
    </Card>
  );
}

// ── Financial statements ───────────────────────────────────────────────────────────────────

function StatementSection({
  title,
  lines,
  totalLabel,
  total,
}: {
  title: string;
  lines: Array<{ code: string; nameAr: string; nameEn: string; amount: string }>;
  /** Omit when a ResultRow right below already carries the section total. */
  totalLabel?: string;
  total: string;
}) {
  const { t, i18n } = useTranslation();
  const shown = lines.filter((l) => !d(l.amount).isZero());
  return (
    <section className="border-b border-line px-5 py-4 last:border-0">
      <h3 className="mb-2 text-[13px] font-semibold tracking-wide text-muted">{title}</h3>
      {shown.length === 0 ? (
        <p className="text-[13px] text-subtle">{t('accounting.income.noLines')}</p>
      ) : (
        <dl className="space-y-1.5 text-sm">
          {shown.map((l) => (
            <div key={l.code} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 text-ink">
                <span className="num me-2 text-xs text-muted">{l.code}</span>
                {ledgerName(l, i18n.language)}
              </dt>
              <dd className="shrink-0">
                <Amt value={l.amount} signedTone />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {totalLabel && (
        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-dashed border-line pt-2 text-sm font-semibold">
          <span>{totalLabel}</span>
          <Amt value={total} strong signedTone />
        </div>
      )}
    </section>
  );
}

function ResultRow({ label, value, tone }: { label: string; value: string; tone?: 'auto' }) {
  const { currency } = useAuth();
  const negative = d(value).isNegative();
  return (
    <div
      className={
        tone === 'auto'
          ? `flex items-baseline justify-between gap-3 px-5 py-4 text-base font-semibold ${negative ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`
          : 'flex items-baseline justify-between gap-3 border-b border-line bg-surface-2/40 px-5 py-3 text-sm font-semibold'
      }
    >
      <span>{label}</span>
      <Money value={value} currency={currency} />
    </div>
  );
}

export function IncomeStatementTab({ lp }: { lp: LP }) {
  const { t } = useTranslation();
  const branchId = lp.get('branch');
  const q = useApi<IncomeStatement>(['ledger', 'income-statement'], '/ledger/income-statement', {
    from: lp.get('from') || undefined,
    to: lp.get('to') || undefined,
    branchId: branchId || undefined,
  });
  return (
    <Card>
      <Toolbar>
        <DateRange from={lp.get('from')} to={lp.get('to')} onChange={(v) => lp.set(v)} />
        <BranchFilter value={branchId} onChange={(v) => lp.set({ branch: v })} />
        {!lp.get('from') && <span className="text-xs text-muted">{t('accounting.income.defaultsHint')}</span>}
      </Toolbar>
      <Loading q={q}>
        {() => {
          const s = q.data!;
          const net = d(s.netIncome);
          return (
            <div className="mx-auto max-w-3xl">
              <p className="px-5 pt-4 text-[13px] text-muted">
                {t('accounting.common.periodRange', { from: fmtDate(s.from), to: fmtDate(s.to) })}
              </p>
              {branchId && (
                <Alert tone="info" className="mx-5 mt-3">
                  {t('accounting.common.branchNote')}
                </Alert>
              )}
              <StatementSection
                title={t('accounting.income.revenue')}
                lines={s.revenue.lines}
                totalLabel={t('accounting.income.totalRevenue')}
                total={s.revenue.total}
              />
              <StatementSection
                title={t('accounting.income.costOfSales')}
                lines={s.costOfSales.lines}
                totalLabel={t('accounting.income.totalCostOfSales')}
                total={s.costOfSales.total}
              />
              <ResultRow label={t('accounting.income.grossProfit')} value={s.grossProfit} />
              <StatementSection
                title={t('accounting.income.expenses')}
                lines={s.expenses.lines}
                totalLabel={t('accounting.income.totalExpenses')}
                total={s.expenses.total}
              />
              <ResultRow
                label={net.isNegative() ? t('accounting.income.netLoss') : t('accounting.income.netIncome')}
                value={s.netIncome}
                tone="auto"
              />
            </div>
          );
        }}
      </Loading>
    </Card>
  );
}

export function BalanceSheetTab({ lp }: { lp: LP }) {
  const { t } = useTranslation();
  const { currency } = useAuth();
  const asOf = lp.get('asOf');
  const q = useApi<BalanceSheet>(['ledger', 'balance-sheet'], '/ledger/balance-sheet', {
    asOf: asOf || undefined,
  });
  return (
    <Card>
      <Toolbar>
        <AsOfInput value={asOf} onChange={(v) => lp.set({ asOf: v })} />
      </Toolbar>
      <Loading q={q}>
        {() => {
          const b = q.data!;
          return (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3 text-[13px]">
                <span className="text-muted">
                  {t('accounting.common.periodUntil', { to: fmtDate(b.asOf) })}
                </span>
                <BalanceCheck
                  ok={b.check.isBalanced}
                  okLabel={t('accounting.balance.balanced')}
                  badLabel={t('accounting.balance.unbalanced', {
                    value: `${b.check.difference} ${currency}`,
                  })}
                />
              </div>
              <div className="grid lg:grid-cols-2">
                <div className="min-w-0">
                  <StatementSection
                    title={t('accounting.balance.assets')}
                    lines={b.assets.lines}
                    total={b.assets.total}
                  />
                  <ResultRow label={t('accounting.balance.totalAssets')} value={b.assets.total} />
                </div>
                <div className="min-w-0 border-t border-line lg:border-t-0 lg:border-s">
                  <StatementSection
                    title={t('accounting.balance.liabilities')}
                    lines={b.liabilities.lines}
                    totalLabel={t('accounting.balance.totalLiabilities')}
                    total={b.liabilities.total}
                  />
                  <StatementSection
                    title={t('accounting.balance.equity')}
                    lines={[
                      ...b.equity.lines,
                      {
                        code: '—',
                        nameAr: t('accounting.balance.earnings'),
                        nameEn: t('accounting.balance.earnings'),
                        amount: b.equity.earnings,
                      },
                    ]}
                    totalLabel={t('accounting.balance.totalEquity')}
                    total={b.equity.total}
                  />
                  <ResultRow
                    label={t('accounting.balance.liabilitiesAndEquity')}
                    value={b.liabilitiesAndEquity}
                  />
                </div>
              </div>
              <p className="px-5 py-3 text-xs text-muted">{t('accounting.balance.earningsHint')}</p>
            </>
          );
        }}
      </Loading>
    </Card>
  );
}
