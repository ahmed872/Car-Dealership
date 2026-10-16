import clsx from 'clsx';
import { CarFront, Filter, Gauge, LayoutGrid, List, Plus, Search, Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BODY_TYPES, FUEL_TYPES, TRANSMISSIONS, VEHICLE_STATUSES, VehicleStatus } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { fmtMoney, fmtNumber } from '@/lib/format';
import { Can, useAuth } from '@/lib/auth';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { useMakes, VehicleListItem } from './api';
import { useStatusLabel, VehiclePhoto, VehicleStatusBadge, vehicleTitle } from './components';

type View = 'grid' | 'table';

function StaleBadge({ days }: { days: number | null }) {
  const { me } = useAuth();
  const { t } = useTranslation();
  if (days === null || !me?.tenant) return null;
  const s = me.tenant.settings.inventory;
  const tone = days >= s.staleDaysCritical ? 'text-danger' : days >= s.staleDaysWarning ? 'text-warning' : 'text-muted';
  return (
    <span className={clsx('num inline-flex items-center gap-1 text-xs', tone)}>
      <Timer className="h-3.5 w-3.5" aria-hidden />
      {t('vehicles.daysCount', { count: days })}
    </span>
  );
}

function VehicleCard({ v, onOpen }: { v: VehicleListItem; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const { currency } = useAuth();
  const title = vehicleTitle(v, i18n.language);
  return (
    <button type="button" onClick={onOpen} className="card group overflow-hidden text-start transition hover:border-line-strong hover:shadow-pop focus-visible:shadow-pop">
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-2">
        <VehiclePhoto fileId={v.primaryPhotoId} alt={title} className="h-full w-full transition duration-300 group-hover:scale-[1.03]" />
        <div className="absolute start-2 top-2">
          <VehicleStatusBadge status={v.status} />
        </div>
      </div>
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-[14.5px] leading-snug font-semibold">{title}</h3>
        </div>
        <p className="num text-xs text-muted">{v.stockNumber}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="num inline-flex items-center gap-1">
            <Gauge className="h-3.5 w-3.5" aria-hidden /> {fmtNumber(v.odometerValue)} {v.odometerUnit}
          </span>
          {v.fuelType && <span>{t(`vehicles.enums.fuelType.${v.fuelType}`)}</span>}
          <StaleBadge days={v.daysInStock} />
        </div>
        <div className="flex items-end justify-between pt-1">
          <span className="num text-base font-semibold text-ink">{v.askingPrice ? fmtMoney(v.askingPrice, currency) : <span className="text-sm text-subtle">{t('vehicles.noPrice')}</span>}</span>
          <span className="text-xs text-subtle">{v.branchName}</span>
        </div>
      </div>
    </button>
  );
}

export function VehiclesListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { currency, can } = useAuth();
  const statusLabel = useStatusLabel();
  const lp = useListParams({ scope: 'stock', sort: '-stockedAt' });
  const [view, setView] = useState<View>(() => (localStorage.getItem('ah.vehicles.view') as View) || 'grid');
  const [search, setSearch] = useState(lp.get('q'));
  const debounced = useDebounced(search, 350);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const makes = useMakes();
  const branches = useBranches();
  useEffect(() => {
    if (debounced !== lp.get('q')) lp.set({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => {
    try {
      localStorage.setItem('ah.vehicles.view', view);
    } catch {
      /* ignore */
    }
  }, [view]);

  const filterKeys = ['status', 'branchId', 'makeId', 'yearFrom', 'yearTo', 'priceFrom', 'priceTo', 'fuelType', 'transmission', 'bodyType', 'stale'];
  const query: Record<string, string | number | undefined> = {
    page: lp.page,
    pageSize: view === 'grid' ? 24 : 25,
    q: lp.get('q') || undefined,
    sort: lp.get('sort') || undefined,
    scope: lp.get('scope') || undefined,
  };
  for (const k of filterKeys) query[k] = lp.get(k) || undefined;
  const q = useApi<{ items: VehicleListItem[]; total: number; page: number; pageSize: number }>(['vehicles'], '/vehicles', query, { placeholderData: (p) => p });
  const activeFilters = filterKeys.filter((k) => lp.get(k)).length;
  const scope = lp.get('scope') as 'stock' | 'sold' | 'all';

  return (
    <>
      <PageHeader
        title={t('vehicles.title')}
        subtitle={t('vehicles.subtitle')}
        actions={
          <Can perm="vehicles.create">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/vehicles/new')}>
              {t('vehicles.add')}
            </Button>
          </Can>
        }
      />
      <Card className="mb-4">
        <div className="px-4 pt-2">
          <Tabs
            value={scope}
            onChange={(k) => lp.set({ scope: k, status: null })}
            tabs={[
              { key: 'stock', label: t('vehicles.scopeStock') },
              { key: 'sold', label: t('vehicles.scopeSold') },
              { key: 'all', label: t('vehicles.scopeAll') },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('vehicles.searchHint')}
              aria-label={t('common.search')}
              className="ps-9"
            />
          </div>
          <Select className="w-auto min-w-[170px]" value={lp.get('status')} onChange={(e) => lp.set({ status: e.target.value })} aria-label={t('common.status')}>
            <option value="">{t('common.status')}: {t('common.all')}</option>
            {VEHICLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s as VehicleStatus)}
              </option>
            ))}
          </Select>
          <Select className="w-auto min-w-[160px]" value={lp.get('sort')} onChange={(e) => lp.set({ sort: e.target.value })} aria-label={t('vehicles.sort')}>
            <option value="-stockedAt">{t('vehicles.sortNewest')}</option>
            <option value="stockedAt">{t('vehicles.sortOldest')}</option>
            <option value="askingPrice">{t('vehicles.sortPriceAsc')}</option>
            <option value="-askingPrice">{t('vehicles.sortPriceDesc')}</option>
            <option value="-modelYear">{t('vehicles.sortYear')}</option>
          </Select>
          <Button variant="secondary" icon={<Filter className="h-4 w-4" />} onClick={() => setFiltersOpen(true)}>
            {t('common.filters')}
            {activeFilters > 0 && <span className="num rounded-full bg-brand px-1.5 text-[11px] text-brand-ink">{activeFilters}</span>}
          </Button>
          <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="view">
            <button type="button" aria-pressed={view === 'grid'} onClick={() => setView('grid')} className={clsx('rounded-md p-1.5', view === 'grid' ? 'bg-surface-3 text-ink' : 'text-muted')} title={t('vehicles.grid')}>
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')} className={clsx('rounded-md p-1.5', view === 'table' ? 'bg-surface-3 text-ink' : 'text-muted')} title={t('vehicles.table')}>
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </Card>

      {q.error ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : view === 'grid' ? (
        <>
          {q.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="card overflow-hidden">
                  <Skeleton className="aspect-[4/3] rounded-none" />
                  <div className="space-y-2 p-4">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : q.data?.items.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {q.data.items.map((v) => (
                <VehicleCard key={v.id} v={v} onOpen={() => navigate(`/app/vehicles/${v.id}`)} />
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                icon={<CarFront className="h-5 w-5" />}
                title={t('vehicles.empty')}
                description={t('vehicles.emptyHint')}
                action={
                  can('vehicles.create') && (
                    <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/vehicles/new')}>
                      {t('vehicles.add')}
                    </Button>
                  )
                }
              />
            </Card>
          )}
          {q.data && (
            <Card className="mt-4">
              <Pagination page={lp.page} pageSize={24} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />
            </Card>
          )}
        </>
      ) : (
        <Card>
          <DataTable
            rows={q.data?.items}
            loading={q.isLoading}
            rowKey={(v) => v.id}
            onRowClick={(v) => navigate(`/app/vehicles/${v.id}`)}
            sort={lp.get('sort')}
            onSortChange={(s) => lp.set({ sort: s })}
            empty={<EmptyState icon={<CarFront className="h-5 w-5" />} title={t('vehicles.empty')} description={t('vehicles.emptyHint')} />}
            columns={[
              {
                key: 'vehicle',
                header: t('nav.vehicles'),
                cell: (v) => (
                  <div className="flex items-center gap-3">
                    <VehiclePhoto fileId={v.primaryPhotoId} alt="" className="h-11 w-16 shrink-0 rounded-md" />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{vehicleTitle(v, i18n.language)}</p>
                      <p className="num truncate text-xs text-muted">
                        {v.stockNumber}
                        {v.vin && ` · ${v.vin}`}
                      </p>
                    </div>
                  </div>
                ),
              },
              { key: 'status', header: t('common.status'), cell: (v) => <VehicleStatusBadge status={v.status} /> },
              { key: 'odo', header: t('vehicles.odometer'), sortKey: 'odometer', hideOnMobile: true, align: 'end', cell: (v) => <span className="num">{fmtNumber(v.odometerValue)} {v.odometerUnit}</span> },
              { key: 'branch', header: t('vehicles.branch'), hideOnMobile: true, cell: (v) => v.branchName },
              { key: 'days', header: t('vehicles.daysInStock'), sortKey: 'stockedAt', hideOnMobile: true, cell: (v) => <StaleBadge days={v.daysInStock} /> },
              ...(can('vehicles.view_cost')
                ? [{ key: 'cost', header: t('vehicles.cost'), align: 'end' as const, hideOnMobile: true, cell: (v: VehicleListItem) => <span className="num text-muted">{v.costTotal && Number(v.costTotal) ? fmtMoney(v.costTotal, currency) : '—'}</span> }]
                : []),
              { key: 'price', header: t('vehicles.askingPrice'), sortKey: 'askingPrice', align: 'end', cell: (v) => <span className="num font-medium">{v.askingPrice ? fmtMoney(v.askingPrice, currency) : '—'}</span> },
            ]}
            footer={q.data && <Pagination page={lp.page} pageSize={25} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
          />
        </Card>
      )}

      <Modal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title={t('common.filters')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                lp.set(Object.fromEntries(filterKeys.map((k) => [k, null])));
                setFiltersOpen(false);
              }}
            >
              {t('common.clearFilters')}
            </Button>
            <Button onClick={() => setFiltersOpen(false)}>{t('common.close')}</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('vehicles.branch')}>
            {(id) => (
              <Select id={id} value={lp.get('branchId')} onChange={(e) => lp.set({ branchId: e.target.value })}>
                <option value="">{t('common.allBranches')}</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('vehicles.make')}>
            {(id) => (
              <Select id={id} value={lp.get('makeId')} onChange={(e) => lp.set({ makeId: e.target.value })}>
                <option value="">{t('common.all')}</option>
                {makes.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {i18n.language === 'en' ? m.nameEn : m.nameAr}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('vehicles.yearFrom')}>{(id) => <Input id={id} type="number" min={1950} max={2100} value={lp.get('yearFrom')} onChange={(e) => lp.set({ yearFrom: e.target.value })} />}</Field>
          <Field label={t('vehicles.yearTo')}>{(id) => <Input id={id} type="number" min={1950} max={2100} value={lp.get('yearTo')} onChange={(e) => lp.set({ yearTo: e.target.value })} />}</Field>
          <Field label={t('vehicles.priceFrom')}>{(id) => <MoneyInput id={id} currency={currency} value={lp.get('priceFrom')} onChange={(e) => lp.set({ priceFrom: e.target.value })} />}</Field>
          <Field label={t('vehicles.priceTo')}>{(id) => <MoneyInput id={id} currency={currency} value={lp.get('priceTo')} onChange={(e) => lp.set({ priceTo: e.target.value })} />}</Field>
          {(
            [
              ['fuelType', FUEL_TYPES],
              ['transmission', TRANSMISSIONS],
              ['bodyType', BODY_TYPES],
            ] as const
          ).map(([key, values]) => (
            <Field key={key} label={t(`vehicles.${key}`)}>
              {(id) => (
                <Select id={id} value={lp.get(key)} onChange={(e) => lp.set({ [key]: e.target.value })}>
                  <option value="">{t('common.all')}</option>
                  {values.map((v) => (
                    <option key={v} value={v}>
                      {t(`vehicles.enums.${key}.${v}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ))}
          <Field label={t('vehicles.stale')}>
            {(id) => (
              <Select id={id} value={lp.get('stale')} onChange={(e) => lp.set({ stale: e.target.value })}>
                <option value="">{t('common.all')}</option>
                <option value="warning">{t('vehicles.staleWarning')}</option>
                <option value="critical">{t('vehicles.staleCritical')}</option>
              </Select>
            )}
          </Field>
        </div>
      </Modal>
    </>
  );
}
