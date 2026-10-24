import { Ban, Check, HandCoins, Undo2, Wallet, X } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { ReceiptStatus, Refund, RefundSourceType, RefundStatus, targetLink } from './api';
import {
  CashAccountOption,
  CashAccountSelect,
  MethodSelect,
  Money,
  MONEY_KEYS,
  PaymentMethod,
  ReasonModal,
  useCashAccountOptions,
  useDomainError,
  useDomainMutation,
  useFieldMessage,
  useIdempotencyKey,
  useTenantMoney,
} from './kit';

// ── Badges ───────────────────────────────────────────────────────────────────────────────

export function ReceiptStatusBadge({ status }: { status: ReceiptStatus }) {
  const { t } = useTranslation();
  return <Badge tone={status === 'posted' ? 'success' : 'danger'}>{t(`receivables.receiptStatus.${status}`)}</Badge>;
}

const REFUND_TONE: Record<RefundStatus, Tone> = { requested: 'warning', approved: 'info', paid: 'success', rejected: 'danger', cancelled: 'neutral' };

export function RefundStatusBadge({ status }: { status: RefundStatus }) {
  const { t } = useTranslation();
  return <Badge tone={REFUND_TONE[status] ?? 'neutral'}>{t(`receivables.refundStatus.${status}`)}</Badge>;
}

export function SourceLink({ type, id, customerId, label }: { type: RefundSourceType | 'installment'; id: string; customerId: string; label?: ReactNode }) {
  const { t } = useTranslation();
  const to = targetLink(type, id, customerId);
  const text = label ?? t(`receivables.target.${type}`);
  if (!to) return <span className="whitespace-nowrap">{text}</span>;
  return (
    <Link to={to} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap text-brand-strong hover:underline">
      {text}
    </Link>
  );
}

// ── Receipt void ─────────────────────────────────────────────────────────────────────────

