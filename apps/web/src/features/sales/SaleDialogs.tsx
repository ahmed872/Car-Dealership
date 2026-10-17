import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { d } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtNumber, fmtPct } from '@/lib/format';
import { DeliveryBlocker, SaleDetail, SaleDocumentType } from './api';
import {
  AmountInput,
  FailureAlert,
  isPositiveMoney,
  Money,
  ReasonModal,
  Row,
  serverFieldErrors,
  useFieldMessage,
  useIdempotencyKey,
  useSalesError,
  useSalesMutation,
  useTenantMoney,
} from './shared';
import { emptyTradeIn, TradeInFields, tradeInBody, validateTradeIn } from './TradeInFields';

interface DialogProps {
  sale: SaleDetail;
  onClose: () => void;
  onReload: () => void;
}

export function BlockerList({ blockers }: { blockers: DeliveryBlocker[] }) {
  const { t } = useTranslation();
  return (
    <ul className="list-disc space-y-1 ps-5">
      {blockers.map((b, i) => (
        <li key={i}>
          {t(`sales.blockers.${b.code}`, { defaultValue: b.code })}
          {b.amount && (
            <>
              {': '}
              <Money value={b.amount} className="font-medium" />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Price approval ───────────────────────────────────────────────────────────────────────

export function ApproveSaleModal({ sale, onClose, onReload }: DialogProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const approve = useSalesMutation<{ note: string | null; version: number }>({
    path: `/sales/${sale.id}/approve`,
    toastError: false,
    success: t('sales.approval.approved'),
    onSuccess: onClose,
  });
  const selfApproval = failure instanceof ApiError && failure.code === 'self_approval_forbidden';
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sales.approval.approveTitle', { number: sale.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="success"
            loading={approve.isPending}
            disabled={selfApproval}
            onClick={() => {
              setFailure(null);
              approve.mutate({ note: note.trim() || null, version: sale.version }, { onError: setFailure });
            }}
          >
            {t('common.approve')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {selfApproval ? (
          <Alert tone="danger" title={t('sales.approval.makerCheckerTitle')}>
            {t('sales.approval.makerCheckerBody')}
          </Alert>
        ) : (
          failure !== null && <FailureAlert error={failure} onReload={onReload} />
        )}
        <p className="text-sm text-muted">
          {sale.approvalPermission === 'sales.approve_below_floor' ? t('sales.approval.belowFloorHint') : t('sales.approval.discountHint')}
        </p>
        <dl className="divide-y divide-line rounded-xl border border-line px-4">
          <Row label={t('sales.fields.askingPrice')}>
            <Money value={sale.askingPrice} />
          </Row>
          <Row label={t('sales.fields.floorPrice')}>
            <Money value={sale.floorPrice} />
          </Row>
          <Row label={t('sales.fields.agreedPrice')} strong>
            <Money value={sale.agreedPrice} />
          </Row>
          <Row label={t('sales.fields.discount')} tone="warning">
            <Money value={sale.discountAmount} /> <span className="num text-xs">({fmtPct(sale.discountPct, 2)})</span>
          </Row>
        </dl>
        <Field label={t('sales.approval.note')}>
          {(id) => <Textarea id={id} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

export function RejectSaleModal({ sale, onClose, onReload }: DialogProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<unknown>(null);
  const reject = useSalesMutation<{ reason: string; version: number }>({
    path: `/sales/${sale.id}/reject`,
    toastError: false,
    success: t('sales.approval.rejected'),
    onSuccess: onClose,
  });
  return (
    <ReasonModal
      title={t('sales.approval.rejectTitle', { number: sale.number })}
      message={t('sales.approval.rejectHint')}
      confirmLabel={t('common.reject')}
      loading={reject.isPending}
      error={failure !== null ? <FailureInline error={failure} onReload={onReload} /> : undefined}
      onClose={onClose}
      onConfirm={(reason) => {
        setFailure(null);
        reject.mutate({ reason, version: sale.version }, { onError: setFailure });
      }}
    />
  );
}

/** Translated failure text for ReasonModal's error slot (version conflicts get a reload hint). */
function FailureInline({ error, onReload }: { error: unknown; onReload: () => void }) {
  const { t } = useTranslation();
  const describe = useSalesError();
  if (error instanceof ApiError && error.code === 'version_conflict') {
    return (
      <span>
        {t('sales.stale.body')}{' '}
        <button type="button" className="font-medium underline" onClick={onReload}>
          {t('sales.stale.reload')}
        </button>
      </span>
    );
  }
  return <span>{describe(error)}</span>;
}

// ── Confirmation ─────────────────────────────────────────────────────────────────────────

export function ConfirmSaleModal({ sale, onClose, onReload }: DialogProps) {
  const { t } = useTranslation();
  const [idemKey] = useIdempotencyKey();
  const [failure, setFailure] = useState<unknown>(null);
  const confirm = useSalesMutation<{ version: number }>({
    path: `/sales/${sale.id}/confirm`,
    idempotent: true,
    toastError: false,
    success: t('sales.confirm.done'),
    onSuccess: onClose,
  });
  const pendingTradeIns = sale.tradeIns.filter((x) => x.status === 'pending');
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sales.confirm.title', { number: sale.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={confirm.isPending}
            onClick={() => {
              setFailure(null);
              confirm.mutate({ version: sale.version, __idemKey: idemKey }, { onError: setFailure });
            }}
          >
            {t('sales.actions.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {failure !== null && <FailureAlert error={failure} onReload={onReload} />}
        <p className="text-muted">{t('sales.confirm.intro')}</p>
        <ul className="list-disc space-y-1 ps-5 text-ink">
          <li>{t('sales.confirm.vehicleSold')}</li>
          <li>{t('sales.confirm.termsFrozen')}</li>
          {sale.paymentType === 'installments' && <li>{t('sales.confirm.scheduleFrozen')}</li>}
          {pendingTradeIns.length > 0 && <li>{t('sales.confirm.tradeIns', { n: pendingTradeIns.length })}</li>}
          {sale.reservationId && <li>{t('sales.confirm.deposit')}</li>}
          <li>{t('sales.confirm.revenue')}</li>
        </ul>
        <dl className="divide-y divide-line rounded-xl border border-line px-4">
          <Row label={t('sales.fields.gross')} strong>
            <Money value={sale.grossAmount} />
          </Row>
          <Row label={t('sales.fields.dueBeforeDelivery')}>
            <Money value={sale.money.dueBeforeDelivery} />
          </Row>
        </dl>
      </div>
    </Modal>
  );
}

// ── External finance decision ────────────────────────────────────────────────────────────

export function ExternalFinanceModal({ sale, onClose, onReload }: DialogProps) {
  const { t } = useTranslation();
  const ef = sale.externalFinance;
  const [status, setStatus] = useState<'approved' | 'rejected'>('approved');
  const [reference, setReference] = useState(ef?.reference ?? '');
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const decide = useSalesMutation<{ status: string; reference: string | null; note: string | null }>({
    path: `/sales/${sale.id}/external-finance`,
    toastError: false,
    success: t('sales.ef.saved'),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sales.ef.title')}
      description={t('sales.ef.hint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={status === 'approved' ? 'success' : 'danger'}
            loading={decide.isPending}
            onClick={() => {
              setFailure(null);
              decide.mutate({ status, reference: reference.trim() || null, note: note.trim() || null }, { onError: setFailure });
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {failure !== null && <FailureAlert error={failure} onReload={onReload} />}
        {ef && (
          <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm">
            <span className="text-muted">{ef.provider}</span>
            <Money value={ef.amount} className="font-semibold" />
          </div>
        )}
        <Field label={t('sales.ef.decision')}>
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as 'approved' | 'rejected')}>
              <option value="approved">{t('sales.efStatus.approved')}</option>
              <option value="rejected">{t('sales.efStatus.rejected')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('sales.fields.efReference')}>{(id) => <Input id={id} maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
        <Field label={t('common.notes')}>{(id) => <Textarea id={id} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

// ── Delivery ─────────────────────────────────────────────────────────────────────────────

export function DeliverModal({ sale, onClose, onReload, onIssueInvoice }: DialogProps & { onIssueInvoice: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [idemKey] = useIdempotencyKey();
  const [reason, setReason] = useState('');
  const [odometer, setOdometer] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const deliver = useSalesMutation<{ version: number; overrideReason?: string; odometer?: number }>({
    path: `/sales/${sale.id}/deliver`,
    idempotent: true,
    toastError: false,
    success: t('sales.deliver.done'),
    onSuccess: onClose,
  });
  const failureBlockers =
    failure instanceof ApiError && failure.code === 'delivery_blocked' ? ((failure.details?.blockers as DeliveryBlocker[] | undefined) ?? []) : null;
  const blockers = failureBlockers ?? sale.deliveryBlockers;
  const needsInvoice = blockers.some((b) => b.code === 'invoice_required');
  const money = blockers.filter((b) => b.code !== 'invoice_required');
  const canOverride = can('sales.deliver_with_balance');
  const odoValid = odometer.trim() === '' || (/^\d+$/.test(odometer.trim()) && Number(odometer) <= 3_000_000);
  const reasonValid = money.length === 0 || reason.trim().length >= 5;
  const disabled = needsInvoice || (money.length > 0 && !canOverride) || !reasonValid || !odoValid;
  const v = sale.vehicleSnapshot;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sales.deliver.title', { number: sale.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="success"
            loading={deliver.isPending}
            disabled={disabled}
            onClick={() => {
              setFailure(null);
              deliver.mutate(
                {
                  version: sale.version,
                  ...(money.length ? { overrideReason: reason.trim() } : {}),
                  ...(odometer.trim() ? { odometer: Number(odometer) } : {}),
                  __idemKey: idemKey,
                },
                { onError: setFailure },
              );
            }}
          >
            {money.length ? t('sales.deliver.withBalance') : t('sales.actions.deliver')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {failure !== null && !failureBlockers && <FailureAlert error={failure} onReload={onReload} />}
        {needsInvoice && (
          <Alert tone="warning" title={t('sales.blockers.invoice_required')}>
            <p>{t('sales.deliver.invoiceFirst')}</p>
            {can('documents.issue') && (
              <Button size="sm" variant="secondary" className="mt-2" onClick={onIssueInvoice}>
                {t('sales.documents.issueInvoice')}
              </Button>
            )}
          </Alert>
        )}
        {!needsInvoice && money.length === 0 && <Alert tone="success">{t('sales.deliver.ready')}</Alert>}
        {money.length > 0 && (
          <Alert tone={canOverride ? 'warning' : 'danger'} title={t('sales.deliver.blockedTitle')}>
            <BlockerList blockers={money} />
            <p className="mt-2">{canOverride ? t('sales.deliver.overrideHint') : t('sales.deliver.noOverride')}</p>
          </Alert>
        )}
        {money.length > 0 && canOverride && !needsInvoice && (
          <Field label={t('sales.deliver.overrideReason')} required hint={t('sales.validation.minChars', { n: 5 })}>
            {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        )}
        {!needsInvoice && (
          <Field
            label={t('sales.deliver.odometer')}
            hint={t('sales.deliver.odometerHint', { value: fmtNumber(v.odometerValue), unit: t(`sales.tradeIn.${v.odometerUnit}`) })}
            error={odoValid ? null : t('sales.validation.invalid')}
          >
            {(id, desc) => (
              <Input id={id} aria-describedby={desc} dir="ltr" inputMode="numeric" className="num" value={odometer} invalid={!odoValid} onChange={(e) => setOdometer(e.target.value)} />
            )}
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ── Documents ────────────────────────────────────────────────────────────────────────────

export function IssueDocumentModal({ sale, onClose, onReload, initialType }: DialogProps & { initialType?: SaleDocumentType }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const live = (type: string) => sale.documents.some((x) => x.type === type && x.status === 'issued');
  const options = (['contract', 'invoice', 'delivery_note'] as const).filter(
    (type) => !live(type) && (type === 'delivery_note' ? sale.status === 'delivered' : sale.status === 'confirmed' || sale.status === 'delivered'),
  );
  const [type, setType] = useState<string>(initialType && options.includes(initialType as never) ? initialType : (options[0] ?? ''));
  const [locale, setLocale] = useState<'ar' | 'en'>(me?.tenant?.settings.documents.defaultLocale === 'en' ? 'en' : 'ar');
  const [failure, setFailure] = useState<unknown>(null);
  const issue = useSalesMutation<{ type: string; locale: string }, { number: string }>({
    path: `/sales/${sale.id}/documents`,
    toastError: false,
    success: (r) => t('sales.documents.issued', { number: r.number }),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sales.documents.issueTitle')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={issue.isPending}
            disabled={!type}
            onClick={() => {
              setFailure(null);
              issue.mutate({ type, locale }, { onError: setFailure });
            }}
          >
            {t('sales.documents.issue')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {failure !== null && <FailureAlert error={failure} onReload={onReload} />}
        {options.length === 0 ? (
          <Alert tone="info">{t('sales.documents.nothingToIssue')}</Alert>
        ) : (
          <Field label={t('sales.documents.type')}>
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {t(`sales.docType.${o}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('sales.documents.language')}>
          {(id) => (
            <Select id={id} value={locale} onChange={(e) => setLocale(e.target.value as 'ar' | 'en')}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </Select>
          )}
        </Field>
        <p className="text-xs text-muted">{t('sales.documents.snapshotNote')}</p>
      </div>
    </Modal>
  );
}

export function VoidDocumentModal({ sale, docId, docLabel, onClose, onReload }: DialogProps & { docId: string; docLabel: string }) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<unknown>(null);
  const voidDoc = useSalesMutation<{ reason: string }>({
    path: `/sale-documents/${docId}/void`,
    toastError: false,
    invalidate: [['sale', sale.id]],
    success: t('sales.documents.voided'),
    onSuccess: onClose,
  });
  return (
    <ReasonModal
      title={t('sales.documents.voidTitle', { label: docLabel })}
      message={t('sales.documents.voidHint')}
      confirmLabel={t('sales.documents.void')}
      loading={voidDoc.isPending}
      error={failure !== null ? <FailureInline error={failure} onReload={onReload} /> : undefined}
      onClose={onClose}
      onConfirm={(reason) => {
        setFailure(null);
        voidDoc.mutate({ reason }, { onError: setFailure });
      }}
    />
  );
}

// ── Cancel / return ──────────────────────────────────────────────────────────────────────

export function CancelSaleModal({ sale, onClose, onReload }: DialogProps) {
  const { t } = useTranslation();
  const [idemKey] = useIdempotencyKey();
  const [failure, setFailure] = useState<unknown>(null);
  const cancel = useSalesMutation<{ reason: string; version: number }>({
    path: `/sales/${sale.id}/cancel`,
    idempotent: true,
    toastError: false,
    success: t('sales.cancel.done'),
    onSuccess: onClose,
  });
  const confirmed = sale.status === 'confirmed';
  return (
    <ReasonModal
      title={t('sales.cancel.title', { number: sale.number })}
      message={
        <ul className="list-disc space-y-1 ps-5">
          {(confirmed ? ['vehicleBack', 'unwind', 'credit', 'commission', 'documents'] : ['vehicleBackDraft', 'tradeIns']).map((k) => (
            <li key={k}>{t(`sales.cancel.${k}`)}</li>
          ))}
        </ul>
      }
      confirmLabel={t('sales.actions.cancel')}
      loading={cancel.isPending}
      error={failure !== null ? <FailureInline error={failure} onReload={onReload} /> : undefined}
      onClose={onClose}
      onConfirm={(reason) => {
        setFailure(null);
        cancel.mutate({ reason, version: sale.version, __idemKey: idemKey }, { onError: setFailure });
      }}
    />
  );
}

export function ReturnSaleModal({ sale, onClose, onReload }: DialogProps) {
  const { t } = useTranslation();
  const [idemKey] = useIdempotencyKey();
  const [failure, setFailure] = useState<unknown>(null);
  const ret = useSalesMutation<{ reason: string; version: number }>({
    path: `/sales/${sale.id}/return`,
    idempotent: true,
    toastError: false,
    success: t('sales.return.done'),
    onSuccess: onClose,
  });
  return (
    <ReasonModal
      title={t('sales.return.title', { number: sale.number })}
      message={
        <ul className="list-disc space-y-1 ps-5">
          {['vehicle', 'unwind', 'credit', 'creditNote', 'commission'].map((k) => (
            <li key={k}>{t(`sales.return.${k}`)}</li>
          ))}
        </ul>
      }
      confirmLabel={t('sales.actions.return')}
      loading={ret.isPending}
      error={failure !== null ? <FailureInline error={failure} onReload={onReload} /> : undefined}
      onClose={onClose}
      onConfirm={(reason) => {
        setFailure(null);
        ret.mutate({ reason, version: sale.version, __idemKey: idemKey }, { onError: setFailure });
      }}
    />
  );
}

// ── Refund request ───────────────────────────────────────────────────────────────────────

export function RefundRequestModal({ sale, onClose, onReload }: DialogProps) {
  const { t } = useTranslation();
  const { base } = useTenantMoney();
  const fm = useFieldMessage();
  const [idemKey] = useIdempotencyKey();
  const [amount, setAmount] = useState(sale.money.refundable);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const request = useSalesMutation<{ sourceType: 'sale'; sourceId: string; amountBase: string; reason: string }, { number: string }>({
    path: '/refunds',
    idempotent: true,
    toastError: false,
    success: (r) => t('sales.refund.requested', { number: r.number }),
    onSuccess: onClose,
  });
  const amountError = !isPositiveMoney(amount) ? 'must_be_positive' : d(amount.trim()).gt(sale.money.refundable) ? 'exceeds_refundable' : null;
  const valid = !amountError && reason.trim().length >= 3;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sales.refund.title', { number: sale.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={request.isPending}
            disabled={!valid}
            onClick={() => {
              setFailure(null);
              request.mutate({ sourceType: 'sale', sourceId: sale.id, amountBase: amount.trim(), reason: reason.trim(), __idemKey: idemKey }, { onError: setFailure });
            }}
          >
            {t('sales.refund.submit')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {failure !== null && <FailureAlert error={failure} onReload={onReload} />}
        <p className="text-sm text-muted">{t('sales.refund.hint')}</p>
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm">
          <span className="text-muted">{t('sales.money.refundable')}</span>
          <Money value={sale.money.refundable} className="font-semibold" />
        </div>
        <Field label={t('sales.refund.amount')} required error={fm(amountError)}>
          {(id) => <AmountInput id={id} currency={base} value={amount} invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('common.reason')} required hint={t('sales.validation.minChars', { n: 3 })}>
          {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

// ── Trade-ins on an existing sale ────────────────────────────────────────────────────────

export function AddTradeInModal({ sale, onClose, onReload }: DialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(emptyTradeIn);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const add = useSalesMutation<Record<string, unknown>>({
    path: `/sales/${sale.id}/trade-ins`,
    toastError: false,
    invalidate: [['sale', sale.id], ['sales']],
    success: t('sales.tradeIn.added'),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('sales.tradeIn.addTitle')}
      description={t('sales.tradeIn.addHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={add.isPending}
            onClick={() => {
              const e = validateTradeIn(value);
              setErrors(e);
              if (Object.keys(e).length) return;
              setFailure(null);
              add.mutate(
                { ...tradeInBody(value), version: sale.version },
                {
                  onError: (err) => {
                    setFailure(err);
                    setErrors(serverFieldErrors(err));
                  },
                },
              );
            }}
          >
            {t('sales.tradeIn.add')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure !== null && <FailureAlert error={failure} onReload={onReload} />}
        <TradeInFields value={value} onChange={setValue} errors={errors} />
      </div>
    </Modal>
  );
}

export function RemoveTradeInModal({ sale, tradeInId, onClose, onReload }: DialogProps & { tradeInId: string }) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<unknown>(null);
  const remove = useSalesMutation<{ version: number }>({
    path: `/sales/${sale.id}/trade-ins/${tradeInId}/remove`,
    toastError: false,
    invalidate: [['sale', sale.id], ['sales']],
    success: t('sales.tradeIn.removed'),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('sales.tradeIn.removeTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => {
              setFailure(null);
              remove.mutate({ version: sale.version }, { onError: setFailure });
            }}
          >
            {t('common.delete')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {failure !== null && <FailureAlert error={failure} onReload={onReload} />}
        <p className="text-sm text-muted">{t('sales.tradeIn.removeHint')}</p>
      </div>
    </Modal>
  );
}

// ── Void a payment ───────────────────────────────────────────────────────────────────────

export function VoidPaymentModal({ receiptId, number, onClose, onReload }: { receiptId: string; number: string; onClose: () => void; onReload: () => void }) {
  const { t } = useTranslation();
  const [idemKey] = useIdempotencyKey();
  const [failure, setFailure] = useState<unknown>(null);
  const voidIt = useSalesMutation<{ reason: string }>({
    path: `/receipts/${receiptId}/void`,
    idempotent: true,
    toastError: false,
    success: t('sales.payments.voided', { number }),
    onSuccess: onClose,
  });
  return (
    <ReasonModal
      title={t('sales.payments.voidTitle', { number })}
      message={t('sales.payments.voidHint')}
      confirmLabel={t('sales.payments.void')}
      loading={voidIt.isPending}
      error={failure !== null ? <FailureInline error={failure} onReload={onReload} /> : undefined}
      onClose={onClose}
      onConfirm={(reason) => {
        setFailure(null);
        voidIt.mutate({ reason, __idemKey: idemKey }, { onError: setFailure });
      }}
    />
  );
}
