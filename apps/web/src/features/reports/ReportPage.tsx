import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import {
  LEAD_GROUPS,
  LEAD_SOURCES,
  ON_HAND_STATUSES,
  SALE_PAYMENT_TYPES,
  SALES_GROUPS,
  STOCK_AGE_BUCKETS,
  VEHICLE_STATUS_LABELS,
} from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtNumber, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import {
  CashAccountOption,
  isReportKey,
  MemberOption,
  ReportDef,
  reportDef,
  ReportKey,
  ReportResult,
  useBranchOptions,
} from './api';
import { BranchFilter, ExportLinks, PeriodFilter, ReconciliationPanel, ReportTable, SummaryGrid, useFilterParams, useLang, usePeriod } from './components';

const BUCKET_KEY: Record<(typeof STOCK_AGE_BUCKETS)[number], string> = { '0-30': 'b0_30', '31-60': 'b31_60', '61-90': 'b61_90', '90+': 'b90' };
/** URL parameters that are report filters (cleared by "Reset"). */
const FILTER_PARAMS = ['period', 'from', 'to', 'asOf', 'branchId', 'groupBy', 'status', 'bucket', 'source', 'paymentType', 'salespersonId', 'cashAccountId'];

const oneOf = <T extends string>(list: readonly T[], v: string): T | undefined => (list.includes(v as T) ? (v as T) : undefined);
const uuidLike = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : undefined);

/** /app/reports/:key — renders any ReportResult with its filters, summary, table and reconciliation. */
export function ReportPage() {
  const { key } = useParams();
  const { t } = useTranslation();
  if (!isReportKey(key)) return <EmptyState title="404" description={t('reports.notFound')} />;
  return <ReportView key={key} reportKey={key} />;
}

function ReportView({ reportKey }: { reportKey: ReportKey }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const def = reportDef(reportKey);
  if (!can(...def.perms)) return <EmptyState title={t('reports.forbidden')} />;
  return <ReportBody def={def} />;
}

