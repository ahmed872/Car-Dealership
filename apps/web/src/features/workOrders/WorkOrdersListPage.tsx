import { Plus, Search, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Paginated, WORK_ORDER_PRIORITIES, WORK_ORDER_STATUSES, WORK_ORDER_TYPES } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { priorityTone, statusTone, useMembers, WorkOrderListItem, woVehicleTitle } from './api';
import { WorkOrderFormModal } from './WorkOrderFormModal';

export function WorkOrdersListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can, currency } = useAuth();
  const lp = useListParams({ sort: '-createdAt' });
  const [search, setSearch] = useState(lp.get('q'));
  const debounced = useDebounced(search, 350);
  const [creating, setCreating] = useState(false);
  const members = useMembers();
  useEffect(() => {
    if (debounced !== lp.get('q')) lp.set({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const query = {
    page: lp.page,
    pageSize: 25,
    q: lp.get('q') || undefined,
    sort: lp.get('sort') || undefined,
    status: lp.get('status') || undefined,
    type: lp.get('type') || undefined,
    priority: lp.get('priority') || undefined,
    assignedUserId: lp.get('assignedUserId') || undefined,
  };
  const q = useApi<Paginated<WorkOrderListItem>>(['work-orders'], '/work-orders', query, {
    placeholderData: (p) => p,
  });
  const filtered = ['q', 'type', 'priority', 'assignedUserId'].some((k) => lp.get(k));

  return (
    <>
      <PageHeader
        title={t('workOrders.title')}
        subtitle={t('workOrders.subtitle')}
        actions={
          <Can perm="work_orders.manage">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              {t('workOrders.new')}
            </Button>
          </Can>
        }
      />
      <Card>
        <div className="px-4 pt-2">
          <Tabs
            value={lp.get('status') || 'all'}
            onChange={(k) => lp.set({ status: k === 'all' ? null : k })}
            tabs={[
              { key: 'all', label: t('common.all') },
              ...WORK_ORDER_STATUSES.map((s) => ({ key: s, label: t(`workOrders.statuses.${s}`) })),
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <div className="relative min-w-[200px] flex-1">
            <Search
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
              aria-hidden
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('workOrders.filters.search')}
              aria-label={t('common.search')}
              className="ps-9"
            />
          </div>
          <Select
            className="w-full sm:w-auto sm:min-w-[150px]"
            value={lp.get('type')}
            onChange={(e) => lp.set({ type: e.target.value })}
            aria-label={t('workOrders.type')}
          >
            <option value="">{t('workOrders.filters.allTypes')}</option>
            {WORK_ORDER_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`workOrders.types.${x}`)}
              </option>
            ))}
          </Select>
          <Select
            className="w-full sm:w-auto sm:min-w-[150px]"
            value={lp.get('priority')}
            onChange={(e) => lp.set({ priority: e.target.value })}
            aria-label={t('workOrders.priority')}
          >
            <option value="">{t('workOrders.filters.allPriorities')}</option>
            {WORK_ORDER_PRIORITIES.map((x) => (
              <option key={x} value={x}>
                {t(`workOrders.priorities.${x}`)}
              </option>
            ))}
          </Select>
          {members.allowed && (
            <Select
              className="w-full sm:w-auto sm:min-w-[160px]"
              value={lp.get('assignedUserId')}
              onChange={(e) => lp.set({ assignedUserId: e.target.value })}
              aria-label={t('workOrders.assignee')}
            >
              <option value="">{t('workOrders.filters.allAssignees')}</option>
              {members.active.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.fullName}
                </option>
              ))}
            </Select>
          )}
          <Select
            className="w-full sm:w-auto sm:min-w-[150px]"
            value={lp.get('sort')}
            onChange={(e) => lp.set({ sort: e.target.value })}
            aria-label={t('workOrders.filters.sort')}
          >
            <option value="-createdAt">{t('workOrders.filters.sortNewest')}</option>
            <option value="createdAt">{t('workOrders.filters.sortOldest')}</option>
            <option value="-priority">{t('workOrders.filters.sortPriority')}</option>
            <option value="-updatedAt">{t('workOrders.filters.sortUpdated')}</option>
          </Select>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch('');
                lp.set({ q: null, type: null, priority: null, assignedUserId: null });
              }}
            >
              {t('common.clearFilters')}
            </Button>
          )}
        </div>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/app/work-orders/${r.id}`)}
          sort={lp.get('sort')}
          onSortChange={(s) => lp.set({ sort: s })}
          empty={
            <EmptyState
              icon={<Wrench className="h-5 w-5" />}
              title={t('workOrders.empty')}
              description={t('workOrders.emptyHint')}
              action={
                can('work_orders.manage') &&
                !filtered && (
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                    {t('workOrders.new')}
                  </Button>
                )
              }
            />
          }
          columns={[
            {
              key: 'number',
              header: t('workOrders.number'),
              sortKey: 'number',
              cell: (r) => (
                <div className="whitespace-nowrap">
                  <p className="num font-medium">{r.number}</p>
                  <p className="num text-xs text-muted">{fmtDate(r.createdAt)}</p>
                </div>
              ),
            },
            {
              key: 'title',
              header: t('workOrders.titleField'),
              cell: (r) => (
                <div className="min-w-[150px] max-w-[260px]">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="text-xs text-muted">
                    {t(`workOrders.types.${r.type}`)} · {t('workOrders.itemCount', { count: r.itemCount })}
                  </p>
                </div>
              ),
            },
            {
              key: 'vehicle',
              header: t('workOrders.vehicle'),
              cell: (r) => (
                <div className="min-w-[120px]">
                  <p className="truncate">{woVehicleTitle(r, i18n.language)}</p>
                  <p className="num text-xs text-muted">{r.stockNumber}</p>
                </div>
              ),
            },
            {
              key: 'status',
              header: t('workOrders.status'),
              sortKey: 'status',
              cell: (r) => (
                <div className="flex flex-col items-start gap-1">
                  <Badge tone={statusTone[r.status]}>{t(`workOrders.statuses.${r.status}`)}</Badge>
                  <Badge tone={priorityTone[r.priority]}>
                    {t('workOrders.priority')}: {t(`workOrders.priorities.${r.priority}`)}
                  </Badge>
                </div>
              ),
            },
            {
              key: 'assignee',
              header: t('workOrders.assignee'),
              hideOnMobile: true,
              cell: (r) => (
                <span className="whitespace-nowrap">
                  {r.assigneeName ?? <span className="text-subtle">{t('workOrders.unassigned')}</span>}
                </span>
              ),
            },
            {
              key: 'total',
              header: t('workOrders.itemsTotal'),
              align: 'end',
              cell: (r) => (
                <span className="num whitespace-nowrap font-medium">{fmtMoney(r.itemsTotal, currency)}</span>
              ),
            },
          ]}
          footer={
            q.data && (
              <Pagination
                page={lp.page}
                pageSize={25}
                total={q.data.total}
                onPage={(p) => lp.set({ page: p }, false)}
              />
            )
          }
        />
      </Card>
      {creating && <WorkOrderFormModal onClose={() => setCreating(false)} />}
    </>
  );
}
