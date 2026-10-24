import { BookmarkCheck, Plus, Search, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, StatCard } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { Money, Paged, vehicleLabel } from '@/features/receivables/kit';
import { Can, useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { ReservationListItem } from './api';
import { ExpiryHint, ReservationFormModal, ReservationStatusBadge } from './components';

type Tab = 'active' | 'expiring' | 'converted' | 'expired' | 'cancelled' | 'all';
const TABS: Tab[] = ['active', 'expiring', 'converted', 'expired', 'cancelled', 'all'];
/** "Expiring soon" window. */
const SOON_HOURS = 48;

export function ReservationsListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const lp = useListParams({ tab: 'active' });
  const tab = (lp.get('tab') || 'active') as Tab;
  const [search, setSearch] = useState(lp.get('q'));
  const debounced = useDebounced(search, 350);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (debounced !== lp.get('q')) lp.set({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const status = tab === 'expiring' ? undefined : tab === 'all' ? undefined : tab;
  const q = useApi<Paged<ReservationListItem>>(
    ['reservations'],
    '/reservations',
    {
      page: lp.page,
      pageSize: 25,
      q: lp.get('q') || undefined,
      status,
      expiringWithinHours: tab === 'expiring' ? SOON_HOURS : undefined,
    },
    { placeholderData: (p) => p },
  );
  const activeCount = useApi<Paged<ReservationListItem>>(['reservations', 'count', 'active'], '/reservations', { status: 'active', pageSize: 1 });
  const soonCount = useApi<Paged<ReservationListItem>>(['reservations', 'count', 'expiring'], '/reservations', { expiringWithinHours: SOON_HOURS, pageSize: 1 });

  return (
    <>
      <PageHeader
        title={t('reservations.title')}
        subtitle={t('reservations.subtitle')}
        actions={
          <Can perm="reservations.create">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              {t('reservations.new')}
            </Button>
          </Can>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <StatCard
          label={t('reservations.stats.active')}
          value={activeCount.data?.total ?? '—'}
          icon={<BookmarkCheck className="h-5 w-5" />}
          tone="brand"
          onClick={() => lp.set({ tab: null })}
        />
        <StatCard
          label={t('reservations.stats.expiring', { hours: SOON_HOURS })}
          value={soonCount.data?.total ?? '—'}
          icon={<Timer className="h-5 w-5" />}
          tone={soonCount.data?.total ? 'warning' : 'default'}
          onClick={() => lp.set({ tab: 'expiring' })}
        />
      </div>
      <Card>
        <div className="px-4 pt-2">
          <Tabs<Tab>
            value={tab}
            onChange={(k) => lp.set({ tab: k === 'active' ? null : k })}
            tabs={TABS.map((k) => ({ key: k, label: k === 'all' ? t('common.all') : k === 'expiring' ? t('reservations.tabs.expiring') : t(`reservations.status.${k}`) }))}
          />
        </div>
        <div className="p-4">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input type="search" className="ps-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('reservations.searchHint')} aria-label={t('common.search')} />
          </div>
        </div>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/app/reservations/${r.id}`)}
          empty={
            <EmptyState
              icon={<BookmarkCheck className="h-5 w-5" />}
              title={tab === 'expiring' ? t('reservations.emptyExpiring') : t('reservations.empty')}
              description={can('reservations.create') ? t('reservations.emptyHint') : undefined}
            />
          }
          columns={[
            {
              key: 'number',
              header: t('reservations.fields.number'),
              cell: (r) => (
                <Link to={`/app/reservations/${r.id}`} onClick={(e) => e.stopPropagation()} className="num whitespace-nowrap font-medium text-brand-strong hover:underline">
                  {r.number}
                </Link>
              ),
            },
            {
              key: 'vehicle',
              header: t('reservations.fields.vehicle'),
              cell: (r) => (
                <div className="min-w-0">
                  <p className="max-w-[220px] truncate font-medium text-ink">{vehicleLabel(r, i18n.language)}</p>
                  <p className="num text-xs text-muted">{r.stockNumber}</p>
                </div>
              ),
            },
            {
              key: 'customer',
              header: t('reservations.fields.customer'),
              cell: (r) => (
                <div className="min-w-0">
                  <p className="max-w-[180px] truncate">{r.customerName}</p>
                  {r.customerPhone && (
                    <p className="num text-xs text-muted">
                      <bdi dir="ltr">{r.customerPhone}</bdi>
                    </p>
                  )}
                </div>
              ),
            },
            {
              key: 'expires',
              header: t('reservations.fields.expiresAt'),
              cell: (r) => (
                <div>
                  <p className="whitespace-nowrap text-[13px]">{fmtDateTime(r.expiresAt)}</p>
                  <ExpiryHint expiresAt={r.expiresAt} status={r.status} />
                </div>
              ),
            },
            {
              key: 'deposit',
              header: t('reservations.fields.deposit'),
              align: 'end',
              cell: (r) => {
                const short = d(r.receivedBase).lt(r.depositAmount);
                return (
                  <div>
                    <Money value={r.receivedBase} className="font-medium" />
                    {d(r.depositAmount).gt(0) && (
                      <p className={`text-xs ${short ? 'text-warning' : 'text-muted'}`}>
                        {t('reservations.ofRequired')} <Money value={r.depositAmount} />
                      </p>
                    )}
                  </div>
                );
              },
            },
            { key: 'sales', header: t('reservations.fields.salesUser'), hideOnMobile: true, cell: (r) => <span className="text-muted">{r.salesUserName ?? '—'}</span> },
            { key: 'status', header: t('common.status'), cell: (r) => <ReservationStatusBadge status={r.status} /> },
          ]}
          footer={q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
      {creating && <ReservationFormModal onClose={() => setCreating(false)} onDone={(r) => navigate(`/app/reservations/${r.id}`)} />}
    </>
  );
}