function ReportBody({ def }: { def: ReportDef }) {
  const { t } = useTranslation();
  const lang = useLang();
  const { can, me, currency } = useAuth();
  const tz = me?.tenant?.settings.timezone;
  const lp = useFilterParams();
  const period = usePeriod(lp);
  const has = (f: ReportDef['filters'][number]) => def.filters.includes(f);
  const { branches, show: showBranches } = useBranchOptions();
  const canPickSalesperson = has('salesperson') && can('users.read');
  const members = useApi<MemberOption[]>(['users'], canPickSalesperson ? '/users' : null, undefined, { staleTime: 5 * 60_000 });
  const accounts = useApi<CashAccountOption[]>(['cash-accounts', 'list', 'all'], has('cashAccount') ? '/cash-accounts' : null, { includeInactive: 'true' }, { staleTime: 60_000 });

  // The query the API receives: only the filters this report accepts, with valid values.
  const filters: Record<string, string | undefined> = {
    ...(has('period') ? period.query : {}),
    ...(has('asOf') ? { asOf: /^\d{4}-\d{2}-\d{2}$/.test(lp.get('asOf')) ? lp.get('asOf') : undefined } : {}),
    ...(has('branch') ? { branchId: uuidLike(lp.get('branchId')) } : {}),
    ...(has('salesGroupBy') ? { groupBy: oneOf(SALES_GROUPS, lp.get('groupBy')) } : {}),
    ...(has('leadsGroupBy') ? { groupBy: oneOf(LEAD_GROUPS, lp.get('groupBy')) } : {}),
    ...(has('status') ? { status: oneOf(ON_HAND_STATUSES, lp.get('status')) } : {}),
    ...(has('bucket') ? { bucket: oneOf(STOCK_AGE_BUCKETS, lp.get('bucket')) } : {}),
    ...(has('source') ? { source: oneOf(LEAD_SOURCES, lp.get('source')) } : {}),
    ...(has('paymentType') ? { paymentType: oneOf(SALE_PAYMENT_TYPES, lp.get('paymentType')) } : {}),
    ...(has('salesperson') ? { salespersonId: uuidLike(lp.get('salespersonId')) } : {}),
    ...(has('cashAccount') ? { cashAccountId: uuidLike(lp.get('cashAccountId')) } : {}),
  };
  const blocked = has('period') && period.invalid;
  const q = useApi<ReportResult>(['report', def.key], blocked ? null : `/reports/${def.key}`, filters, { placeholderData: (p) => p });
  const report = q.data;
  const title = t(`reports.catalog.${def.i18nKey}.title`);
  const anyFilter = FILTER_PARAMS.some((k) => lp.get(k));
  const today = todayIso(tz);

  const selectField = (label: string, param: string, options: Array<{ value: string; label: string }>, all: string, width = 'sm:w-[200px]') => (
    <Field label={label} className={`w-full ${width}`}>
      {(id) => (
        <Select id={id} value={lp.get(param)} onChange={(e) => lp.set({ [param]: e.target.value })}>
          {all && <option value="">{all}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  return (
    <>
      <PageHeader
        title={title}
        subtitle={t(`reports.catalog.${def.i18nKey}.description`)}
        breadcrumbs={[{ label: t('reports.hub.title'), to: '/app/reports' }, { label: title }]}
        actions={can('reports.export') ? <ExportLinks reportKey={def.key} filters={filters} disabled={blocked || !report} /> : undefined}
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3 p-4">
          {has('period') && <PeriodFilter lp={lp} period={period} />}
          {has('asOf') && (
            <Field label={t('reports.filters.asOf')} className="w-[170px]">
              {(id) => <Input id={id} type="date" value={lp.get('asOf') || today} onChange={(e) => lp.set({ asOf: e.target.value })} />}
            </Field>
          )}
          {has('branch') && showBranches && <BranchFilter value={lp.get('branchId')} onChange={(v) => lp.set({ branchId: v })} branches={branches} />}
          {has('salesGroupBy') &&
            selectField(
              t('reports.filters.groupBy'),
              'groupBy',
              SALES_GROUPS.map((g) => ({ value: g, label: t(`reports.groupBy.${g}`) })),
              t('reports.filters.noGrouping'),
              'sm:w-[230px]',
            )}
          {has('leadsGroupBy') &&
            selectField(
              t('reports.filters.groupBy'),
              'groupBy',
              LEAD_GROUPS.map((g) => ({ value: g === 'source' ? '' : g, label: t(`reports.groupBy.${g}`) })),
              '',
            )}
          {has('status') &&
            selectField(
              t('reports.filters.status'),
              'status',
              ON_HAND_STATUSES.map((s) => ({ value: s, label: VEHICLE_STATUS_LABELS[s][lang] })),
              t('reports.filters.allStatuses'),
            )}
          {has('bucket') &&
            selectField(
              t('reports.filters.bucket'),
              'bucket',
              STOCK_AGE_BUCKETS.map((b) => ({ value: b, label: t(`reports.buckets.${BUCKET_KEY[b]}`) })),
              t('reports.filters.allBuckets'),
            )}
          {has('source') &&
            selectField(
              t('reports.filters.source'),
              'source',
              LEAD_SOURCES.map((s) => ({ value: s, label: t(`reports.sources.${s}`) })),
              t('reports.filters.allSources'),
            )}
          {has('paymentType') &&
            selectField(
              t('reports.filters.paymentType'),
              'paymentType',
              SALE_PAYMENT_TYPES.map((p) => ({ value: p, label: t(`reports.paymentTypes.${p}`) })),
              t('reports.filters.allPaymentTypes'),
            )}
          {canPickSalesperson &&
            selectField(
              t('reports.filters.salesperson'),
              'salespersonId',
              (members.data ?? []).map((m) => ({ value: m.userId, label: m.status === 'active' ? m.fullName : `${m.fullName} (${t('common.inactive')})` })),
              t('reports.filters.allSalespeople'),
            )}
          {has('cashAccount') &&
            selectField(
              t('reports.filters.cashAccount'),
              'cashAccountId',
              (accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}${a.isActive ? '' : ` (${t('common.inactive')})`}` })),
              t('reports.filters.allCashAccounts'),
              'sm:w-[240px]',
            )}
          {anyFilter && (
            <Button variant="ghost" onClick={() => lp.set(Object.fromEntries(FILTER_PARAMS.map((k) => [k, null])))}>
              {t('reports.filters.reset')}
            </Button>
          )}
        </div>
        {report && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-[12.5px] text-muted">
            {report.params.from && report.params.to && (
              <span className="num">{t('reports.meta.period', { from: fmtDate(report.params.from), to: fmtDate(report.params.to) })}</span>
            )}
            {report.params.asOf && <span className="num">{t('reports.meta.asOf', { date: fmtDate(report.params.asOf) })}</span>}
            <span className="num">{t('reports.meta.generatedAt', { time: fmtDateTime(report.generatedAt, tz) })}</span>
            <span>{t('reports.meta.currency', { currency })}</span>
          </div>
        )}
      </Card>

      {q.error && !blocked ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <div className="space-y-4">
          {report?.truncated && (
            <Alert tone="warning" title={t('reports.truncated.title')}>
              {t('reports.truncated.body')}
            </Alert>
          )}
          {report && <SummaryGrid report={report} currency={currency} />}
          <Card aria-busy={q.isFetching || undefined}>
            <CardHeader
              title={report ? (lang === 'en' ? report.titleEn : report.titleAr) : title}
              subtitle={report ? <span className="num">{t('reports.table.rowsCount', { n: fmtNumber(report.rows.length) })}</span> : undefined}
              actions={
                q.isFetching && report ? (
                  <span className="text-xs text-muted" role="status">
                    {t('common.loading')}
                  </span>
                ) : undefined
              }
            />
            {blocked ? (
              <EmptyState icon={<AlertTriangle className="h-5 w-5" />} title={t('reports.filters.invalidRange')} />
            ) : (
              <ReportTable report={report} currency={currency} loading={q.isLoading} />
            )}
          </Card>
          {report && <ReconciliationPanel report={report} currency={currency} />}
        </div>
      )}
    </>
  );
}
