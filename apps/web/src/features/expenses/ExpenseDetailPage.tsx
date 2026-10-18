import { Check, CreditCard, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Field, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { Money, Stat, useFinMutation } from '@/features/cash/finance-ui';
import { categoryName, EXPENSE_KEYS, ExpenseDetail, useExpense } from './api';
import { ExpenseStatusBadge } from './components';

function ApproveModal({ e, onClose }: { e: ExpenseDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const { currency: base } = useAuth();
  const [note, setNote] = useState('');
  const approve = useFinMutation<{ note: string | null }, ExpenseDetail>({
    path: `/expenses/${e.id}/approve`,
    invalidate: EXPENSE_KEYS,
    success: t('expenses.detail.approved'),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('expenses.detail.approveTitle', { number: e.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="success"
            icon={<Check className="h-4 w-4" />}
            loading={approve.isPending}
            onClick={() => approve.mutate({ note: note.trim() || null })}
          >
            {t('expenses.detail.approve')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        {t('expenses.detail.approveHint', { value: fmtMoney(e.amountBase, base) })}
      </p>
      <Field label={t('expenses.detail.approveNote')} className="mt-4">
        {(id) => (
          <Textarea
            id={id}
            rows={3}
            maxLength={500}
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
          />
        )}
      </Field>
    </Modal>
  );
}

export function ExpenseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can, me, currency: base } = useAuth();
  const q = useExpense(id);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reversing, setReversing] = useState(false);

  const reject = useFinMutation<{ reason: string }, ExpenseDetail>({
    path: `/expenses/${id}/reject`,
    invalidate: EXPENSE_KEYS,
    success: t('expenses.detail.rejected'),
    onSuccess: () => setRejecting(false),
  });
  const reverse = useFinMutation<{ reason: string }, ExpenseDetail>({
    path: `/expenses/${id}/reverse`,
    idempotent: true,
    invalidate: EXPENSE_KEYS,
    success: t('expenses.detail.reversedOk'),
    onSuccess: () => setReversing(false),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  const e = q.data;
  const foreign = e.currency !== base;
  const canDecide = can('expenses.approve') && e.status === 'pending_approval';
  const ownRequest = !!me && e.createdBy === me.user.id;
  const paid = d(e.paidBase).gt(0);
  const outstanding = e.outstandingBase !== null && d(e.outstandingBase).gt(0);
  const canPay = can('supplier_payments.create') && e.status === 'posted' && outstanding;
  const canReverse = can('expenses.approve') && e.status === 'posted';
  const paymentLinks = can('suppliers.read', 'payments.read');
  const ledgerLinks = can('ledger.read') && !!me?.allBranches;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: t('expenses.list.title'), to: '/app/expenses' },
          { label: <bdi>{e.number}</bdi> },
        ]}
        title={e.description}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <ExpenseStatusBadge status={e.status} />
            <span className="num">
              <bdi>{e.number}</bdi>
            </span>
            <span>·</span>
            <span className="num">{fmtDate(e.expenseDate)}</span>
          </span>
        }
        actions={
          <>
            {canPay && (
              <Button
                icon={<CreditCard className="h-4 w-4" />}
                onClick={() =>
                  navigate(
                    `/app/purchasing/payments/new?supplierId=${e.supplierId ?? 'none'}&target=expense:${e.id}`,
                  )
                }
              >
                {t('expenses.detail.pay')}
              </Button>
            )}
            {canDecide && (
              <>
                <Button
                  variant="success"
                  icon={<Check className="h-4 w-4" />}
                  disabled={ownRequest}
                  onClick={() => setApproving(true)}
                >
                  {t('expenses.detail.approve')}
                </Button>
                <Button variant="outline" icon={<X className="h-4 w-4" />} onClick={() => setRejecting(true)}>
                  {t('expenses.detail.reject')}
                </Button>
              </>
            )}
            {canReverse && (
              <Button
                variant="danger"
                icon={<Undo2 className="h-4 w-4" />}
                disabled={paid}
                title={paid ? t('expenses.detail.reverseBlocked') : undefined}
                onClick={() => setReversing(true)}
              >
                {t('expenses.detail.reverse')}
              </Button>
            )}
          </>
        }
      />

      {e.status === 'pending_approval' && (
        <Alert tone="warning" className="mb-4" title={t('expenses.detail.pendingTitle')}>
          {t('expenses.detail.pendingHint')}
          {canDecide && ownRequest && <span className="mt-1 block">{t('expenses.detail.ownPending')}</span>}
        </Alert>
      )}
      {e.status === 'rejected' && (
        <Alert tone="danger" className="mb-4" title={t('expenses.detail.rejectedTitle')}>
          {e.rejectedReason}
        </Alert>
      )}
      {e.status === 'reversed' && (
        <Alert
          tone="warning"
          className="mb-4"
          title={t('expenses.detail.reversedTitle', { date: fmtDateTime(e.reversedAt) })}
        >
          <span className="block">{e.reversalReason}</span>
          <span className="mt-1 block">{t('expenses.detail.reversedHint')}</span>
        </Alert>
      )}
      {canReverse && paid && (
        <Alert tone="info" className="mb-4">
          {t('expenses.detail.reverseBlocked')}
        </Alert>
      )}

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-4 px-5 py-4 md:grid-cols-4">
          <Stat label={t('expenses.detail.amount')}>
            <Money value={e.amount} currency={e.currency} className="text-base font-semibold" />
            {foreign && (
              <p className="num text-xs font-normal text-muted">
                {t('expenses.detail.rate')}:{' '}
                <bdi dir="ltr">
                  1 {e.currency} = {d(e.exchangeRate).toString()} {base}
                </bdi>
              </p>
            )}
          </Stat>
          <Stat label={t('expenses.detail.amountBase')}>
            <Money value={e.amountBase} currency={base} className="text-base font-semibold" />
          </Stat>
          <Stat label={t('expenses.detail.paid')}>
            <Money
              value={e.paidBase}
              currency={base}
              className={paid ? 'text-base font-semibold text-success' : 'text-base font-semibold'}
            />
          </Stat>
          <Stat label={t('expenses.detail.outstanding')}>
            {e.outstandingBase === null ? (
              <span className="text-[13px] text-muted">{t('expenses.detail.notPayable')}</span>
            ) : (
              <Money
                value={e.outstandingBase}
                currency={base}
                className={outstanding ? 'text-base font-semibold text-warning' : 'text-base font-semibold'}
              />
            )}
          </Stat>
        </div>
      </Card>

      <Card className="mb-4">
        <CardHeader title={t('expenses.detail.details')} />
        <CardBody>
          <DescriptionList
            columns={3}
            items={[
              { label: t('expenses.detail.category'), value: categoryName(e, i18n.language) },
              { label: t('expenses.detail.branch'), value: e.branchName },
              {
                label: t('expenses.detail.supplier'),
                value: e.supplierId ? (
                  can('suppliers.read') ? (
                    <Link
                      to={`/app/purchasing/suppliers/${e.supplierId}`}
                      className="font-medium text-brand-strong hover:underline"
                    >
                      {e.supplierName}
                    </Link>
                  ) : (
                    e.supplierName
                  )
                ) : (
                  <span className="text-muted">{t('expenses.list.noSupplier')}</span>
                ),
              },
              {
                label: t('expenses.detail.expenseDate'),
                value: <span className="num">{fmtDate(e.expenseDate)}</span>,
              },
              { label: t('expenses.detail.createdBy'), value: e.createdByName },
              { label: t('common.createdAt'), value: fmtDateTime(e.createdAt) },
              ...(e.approvedByName
                ? [
                    { label: t('expenses.detail.approvedBy'), value: e.approvedByName },
                    { label: t('expenses.detail.approvedAt'), value: fmtDateTime(e.approvedAt) },
                  ]
                : []),
              { label: t('expenses.detail.notes'), value: e.notes, full: true },
            ]}
          />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader title={t('expenses.detail.payments')} />
          <DataTable
            rows={e.payments}
            rowKey={(p) => p.paymentId}
            dense
            empty={
              <EmptyState
                icon={<CreditCard className="h-5 w-5" />}
                title={t('expenses.detail.paymentsEmpty')}
              />
            }
            columns={[
              {
                key: 'number',
                header: t('expenses.detail.paymentNumber'),
                cell: (p) =>
                  paymentLinks ? (
                    <Link
                      to={`/app/purchasing/payments/${p.paymentId}`}
                      className="num font-medium text-brand-strong hover:underline"
                    >
                      <bdi>{p.number}</bdi>
                    </Link>
                  ) : (
                    <span className="num">
                      <bdi>{p.number}</bdi>
                    </span>
                  ),
              },
              {
                key: 'date',
                header: t('expenses.detail.paymentDate'),
                hideOnMobile: true,
                cell: (p) => <span className="num whitespace-nowrap">{fmtDate(p.paidAt)}</span>,
              },
              {
                key: 'method',
                header: t('expenses.detail.paymentMethod'),
                hideOnMobile: true,
                cell: (p) => t(`expenses.method.${p.method}`),
              },
              {
                key: 'amount',
                header: t('expenses.detail.paymentAmount'),
                align: 'end',
                cell: (p) => (
                  <Money
                    value={p.amountBase}
                    currency={base}
                    className={p.status === 'voided' ? 'text-subtle line-through' : undefined}
                  />
                ),
              },
              {
                key: 'status',
                header: t('common.status'),
                cell: (p) => (
                  <Badge tone={p.status === 'posted' ? 'success' : 'neutral'}>
                    {t(`expenses.paymentStatus.${p.status}`)}
                  </Badge>
                ),
              },
            ]}
          />
        </Card>

        <Card className="min-w-0">
          <CardHeader title={t('expenses.detail.ledger')} />
          {e.journalEntries.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">{t('expenses.detail.ledgerEmpty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {e.journalEntries.map((j) => (
                <li
                  key={j.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {t(`expenses.detail.event.${j.event.replace('.', '_')}`, { defaultValue: j.event })}
                    </p>
                    <p className="num text-xs text-muted">
                      {t('expenses.detail.entryNo', { no: j.entryNo })} · {fmtDate(j.entryDate)}
                    </p>
                  </div>
                  {ledgerLinks && (
                    <Link
                      to={`/app/accounting/entries/${j.id}`}
                      className="text-[13px] font-medium text-brand-strong hover:underline"
                    >
                      {t('expenses.detail.openEntry')}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {approving && <ApproveModal e={e} onClose={() => setApproving(false)} />}
      <ConfirmDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        requireReason
        tone="danger"
        loading={reject.isPending}
        title={t('expenses.detail.rejectTitle', { number: e.number })}
        message={t('expenses.detail.rejectHint')}
        confirmLabel={t('expenses.detail.reject')}
        onConfirm={(reason) => reject.mutate({ reason })}
      />
      <ConfirmDialog
        open={reversing}
        onClose={() => setReversing(false)}
        requireReason
        tone="danger"
        loading={reverse.isPending}
        title={t('expenses.detail.reverseTitle', { number: e.number })}
        message={t('expenses.detail.reverseHint')}
        confirmLabel={t('expenses.detail.reverse')}
        onConfirm={(reason) => reverse.mutate({ reason })}
      />
    </>
  );
}
