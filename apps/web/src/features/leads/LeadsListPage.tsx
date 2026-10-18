import { Handshake, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Input, Select } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useApi, useDebounced, useListParams } from '@/lib/hooks';
import { Paged } from '@/features/customers/api';
import { PhoneText } from '@/features/customers/components';
import { cardVehicleLabel, LeadCard, LeadStatus, useStageName, useStages } from './api';
import { ActionMenu, FollowUpText, HiddenLabel, LeadDialog, LeadDialogs, LeadStatusBadge, StageBadge, useLeadActions } from './components';
import { LeadCommonFilters, LeadViewSwitch, NewLeadButton } from './shared';

type StatusTab = LeadStatus | 'all';

export function LeadsListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { currency } = useAuth();
  const name = useStageName();
  const stages = useStages(true);
  const lp = useListParams({ status: 'open', sort: '-createdAt' });
  const actions = useLeadActions();
  const [dialog, setDialog] = useState<LeadDialog | null>(null);
  const [search, setSearch] = useState(lp.get('q'));
  const debounced = useDebounced(search, 350);
  useEffect(() => {
    if (debounced !== lp.get('q')) lp.set({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const status = lp.get('status') as StatusTab;
  const query = {
    page: lp.page,
    pageSize: 25,
    q: lp.get('q') || undefined,
    sort: lp.get('sort') || undefined,
    status: status === 'all' ? undefined : status,
    stageId: lp.get('stageId') || undefined,
    source: lp.get('source') || undefined,
    branchId: lp.get('branchId') || undefined,
    assignedUserId: lp.get('assignedUserId') || undefined,
    mine: lp.get('mine') || undefined,
    followUpDue: lp.get('followUpDue') || undefined,
  };
  const q = useApi<Paged<LeadCard>>(['leads'], '/leads', query, { placeholderData: (p) => p });
  const stageOptions = (stages.data ?? []).filter((s) => status === 'all' || s.kind === status);

  return (
    <>
      <PageHeader
        title={t('leads.list.title')}
        subtitle={q.data ? t('leads.list.subtitle', { count: q.data.total }) : undefined}
        actions={
          <>
            <LeadViewSwitch />
            <NewLeadButton />
          </>
        }
      />
      <Card className="mb-4">
        <div className="px-4 pt-2">
          <Tabs<StatusTab>
            value={status}
            onChange={(k) => lp.set({ status: k, stageId: null, followUpDue: null })}
            tabs={[
              { key: 'open', label: t('leads.enums.status.open') },
              { key: 'won', label: t('leads.enums.status.won') },
              { key: 'lost', label: t('leads.enums.status.lost') },
              { key: 'all', label: t('common.all') },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('leads.list.searchHint')} aria-label={t('common.search')} className="ps-9" />
          </div>
          <Select className="w-auto min-w-[140px]" value={lp.get('stageId')} onChange={(e) => lp.set({ stageId: e.target.value })} aria-label={t('leads.fields.stage')}>
            <option value="">
              {t('leads.fields.stage')}: {t('common.all')}
            </option>
            {stageOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {name(s)}
                {!s.isActive ? ` (${t('common.inactive')})` : ''}
              </option>
            ))}
          </Select>
          <LeadCommonFilters lp={lp} />
          {(status === 'open' || status === 'all') && (
            <Checkbox label={t('leads.filters.followUpDue')} checked={lp.get('followUpDue') === 'true'} onChange={(e) => lp.set({ followUpDue: e.target.checked ? 'true' : null })} />
          )}
        </div>
      </Card>
      <Card>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(l) => l.id}
          onRowClick={(l) => navigate(`/app/leads/${l.id}`)}
          sort={lp.get('sort')}
          onSortChange={(s) => lp.set({ sort: s })}
          empty={<EmptyState icon={<Handshake className="h-5 w-5" />} title={lp.get('q') ? t('common.noResults') : t('leads.list.empty')} />}
          columns={[
            {
              key: 'number',
              header: t('leads.fields.number'),
              sortKey: 'createdAt',
              cell: (l) => (
                <div className="whitespace-nowrap">
                  <p className="num font-medium">{l.number}</p>
                  <p className="text-xs text-muted">{fmtDate(l.createdAt)}</p>
                </div>
              ),
            },
            {
              key: 'customer',
              header: t('leads.fields.customer'),
              cell: (l) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{l.customerName}</p>
                  <PhoneText phone={l.customerPhone} className="text-xs text-muted" />
                </div>
              ),
            },
            {
              key: 'stage',
              header: t('leads.fields.stage'),
              cell: (l) => (
                <span className="flex flex-wrap items-center gap-1">
                  <StageBadge stage={{ nameEn: l.stageNameEn, nameAr: l.stageNameAr, code: l.stageCode, kind: l.stageKind }} />
                  {l.status !== 'open' && <LeadStatusBadge status={l.status} />}
                </span>
              ),
            },
            { key: 'vehicle', header: t('leads.fields.vehicle'), hideOnMobile: true, cell: (l) => cardVehicleLabel(l, i18n.language) ?? <span className="text-subtle">—</span> },
            {
              key: 'budget',
              header: t('leads.fields.budget'),
              sortKey: 'budgetMax',
              align: 'end',
              hideOnMobile: true,
              cell: (l) => <span className="num whitespace-nowrap">{l.budgetMax || l.budgetMin ? fmtMoney(l.budgetMax ?? l.budgetMin, currency) : '—'}</span>,
            },
            { key: 'follow', header: t('leads.fields.nextFollowUpAt'), sortKey: 'nextFollowUpAt', cell: (l) => (l.status === 'open' ? <FollowUpText at={l.nextFollowUpAt} /> : <span className="text-subtle">—</span>) },
            { key: 'owner', header: t('leads.fields.assignee'), hideOnMobile: true, cell: (l) => <span className="whitespace-nowrap">{l.assigneeName ?? <span className="text-subtle">{t('customers.unassigned')}</span>}</span> },
            { key: 'actions', header: <HiddenLabel>{t('common.actions')}</HiddenLabel>, align: 'end', cell: (l) => <ActionMenu label={t('common.actions')} actions={actions(l, setDialog)} className="inline-block" /> },
          ]}
          footer={q.data && <Pagination page={lp.page} pageSize={25} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
      <LeadDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}
