import clsx from 'clsx';
import { Ban, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog } from '@/components/ui/Modal';
import { newIdempotencyKey } from '@/lib/api';
import { Can } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { PAYABLE_KEYS, SupplierPayment, SupplierPaymentAllocation, useCashAccountOptions, useDocInfo, useSupplier, useSupplierPayment } from './api';
import { documentHref, Money, PaymentStatusBadge, Stat, TargetTypeBadge, useTenantMoney } from './components';
import { usePurchasingMutation } from './mutation';

/** Document label and settled document-currency amount, read from the document itself. */
function AllocationDocument({ a }: { a: SupplierPaymentAllocation }) {
  const { t } = useTranslation();
  const doc = useDocInfo(a.targetType, a.targetId);
  const href = documentHref(a.targetType, a.targetId);
  const label = doc.info?.label ?? t('purchasing.paymentDetail.documentRef', { id: a.targetId.slice(0, 8) });
  return (
    <div className="min-w-0 space-y-1">
      <TargetTypeBadge type={a.targetType} />
      <p className="truncate font-medium">
        {href ? (
          <Link to={href} className="hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
      </p>
    </div>
  );
}

function SettledDoc({ a, base }: { a: SupplierPaymentAllocation; base: string }) {
  const doc = useDocInfo(a.targetType, a.targetId);
  if (!a.amountDoc) return <span className="text-subtle">—</span>;
  const cur = doc.info?.currency ?? base;
  if (cur === base) return <span className="text-subtle">—</span>;
  return <Money value={a.amountDoc} currency={cur} />;
}

export function SupplierPaymentDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { base } = useTenantMoney();
  const q = useSupplierPayment(id);
  const supplier = useSupplier(q.data?.supplierId);
  const accounts = useCashAccountOptions();
  const [voiding, setVoiding] = useState(false);
  const [voidKey, setVoidKey] = useState('');
  const voidM = usePurchasingMutation<{ reason: string }, SupplierPayment>({
    path: `/supplier-payments/${id}/void`,
    idempotent: true,
    invalidate: PAYABLE_KEYS,
    success: t('purchasing.payments.voided'),
    onSuccess: () => setVoiding(false),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  const p = q.data;
  const account = accounts.data?.find((a) => a.id === p.cashAccountId);
  const foreign = p.currency !== base;
  const fxTotal = p.allocations.reduce((acc, a) => acc.plus(d(a.paymentBase).minus(a.amountBase)), d(0));
  // Realised FX difference (payment share − carrying amount relieved); only meaningful when non-zero.
  const showFx = foreign || !fxTotal.isZero();

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('purchasing.payments.title'), to: '/app/purchasing/payments' }, { label: p.number }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="num">{p.number}</span>
            <PaymentStatusBadge status={p.status} />
          </span>
        }
        subtitle={p.supplierId ? (supplier.data?.name ?? '…') : t('purchasing.payments.directPurchases')}
        actions={
          p.status === 'posted' && (
            <Can perm="payments.void">
              <Button
                variant="ghost"
                className="text-danger"
                icon={<Ban className="h-4 w-4" />}
                onClick={() => {
                  setVoidKey(newIdempotencyKey());
                  setVoiding(true);
                }}
              >
                {t('purchasing.payments.void')}
              </Button>
            </Can>
          )
        }
      />

      {p.status === 'voided' && (
        <Alert tone="danger" className="mb-4" title={t('purchasing.payments.voidedOn', { date: fmtDateTime(p.voidedAt) })}>
          {p.voidReason}
        </Alert>
      )}

      <div className={clsx('mb-5 grid gap-4', showFx ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        <Card className="p-4">
          <Stat label={t('common.amount')}>
            <Money value={p.amount} currency={p.currency} className="text-lg font-semibold" />
          </Stat>
          {foreign && <p className="num mt-1 text-xs text-muted">{t('purchasing.fx.atRate', { rate: d(p.exchangeRate).toString() })}</p>}
        </Card>
        <Card className="p-4">
          <Stat label={t('purchasing.paymentDetail.amountBase')}>
            <Money value={p.amountBase} currency={base} className="text-lg font-semibold" />
          </Stat>
        </Card>
        {showFx && (
          <Card className="p-4">
            <Stat label={t('purchasing.paymentForm.fxDifference')}>
              <Money value={fxTotal.toFixed(2)} currency={base} className="text-lg font-semibold" />
            </Stat>
            <p className="mt-1 text-xs text-muted">{t('purchasing.paymentDetail.fxHint')}</p>
          </Card>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card className="min-w-0">
          <CardHeader title={t('purchasing.paymentDetail.allocations')} subtitle={t('purchasing.paymentDetail.allocationsHint')} />
          <DataTable
            rows={p.allocations}
            rowKey={(a) => a.id}
            columns={[
              { key: 'doc', header: t('purchasing.payables.document'), cell: (a) => <AllocationDocument a={a} /> },
              { key: 'paid', header: t('purchasing.paymentDetail.paidShare'), align: 'end', cell: (a) => <Money value={a.paymentBase} currency={base} /> },
              { key: 'settled', header: t('purchasing.payments.settled'), align: 'end', cell: (a) => <Money value={a.amountBase} currency={base} /> },
              { key: 'doc-amt', header: t('purchasing.paymentDetail.settledDoc'), align: 'end', hideOnMobile: true, cell: (a) => <SettledDoc a={a} base={base} /> },
            ]}
          />
        </Card>
        <Card className="min-w-0">
          <CardHeader title={t('common.details')} />
          <CardBody>
            <DescriptionList
              columns={1}
              items={[
                {
                  label: t('purchasing.payables.supplier'),
                  value: p.supplierId ? (
                    <Link to={`/app/purchasing/suppliers/${p.supplierId}`} className="inline-flex items-center gap-1 font-medium text-brand-strong hover:underline">
                      {supplier.data?.name ?? '…'} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  ) : (
                    t('purchasing.payments.directPurchases')
                  ),
                },
                { label: t('purchasing.payments.cashAccount'), value: account ? `${account.name} (${account.currency})` : p.currency },
                { label: t('purchasing.paymentForm.paidAt'), value: fmtDate(p.paidAt) },
                { label: t('purchasing.payments.method'), value: t(`purchasing.enums.method.${p.method}`) },
                { label: t('common.reference'), value: p.reference ? <span className="num">{p.reference}</span> : null },
                ...(foreign ? [{ label: t('purchasing.fx.rateLabel'), value: <span className="num">{d(p.exchangeRate).toString()}</span> }] : []),
                { label: t('common.notes'), value: p.notes },
                { label: t('common.createdAt'), value: fmtDateTime(p.createdAt) },
              ]}
            />
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={voiding}
        onClose={() => setVoiding(false)}
        title={t('purchasing.payments.voidTitle', { number: p.number })}
        message={t('purchasing.payments.voidHint')}
        confirmLabel={t('purchasing.payments.void')}
        tone="danger"
        requireReason
        loading={voidM.isPending}
        onConfirm={(reason) => voidM.mutate({ reason, __idemKey: voidKey })}
      />
    </>
  );
}