/** Voids a posted receipt (payments.void): the cash leaves the account again (mirrored entries). */
export function VoidReceiptDialog({ receipt, onClose, onDone }: { receipt: { id: string; number: string }; onClose: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const describe = useDomainError('receivables');
  const [idemKey] = useIdempotencyKey();
  const [failure, setFailure] = useState<unknown>(null);
  const voidIt = useDomainMutation<{ reason: string }>({
    ns: 'receivables',
    path: `/receipts/${receipt.id}/void`,
    idempotent: true,
    toastError: false,
    invalidate: MONEY_KEYS,
    success: t('receivables.receipts.voided', { number: receipt.number }),
    onSuccess: () => {
      onDone?.();
      onClose();
    },
  });
  return (
    <ReasonModal
      title={t('receivables.receipts.voidTitle', { number: receipt.number })}
      message={t('receivables.receipts.voidMessage')}
      confirmLabel={t('receivables.receipts.void')}
      loading={voidIt.isPending}
      error={failure ? describe(failure) : null}
      onClose={onClose}
      onConfirm={(reason) => {
        setFailure(null);
        voidIt.mutate({ reason, __idemKey: idemKey }, { onError: setFailure });
      }}
    />
  );
}

// ── Refund actions ───────────────────────────────────────────────────────────────────────

type RefundDialog = 'approve' | 'reject' | 'cancel' | 'pay' | null;

/** Approve / reject / cancel / pay buttons for one refund, gated by status and permission. */
export function RefundActions({ refund, compact }: { refund: Refund; compact?: boolean }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const [open, setOpen] = useState<RefundDialog>(null);
  const isRequester = !!me && refund.requestedBy === me.user.id;
  const canApprove = can('refunds.approve') && refund.status === 'requested';
  const canCancel = (refund.status === 'requested' || refund.status === 'approved') && (isRequester || can('refunds.approve'));
  const canPay = refund.status === 'approved' && can('payments.receive');
  if (!canApprove && !canCancel && !canPay) return null;
  const size = compact ? 'sm' : 'md';
  return (
    <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {canApprove && (
        <Button size={size} variant="success" icon={<Check className="h-4 w-4" />} onClick={() => setOpen('approve')}>
          {t('common.approve')}
        </Button>
      )}
      {canApprove && (
        <Button size={size} variant="outline" icon={<X className="h-4 w-4" />} onClick={() => setOpen('reject')}>
          {t('common.reject')}
        </Button>
      )}
      {canPay && (
        <Button size={size} icon={<Wallet className="h-4 w-4" />} onClick={() => setOpen('pay')}>
          {t('receivables.refunds.pay')}
        </Button>
      )}
      {canCancel && (
        <Button size={size} variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={() => setOpen('cancel')}>
          {t('receivables.refunds.cancel')}
        </Button>
      )}
      {open === 'approve' && <DecisionDialog refund={refund} kind="approve" onClose={() => setOpen(null)} />}
      {open === 'reject' && <DecisionDialog refund={refund} kind="reject" onClose={() => setOpen(null)} />}
      {open === 'cancel' && <DecisionDialog refund={refund} kind="cancel" onClose={() => setOpen(null)} />}
      {open === 'pay' && <PayRefundModal refund={refund} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DecisionDialog({ refund, kind, onClose }: { refund: Refund; kind: 'approve' | 'reject' | 'cancel'; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const describe = useDomainError('receivables');
  const [failure, setFailure] = useState<unknown>(null);
  const m = useDomainMutation<{ note?: string | null; reason?: string }>({
    ns: 'receivables',
    path: `/refunds/${refund.id}/${kind}`,
    toastError: false,
    invalidate: MONEY_KEYS,
    success: t(`receivables.refunds.done.${kind}`, { number: refund.number }),
    onSuccess: onClose,
  });
  const selfRequested = kind === 'approve' && !!me && refund.requestedBy === me.user.id;
  return (
    <ReasonModal
      title={t(`receivables.refunds.${kind}Title`, { number: refund.number })}
      message={
        <div className="space-y-2">
          <p>{t(`receivables.refunds.${kind}Message`)}</p>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
            <span>{refund.customerName ?? t('receivables.fields.customer')}</span>
            <Money value={refund.amountBase} className="font-semibold text-ink" />
          </div>
        </div>
      }
      label={kind === 'approve' ? t('receivables.refunds.note') : undefined}
      required={kind !== 'approve'}
      tone={kind === 'approve' ? 'primary' : 'danger'}
      confirmLabel={t(`receivables.refunds.${kind}Confirm`)}
      loading={m.isPending}
      error={failure ? describe(failure) : null}
      onClose={onClose}
      onConfirm={(text) => {
        setFailure(null);
        m.mutate(kind === 'approve' ? { note: text || null } : { reason: text }, { onError: setFailure });
      }}
    >
      {selfRequested && <Alert tone="warning">{t('receivables.refunds.selfRequestedHint')}</Alert>}
    </ReasonModal>
  );
}

/** Pays an approved refund from a base-currency account (Dr customer advances / Cr cash). */
function PayRefundModal({ refund, onClose }: { refund: Refund; onClose: () => void }) {
  const { t } = useTranslation();
  const { base, today } = useTenantMoney();
  const describe = useDomainError('receivables');
  const fm = useFieldMessage('receivables');
  const accounts = useCashAccountOptions();
  const [idemKey] = useIdempotencyKey();
  const [account, setAccount] = useState<CashAccountOption | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(today);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const baseAccounts = (accounts.data ?? []).filter((a) => a.currency === base);
  const pay = useDomainMutation<Record<string, unknown>>({
    ns: 'receivables',
    path: `/refunds/${refund.id}/pay`,
    idempotent: true,
    toastError: false,
    invalidate: MONEY_KEYS,
    success: t('receivables.refunds.done.pay', { number: refund.number }),
    onSuccess: onClose,
  });
  const submit = () => {
    setTouched(true);
    if (!account) return;
    setFailure(null);
    pay.mutate({ cashAccountId: account.id, method, reference: reference.trim() || null, paidAt, __idemKey: idemKey }, { onError: setFailure });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('receivables.refunds.payTitle', { number: refund.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon={<HandCoins className="h-4 w-4" />} loading={pay.isPending} onClick={submit}>
            {t('receivables.refunds.payConfirm')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {failure !== null && (
          <Alert tone="danger" className="sm:col-span-2">
            {describe(failure)}
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm sm:col-span-2">
          <span className="text-muted">{refund.customerName ?? t('receivables.refunds.amount')}</span>
          <Money value={refund.amountBase} currency={base} className="font-semibold" />
        </div>
        <Field label={t('receivables.kit.account')} required hint={t('receivables.refunds.baseOnlyHint', { currency: base })} error={touched && !account ? fm('required') : null} className="sm:col-span-2">
          {(id, desc) => <CashAccountSelect id={id} describedBy={desc} value={account?.id ?? ''} accounts={accounts.data} baseOnly invalid={touched && !account} onChange={setAccount} />}
        </Field>
        {accounts.data && baseAccounts.length === 0 && (
          <Alert tone="warning" className="sm:col-span-2">
            {t('receivables.kit.noAccounts')}
          </Alert>
        )}
        <Field label={t('receivables.kit.method')}>{(id) => <MethodSelect id={id} value={method} onChange={setMethod} />}</Field>
        <Field label={t('common.reference')}>{(id) => <Input id={id} value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />}</Field>
        <Field label={t('receivables.refunds.paidAt')}>{(id) => <Input id={id} type="date" value={paidAt} max={today} onChange={(e) => setPaidAt(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

// ── Refunds table ────────────────────────────────────────────────────────────────────────

/** Refunds with their actions (used by the refunds page and the reservation detail). */
export function RefundsTable({
  rows,
  loading,
  error,
  onRetry,
  showSource = true,
  onRowClick,
}: {
  rows: Refund[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  showSource?: boolean;
  onRowClick?: (r: Refund) => void;
}) {
  const { t } = useTranslation();
  return (
    <DataTable
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(r) => r.id}
      onRowClick={onRowClick}
      empty={<EmptyState icon={<Undo2 className="h-5 w-5" />} title={t('receivables.refunds.empty')} />}
      columns={[
        { key: 'number', header: t('receivables.fields.number'), cell: (r) => <span className="num whitespace-nowrap font-medium text-ink">{r.number}</span> },
        { key: 'date', header: t('receivables.refunds.requestedAt'), hideOnMobile: true, cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.requestedAt)}</span> },
        ...(showSource
          ? [
              { key: 'customer', header: t('receivables.fields.customer'), cell: (r: Refund) => <span className="block max-w-[180px] truncate">{r.customerName ?? '—'}</span> },
              {
                key: 'source',
                header: t('receivables.refunds.source'),
                cell: (r: Refund) => <SourceLink type={r.sourceType} id={r.sourceId} customerId={r.customerId} />,
              },
            ]
          : []),
        { key: 'reason', header: t('common.reason'), hideOnMobile: true, cell: (r) => <span className="line-clamp-2 max-w-[260px] text-[13px] text-muted">{r.reason}</span> },
        { key: 'amount', header: t('receivables.refunds.amount'), align: 'end', cell: (r) => <Money value={r.amountBase} className="font-medium" /> },
        {
          key: 'status',
          header: t('common.status'),
          cell: (r) => (
            <div className="space-y-1">
              <RefundStatusBadge status={r.status} />
              {r.paidAt && <p className="num whitespace-nowrap text-xs text-muted">{fmtDate(r.paidAt)}</p>}
            </div>
          ),
        },
        { key: 'actions', header: t('common.actions'), cell: (r) => <RefundActions refund={r} compact /> },
      ]}
    />
  );
}

/** Small summary of refund amounts by state (requested / approved / paid). */
export function refundTotals(rows: Refund[] | undefined) {
  const acc = { pending: d(0), paid: d(0) };
  for (const r of rows ?? []) {
    if (r.status === 'requested' || r.status === 'approved') acc.pending = acc.pending.plus(r.amountBase);
    if (r.status === 'paid') acc.paid = acc.paid.plus(r.amountBase);
  }
  return { pending: acc.pending.toFixed(2), paid: acc.paid.toFixed(2) };
}
