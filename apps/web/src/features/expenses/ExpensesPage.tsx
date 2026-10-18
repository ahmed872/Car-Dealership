import { Clock, Plus, Receipt, RotateCcw, Search, Tags } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { PageHeader, Tabs, Toolbar } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { DateRange, Money, useAccessibleBranches } from '@/features/cash/finance-ui';
import {
  categoryName,
  ExpenseListItem,
  ExpenseStatus,
  ExpenseSummary,
  Paged,
  useExpenseCategories,
} from './api';
import { ExpenseStatusBadge } from './components';
import { ExpenseFormModal } from './ExpenseFormModal';

const STATUSES: ExpenseStatus[] = ['pending_approval', 'posted', 'rejected', 'reversed'];

/** "2026-10" → localized month name and year. */
function monthLabel(month: string, lang: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

function pct(part: string, total: string): string {
  if (d(total).isZero()) return '0';
  return d(part).div(total).times(100).toFixed(0);
}

function SummaryPanel({
  data,
  loading,
  error,
  onRetry,
}: {
  data: ExpenseSummary | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Card className="mb-4">
      <CardHeader
        title={t('expenses.summary.byCategory')}
        subtitle={
          data
            ? data.from || data.to
              ? `${data.from ? fmtDate(data.from) : '…'} — ${data.to ? fmtDate(data.to) : '…'}`
              : t('expenses.summary.periodAll')
            : undefined
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading && !data ? (
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !data || data.byCategory.length === 0 ? (
        <EmptyState icon={<Tags className="h-5 w-5" />} title={t('expenses.summary.none')} />
      ) : (
        <>
          <ul className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
            {data.byCategory.map((c) => {
              const share = pct(c.totalBase, data.totalBase);
              return (
                <li key={c.categoryId} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-ink">
                      {categoryName(c, i18n.language)}
                    </span>
                    <Money value={c.totalBase} currency={data.currency} className="text-[13px]" />
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                    <div className="h-full rounded-full bg-brand" style={{ width: `${share}%` }} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {t('expenses.summary.share', { pct: share })} ·{' '}
                    {t('expenses.summary.count', { count: c.count })}
                  </p>
                </li>
              );
            })}
          </ul>
          {data.byMonth.length > 1 && (
            <div className="border-t border-line px-5 py-3">
              <h3 className="mb-2 text-xs font-semibold text-muted">{t('expenses.summary.byMonth')}</h3>
              <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-[13px]">
                {data.byMonth.map((m) => (
                  <div key={m.month} className="flex items-center gap-2">
                    <dt className="text-muted">{monthLabel(m.month, i18n.language)}</dt>
                    <dd>
                      <Money value={m.totalBase} currency={data.currency} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can, currency: base } = useAuth();
  const lp = useListParams();
  const branches = useAccessibleBranches();
  const categories = useExpenseCategories();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(lp.get('q'));
  const q = useDebounced(search.trim(), 300);

  const status = lp.get('status') as ExpenseStatus | '';
  const filters = {
    status: status || undefined,
    branchId: lp.get('branch') || undefined,
    categoryId: lp.get('category') || undefined,
    from: lp.get('from') || undefined,
    to: lp.get('to') || undefined,
  };
  const sort = lp.get('sort') || '-expenseDate';
  const list = useApi<Paged<ExpenseListItem>>(
    ['expenses', 'list'],
    '/expenses',
    { ...filters, q: q || undefined, sort, page: lp.page, pageSize: 25 },
    { placeholderData: (p) => p },
  );
  const summary = useApi<ExpenseSummary>(['expenses', 'summary'], '/expenses/summary', {
    branchId: filters.branchId,
    from: filters.from,
    to: filters.to,
  });
  const pending = useApi<Paged<ExpenseListItem>>(['expenses', 'pending-count'], '/expenses', {
    status: 'pending_approval',
    branchId: filters.branchId,
    pageSize: 1,
  });
  const filtered = Object.values(filters).some(Boolean) || !!q;
  const top = summary.data?.byCategory[0];

  return (
    <>
      <PageHeader
        title={t('expenses.list.title')}
        subtitle={t('expenses.list.subtitle')}
        actions={
          <Can perm="expenses.create">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              {t('expenses.list.add')}
            </Button>
          </Can>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t('expenses.summary.total')}
          value={summary.data ? fmtMoney(summary.data.totalBase, summary.data.currency) : '…'}
          hint={summary.data ? t('expenses.summary.totalHint', { count: summary.data.count }) : undefined}
          icon={<Receipt className="h-5 w-5" />}
          tone="brand"
        />
        <StatCard
          label={t('expenses.summary.pending')}
          value={pending.data ? pending.data.total : '…'}
          hint={t('expenses.summary.pendingHint')}
          icon={<Clock className="h-5 w-5" />}
          tone="warning"
          onClick={() => lp.set({ status: 'pending_approval' })}
        />
        <StatCard
          label={t('expenses.summary.topCategory')}
          value={top ? categoryName(top, i18n.language) : '—'}
          hint={top ? fmtMoney(top.totalBase, summary.data!.currency) : undefined}
          icon={<Tags className="h-5 w-5" />}
          tone="info"
          onClick={top ? () => lp.set({ category: top.categoryId }) : undefined}
        />
      </div>

      <SummaryPanel
        data={summary.data}
        loading={summary.isLoading}
        error={summary.error}
        onRetry={() => summary.refetch()}
      />

      <Card className="min-w-0">
        <div className="px-4 pt-2">
          <Tabs
            value={status || 'all'}
            onChange={(k) => lp.set({ status: k === 'all' ? null : k })}
            tabs={[
              { key: 'all', label: t('common.all') },
              ...STATUSES.map((s) => ({ key: s, label: t(`expenses.status.${s}`) })),
            ]}
          />
        </div>
        <Toolbar>
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-subtle"
              aria-hidden
            />
            <Input
              className="ps-9"
              value={search}
              placeholder={t('expenses.list.searchPlaceholder')}
              aria-label={t('common.search')}
              onChange={(e) => {
                setSearch(e.target.value);
                lp.set({ q: e.target.value.trim() || null });
              }}
            />
          </div>
          {branches.branches.length > 1 && (
            <Select
              className="w-full sm:w-auto sm:min-w-[160px]"
              value={lp.get('branch')}
              onChange={(e) => lp.set({ branch: e.target.value })}
              aria-label={t('common.branch')}
            >
              <option value="">{t('expenses.list.allBranches')}</option>
              {branches.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
          <Select
            className="w-full sm:w-auto sm:min-w-[170px]"
            value={lp.get('category')}
            onChange={(e) => lp.set({ category: e.target.value })}
            aria-label={t('expenses.list.category')}
          >
            <option value="">{t('expenses.list.allCategories')}</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {categoryName(c, i18n.language)}
              </option>
            ))}
          </Select>
          <DateRange from={lp.get('from')} to={lp.get('to')} onChange={(v) => lp.set(v)} />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={() => {
                setSearch('');
                lp.set({ status: null, branch: null, category: null, from: null, to: null, q: null });
              }}
            >
              {t('common.clearFilters')}
            </Button>
          )}
        </Toolbar>
        <DataTable
          rows={list.data?.items}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/app/expenses/${r.id}`)}
          sort={sort}
          onSortChange={(s) => lp.set({ sort: s })}
          empty={
            <EmptyState
              icon={<Receipt className="h-5 w-5" />}
              title={filtered ? t('expenses.list.emptyFiltered') : t('expenses.list.empty')}
              description={filtered ? undefined : t('expenses.list.emptyHint')}
              action={
                !filtered &&
                can('expenses.create') && (
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                    {t('expenses.list.add')}
                  </Button>
                )
              }
            />
          }
          footer={
            list.data && (
              <Pagination
                page={lp.page}
                pageSize={list.data.pageSize}
                total={list.data.total}
                onPage={(p) => lp.set({ page: p }, false)}
              />
            )
          }
          columns={[
            {
              key: 'date',
              header: t('common.date'),
              sortKey: 'expenseDate',
              hideOnMobile: true,
              cell: (r) => (
                <div>
                  <p className="num whitespace-nowrap">{fmtDate(r.expenseDate)}</p>
                  <p className="num text-xs font-medium whitespace-nowrap text-muted">
                    <bdi>{r.number}</bdi>
                  </p>
                </div>
              ),
            },
            {
              key: 'expense',
              header: t('expenses.list.expense'),
              cell: (r) => (
                <div className="max-w-[320px] min-w-0 md:min-w-[160px]">
                  <p className="truncate font-medium">{r.description}</p>
                  <p className="truncate text-xs text-muted">{categoryName(r, i18n.language)}</p>
                  {/* Phones: date, number and status live here (their columns are hidden). */}
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
                    <span className="num text-xs text-muted">{fmtDate(r.expenseDate)}</span>
                    <bdi className="num text-xs text-muted">{r.number}</bdi>
                    <Money value={r.amount} currency={r.currency} className="text-xs font-semibold" />
                    <ExpenseStatusBadge status={r.status} />
                  </p>
                </div>
              ),
            },
            {
              key: 'branch',
              header: t('common.branch'),
              hideOnMobile: true,
              cell: (r) => <span className="text-[13px] whitespace-nowrap">{r.branchName}</span>,
            },
            {
              key: 'supplier',
              header: t('expenses.list.supplier'),
              hideOnMobile: true,
              cell: (r) =>
                r.supplierName ? (
                  <span className="block max-w-[200px] truncate text-[13px]" title={r.supplierName}>
                    {r.supplierName}
                  </span>
                ) : (
                  <span className="text-xs whitespace-nowrap text-subtle">
                    {t('expenses.list.noSupplier')}
                  </span>
                ),
            },
            {
              key: 'amount',
              header: t('expenses.list.amount'),
              align: 'end',
              sortKey: 'amountBase',
              cell: (r) => (
                <div>
                  <Money value={r.amount} currency={r.currency} className="font-semibold" />
                  {r.currency !== base && (
                    <p className="text-xs text-muted">
                      <Money value={r.amountBase} currency={base} />
                    </p>
                  )}
                </div>
              ),
            },
            {
              key: 'payment',
              header: t('expenses.list.payment'),
              hideOnMobile: true,
              cell: (r) =>
                r.outstandingBase === null ? (
                  <span className="text-xs text-subtle">—</span>
                ) : d(r.outstandingBase).isZero() ? (
                  <span className="text-xs font-medium whitespace-nowrap text-success">
                    {t('expenses.list.paidInFull')}
                  </span>
                ) : (
                  <span className="text-xs font-medium whitespace-nowrap text-warning">
                    {t('expenses.list.outstanding', { value: fmtMoney(r.outstandingBase, base) })}
                  </span>
                ),
            },
            {
              key: 'status',
              header: t('common.status'),
              hideOnMobile: true,
              cell: (r) => <ExpenseStatusBadge status={r.status} />,
            },
          ]}
        />
      </Card>

      {creating && (
        <ExpenseFormModal
          onClose={() => setCreating(false)}
          onDone={(e) => {
            setCreating(false);
            navigate(`/app/expenses/${e.id}`);
          }}
        />
      )}
    </>
  );
}
