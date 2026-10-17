import { HandCoins, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { SALE_PAYMENT_TYPES, SALE_STATUSES } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { Paged, SaleListItem } from './api';
import { Money, PaymentTypeBadge, SaleStatusBadge, vehicleSnapshotTitle } from './shared';

export function SalesListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const lp = useListParams();
  const [search, setSearch] = useState(lp.get('q'));
  const debounced = useDebounced(search, 350);
  useEffect(() => {
    if (debounced !== lp.get('q')) lp.set({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const pageSize = 25;
  const q = useApi<Paged<SaleListItem>>(
    ['sales'],
    '/sales',
    {
      page: lp.page,
      pageSize,
      q: lp.get('q') || undefined,
      status: lp.get('status') || undefined,
      paymentType: lp.get('paymentType') || undefined,
      mine: lp.get('mine') === 'true' ? 'true' : undefined,
    },
    { placeholderData: (p) => p },
  );
  const filtered = ['q', 'status', 'paymentType', 'mine'].some((k) => lp.get(k));

  return (
    <>
      <PageHeader
        title={t('sales.title')}
        subtitle={t('sales.subtitle')}
        actions={
          <Can perm="sales.create">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/sales/new')}>
              {t('sales.new')}
            </Button>
          </Can>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1.6fr)_repeat(2,minmax(160px,1fr))_auto] lg:items-center">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('sales.list.searchHint')}
              aria-label={t('common.search')}
              className="ps-9"
            />
          </div>
          <Select value={lp.get('status')} onChange={(e) => lp.set({ status: e.target.value })} aria-label={t('common.status')}>
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            {SALE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`sales.status.${s}`)}
              </option>
            ))}
          </Select>
          <Select value={lp.get('paymentType')} onChange={(e) => lp.set({ paymentType: e.target.value })} aria-label={t('sales.fields.paymentType')}>
            <option value="">
              {t('sales.fields.paymentType')}: {t('common.all')}
            </option>
            {SALE_PAYMENT_TYPES.map((p) => (
              <option key={p} value={p}>
                {t(`sales.paymentType.${p}`)}
              </option>
            ))}
          </Select>
          <div className="flex items-center justify-between gap-3">
            <Checkbox label={t('sales.list.mine')} checked={lp.get('mine') === 'true'} onChange={(e) => lp.set({ mine: e.target.checked ? 'true' : null })} />
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch('');
                  lp.set({ q: null, status: null, paymentType: null, mine: null });
                }}
              >
                {t('common.clearFilters')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/app/sales/${s.id}`)}
          empty={
            <EmptyState
              icon={<HandCoins className="h-5 w-5" />}
              title={filtered ? t('common.noResults') : t('sales.list.empty')}
              description={filtered ? undefined : t('sales.list.emptyHint')}
              action={
                !filtered &&
                can('sales.create') && (
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/sales/new')}>
                    {t('sales.new')}
                  </Button>
                )
              }
            />
          }
          columns={[
            {
              key: 'number',
              header: t('sales.fields.number'),
              cell: (s) => (
                <div>
                  <p className="num font-medium">{s.number}</p>
                  <p className="text-xs text-muted">{fmtDate(s.saleDate)}</p>
                </div>
              ),
            },
            {
              key: 'customer',
              header: t('sales.fields.customer'),
              cell: (s) => <p className="max-w-[200px] truncate">{s.customerName}</p>,
            },
            {
              key: 'vehicle',
              header: t('sales.fields.vehicle'),
              cell: (s) => (
                <div className="min-w-0">
                  <p className="max-w-[240px] truncate font-medium">{vehicleSnapshotTitle(s.vehicle, i18n.language)}</p>
                  <p className="num truncate text-xs text-muted">{s.stockNumber}</p>
                </div>
              ),
            },
            {
              key: 'salesperson',
              header: t('sales.fields.salesperson'),
              hideOnMobile: true,
              cell: (s) => (
                <div className="min-w-0">
                  <p className="max-w-[160px] truncate">{s.salespersonName ?? '—'}</p>
                  <PaymentTypeBadge type={s.paymentType} />
                </div>
              ),
            },
            {
              key: 'gross',
              header: t('sales.fields.gross'),
              align: 'end',
              cell: (s) => <Money value={s.grossAmount} className="font-medium" />,
            },
            {
              key: 'held',
              header: t('sales.fields.held'),
              align: 'end',
              hideOnMobile: true,
              cell: (s) => <Money value={s.held} className="text-success" />,
            },
            { key: 'status', header: t('common.status'), cell: (s) => <SaleStatusBadge status={s.status} /> },
            {
              key: 'open',
              header: <span className="sr-only">{t('common.view')}</span>,
              className: 'relative',
              align: 'end',
              cell: (s) => (
                <Link to={`/app/sales/${s.id}`} onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-brand-strong hover:underline">
                  {t('common.view')}
                </Link>
              ),
            },
          ]}
          footer={q.data && <Pagination page={lp.page} pageSize={pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
    </>
  );
}
