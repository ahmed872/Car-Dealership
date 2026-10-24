import { Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pagination } from '@/components/ui/DataTable';
import { Select } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { Can } from '@/lib/auth';
import { useApi, useListParams } from '@/lib/hooks';
import { Refund, RefundSourceType, RefundStatus } from './api';
import { RefundsTable } from './components';
import { RequestRefundModal } from './dialogs';
import { CustomerPicker, ListSearchInput, Paged, useListSearch } from './kit';

type StatusTab = 'all' | RefundStatus;
const TABS: StatusTab[] = ['requested', 'approved', 'paid', 'rejected', 'cancelled', 'all'];

/** Customer refunds: requested → approved (by someone else) → paid; rejected or cancelled before payment. */
export function RefundsPage() {
  const { t } = useTranslation();
  const lp = useListParams({ status: 'requested' });
  const status = (lp.get('status') || 'requested') as StatusTab;
  const sourceType = lp.get('sourceType') as RefundSourceType | '';
  const sourceId = lp.get('sourceId');
  const [customerLabel, setCustomerLabel] = useState('');
  const [requesting, setRequesting] = useState(false);
  const search = useListSearch(lp);
  const q = useApi<Paged<Refund>>(
    ['refunds'],
    '/refunds',
    {
      page: lp.page,
      pageSize: 25,
      q: lp.get('q') || undefined,
      status: status === 'all' ? undefined : status,
      customerId: lp.get('customerId') || undefined,
      sourceType: sourceType || undefined,
      sourceId: sourceId || undefined,
    },
    { placeholderData: (p) => p },
  );
  const pending = useApi<Paged<Refund>>(['refunds', 'count', 'requested'], '/refunds', { status: 'requested', pageSize: 1 });
  const approved = useApi<Paged<Refund>>(['refunds', 'count', 'approved'], '/refunds', { status: 'approved', pageSize: 1 });

  return (
    <>
      <PageHeader
        title={t('receivables.refunds.title')}
        subtitle={t('receivables.refunds.subtitle')}
        actions={
          <Can perm="refunds.create">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRequesting(true)}>
              {t('receivables.refunds.new')}
            </Button>
          </Can>
        }
      />
      <Card>
        <div className="px-4 pt-2">
          <Tabs<StatusTab>
            value={status}
            onChange={(k) => lp.set({ status: k === 'requested' ? null : k })}
            tabs={TABS.map((k) => ({
              key: k,
              label: k === 'all' ? t('common.all') : t(`receivables.refundStatus.${k}`),
              count: k === 'requested' ? pending.data?.total : k === 'approved' ? approved.data?.total : undefined,
            }))}
          />
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,220px)_auto]">
          <ListSearchInput value={search.text} onChange={search.setText} placeholder={t('receivables.refunds.searchHint')} />
          <CustomerPicker
            value={lp.get('customerId')}
            selectedLabel={lp.get('customerId') ? customerLabel || t('receivables.receipts.selectedCustomer') : ''}
            onSelect={(c) => {
              setCustomerLabel(c.fullName);
              lp.set({ customerId: c.id });
            }}
            onClear={() => {
              setCustomerLabel('');
              lp.set({ customerId: null });
            }}
          />
          <Select aria-label={t('receivables.refunds.sourceType')} value={sourceType} onChange={(e) => lp.set({ sourceType: e.target.value || null, sourceId: null })}>
            <option value="">{t('receivables.refunds.allSources')}</option>
            {(['reservation', 'sale', 'customer_credit'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`receivables.target.${s}`)}
              </option>
            ))}
          </Select>
          {(lp.get('customerId') || sourceType || sourceId || lp.get('q')) && (
            <Button
              variant="ghost"
              onClick={() => {
                setCustomerLabel('');
                search.clear();
                lp.set({ customerId: null, sourceType: null, sourceId: null, q: null });
              }}
            >
              {t('common.clearFilters')}
            </Button>
          )}
        </div>
        {sourceId && sourceType === 'reservation' && (
          <p className="px-4 pb-3 text-[13px] text-muted">
            {t('receivables.refunds.filteredBySource')}{' '}
            <Link to={`/app/reservations/${sourceId}`} className="text-brand-strong hover:underline">
              {t('receivables.refunds.openSource')}
            </Link>
          </p>
        )}
        <RefundsTable rows={q.data?.items} loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} />
        {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
      </Card>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-subtle">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
        {t('receivables.refunds.makerChecker')}
      </p>
      {requesting && <RequestRefundModal onClose={() => setRequesting(false)} onDone={() => lp.set({ status: null })} />}
    </>
  );
}
