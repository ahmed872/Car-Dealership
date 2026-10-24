import { Ban, ReceiptText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ApiError } from '@/lib/api';
import { ReceiptDetail } from './api';
import { ReceiptStatusBadge, SourceLink, VoidReceiptDialog } from './components';
import { Money, useCashAccountOptions, useTenantMoney } from './kit';

export function ReceiptDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const { base } = useTenantMoney();
  const [voiding, setVoiding] = useState(false);
  const q = useApi<ReceiptDetail>(['receipt', id], id ? `/receipts/${id}` : null);
  const accounts = useCashAccountOptions();

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) {
    if (q.error instanceof ApiError && q.error.status === 404) return <EmptyState icon={<ReceiptText className="h-5 w-5" />} title={t('receivables.receipts.notFound')} />;
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  }
  const r = q.data;
  const account = accounts.data?.find((a) => a.id === r.cashAccountId);
  const foreign = r.currency !== base;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('receivables.receipts.title'), to: '/app/receipts' }, { label: r.number }]}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="num">{r.number}</span>
            <ReceiptStatusBadge status={r.status} />
          </span>
        }
        subtitle={r.customerName ?? undefined}
        actions={
          r.status === 'posted' &&
          can('payments.void') && (
            <Button variant="outline" icon={<Ban className="h-4 w-4" />} onClick={() => setVoiding(true)}>
              {t('receivables.receipts.void')}
            </Button>
          )
        }
      />
      {r.status === 'voided' && (
        <Alert tone="danger" title={t('receivables.receipts.voidedTitle')} className="mb-4">
          {r.voidReason} {r.voidedAt ? `· ${fmtDateTime(r.voidedAt)}` : ''}
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader title={t('receivables.receipts.details')} />
          <CardBody>
            <DescriptionList
              items={[
                {
                  label: t('receivables.fields.customer'),
                  value: (
                    <Link to={`/app/customers/${r.customerId}`} className="text-brand-strong hover:underline">
                      {r.customerName ?? '—'}
                    </Link>
                  ),
                },
                { label: t('common.date'), value: fmtDate(r.receivedAt) },
                { label: t('receivables.kit.account'), value: account ? `${account.name} · ${account.currency}` : r.currency },
                { label: t('receivables.kit.method'), value: t(`receivables.kit.methods.${r.method}`, { defaultValue: r.method }) },
                { label: t('common.reference'), value: r.reference ?? '—' },
                { label: t('receivables.receipts.recordedAt'), value: fmtDateTime(r.createdAt) },
                { label: t('common.notes'), value: r.notes ?? '—', full: true },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('common.amount')} />
          <CardBody className="space-y-3">
            <p className="num text-2xl font-semibold text-ink">
              <Money value={r.amount} currency={r.currency} />
            </p>
            {foreign && (
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">{t('receivables.receipts.rate')}</dt>
                  <dd className="num">{d(r.exchangeRate).toString()}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">{t('receivables.kit.baseEquivalent')}</dt>
                  <dd>
                    <Money value={r.amountBase} />
                  </dd>
                </div>
              </dl>
            )}
          </CardBody>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title={t('receivables.receipts.allocations')} subtitle={t('receivables.receipts.allocationsHint', { currency: base })} />
        <DataTable
          rows={r.allocations}
          rowKey={(a) => a.id}
          columns={[
            { key: 'type', header: t('common.type'), cell: (a) => <SourceLink type={a.targetType} id={a.targetId} customerId={r.customerId} /> },
            { key: 'doc', header: t('receivables.fields.number'), cell: (a) => (a.targetType === 'reservation' ? <ReservationNumber id={a.targetId} /> : '—') },
            { key: 'amount', header: t('receivables.receipts.allocated'), align: 'end', cell: (a) => <Money value={a.amountBase} className="font-medium" /> },
          ]}
        />
      </Card>
      {voiding && <VoidReceiptDialog receipt={r} onClose={() => setVoiding(false)} />}
    </>
  );
}

/** The reservation number behind a deposit allocation (shown when the user may read reservations). */
function ReservationNumber({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useApi<{ number: string }>(['reservation', id], can('reservations.read') ? `/reservations/${id}` : null);
  if (!q.data) return <span className="text-muted">—</span>;
  return (
    <Link to={`/app/reservations/${id}`} className="num whitespace-nowrap text-brand-strong hover:underline">
      {q.data.number}
    </Link>
  );
}
