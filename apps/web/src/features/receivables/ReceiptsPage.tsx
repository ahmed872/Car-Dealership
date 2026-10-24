import { HandCoins, Plus, ReceiptText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Select } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { ReceiptListItem } from './api';
import { ReceiptStatusBadge, VoidReceiptDialog } from './components';
import { RecordReceiptModal } from './dialogs';
import { CustomerPicker, ListSearchInput, Money, Paged, useCashAccountOptions, useListSearch, useTenantMoney } from './kit';

type StatusTab = 'all' | 'posted' | 'voided';

/** Customer receipts: deposits, advances, sale and installment payments. */
export function ReceiptsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { base } = useTenantMoney();
  const lp = useListParams({ status: 'all' });
  const status = (lp.get('status') || 'all') as StatusTab;
  const [customerLabel, setCustomerLabel] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<ReceiptListItem | null>(null);
  const accounts = useCashAccountOptions();
  const search = useListSearch(lp);
  const q = useApi<Paged<ReceiptListItem>>(
    ['receipts'],
    '/receipts',
    {
      page: lp.page,
      pageSize: 25,
      q: lp.get('q') || undefined,
      status: status === 'all' ? undefined : status,
      customerId: lp.get('customerId') || undefined,
      cashAccountId: lp.get('cashAccountId') || undefined,
    },
    { placeholderData: (p) => p },
  );

  return (
    <>
      <PageHeader
        title={t('receivables.receipts.title')}
        subtitle={t('receivables.receipts.subtitle')}
        actions={
          <Can perm="payments.receive">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRecording(true)}>
              {t('receivables.receipts.new')}
            </Button>
          </Can>
        }
      />
      <Card>
        <div className="px-4 pt-2">
          <Tabs<StatusTab>
            value={status}
            onChange={(k) => lp.set({ status: k === 'all' ? null : k })}
            tabs={[
              { key: 'all', label: t('common.all') },
              { key: 'posted', label: t('receivables.receiptStatus.posted') },
              { key: 'voided', label: t('receivables.receiptStatus.voided') },
            ]}
          />
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,240px)_auto]">
          <ListSearchInput value={search.text} onChange={search.setText} placeholder={t('receivables.receipts.searchHint')} />
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
          <Select aria-label={t('receivables.kit.account')} value={lp.get('cashAccountId')} onChange={(e) => lp.set({ cashAccountId: e.target.value || null })}>
            <option value="">{t('receivables.receipts.allAccounts')}</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </Select>
          {(lp.get('customerId') || lp.get('cashAccountId') || lp.get('q')) && (
            <Button
              variant="ghost"
              onClick={() => {
                setCustomerLabel('');
                search.clear();
                lp.set({ customerId: null, cashAccountId: null, q: null });
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
          onRowClick={(r) => navigate(`/app/receipts/${r.id}`)}
          empty={
            <EmptyState
              icon={<ReceiptText className="h-5 w-5" />}
              title={t('receivables.receipts.empty')}
              description={can('payments.receive') ? t('receivables.receipts.emptyHint') : undefined}
            />
          }
          columns={[
            {
              key: 'number',
              header: t('receivables.fields.number'),
              cell: (r) => (
                <Link to={`/app/receipts/${r.id}`} onClick={(e) => e.stopPropagation()} className="num whitespace-nowrap font-medium text-brand-strong hover:underline">
                  {r.number}
                </Link>
              ),
            },
            { key: 'date', header: t('common.date'), cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.receivedAt)}</span> },
            { key: 'customer', header: t('receivables.fields.customer'), cell: (r) => <span className="block max-w-[200px] truncate">{r.customerName}</span> },
            { key: 'account', header: t('receivables.kit.account'), hideOnMobile: true, cell: (r) => <span className="block max-w-[180px] truncate text-muted">{r.cashAccountName}</span> },
            { key: 'method', header: t('receivables.kit.method'), hideOnMobile: true, cell: (r) => t(`receivables.kit.methods.${r.method}`, { defaultValue: r.method }) },
            {
              key: 'amount',
              header: t('common.amount'),
              align: 'end',
              cell: (r) => (
                <div>
                  <Money value={r.amount} currency={r.currency} className="font-medium" />
                  {r.currency !== base && <Money value={r.amountBase} currency={base} className="block text-xs text-muted" />}
                </div>
              ),
            },
            { key: 'status', header: t('common.status'), cell: (r) => <ReceiptStatusBadge status={r.status} /> },
            {
              key: 'actions',
              header: t('common.actions'),
              cell: (r) =>
                r.status === 'posted' && can('payments.void') ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setVoiding(r);
                    }}
                  >
                    {t('receivables.receipts.void')}
                  </Button>
                ) : null,
            },
          ]}
          footer={q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
      {recording && <RecordReceiptModal onClose={() => setRecording(false)} onDone={(r) => navigate(`/app/receipts/${r.id}`)} />}
      {voiding && <VoidReceiptDialog receipt={voiding} onClose={() => setVoiding(null)} />}
      <p className="mt-3 flex items-center gap-1.5 text-xs text-subtle">
        <HandCoins className="h-3.5 w-3.5" aria-hidden />
        {t('receivables.receipts.ledgerNote')}
      </p>
    </>
  );
}
