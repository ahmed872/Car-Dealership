import clsx from 'clsx';
import { ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Download, FileSpreadsheet, FileText, Inbox, Scale } from 'lucide-react';
import { ReactNode, useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { addDays, addMonths, d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';
import { Pagination } from '@/components/ui/DataTable';
import { Alert, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { buildUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney, fmtNumber, fmtPct, todayIso } from '@/lib/format';
import { BranchOption, DRILL_DOWN, ReportCell, ReportColumn, ReportKey, ReportResult } from './api';


/**
 * Filter state kept in the URL (shareable, back-button friendly). Each update starts from the live
 * URL rather than the router's params: React Router applies search changes in a transition, so
 * its params can lag behind two quick edits and the second would undo the first.
 */
export function useFilterParams() {
  const [params, setParams] = useSearchParams();
  const get = useCallback((k: string) => params.get(k) ?? '', [params]);
  const set = useCallback(
    (updates: Record<string, string | null | undefined>) =>
      setParams(
        () => {
          const next = new URLSearchParams(window.location.search);
          for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === undefined || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return { get, set };
}
type ListParams = ReturnType<typeof useFilterParams>;
type Query = Record<string, string | undefined>;

export const useLang = (): 'ar' | 'en' => (useTranslation().i18n.language === 'en' ? 'en' : 'ar');
export const pickLabel = (x: { labelAr: string; labelEn: string }, lang: 'ar' | 'en') => (lang === 'en' ? x.labelEn : x.labelAr);

// ── Period ───────────────────────────────────────────────────────────────────────────────

export type PeriodPreset = 'month' | 'last' | 'custom';
const PRESETS: PeriodPreset[] = ['month', 'last', 'custom'];

/**
 * The period in the URL (`period`, `from`, `to`). "This month" sends nothing, so the server's
 * default (the 1st of the month to today, company time zone) applies; "last month" is computed
 * from today in the company time zone.
 */
export function usePeriod(lp: ListParams) {
  const { me } = useAuth();
  const raw = lp.get('period');
  const preset: PeriodPreset = PRESETS.includes(raw as PeriodPreset) ? (raw as PeriodPreset) : 'month';
  const today = todayIso(me?.tenant?.settings.timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  let from = monthStart;
  let to = today;
  if (preset === 'last') {
    from = addMonths(monthStart, -1);
    to = addDays(monthStart, -1);
  } else if (preset === 'custom') {
    from = lp.get('from');
    to = lp.get('to');
  }
  const invalid = preset === 'custom' && !!from && !!to && from > to;
  const query: Query = preset === 'month' ? {} : { from: from || undefined, to: to || undefined };
  return { preset, from, to, invalid, query };
}

export function PeriodFilter({ lp, period }: { lp: ListParams; period: ReturnType<typeof usePeriod> }) {
  const { t } = useTranslation();
  const labelId = useId();
  const choose = (p: PeriodPreset) => {
    if (p === period.preset) return;
    // Switching to a custom range starts from the range currently shown.
    if (p === 'custom') lp.set({ period: 'custom', from: period.from, to: period.to });
    else lp.set({ period: p === 'month' ? null : p, from: null, to: null });
  };
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="min-w-0">
        <span className="label" id={labelId}>
          {t('reports.filters.period')}
        </span>
        <div role="group" aria-labelledby={labelId} className="inline-flex h-10 rounded-lg border border-line bg-surface-2 p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period.preset === p}
              onClick={() => choose(p)}
              className={clsx(
                'rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors',
                period.preset === p ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
              )}
            >
              {t(`reports.filters.${p === 'month' ? 'thisMonth' : p === 'last' ? 'lastMonth' : 'custom'}`)}
            </button>
          ))}
        </div>
      </div>
      {period.preset === 'custom' && <CustomRange lp={lp} from={period.from} to={period.to} />}
    </div>
  );
}

/** From/to inputs of a custom period; the local draft keeps typing responsive while the URL updates. */
function CustomRange({ lp, from, to }: { lp: ListParams; from: string; to: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState({ from, to });
  const invalid = !!draft.from && !!draft.to && draft.from > draft.to;
  const change = (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    lp.set({ period: 'custom', from: next.from, to: next.to });
  };
  return (
    <>
      <Field label={t('reports.filters.from')} className="w-[160px]" error={invalid ? t('reports.filters.invalidRange') : null}>
        {(id, describedBy) => (
          <Input
            id={id}
            type="date"
            value={draft.from}
            max={draft.to || undefined}
            aria-describedby={describedBy}
            invalid={invalid}
            onChange={(e) => change({ from: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('reports.filters.to')} className="w-[160px]">
        {(id) => <Input id={id} type="date" value={draft.to} min={draft.from || undefined} invalid={invalid} onChange={(e) => change({ to: e.target.value })} />}
      </Field>
    </>
  );
}

export function BranchFilter({ value, onChange, branches }: { value: string; onChange: (v: string) => void; branches: BranchOption[] }) {
  const { t } = useTranslation();
  return (
    <Field label={t('reports.filters.branch')} className="w-full sm:w-[200px]">
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('reports.filters.allBranches')}</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

// ── Cell formatting ──────────────────────────────────────────────────────────────────────

const NUMERIC = new Set(['money', 'number', 'percent']);
export const isNumeric = (type: string) => NUMERIC.has(type);

/** "2026-10" → "Oct 2026" in the current language (Latin digits, like every figure in the app). */
export function monthLabel(ym: string, lang: 'ar' | 'en', style: 'short' | 'long' = 'short'): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { month: style, year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** "2026-10" → "Oct" / "أكتوبر" (the year is shown separately). */
function monthName(ym: string, lang: 'ar' | 'en'): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

function decimals(v: string | number): number {
  const s = String(v);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(s.length - i - 1, 2);
}

/** Display text of one report value by its declared type (money stays a decimal string). */
export function formatValue(
  c: Pick<ReportColumn, 'type' | 'options'>,
  v: ReportCell | undefined,
  lang: 'ar' | 'en',
  currency: string,
): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (c.type) {
    case 'money':
      return fmtMoney(String(v), currency);
    case 'percent':
      return fmtPct(v, 2);
    case 'number':
      return fmtNumber(v, decimals(v));
    case 'date':
      return fmtDate(String(v));
    case 'enum': {
      const o = c.options?.[String(v)];
      return o ? (lang === 'en' ? o.en : o.ar) : String(v);
    }
    default:
      return String(v);
  }
}

/**
 * The currency of a money cell. Rows that carry their own `currency` (cash accounts) show their
 * amounts in it, except base-currency columns (`…Base`); totals and summaries are in the base.
 */
function cellCurrency(c: ReportColumn, row: Record<string, ReportCell> | null, base: string): string {
  const own = row?.currency;
  return typeof own === 'string' && own && !c.key.endsWith('Base') ? own : base;
}

function compare(c: ReportColumn, a: ReportCell | undefined, b: ReportCell | undefined, lang: 'ar' | 'en'): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  // Decimal comparison of the exact strings: no float conversion of money.
  if (isNumeric(c.type)) return d(String(a)).cmp(d(String(b)));
  if (c.type === 'enum') return formatValue(c, a, lang, '').localeCompare(formatValue(c, b, lang, ''), lang);
  return String(a).localeCompare(String(b), lang);
}

// ── Report table ─────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

/**
 * Renders any `ReportResult` table: columns typed by the API, a totals row, client-side sort and
 * paging over the rows the API returned, and drill-down links on the first column.
 */
export function ReportTable({ report, currency, loading }: { report: ReportResult | undefined; currency: string; loading?: boolean }) {
  const { t } = useTranslation();
  const lang = useLang();
  const { can } = useAuth();
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [page, setPage] = useState(1);
  // Other filters (a new result shape) start again from the first page.
  const paramsKey = JSON.stringify(report?.params ?? null);
  const [seen, setSeen] = useState(paramsKey);
  if (paramsKey !== seen) {
    setSeen(paramsKey);
    setPage(1);
  }
  const columns = report?.columns ?? [];
  const sorted = useMemo(() => {
    const rows = report?.rows ?? [];
    if (!sort) return rows;
    const col = report?.columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    return [...rows].sort((a, b) => (sort.desc ? -1 : 1) * compare(col, a[col.key], b[col.key], lang));
  }, [report, sort, lang]);
  const drill = report?.drillDown && can(DRILL_DOWN[report.drillDown.kind].perm) ? report.drillDown : null;
  const monthGroups = report?.params.groupBy === 'month';

  if (!report) {
    if (!loading) return null;
    return (
      <div className="space-y-3 p-4" aria-hidden>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }
  if (report.rows.length === 0) {
    return <EmptyState icon={<Inbox className="h-5 w-5" />} title={t('reports.table.empty')} description={t('reports.table.emptyHint')} />;
  }
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const alignOf = (c: ReportColumn) => (isNumeric(c.type) ? 'text-end' : 'text-start');

  const cell = (c: ReportColumn, row: Record<string, ReportCell>, i: number): ReactNode => {
    let text = formatValue(c, row[c.key], lang, cellCurrency(c, row, currency));
    if (monthGroups && c.key === 'group' && typeof row[c.key] === 'string') text = monthLabel(row[c.key] as string, lang, 'long');
    if (i === 0 && drill) {
      const id = row[drill.idKey];
      if (typeof id === 'string' && id) {
        return (
          <Link to={DRILL_DOWN[drill.kind].path(id)} className="font-medium text-brand-strong hover:underline">
            {text}
          </Link>
        );
      }
    }
    return text;
  };

  return (
    <div className="w-full">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2/60">
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const label = pickLabel(c, lang);
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}
                    className={clsx('px-3 py-2.5 text-[12px] font-semibold tracking-wide text-muted whitespace-nowrap', alignOf(c))}
                  >
                    <button
                      type="button"
                      title={t('reports.table.sortBy', { column: label })}
                      className={clsx('inline-flex items-center gap-1 hover:text-ink', isNumeric(c.type) && 'flex-row-reverse')}
                      onClick={() => setSort(active ? (sort.desc ? null : { key: c.key, desc: true }) : { key: c.key, desc: false })}
                    >
                      {label}
                      {active ? (
                        sort.desc ? (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr key={String(row.id ?? row.groupKey ?? `${page}-${ri}`)} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={clsx(
                      'px-3 py-2.5 align-middle whitespace-nowrap',
                      alignOf(c),
                      isNumeric(c.type) && 'num',
                      c.type === 'money' && String(row[c.key] ?? '').startsWith('-') && 'text-danger',
                    )}
                  >
                    {cell(c, row, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {report.totals && (
            <tfoot>
              <tr className="border-t-2 border-line-strong bg-surface-2/60 font-semibold">
                {columns.map((c, i) => (
                  <td key={c.key} className={clsx('px-3 py-2.5 whitespace-nowrap', alignOf(c), isNumeric(c.type) && 'num')}>
                    {i === 0 ? t('reports.table.total') : report.totals![c.key] === undefined ? '' : formatValue(c, report.totals![c.key], lang, currency)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {sorted.length > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={sorted.length} onPage={setPage} />}
    </div>
  );
}

// ── Summary, reconciliation, export ──────────────────────────────────────────────────────

export function SummaryGrid({ report, currency }: { report: ReportResult; currency: string }) {
  const { t } = useTranslation();
  const lang = useLang();
  if (!report.summary.length) return null;
  return (
    <section aria-label={t('reports.summary')} className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
      {report.summary.map((s) => (
        <div key={s.key} className="card min-w-0 px-4 py-3">
          <p className="text-[12.5px] text-muted">{pickLabel(s, lang)}</p>
          <p className={clsx('num mt-0.5 truncate text-[17px] font-semibold text-ink', s.type === 'money' && String(s.value ?? '').startsWith('-') && 'text-danger')}>
            {formatValue(s, s.value, lang, currency)}
          </p>
        </div>
      ))}
    </section>
  );
}

export function ReconciliationPanel({ report, currency }: { report: ReportResult; currency: string }) {
  const { t } = useTranslation();
  const lang = useLang();
  const items = report.reconciliation;
  if (!items) {
    return (
      <p className="flex items-start gap-2 text-[13px] text-muted">
        <Scale className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {t('reports.reconciliation.notShown')}
      </p>
    );
  }
  if (!items.length) return null;
  const allZero = items.every((x) => d(x.difference).isZero());
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Scale className="h-4 w-4 text-muted" aria-hidden />
            {t('reports.reconciliation.title')}
          </span>
        }
        subtitle={t('reports.reconciliation.subtitle')}
        actions={
          allZero ? (
            <Badge tone="success">{t('reports.reconciliation.balanced')}</Badge>
          ) : (
            <Badge tone="danger">{t('reports.reconciliation.mismatch')}</Badge>
          )
        }
      />
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
              <th scope="col" className="px-4 py-2.5 text-start font-semibold">
                {t('reports.reconciliation.item')}
              </th>
              <th scope="col" className="px-4 py-2.5 text-end font-semibold">
                {t('reports.reconciliation.report')}
              </th>
              <th scope="col" className="px-4 py-2.5 text-end font-semibold">
                {t('reports.reconciliation.ledger')}
              </th>
              <th scope="col" className="px-4 py-2.5 text-end font-semibold">
                {t('reports.reconciliation.difference')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((x, i) => {
              const zero = d(x.difference).isZero();
              return (
                <tr key={i} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">{pickLabel(x, lang)}</td>
                  <td className="num px-4 py-2.5 text-end whitespace-nowrap">{fmtMoney(x.report, currency)}</td>
                  <td className="num px-4 py-2.5 text-end whitespace-nowrap">{fmtMoney(x.ledger, currency)}</td>
                  <td className={clsx('num px-4 py-2.5 text-end font-semibold whitespace-nowrap', zero ? 'text-success' : 'bg-danger-soft text-danger')}>
                    <span className="inline-flex items-center gap-1.5">
                      {zero && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                      {fmtMoney(x.difference, currency)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line px-5 py-3">
        {allZero ? (
          <p className="text-[13px] text-muted">{t('reports.reconciliation.allBalanced')}</p>
        ) : (
          <Alert tone="danger">{t('reports.reconciliation.hasDifference')}</Alert>
        )}
      </div>
    </Card>
  );
}

const FORMATS = [
  { format: 'csv', labelKey: 'reports.export.csv', Icon: FileText },
  { format: 'xlsx', labelKey: 'reports.export.excel', Icon: FileSpreadsheet },
  { format: 'pdf', labelKey: 'reports.export.pdf', Icon: Download },
] as const;

/**
 * Plain download links (the session cookie authenticates them) to GET /reports/:key/export with
 * the same filters as the screen and the current language.
 */
export function ExportLinks({ reportKey, filters, disabled }: { reportKey: ReportKey; filters: Query; disabled?: boolean }) {
  const { t } = useTranslation();
  const lang = useLang();
  return (
    <div role="group" aria-label={t('reports.export.label')} title={t('reports.export.hint')} className="inline-flex flex-wrap items-center gap-2">
      {FORMATS.map(({ format, labelKey, Icon }) =>
        disabled ? (
          <span
            key={format}
            aria-disabled
            className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 text-[13px] font-medium text-ink opacity-55"
          >
            <Icon className="h-4 w-4" aria-hidden />
            {t(labelKey)}
          </span>
        ) : (
          <a
            key={format}
            href={buildUrl(`/reports/${reportKey}/export`, { format, locale: lang, ...filters })}
            download
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 text-[13px] font-medium whitespace-nowrap text-ink transition-colors hover:bg-surface-3"
          >
            <Icon className="h-4 w-4" aria-hidden />
            {t(labelKey)}
          </a>
        ),
      )}
    </div>
  );
}

// ── Trend chart ──────────────────────────────────────────────────────────────────────────

// A normal space (Intl uses a no-break space) lets "232.2 ألف" wrap between number and unit on phones.
const compact = (v: string, lang: 'ar' | 'en') =>
  new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(v)).replace(/[\u00a0\u202f]/g, ' ');

/**
 * Single-series bar chart of monthly net revenue for the six months ending with `endMonth`
 * (months without sales show as zero). Bar heights are proportions only; the exact figures are in
 * the tooltip and in the screen-reader table.
 */
export function RevenueTrend({
  monthly,
  endMonth,
  currency,
}: {
  monthly: Array<{ month: string; units: number; netRevenue: string }>;
  endMonth: string;
  currency: string;
}) {
  const { t } = useTranslation();
  const lang = useLang();
  const months = Array.from({ length: 6 }, (_, i) => addMonths(`${endMonth}-01`, i - 5).slice(0, 7));
  const byMonth = new Map(monthly.map((m) => [m.month, m]));
  const data = months.map((m) => byMonth.get(m) ?? { month: m, units: 0, netRevenue: '0.00' });
  const max = Math.max(0, ...data.map((m) => Number(m.netRevenue)));
  if (max === 0 && data.every((m) => d(m.netRevenue).isZero())) {
    return <EmptyState icon={<Inbox className="h-5 w-5" />} title={t('reports.dashboard.sales.trendEmpty')} />;
  }
  return (
    <figure className="px-5 pt-6 pb-4">
      <div aria-hidden className="relative flex h-48 items-end gap-2 border-b border-line-strong sm:gap-4">
        {data.map((m, i) => {
          const value = Number(m.netRevenue);
          const pct = max > 0 && value > 0 ? Math.max(2, (value / max) * 100) : 0;
          const last = i === data.length - 1;
          return (
            <div key={m.month} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end">
              {(last || value === max) && value > 0 && (
                <span className="num mb-1 max-w-full text-center text-[11px] leading-tight font-medium text-muted">{compact(m.netRevenue, lang)}</span>
              )}
              <div
                className={clsx('w-full max-w-14 rounded-t-[4px] transition-opacity group-hover:opacity-80', value < 0 ? 'bg-danger' : 'bg-brand')}
                style={{ height: value < 0 ? '3px' : `${pct}%` }}
              />
              <div className="pointer-events-none absolute bottom-full z-10 mb-1 hidden w-max max-w-[220px] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop group-hover:block">
                <p className="font-medium text-ink">{monthLabel(m.month, lang, 'long')}</p>
                <p className="num text-ink">{fmtMoney(m.netRevenue, currency)}</p>
                <p className="num text-muted">{t('reports.dashboard.sales.unitsShort', { count: m.units })}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div aria-hidden className="mt-2 flex gap-2 sm:gap-4">
        {data.map((m, i) => (
          <span key={m.month} className="min-w-0 flex-1 text-center text-[11px] leading-tight text-muted">
            <span className="block truncate">{monthName(m.month, lang)}</span>
            {(i === 0 || m.month.endsWith('-01')) && <span className="num block text-subtle">{m.month.slice(0, 4)}</span>}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{t('reports.dashboard.sales.trendTitle')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('reports.dashboard.sales.month')}</th>
            <th scope="col">{t('reports.dashboard.sales.netRevenue')}</th>
            <th scope="col">{t('reports.dashboard.sales.units')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((m) => (
            <tr key={m.month}>
              <th scope="row">{monthLabel(m.month, lang, 'long')}</th>
              <td>{fmtMoney(m.netRevenue, currency)}</td>
              <td>{m.units}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
