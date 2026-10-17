import { CreditCard, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { fmtDate } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { Paged, SupplierPaymentListItem, useApAccess, useCashAccountOptions } from './api';
import { Money, PaymentStatusBadge, SupplierPicker, useTenantMoney } from './components';

export function SupplierPaymentsListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { base } = useTenantMoney();
  const ap = useApAccess();
  const lp = useListParams();
  const accounts = useCashAccountOptions();
  const pageSize = 25;
  const supplierId = lp.get('supplierId');
  const q = useApi<Paged<SupplierPaymentListItem>>(
    ['supplier-payments', 'list'],
    '/supplier-payments',
    {
      page: lp.page,
      pageSize,
      // "none" (direct purchases) is not a filter the payments list supports.
      supplierId: supplierId && supplierId !== 'none' ? supplierId : undefined,
      cashAccountId: lp.get('cashAccountId') || undefined,
      status: lp.get('status') || undefined,
    },
    { placeholderData: (p) => p },
  );
  const filtered = !!(supplierId || lp.get('cashAccountId') || lp.get('status'));

  return (
    <>
      <PageHeader
        title={t('purchasing.payments.title')}
        subtitle={t('purchasing.payments.subtitle')}
        actions={
          ap.pay && (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/app/purchasing/payments/new')}>
              {t('purchasing.payments.add')}
            </Button>
          )
        }
      />
      <Card className="mb-4">
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(240px,1.5fr)_repeat(2,minmax(160px,1fr))_auto]">
          <SupplierPicker value={supplierId} onChange={(v) => lp.set({ supplierId: v })} clearable activeOnly={false} />
          <Select value={lp.get('cashAccountId')} onChange={(e) => lp.set({ cashAccountId: e.target.value })} aria-label={t('purchasing.payments.cashAccount')}>
            <option value="">
              {t('purchasing.payments.cashAccount')}: {t('common.all')}
            </option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </Select>
          <Select value={lp.get('status')} onChange={(e) => lp.set({ status: e.target.value })} aria-label={t('common.status')}>
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            <option value="posted">{t('purchasing.enums.paymentStatus.posted')}</option>
            <option value="voided">{t('purchasing.enums.paymentStatus.voided')}</option>
          </Select>
          {filtered && (
            <Button variant="ghost" onClick={() => lp.set({ supplierId: null, cashAccountId: null, status: null })}>
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
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/app/purchasing/payments/${p.id}`)}
          empty={
            <EmptyState
              icon={<CreditCard className="h-5 w-5" />}
              title={filtered ? t('common.noResults') : t('purchasing.payments.empty')}
              description={filtered ? undefined : t('purchasing.payments.emptyHint')}
            />
          }
          columns={[
            {
              key: 'number',
              header: t('purchasing.payments.number'),
              cell: (p) => (
                <div>
                  <p className="num font-medium">{p.number}</p>
                  <p className="text-xs text-muted">{fmtDate(p.paidAt)}</p>
                </div>
              ),
            },
            {
              key: 'supplier',
              header: t('purchasing.payables.supplier'),
              cell: (p) =>
                p.supplierId ? (
                  <Link to={`/app/purchasing/suppliers/${p.supplierId}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                    {p.supplierName}
                  </Link>
                ) : (
                  <span className="text-muted">{t('purchasing.payments.directPurchases')}</span>
                ),
            },
            { key: 'account', header: t('purchasing.payments.cashAccount'), hideOnMobile: true, cell: (p) => p.cashAccountName },
            {
              key: 'method',
              header: t('purchasing.payments.method'),
              hideOnMobile: true,
              cell: (p) => (
                <div>
                  <p>{t(`purchasing.enums.method.${p.method}`)}</p>
                  {p.reference && <p className="num text-xs text-muted">{p.reference}</p>}
                </div>
              ),
            },
            {
              key: 'amount',
              header: t('common.amount'),
              align: 'end',
              cell: (p) => (
                <div className={p.status === 'voided' ? 'text-subtle line-through' : ''}>
                  <Money value={p.amount} currency={p.currency} className="font-medium" />
                  {p.currency !== base && (
                    <p className="text-xs text-muted">
                      <Money value={p.amountBase} currency={base} />
                    </p>
                  )}
                </div>
              ),
            },
            { key: 'status', header: t('common.status'), cell: (p) => <PaymentStatusBadge status={p.status} /> },
          ]}
          footer={q.data && <Pagination page={lp.page} pageSize={pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
    </>
  );
}
