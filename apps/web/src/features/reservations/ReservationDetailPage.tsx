import { BookmarkCheck, CalendarClock, HandCoins, Undo2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { ReceiptStatusBadge, RefundsTable, VoidReceiptDialog } from '@/features/receivables/components';
import { RequestRefundModal } from '@/features/receivables/dialogs';
import { Money, Row, useTenantMoney, vehicleLabel } from '@/features/receivables/kit';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ReservationDetail } from './api';
import { CancelReservationModal, DepositModal, ExpiryHint, ExtendModal, policyText, ReservationStatusBadge } from './components';

type Dialog = 'deposit' | 'extend' | 'cancel' | 'refund' | null;

export function ReservationDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { base } = useTenantMoney();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [voiding, setVoiding] = useState<{ id: string; number: string } | null>(null);
  const q = useApi<ReservationDetail>(['reservation', id], id ? `/reservations/${id}` : null);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) {
    if (q.error instanceof ApiError && q.error.status === 404) return <EmptyState icon={<BookmarkCheck className="h-5 w-5" />} title={t('reservations.notFound')} />;
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  }
  const r = q.data;
  const active = r.status === 'active';
  const outstanding = d(r.depositAmount).minus(r.receivedBase);
  const held = d(r.availableDepositBase);
  const vehicleTitle = r.vehicle ? vehicleLabel(r.vehicle, i18n.language) : '';
  const canRefund = (r.status === 'expired' || r.status === 'cancelled') && held.gt(0) && can('refunds.create');

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('reservations.title'), to: '/app/reservations' }, { label: r.number }]}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="num">{r.number}</span>
            <ReservationStatusBadge status={r.status} />
          </span>
        }
        subtitle={[vehicleTitle, r.customer?.fullName].filter(Boolean).join(' · ')}
        actions={
          <>
            {active && can('payments.receive') && (
              <Button variant="secondary" icon={<HandCoins className="h-4 w-4" />} onClick={() => setDialog('deposit')}>
                {t('reservations.addDeposit')}
              </Button>
            )}
            {active && can('reservations.extend') && (
              <Button variant="secondary" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setDialog('extend')}>
                {t('reservations.extend')}
              </Button>
            )}
            {active && can('reservations.cancel') && (
              <Button variant="danger" icon={<XCircle className="h-4 w-4" />} onClick={() => setDialog('cancel')}>
                {t('reservations.cancel')}
              </Button>
            )}
            {canRefund && (
              <Button icon={<Undo2 className="h-4 w-4" />} onClick={() => setDialog('refund')}>
                {t('reservations.requestRefund')}
              </Button>
            )}
          </>
        }
      />

      {r.status === 'expired' && (
        <Alert tone="warning" className="mb-4" title={t('reservations.expiredTitle', { date: fmtDateTime(r.expiredAt ?? r.expiresAt) })}>
          {held.gt(0) ? t('reservations.expiredHeld') : t('reservations.expiredNoDeposit')}
          {held.gt(0) && <Money value={r.availableDepositBase} currency={base} className="ms-1 font-semibold text-ink" />}
        </Alert>
      )}
      {r.status === 'cancelled' && (
        <Alert tone="info" className="mb-4" title={t('reservations.cancelledTitle', { date: fmtDateTime(r.cancelledAt) })}>
          {r.cancelReason}
        </Alert>
      )}
      {r.status === 'converted' && (
        <Alert tone="success" className="mb-4" title={t('reservations.convertedTitle', { date: fmtDateTime(r.convertedAt) })}>
          {r.saleId && (
            <Link to={`/app/sales/${r.saleId}`} className="text-brand-strong hover:underline">
              {t('reservations.openSale')}
            </Link>
          )}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader title={t('reservations.details')} />
          <CardBody>
            <DescriptionList
              items={[
                {
                  label: t('reservations.fields.vehicle'),
                  value: r.vehicle ? (
                    <Link to={`/app/vehicles/${r.vehicle.id}`} className="text-brand-strong hover:underline">
                      {vehicleTitle} <span className="num text-muted">· {r.vehicle.stockNumber}</span>
                    </Link>
                  ) : (
                    '—'
                  ),
                },
                {
                  label: t('reservations.fields.customer'),
                  value: r.customer ? (
                    <span>
                      <Link to={`/app/customers/${r.customer.id}`} className="text-brand-strong hover:underline">
                        {r.customer.fullName}
                      </Link>
                      {r.customer.phone && (
                        <span className="num ms-2 text-muted">
                          <bdi dir="ltr">{r.customer.phone}</bdi>
                        </span>
                      )}
                    </span>
                  ) : (
                    '—'
                  ),
                },
                { label: t('reservations.fields.reservedAt'), value: fmtDateTime(r.reservedAt) },
                {
                  label: t('reservations.fields.expiresAt'),
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {fmtDateTime(r.expiresAt)}
                      <ExpiryHint expiresAt={r.expiresAt} status={r.status} />
                    </span>
                  ),
                },
                { label: t('reservations.fields.extendedCount'), value: <span className="num">{r.extendedCount}</span> },
                { label: t('reservations.fields.agreedPrice'), value: r.agreedPrice ? <Money value={r.agreedPrice} currency={base} /> : t('reservations.noAgreedPrice') },
                { label: t('reservations.fields.refundPolicy'), value: policyText(r.refundPolicy, r.refundablePct, t) },
                {
                  label: t('reservations.fields.lead'),
                  value: r.leadId ? (
                    <Link to={`/app/leads/${r.leadId}`} className="text-brand-strong hover:underline">
                      {t('reservations.openLead')}
                    </Link>
                  ) : (
                    '—'
                  ),
                },
                { label: t('common.notes'), value: r.notes ?? '—', full: true },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('reservations.money.title')} subtitle={t('reservations.money.subtitle')} />
          <CardBody>
            <dl>
              <Row label={t('reservations.money.required')}>
                <Money value={r.depositAmount} currency={base} />
              </Row>
              <Row label={t('reservations.money.received')} tone="success">
                <Money value={r.receivedBase} currency={base} />
              </Row>
              {active && outstanding.gt(0) && (
                <Row label={t('reservations.money.outstanding')} tone="warning">
                  <Money value={outstanding.toFixed(2)} currency={base} />
                </Row>
              )}
              {d(r.forfeitedBase).gt(0) && (
                <Row label={t('reservations.money.forfeited')} tone="danger">
                  <Money value={r.forfeitedBase} currency={base} />
                </Row>
              )}
              <div className="mt-2 border-t border-line pt-2">
                <Row label={t('reservations.money.held')} strong>
                  <Money value={r.availableDepositBase} currency={base} />
                </Row>
              </div>
            </dl>
            <p className="mt-2 text-xs text-muted">{t('reservations.money.liabilityNote')}</p>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title={t('reservations.receipts')} />
        <DataTable
          rows={r.receipts}
          rowKey={(x) => x.receiptId}
          empty={<EmptyState icon={<HandCoins className="h-5 w-5" />} title={t('reservations.noReceipts')} />}
          columns={[
            {
              key: 'number',
              header: t('receivables.fields.number'),
              cell: (x) =>
                can('payments.read') ? (
                  <Link to={`/app/receipts/${x.receiptId}`} className="num whitespace-nowrap font-medium text-brand-strong hover:underline">
                    {x.number}
                  </Link>
                ) : (
                  <span className="num">{x.number}</span>
                ),
            },
            { key: 'date', header: t('common.date'), cell: (x) => <span className="whitespace-nowrap">{fmtDate(x.receivedAt)}</span> },
            { key: 'method', header: t('receivables.kit.method'), hideOnMobile: true, cell: (x) => t(`receivables.kit.methods.${x.method}`, { defaultValue: x.method }) },
            {
              key: 'amount',
              header: t('common.amount'),
              align: 'end',
              cell: (x) => (
                <div>
                  <Money value={x.amount} currency={x.currency} className="font-medium" />
                  {x.currency !== base && <Money value={x.amountBase} currency={base} className="block text-xs text-muted" />}
                </div>
              ),
            },
            { key: 'status', header: t('common.status'), cell: (x) => <ReceiptStatusBadge status={x.status} /> },
            {
              key: 'actions',
              header: t('common.actions'),
              cell: (x) =>
                x.status === 'posted' && can('payments.void') ? (
                  <Button size="sm" variant="ghost" onClick={() => setVoiding({ id: x.receiptId, number: x.number })}>
                    {t('receivables.receipts.void')}
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>

      <Card className="mt-4">
        <CardHeader
          title={t('reservations.refunds')}
          actions={
            can('payments.read') && r.refunds.length > 0 ? (
              <Link to={`/app/refunds?status=all&sourceType=reservation&sourceId=${r.id}`} className="text-[13px] text-brand-strong hover:underline">
                {t('reservations.allRefunds')}
              </Link>
            ) : null
          }
        />
        <RefundsTable rows={r.refunds} showSource={false} />
      </Card>

      {dialog === 'deposit' && <DepositModal reservation={r} onClose={() => setDialog(null)} />}
      {dialog === 'extend' && <ExtendModal reservation={r} onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && <CancelReservationModal reservation={r} onClose={() => setDialog(null)} />}
      {dialog === 'refund' && r.customer && (
        <RequestRefundModal
          source={{ type: 'reservation', id: r.id, customer: { id: r.customer.id, fullName: r.customer.fullName }, label: r.number, refundableBase: r.availableDepositBase }}
          onClose={() => setDialog(null)}
        />
      )}
      {voiding && <VoidReceiptDialog receipt={voiding} onClose={() => setVoiding(null)} />}
    </>
  );
}
