import { Plus, Search, Tag, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Input, Select } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { fmtDate } from '@/lib/format';
import { Can, useAuth } from '@/lib/auth';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { CustomerListItem, Paged, useAssignees } from './api';
import { ActiveBadge, CustomerTypeBadge, PhoneText } from './components';

type ActiveFilter = 'true' | 'false' | 'all';

export function CustomersListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can, canAny } = useAuth();
  const lp = useListParams({ active: 'true', sort: '-createdAt' });
  const [search, setSearch] = useState(lp.get('q'));
  const debounced = useDebounced(search, 350);
  const branches = useBranches();
  const seesOthers = canAny('customers.read_all', 'leads.assign');
  const assignees = useAssignees({ perm: 'customers.read', enabled: seesOthers });
  useEffect(() => {
    if (debounced !== lp.get('q')) lp.set({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const query = {
    page: lp.page,
    pageSize: 25,
    q: lp.get('q') || undefined,
    sort: lp.get('sort') || undefined,
    active: lp.get('active') || undefined,
    type: lp.get('type') || undefined,
    branchId: lp.get('branchId') || undefined,
    assignedUserId: lp.get('assignedUserId') || undefined,
    mine: lp.get('mine') || undefined,
    tag: lp.get('tag') || undefined,
  };
  const q = useApi<Paged<CustomerListItem>>(['customers'], '/customers', query, { placeholderData: (p) => p });
  const active = lp.get('active') as ActiveFilter;

  return (
    <>
      <PageHeader
        title={t('customers.title')}
        subtitle={seesOthers ? t('customers.subtitle') : t('customers.subtitleOwn')}
        actions={
          <Can perm="customers.manage">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/customers/new')}>
              {t('customers.add')}
            </Button>
          </Can>
        }
      />
      <Card className="mb-4">
        <div className="px-4 pt-2">
          <Tabs<ActiveFilter>
            value={active}
            onChange={(k) => lp.set({ active: k })}
            tabs={[
              { key: 'true', label: t('customers.filters.active') },
              { key: 'false', label: t('customers.filters.inactive') },
              { key: 'all', label: t('common.all') },
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
              placeholder={t('customers.searchHint')}
              aria-label={t('common.search')}
              className="ps-9"
            />
          </div>
          <Select className="w-auto min-w-[140px]" value={lp.get('type')} onChange={(e) => lp.set({ type: e.target.value })} aria-label={t('customers.fields.type')}>
            <option value="">
              {t('customers.fields.type')}: {t('common.all')}
            </option>
            <option value="individual">{t('customers.enums.type.individual')}</option>
            <option value="company">{t('customers.enums.type.company')}</option>
          </Select>
          {(branches.data?.length ?? 0) > 1 && (
            <Select className="w-auto min-w-[150px]" value={lp.get('branchId')} onChange={(e) => lp.set({ branchId: e.target.value })} aria-label={t('common.branch')}>
              <option value="">{t('common.allBranches')}</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
          {seesOthers && (
            <Select
              className="w-auto min-w-[170px]"
              value={lp.get('assignedUserId')}
              onChange={(e) => lp.set({ assignedUserId: e.target.value, mine: null })}
              aria-label={t('customers.fields.assignedUser')}
            >
              <option value="">
                {t('customers.fields.assignedUser')}: {t('common.all')}
              </option>
              {assignees.list.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.fullName}
                </option>
              ))}
            </Select>
          )}
          <Select className="w-auto min-w-[150px]" value={lp.get('sort')} onChange={(e) => lp.set({ sort: e.target.value })} aria-label={t('customers.sort.label')}>
            <option value="-createdAt">{t('customers.sort.newest')}</option>
            <option value="createdAt">{t('customers.sort.oldest')}</option>
            <option value="fullName">{t('customers.sort.name')}</option>
            <option value="-updatedAt">{t('customers.sort.updated')}</option>
          </Select>
          {seesOthers && (
            <Checkbox
              label={t('customers.filters.mine')}
              checked={lp.get('mine') === 'true'}
              onChange={(e) => lp.set({ mine: e.target.checked ? 'true' : null, assignedUserId: null })}
            />
          )}
          {lp.get('tag') && (
            <button
              type="button"
              onClick={() => lp.set({ tag: null })}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs text-ink hover:border-line-strong"
              title={t('common.clearFilters')}
            >
              <Tag className="h-3 w-3" aria-hidden /> {lp.get('tag')} ×
            </button>
          )}
        </div>
      </Card>

      <Card>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(c) => c.id}
          onRowClick={(c) => navigate(`/app/customers/${c.id}`)}
          sort={lp.get('sort')}
          onSortChange={(s) => lp.set({ sort: s })}
          empty={
            <EmptyState
              icon={<Users className="h-5 w-5" />}
              title={lp.get('q') ? t('common.noResults') : t('customers.empty')}
              description={lp.get('q') ? undefined : t('customers.emptyHint')}
              action={
                can('customers.manage') && !lp.get('q') ? (
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/customers/new')}>
                    {t('customers.add')}
                  </Button>
                ) : undefined
              }
            />
          }
          columns={[
            {
              key: 'name',
              header: t('customers.fields.fullName'),
              sortKey: 'fullName',
              cell: (c) => (
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <span className="truncate">{c.fullName}</span>
                    {!c.isActive && <ActiveBadge active={false} />}
                  </p>
                  {/* Phones: the phone column is hidden on small screens, so the number goes under the name. */}
                  {(c.phone ?? c.whatsapp) && (
                    <p className="mt-0.5 text-xs text-muted md:hidden">
                      <PhoneText phone={c.phone ?? c.whatsapp} />
                    </p>
                  )}
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <CustomerTypeBadge type={c.type} />
                    {c.companyName && <span className="truncate">{c.companyName}</span>}
                    {c.tags.slice(0, 3).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          lp.set({ tag });
                        }}
                        className="rounded-full bg-surface-2 px-1.5 text-[11px] text-muted hover:text-ink"
                      >
                        #{tag}
                      </button>
                    ))}
                  </p>
                </div>
              ),
            },
            { key: 'phone', header: t('customers.fields.phone'), hideOnMobile: true, cell: (c) => <PhoneText phone={c.phone ?? c.whatsapp} /> },
            { key: 'assigned', header: t('customers.fields.assignedUser'), hideOnMobile: true, cell: (c) => c.assignedUserName ?? <span className="text-subtle">{t('customers.unassigned')}</span> },
            {
              key: 'leads',
              header: t('customers.fields.openLeads'),
              align: 'center',
              cell: (c) => (c.openLeads > 0 ? <span className="num rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand-strong">{c.openLeads}</span> : <span className="text-subtle">—</span>),
            },
            { key: 'last', header: t('customers.fields.lastInteraction'), hideOnMobile: true, cell: (c) => <span className="text-muted">{fmtDate(c.lastInteractionAt)}</span> },
            { key: 'branch', header: t('common.branch'), hideOnMobile: true, cell: (c) => c.branchName ?? <span className="text-subtle">—</span> },
            { key: 'created', header: t('common.createdAt'), sortKey: 'createdAt', hideOnMobile: true, cell: (c) => <span className="text-muted">{fmtDate(c.createdAt)}</span> },
          ]}
          footer={q.data && <Pagination page={lp.page} pageSize={25} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
    </>
  );
}
