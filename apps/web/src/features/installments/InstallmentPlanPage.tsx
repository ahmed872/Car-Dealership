import { useQueryClient } from '@tanstack/react-query';
import { Calculator, HandCoins, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { d, FUTURE_INTEREST_POLICIES, FutureInterestPolicy } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, ErrorState, PageLoader, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtNumber, fmtPct } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { CashAccountOption, InstallmentPlanDetail, PaymentMethod, SaleDetail, SettlementQuote } from '@/features/sales/api';
import { useCashAccountOptions } from '@/features/sales/api';
import {
  CashAccountSelect,
  FailureAlert,
  LineStatusBadge,
  MethodSelect,
  Money,
  PlanStatusBadge,
  ReceivePaymentModal,
  Row,
  Stat,
  useIdempotencyKey,
  useSalesError,
  useSalesMutation,
  useTenantMoney,
} from '@/features/sales/shared';

export function InstallmentPlanPage() {
  const { id } = useParams();
  const q = useApi<InstallmentPlanDetail>(['installment-plan', id], id ? `/installment-plans/${id}` : null);
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  return <PlanView plan={q.data} onReload={() => void q.refetch()} />;
}

function PlanView({ plan: p, onReload }: { plan: InstallmentPlanDetail; onReload: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [collect, setCollect] = useState(false);
  const sale = useApi<SaleDetail>(['sale', p.saleId], can('sales.read') ? `/sales/${p.saleId}` : null);
  const next = p.lines.find((l) => d(l.remaining).gt(0));
  const active = p.status === 'active';
  const canCollect = active && d(p.outstanding).gt(0) && can('payments.receive');
  const customerName = sale.data?.customerSnapshot.fullName;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('installments.title'), to: '/app/installments' }, { label: p.saleNumber }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{t('installments.detail.title', { number: p.saleNumber })}</span>
            <PlanStatusBadge status={p.status} />
          </span>
        }
        subtitle={customerName}
        actions={
          canCollect && (
            <Button icon={<Wallet className="h-4 w-4" />} onClick={() => setCollect(true)}>
              {t('installments.collect.button')}
            </Button>
          )
        }
      />

      {p.status === 'scheduled' && (
        <Alert tone="info" className="mb-4">
          {t('installments.detail.scheduledHint')}
        </Alert>
      )}
      {p.status === 'settled' && (
        <Alert tone="success" className="mb-4" title={t('installments.detail.settledTitle', { date: fmtDateTime(p.settledAt) })}>
          {d(p.waivedInterest).gt(0) ? (
            <>
              {t('installments.detail.waivedInterest')}: <Money value={p.waivedInterest} className="font-medium" />
            </>
          ) : (
            t('installments.detail.noWaiver')
          )}
        </Alert>
      )}
      {p.status === 'cancelled' && (
        <Alert tone="danger" className="mb-4">
          {t('installments.detail.cancelledHint')}
        </Alert>
      )}
      {p.status === 'completed' && (
        <Alert tone="success" className="mb-4">
          {t('installments.detail.completedHint')}
        </Alert>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <Stat label={t('installments.fields.total')}>
            <Money value={p.totalAmount} className="text-lg font-semibold" />
          </Stat>
        </Card>
        <Card className="p-4">
          <Stat label={t('installments.fields.outstanding')}>
            <Money value={p.outstanding} className="text-lg font-semibold" />
          </Stat>
        </Card>
        <Card className="p-4">
          <Stat label={t('installments.fields.overdue')}>
            <Money value={p.overdueAmount} className={d(p.overdueAmount).gt(0) ? 'text-lg font-semibold text-danger' : 'text-lg font-semibold'} />
          </Stat>
        </Card>
        <Card className="p-4">
          <Stat label={t('installments.fields.nextDue')}>
            {next && active ? (
              <span>
                <Money value={next.remaining} className="text-lg font-semibold" />
                <span className="ms-2 text-xs text-muted">{fmtDate(next.dueDate)}</span>
              </span>
            ) : (
              <span className="text-sm text-muted">—</span>
            )}
          </Stat>
        </Card>
      </div>

      <div className="mb-5 grid items-start gap-5 lg:grid-cols-2">
        {active && <SettlementCard plan={p} onReload={onReload} />}
        <Card>
          <CardHeader title={t('installments.detail.terms')} />
          <CardBody>
            <DescriptionList
              items={[
                {
                  label: t('installments.fields.sale'),
                  value: can('sales.read') ? (
                    <Link to={`/app/sales/${p.saleId}`} className="num font-medium text-brand-strong hover:underline">
                      {p.saleNumber}
                    </Link>
                  ) : (
                    <span className="num">{p.saleNumber}</span>
                  ),
                },
                { label: t('sales.fields.instMethod'), value: t(`sales.instMethod.${p.method}`) },
                { label: t('sales.fields.annualRate'), value: fmtPct(p.annualRatePct, 2) },
                { label: t('sales.fields.count'), value: <span className="num">{fmtNumber(p.count)}</span> },
                { label: t('sales.fields.frequency'), value: t(`sales.frequency.m${p.frequencyMonths}`) },
                { label: t('sales.fields.firstDueDate'), value: fmtDate(p.firstDueDate) },
                { label: t('sales.fields.principal'), value: <Money value={p.principal} /> },
                { label: t('sales.fields.interest'), value: <Money value={p.interestTotal} /> },
                { label: t('sales.fields.fees'), value: <Money value={p.feesTotal} /> },
                { label: t('installments.fields.policy'), value: t(`installments.policy.${p.futureInterestPolicy}`) },
                {
                  label: t('installments.fields.allocationOrder'),
                  value: p.allocationOrder.map((c) => t(`installments.component.${c}`)).join(' ← '),
                  full: true,
                },
                { label: t('installments.fields.activatedAt'), value: p.activatedAt ? fmtDateTime(p.activatedAt) : '—' },
              ]}
            />
            <p className="mt-4 text-xs text-muted">{t('installments.detail.noLateFees')}</p>
          </CardBody>
        </Card>
      </div>

      <div className="space-y-5">
        <Card>
          <CardHeader title={t('installments.detail.schedule')} subtitle={t('installments.detail.scheduleHint')} />
          <DataTable
            dense
            rows={p.lines}
            rowKey={(l) => l.id}
            columns={[
              { key: 'seq', header: '#', cell: (l) => <span className="num">{l.seq}</span> },
              { key: 'due', header: t('sales.fields.dueDate'), cell: (l) => <span className="whitespace-nowrap">{fmtDate(l.dueDate)}</span> },
              { key: 'principal', header: t('sales.fields.principal'), align: 'end', hideOnMobile: true, cell: (l) => <Money value={l.principalDue} /> },
              { key: 'interest', header: t('sales.fields.interest'), align: 'end', hideOnMobile: true, cell: (l) => <Money value={l.interestDue} /> },
              ...(d(p.feesTotal).gt(0) ? [{ key: 'fees', header: t('sales.fields.fees'), align: 'end' as const, hideOnMobile: true, cell: (l: InstallmentPlanDetail['lines'][number]) => <Money value={l.feesDue} /> }] : []),
              { key: 'total', header: t('sales.fields.installment'), align: 'end', cell: (l) => <Money value={l.totalDue} className="font-medium" /> },
              { key: 'paid', header: t('installments.fields.paid'), align: 'end', cell: (l) => <Money value={l.paid} className={d(l.paid).gt(0) ? 'text-success' : 'text-muted'} /> },
              {
                key: 'remaining',
                header: t('installments.fields.remaining'),
                align: 'end',
                cell: (l) =>
                  d(l.waived).gt(0) ? (
                    <span className="text-xs text-muted">
                      {t('installments.fields.waived')}: <Money value={l.waived} />
                    </span>
                  ) : (
                    <Money value={l.remaining} className={d(l.remaining).gt(0) ? 'font-medium' : 'text-muted'} />
                  ),
              },
              { key: 'status', header: t('common.status'), cell: (l) => <LineStatusBadge status={l.status} /> },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title={t('installments.detail.payments')} />
          <DataTable
            dense
            rows={p.payments}
            rowKey={(r) => r.receiptId}
            empty={<p className="px-5 py-4 text-sm text-muted">{t('installments.detail.noPayments')}</p>}
            columns={[
              { key: 'number', header: t('sales.payments.number'), cell: (r) => <span className="num font-medium whitespace-nowrap">{r.number}</span> },
              { key: 'date', header: t('common.date'), cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.receivedAt)}</span> },
              { key: 'amount', header: t('common.amount'), align: 'end', cell: (r) => <Money value={r.amount} className={r.status === 'voided' ? 'text-muted line-through' : 'font-medium'} /> },
              { key: 'status', header: t('common.status'), cell: (r) => <Badge tone={r.status === 'posted' ? 'success' : 'danger'}>{t(`sales.payments.status.${r.status}`)}</Badge> },
            ]}
          />
        </Card>
      </div>

      {collect && (
        <ReceivePaymentModal
          title={t('installments.collect.title', { number: p.saleNumber })}
          description={t('installments.collect.hint')}
          customerId={p.customerId}
          targetType="installment"
          targetId={p.id}
          defaultAmount={next?.remaining ?? p.outstanding}
          maxBase={p.outstanding}
          onClose={() => setCollect(false)}
        />
      )}
    </>
  );
}

