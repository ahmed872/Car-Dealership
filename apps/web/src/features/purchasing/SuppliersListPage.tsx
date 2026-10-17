import { Plus, Search, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { SUPPLIER_TYPES } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { Paged, Supplier } from './api';
import { SupplierFormModal } from './components';

export function SuppliersListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const lp = useListParams({ active: 'true' });
  const [search, setSearch] = useState(lp.get('q'));
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search, 350);
  useEffect(() => {
    if (debounced !== lp.get('q')) lp.set({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const pageSize = 25;
  const active = lp.get('active');
  const q = useApi<Paged<Supplier>>(
    ['suppliers', 'list'],
    '/suppliers',
    {
      page: lp.page,
      pageSize,
      q: lp.get('q') || undefined,
      type: lp.get('type') || undefined,
      active: active === 'all' ? undefined : active || undefined,
    },
    { placeholderData: (p) => p },
  );
  const filtered = !!(lp.get('q') || lp.get('type') || active !== 'true');

  return (
    <>
      <PageHeader
        title={t('purchasing.suppliers.title')}
        subtitle={t('purchasing.suppliers.subtitle')}
        actions={
          <Can perm="suppliers.manage">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              {t('purchasing.suppliers.add')}
            </Button>
          </Can>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(220px,2fr)_repeat(2,minmax(160px,1fr))_auto]">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('purchasing.suppliers.searchHint')}
              aria-label={t('common.search')}
              className="ps-9"
            />
          </div>
          <Select value={lp.get('type')} onChange={(e) => lp.set({ type: e.target.value })} aria-label={t('purchasing.suppliers.fields.type')}>
            <option value="">
              {t('purchasing.suppliers.fields.type')}: {t('common.all')}
            </option>
            {SUPPLIER_TYPES.map((s) => (
              <option key={s} value={s}>
                {t(`purchasing.enums.supplierType.${s}`)}
              </option>
            ))}
          </Select>
          <Select value={active} onChange={(e) => lp.set({ active: e.target.value })} aria-label={t('common.status')}>
            <option value="true">{t('purchasing.suppliers.activeOnly')}</option>
            <option value="false">{t('purchasing.suppliers.inactiveOnly')}</option>
            <option value="all">
              {t('common.status')}: {t('common.all')}
            </option>
          </Select>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                lp.set({ q: null, type: null, active: null });
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
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/app/purchasing/suppliers/${s.id}`)}
          empty={
            <EmptyState
              icon={<Truck className="h-5 w-5" />}
              title={filtered ? t('common.noResults') : t('purchasing.suppliers.empty')}
              description={filtered ? undefined : t('purchasing.suppliers.emptyHint')}
              action={
                !filtered &&
                can('suppliers.manage') && (
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                    {t('purchasing.suppliers.add')}
                  </Button>
                )
              }
            />
          }
          columns={[
            {
              key: 'name',
              header: t('common.name'),
              cell: (s) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.name}</p>
                  <p className="truncate text-xs text-muted">{t(`purchasing.enums.supplierType.${s.type}`)}</p>
                </div>
              ),
            },
            {
              key: 'phone',
              header: t('common.phone'),
              cell: (s) =>
                s.phone ? (
                  <bdi dir="ltr" className="num">
                    {s.phone}
                  </bdi>
                ) : (
                  '—'
                ),
            },
            { key: 'city', header: t('common.city'), hideOnMobile: true, cell: (s) => s.city || '—' },
            {
              key: 'tax',
              header: t('purchasing.suppliers.fields.taxNumber'),
              hideOnMobile: true,
              cell: (s) => (s.taxNumber ? <span className="num">{s.taxNumber}</span> : '—'),
            },
            {
              key: 'status',
              header: t('common.status'),
              cell: (s) => <Badge tone={s.isActive ? 'success' : 'neutral'}>{s.isActive ? t('common.active') : t('common.inactive')}</Badge>,
            },
            { key: 'created', header: t('common.createdAt'), hideOnMobile: true, cell: (s) => fmtDate(s.createdAt) },
            {
              key: 'open',
              header: <span className="sr-only">{t('common.view')}</span>,
              // Keeps the absolutely positioned sr-only header inside the table's scroll area on phones.
              className: 'relative',
              align: 'end',
              cell: (s) => (
                <Link
                  to={`/app/purchasing/suppliers/${s.id}`}
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
      {creating && <SupplierFormModal onClose={() => setCreating(false)} onSaved={(s) => navigate(`/app/purchasing/suppliers/${s.id}`)} />}
    </>
  );
}
