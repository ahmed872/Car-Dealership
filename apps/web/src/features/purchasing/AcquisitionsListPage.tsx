import { Plus, Search, ShoppingCart } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ACQUISITION_STATUSES } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { AcquisitionListItem, Paged } from './api';
import { AcquisitionStatusBadge, acquisitionVehicleTitle, DateRange, Money, OwnershipBadge, SupplierPicker } from './components';

export function AcquisitionsListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { currency, can, me } = useAuth();
  const lp = useListParams();
  const branches = useBranches();
  const [search, setSearch] = useState(lp.get('q'));
  const debounced = useDebounced(search, 350);
  useEffect(() => {
    if (debounced !== lp.get('q')) lp.set({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const pageSize = 25;
  const q = useApi<Paged<AcquisitionListItem>>(
    ['acquisitions'],
    '/acquisitions',
    {
      page: lp.page,
      pageSize,
      q: lp.get('q') || undefined,
      status: lp.get('status') || undefined,
      supplierId: lp.get('supplierId') || undefined,
      branchId: lp.get('branchId') || undefined,
      from: lp.get('from') || undefined,
      to: lp.get('to') || undefined,
    },
    { placeholderData: (p) => p },
  );
  const filtered = ['q', 'status', 'supplierId', 'branchId', 'from', 'to'].some((k) => lp.get(k));
  const visibleBranches = (branches.data ?? []).filter((b) => me?.allBranches || me?.branchIds.includes(b.id));

  return (
    <>
      <PageHeader
        title={t('purchasing.acquisitions.title')}
        subtitle={t('purchasing.acquisitions.subtitle')}
        actions={
          <Can perm={['acquisitions.create', 'vehicles.create']}>
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/purchasing/acquisitions/new')}>
              {t('purchasing.acquisitions.add')}
            </Button>
          </Can>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(200px,1.4fr)_repeat(3,minmax(150px,1fr))]">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('purchasing.acquisitions.searchHint')}
              aria-label={t('common.search')}
              className="ps-9"
            />
          </div>
          <Select value={lp.get('status')} onChange={(e) => lp.set({ status: e.target.value })} aria-label={t('common.status')}>
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            {ACQUISITION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`purchasing.enums.acquisitionStatus.${s}`)}
              </option>
            ))}
          </Select>
          <SupplierPicker value={lp.get('supplierId')} onChange={(v) => lp.set({ supplierId: v })} clearable activeOnly={false} />
          <Select value={lp.get('branchId')} onChange={(e) => lp.set({ branchId: e.target.value })} aria-label={t('common.branch')}>
            <option value="">{t('common.allBranches')}</option>
            {visibleBranches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">{t('purchasing.acquisitions.purchaseDate')}</span>
            <DateRange from={lp.get('from')} to={lp.get('to')} onChange={(v) => lp.set(v)} />
          </div>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                lp.set({ q: null, status: null, supplierId: null, branchId: null, from: null, to: null });
              }}
            >
              {t('common.clearFilters')}
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(a) => a.id}
          onRowClick={(a) => navigate(`/app/purchasing/acquisitions/${a.id}`)}
          empty={
            <EmptyState
              icon={<ShoppingCart className="h-5 w-5" />}
              title={filtered ? t('common.noResults') : t('purchasing.acquisitions.empty')}
              description={filtered ? undefined : t('purchasing.acquisitions.emptyHint')}
              action={
                !filtered &&
                can('acquisitions.create', 'vehicles.create') && (
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/purchasing/acquisitions/new')}>
                    {t('purchasing.acquisitions.add')}
                  </Button>
                )
              }
            />
          }
          columns={[
            {
              key: 'number',
              header: t('purchasing.acquisitions.number'),
              cell: (a) => (
                <div>
                  <p className="num font-medium">{a.number}</p>
                  <p className="text-xs text-muted">{fmtDate(a.purchaseDate)}</p>
                </div>
              ),
            },
            {
              key: 'vehicle',
              header: t('purchasing.acquisitions.vehicle'),
              cell: (a) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{acquisitionVehicleTitle(a, i18n.language)}</p>
                  <p className="num truncate text-xs text-muted">
                    {a.stockNumber}
                    {a.vin && ` · ${a.vin}`}
                  </p>
                </div>
              ),
            },
            {
              key: 'supplier',
              header: t('purchasing.acquisitions.supplier'),
              hideOnMobile: true,
              cell: (a) => (
                <div className="min-w-0">
                  <p className="truncate">{a.supplierName}</p>
                  <p className="truncate text-xs text-muted">{a.branchName}</p>
                </div>
              ),
            },
            {
              key: 'price',
              header: t('purchasing.acquisitions.price'),
              align: 'end',
              cell: (a) => (
                <div>
                  <Money value={a.purchasePrice} currency={a.currency} className="font-medium" />
                  {a.currency !== currency && (
                    <p className="text-xs text-muted">
                      <Money value={a.purchasePriceBase} currency={currency} />
                    </p>
                  )}
                </div>
              ),
            },
            {
              key: 'paid',
              header: t('purchasing.acquisitions.paidOutstanding'),
              align: 'end',
              hideOnMobile: true,
              cell: (a) =>
                a.outstandingBase === null ? (
                  <span className="text-xs text-subtle">—</span>
                ) : (
                  <div>
                    <Money value={a.paidBase} currency={currency} className="text-success" />
                    <p className="text-xs">
                      <Money value={a.outstandingBase} currency={currency} className={a.outstandingBase !== '0.00' ? 'text-warning' : 'text-muted'} />
                    </p>
                  </div>
                ),
            },
            { key: 'status', header: t('common.status'), cell: (a) => <AcquisitionStatusBadge status={a.status} /> },
            {
              key: 'ownership',
              header: t('purchasing.acquisitions.ownership'),
              hideOnMobile: true,
              cell: (a) => <OwnershipBadge status={a.ownershipTransferStatus} />,
            },
            {
              key: 'open',
              header: <span className="sr-only">{t('common.view')}</span>,
              // Keeps the absolutely positioned sr-only header inside the table's scroll area on phones.
              className: 'relative',
              align: 'end',
              cell: (a) => (
                <Link
                  to={`/app/purchasing/acquisitions/${a.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-medium text-brand-strong hover:underline"
                >
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