// ── Early settlement: quote, then settle with the quoted total ───────────────────────────

function SettlementCard({ plan: p, onReload }: { plan: InstallmentPlanDetail; onReload: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { today } = useTenantMoney();
  const describe = useSalesError();
  const [asOf, setAsOf] = useState(today);
  const [policy, setPolicy] = useState<FutureInterestPolicy | ''>('');
  const [settling, setSettling] = useState(false);
  const canOverride = can('installments.settle');
  // Keyed on the outstanding balance: any payment re-quotes, and a settled or completed plan
  // (whose card unmounts) is never re-queried.
  const quote = useApi<SettlementQuote>(
    ['settlement-quote', p.id, p.outstanding],
    asOf ? `/installment-plans/${p.id}/settlement-quote` : null,
    { asOf, futureInterestPolicy: policy || undefined },
    // Keep showing the previous quote while a new one loads (the settle dialog stays open).
    { placeholderData: (prev) => prev },
  );
  const q = quote.data;
  const canSettle = can('installments.settle', 'payments.receive');

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Calculator className="h-4 w-4 text-muted" aria-hidden />
            {t('installments.settle.title')}
          </span>
        }
        subtitle={t('installments.settle.hint')}
        actions={quote.isFetching ? <Spinner label="" /> : undefined}
      />
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('installments.settle.asOf')} hint={asOf > today ? t('installments.settle.futureHint') : undefined}>
            {(id, desc) => <Input id={id} aria-describedby={desc} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}
          </Field>
          {canOverride && (
            <Field label={t('installments.settle.policy')} hint={t('installments.settle.policyHint')}>
              {(id, desc) => (
                <Select id={id} aria-describedby={desc} value={policy} onChange={(e) => setPolicy(e.target.value as FutureInterestPolicy | '')}>
                  <option value="">{t('installments.settle.policyDefault', { policy: t(`installments.policy.${p.futureInterestPolicy}`) })}</option>
                  {FUTURE_INTEREST_POLICIES.map((x) => (
                    <option key={x} value={x}>
                      {t(`installments.policy.${x}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        {quote.error ? <Alert tone="danger">{describe(quote.error)}</Alert> : null}
        {q && (
          <dl className="divide-y divide-line rounded-xl border border-line px-4">
            <Row label={t('sales.fields.principal')}>
              <Money value={q.principal} />
            </Row>
            <Row label={t('installments.settle.interestCharged')}>
              <Money value={q.interest} />
            </Row>
            {d(q.fees).gt(0) && (
              <Row label={t('sales.fields.fees')}>
                <Money value={q.fees} />
              </Row>
            )}
            <Row label={t('installments.settle.interestWaived')} tone="success">
              <Money value={q.waivedInterest} />
            </Row>
            <Row label={t('installments.settle.total')} strong>
              <Money value={q.total} />
            </Row>
          </dl>
        )}
        {q && <p className="text-xs text-muted">{t('installments.settle.policyApplied', { policy: t(`installments.policy.${q.policy}`), date: fmtDate(q.asOf) })}</p>}
        {canSettle ? (
          <Button
            className="w-full justify-center"
            icon={<HandCoins className="h-4 w-4" />}
            disabled={!q || !d(q.total).gt(0) || asOf > today || quote.isFetching}
            onClick={() => setSettling(true)}
          >
            {t('installments.settle.button')}
          </Button>
        ) : (
          <p className="text-xs text-muted">{t('installments.settle.needsPermission')}</p>
        )}
      </CardBody>
      {settling && q && (
        <SettleModal
          plan={p}
          quote={q}
          policyOverride={policy || undefined}
          refreshing={quote.isFetching}
          refetchQuote={() => quote.refetch()}
          onReload={onReload}
          onClose={() => setSettling(false)}
        />
      )}
    </Card>
  );
}

function SettleModal({
  plan: p,
  quote,
  policyOverride,
  refreshing,
  refetchQuote,
  onReload,
  onClose,
}: {
  plan: InstallmentPlanDetail;
  quote: SettlementQuote;
  policyOverride?: FutureInterestPolicy;
  refreshing: boolean;
  refetchQuote: () => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { base } = useTenantMoney();
  const qc = useQueryClient();
  const accounts = useCashAccountOptions();
  const [idemKey] = useIdempotencyKey();
  const [account, setAccount] = useState<CashAccountOption | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const settle = useSalesMutation<Record<string, unknown>, { receipt: { number: string } }>({
    path: `/installment-plans/${p.id}/settle`,
    idempotent: true,
    toastError: false,
    success: (r) => t('installments.settle.done', { number: r.receipt.number }),
    onSuccess: onClose,
  });
  const changed = failure instanceof ApiError && failure.code === 'quote_changed';
  const baseAccounts = (accounts.data ?? []).filter((a) => a.currency === base);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('installments.settle.confirmTitle', { number: p.saleNumber })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={settle.isPending}
            disabled={!account || refreshing}
            onClick={() => {
              setFailure(null);
              settle.mutate(
                {
                  cashAccountId: account!.id,
                  method,
                  reference: reference.trim() || null,
                  paidAt: quote.asOf,
                  ...(policyOverride ? { futureInterestPolicy: policyOverride } : {}),
                  expectedTotal: quote.total,
                  __idemKey: idemKey,
                },
                {
                  onError: (e) => {
                    setFailure(e);
                    if (e instanceof ApiError && e.code === 'quote_changed') {
                      void qc.invalidateQueries({ queryKey: ['installment-plan', p.id] });
                      refetchQuote();
                    }
                  },
                },
              );
            }}
          >
            <span>{t('installments.settle.confirm')}</span>
            <Money value={quote.total} />
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {changed ? (
          <Alert tone="warning" title={t('installments.settle.changedTitle')}>
            {t('installments.settle.changedBody')}
          </Alert>
        ) : (
          failure !== null && <FailureAlert error={failure} onReload={onReload} />
        )}
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm">
          <span className="text-muted">{t('installments.settle.total')}</span>
          <Money value={quote.total} className="text-base font-semibold" />
        </div>
        <p className="text-xs text-muted">
          {t('installments.settle.policyApplied', { policy: t(`installments.policy.${quote.policy}`), date: fmtDate(quote.asOf) })}
          {d(quote.waivedInterest).gt(0) && (
            <>
              {' · '}
              {t('installments.settle.interestWaived')}: <Money value={quote.waivedInterest} />
            </>
          )}
        </p>
        <Field label={t('sales.payment.account')} required hint={t('installments.settle.baseOnly', { currency: base })}>
          {(id, desc) => <CashAccountSelect id={id} describedBy={desc} value={account?.id ?? ''} accounts={accounts.data} baseOnly onChange={setAccount} />}
        </Field>
        {accounts.data && baseAccounts.length === 0 && <Alert tone="warning">{t('installments.settle.noBaseAccount', { currency: base })}</Alert>}
        <Field label={t('sales.payment.method')}>{(id) => <MethodSelect id={id} value={method} onChange={setMethod} />}</Field>
        <Field label={t('common.reference')}>{(id) => <Input id={id} maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}
