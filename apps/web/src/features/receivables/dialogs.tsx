import { HandCoins, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { d, min } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Field, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import type { ReservationDetail, ReservationListItem } from '@/features/reservations/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { Refund, RefundSourceType } from './api';
import {
  AmountInput,
  CustomerOption,
  CustomerPicker,
  emptyMoneyIn,
  isPositiveMoney,
  Money,
  MoneyInFields,
  moneyInPayload,
  MONEY_KEYS,
  MoneyInValue,
  Paged,
  Row,
  useDomainError,
  useDomainMutation,
  useFieldMessage,
  useIdempotencyKey,
  useMoneyIn,
  useTenantMoney,
} from './kit';

const outstandingOf = (r: Pick<ReservationListItem, 'depositAmount' | 'receivedBase'>) => {
  const v = d(r.depositAmount).minus(r.receivedBase);
  return (v.isNegative() ? d(0) : v).toFixed(2);
};

/**
 * Records money received from a customer (POST /receipts): held as customer credit (advance), or
 * applied to one of the customer's active reservations up to its outstanding deposit, with any
 * remainder held as credit. Deposits and advances are liabilities, never revenue.
 */
export function RecordReceiptModal({
  customer: fixedCustomer,
  reservationId: fixedReservation,
  onClose,
  onDone,
}: {
  customer?: { id: string; fullName: string };
  reservationId?: string;
  onClose: () => void;
  onDone?: (r: { id: string; number: string }) => void;
}) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { base, today } = useTenantMoney();
  const describe = useDomainError('receivables');
  const fm = useFieldMessage('receivables');
  const [idemKey] = useIdempotencyKey();
  const [customer, setCustomer] = useState<{ id: string; fullName: string } | null>(fixedCustomer ?? null);
  const [money, setMoney] = useState<MoneyInValue>(() => emptyMoneyIn(today));
  const [mode, setMode] = useState<'credit' | 'reservation'>(fixedReservation ? 'reservation' : 'credit');
  const [reservationId, setReservationId] = useState(fixedReservation ?? '');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const mi = useMoneyIn(money);

  const canReservations = can('reservations.read');
  const reservations = useApi<Paged<ReservationListItem>>(
    ['reservations', 'for-receipt', customer?.id],
    customer && canReservations ? '/reservations' : null,
    { customerId: customer?.id, status: 'active', pageSize: 50 },
  );
  const reservation = reservations.data?.items.find((r) => r.id === reservationId) ?? null;
  const outstanding = reservation ? outstandingOf(reservation) : null;
  const applied = mode === 'reservation' && reservation && mi.amountBase && outstanding ? min(mi.amountBase, outstanding).toFixed(2) : null;
  const remainder = applied && mi.amountBase ? d(mi.amountBase).minus(applied).toFixed(2) : null;

  useEffect(() => {
    // Preselect the only active reservation when allocating to a reservation.
    if (mode === 'reservation' && !reservationId && reservations.data?.items.length === 1) setReservationId(reservations.data.items[0]!.id);
  }, [mode, reservationId, reservations.data]);

  const errors = {
    customer: !customer ? 'required' : null,
    reservation: mode === 'reservation' ? (!reservation ? 'required' : outstanding && d(outstanding).lte(0) ? 'nothing_due' : null) : null,
  };
  const valid = mi.valid && !errors.customer && !errors.reservation;

  const receive = useDomainMutation<Record<string, unknown>, { id: string; number: string }>({
    ns: 'receivables',
    path: '/receipts',
    idempotent: true,
    toastError: false,
    invalidate: MONEY_KEYS,
    success: (r) => t('receivables.receipts.recorded', { number: r.number }),
    onSuccess: (r) => {
      onDone?.(r);
      onClose();
    },
  });

  const submit = () => {
    setTouched(true);
    if (!valid || !customer || !mi.amountBase) return;
    setFailure(null);
    const allocations =
      mode === 'reservation' && reservation && applied
        ? [
            { targetType: 'reservation', targetId: reservation.id, amountBase: applied },
            ...(remainder && d(remainder).gt(0) ? [{ targetType: 'customer_credit', targetId: customer.id, amountBase: remainder }] : []),
          ]
        : undefined;
    receive.mutate({ customerId: customer.id, ...moneyInPayload(money, mi.foreign), notes: notes.trim() || null, ...(allocations ? { allocations } : {}), __idemKey: idemKey }, { onError: setFailure });
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('receivables.receipts.newTitle')}
      description={t('receivables.receipts.newHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon={<HandCoins className="h-4 w-4" />} onClick={submit} loading={receive.isPending} disabled={touched && !valid}>
            {t('receivables.receipts.submit')}
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
        <Field label={t('receivables.fields.customer')} required error={touched ? fm(errors.customer) : null} className="sm:col-span-2">
          {(id, desc) => (
            <CustomerPicker
              id={id}
              describedBy={desc}
              invalid={touched && !!errors.customer}
              value={customer?.id ?? ''}
              selectedLabel={customer?.fullName ?? ''}
              disabled={!!fixedCustomer}
              onSelect={(c: CustomerOption) => {
                setCustomer({ id: c.id, fullName: c.fullName });
                if (!fixedReservation) setReservationId('');
              }}
            />
          )}
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="label">{t('receivables.receipts.allocation')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['credit', 'reservation'] as const).map((m) => (
              <label
                key={m}
                className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${mode === m ? 'border-brand bg-brand-soft/40' : 'border-line'} ${m === 'reservation' && !canReservations ? 'cursor-not-allowed opacity-55' : ''}`}
              >
                <input
                  type="radio"
                  name="allocation"
                  className="mt-0.5 accent-[var(--brand-strong)]"
                  checked={mode === m}
                  disabled={(m === 'reservation' && !canReservations) || !!fixedReservation}
                  onChange={() => setMode(m)}
                />
                <span>
                  <span className="block font-medium text-ink">{t(`receivables.receipts.mode.${m}`)}</span>
                  <span className="block text-xs text-muted">{t(`receivables.receipts.modeHint.${m}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {mode === 'reservation' && (
          <Field label={t('receivables.receipts.reservation')} required error={touched ? fm(errors.reservation) : null} className="sm:col-span-2">
            {(id, desc) => (
              <Select id={id} aria-describedby={desc} value={reservationId} invalid={touched && !!errors.reservation} disabled={!customer || !!fixedReservation} onChange={(e) => setReservationId(e.target.value)}>
                <option value="">{customer ? t('receivables.receipts.chooseReservation') : t('receivables.receipts.chooseCustomerFirst')}</option>
                {(reservations.data?.items ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number} · {i18n.language === 'en' ? `${r.makeEn} ${r.modelEn}` : `${r.makeAr} ${r.modelAr}`} {r.modelYear} · {t('receivables.receipts.outstandingShort')} {fmtMoney(outstandingOf(r), base)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {mode === 'reservation' && customer && reservations.data && reservations.data.items.length === 0 && (
          <Alert tone="info" className="sm:col-span-2">
            {t('receivables.receipts.noActiveReservations')}
          </Alert>
        )}
        <MoneyInFields value={money} onChange={setMoney} touched={touched} className="sm:col-span-2" />
        {mode === 'reservation' && reservation && (
          <dl className="rounded-xl border border-line bg-surface-2/50 px-4 py-2 sm:col-span-2">
            <Row label={t('receivables.receipts.depositRequired')}>
              <Money value={reservation.depositAmount} currency={base} />
            </Row>
            <Row label={t('receivables.receipts.depositReceived')}>
              <Money value={reservation.receivedBase} currency={base} />
            </Row>
            <Row label={t('receivables.receipts.outstanding')} strong>
              <Money value={outstanding} currency={base} />
            </Row>
            {applied && (
              <Row label={t('receivables.receipts.appliedToReservation')} tone="success">
                <Money value={applied} currency={base} />
              </Row>
            )}
            {remainder && d(remainder).gt(0) && (
              <Row label={t('receivables.receipts.heldAsCredit')} tone="warning">
                <Money value={remainder} currency={base} />
              </Row>
            )}
            <p className="pb-1 text-xs text-muted">{t('receivables.receipts.expires', { date: fmtDate(reservation.expiresAt) })}</p>
          </dl>
        )}
        <Field label={t('common.notes')} className="sm:col-span-2">
          {(id) => <Textarea id={id} rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Opens a refund request (POST /refunds): from a customer's credit (advance), or from the deposit
 * still held on an expired or cancelled reservation. An approver must approve it before it is paid.
 */
export function RequestRefundModal({
  source: fixed,
  onClose,
  onDone,
}: {
  /** A fixed source (e.g. from the reservation page). */
  source?: { type: RefundSourceType; id: string; customer: { id: string; fullName: string }; label: string; refundableBase?: string };
  onClose: () => void;
  onDone?: (r: Refund) => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { base } = useTenantMoney();
  const describe = useDomainError('receivables');
  const fm = useFieldMessage('receivables');
  const [idemKey] = useIdempotencyKey();
  const [type, setType] = useState<RefundSourceType>(fixed?.type ?? 'customer_credit');
  const [customer, setCustomer] = useState<{ id: string; fullName: string } | null>(fixed?.customer ?? null);
  const [reservationId, setReservationId] = useState(fixed?.type === 'reservation' ? fixed.id : '');
  const [amount, setAmount] = useState(fixed?.refundableBase && d(fixed.refundableBase).gt(0) ? fixed.refundableBase : '');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const canReservations = can('reservations.read');
  const list = useApi<Paged<ReservationListItem>>(
    ['reservations', 'for-refund', customer?.id],
    !fixed && type === 'reservation' && customer && canReservations ? '/reservations' : null,
    { customerId: customer?.id, pageSize: 50 },
  );
  const closed = useMemo(() => (list.data?.items ?? []).filter((r) => r.status === 'expired' || r.status === 'cancelled'), [list.data]);
  const detail = useApi<ReservationDetail>(['reservation', reservationId], !fixed && type === 'reservation' && reservationId ? `/reservations/${reservationId}` : null);
  const refundable = fixed?.refundableBase ?? (type === 'reservation' ? detail.data?.availableDepositBase : undefined);

  useEffect(() => {
    if (!fixed && detail.data && !amount && d(detail.data.availableDepositBase).gt(0)) setAmount(detail.data.availableDepositBase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  const over = refundable !== undefined && isPositiveMoney(amount) && d(amount.trim()).gt(refundable);
  const errors = {
    customer: !customer ? 'required' : null,
    reservation: type === 'reservation' && !reservationId ? 'required' : null,
    amount: !isPositiveMoney(amount) ? (amount.trim() ? 'must_be_positive' : 'required') : over ? 'exceeds_refundable' : null,
    reason: reason.trim().length < 3 ? 'min_reason' : null,
  };
  const valid = !errors.customer && !errors.reservation && !errors.amount && !errors.reason;

  const request = useDomainMutation<Record<string, unknown>, Refund>({
    ns: 'receivables',
    path: '/refunds',
    idempotent: true,
    toastError: false,
    invalidate: MONEY_KEYS,
    success: (r) => t('receivables.refunds.requested', { number: r.number }),
    onSuccess: (r) => {
      onDone?.(r);
      onClose();
    },
  });

  const submit = () => {
    setTouched(true);
    if (!valid || !customer) return;
    setFailure(null);
    request.mutate(
      { sourceType: type, sourceId: type === 'customer_credit' ? customer.id : reservationId, amountBase: d(amount.trim()).toFixed(2), reason: reason.trim(), __idemKey: idemKey },
      { onError: setFailure },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('receivables.refunds.newTitle')}
      description={t('receivables.refunds.newHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon={<Undo2 className="h-4 w-4" />} onClick={submit} loading={request.isPending} disabled={touched && !valid}>
            {t('receivables.refunds.submit')}
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
        {fixed ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm sm:col-span-2">
            <span className="min-w-0">
              <span className="block text-muted">{t(`receivables.target.${fixed.type}`)}</span>
              <span className="num block font-medium text-ink">{fixed.label}</span>
            </span>
            <span className="text-end">
              <span className="block text-xs text-muted">{t('receivables.refunds.refundable')}</span>
              <Money value={fixed.refundableBase} currency={base} className="font-semibold" />
            </span>
          </div>
        ) : (
          <>
            <Field label={t('receivables.refunds.sourceType')}>
              {(id) => (
                <Select
                  id={id}
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value as RefundSourceType);
                    setReservationId('');
                  }}
                >
                  <option value="customer_credit">{t('receivables.target.customer_credit')}</option>
                  {canReservations && <option value="reservation">{t('receivables.target.reservation')}</option>}
                </Select>
              )}
            </Field>
            <Field label={t('receivables.fields.customer')} required error={touched ? fm(errors.customer) : null}>
              {(id, desc) => (
                <CustomerPicker
                  id={id}
                  describedBy={desc}
                  invalid={touched && !!errors.customer}
                  value={customer?.id ?? ''}
                  selectedLabel={customer?.fullName ?? ''}
                  onSelect={(c) => {
                    setCustomer({ id: c.id, fullName: c.fullName });
                    setReservationId('');
                  }}
                />
              )}
            </Field>
            {type === 'reservation' && (
              <Field label={t('receivables.receipts.reservation')} required error={touched ? fm(errors.reservation) : null} hint={t('receivables.refunds.reservationHint')} className="sm:col-span-2">
                {(id, desc) => (
                  <Select id={id} aria-describedby={desc} value={reservationId} disabled={!customer} invalid={touched && !!errors.reservation} onChange={(e) => {
                    setReservationId(e.target.value);
                    setAmount('');
                  }}>
                    <option value="">{customer ? t('receivables.receipts.chooseReservation') : t('receivables.receipts.chooseCustomerFirst')}</option>
                    {closed.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.number} · {t(`reservations.status.${r.status}`)} · {r.stockNumber}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {type === 'reservation' && customer && list.data && closed.length === 0 && (
              <Alert tone="info" className="sm:col-span-2">
                {t('receivables.refunds.noClosedReservations')}
              </Alert>
            )}
            {type === 'reservation' && detail.data && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm sm:col-span-2">
                <span className="text-muted">{t('receivables.refunds.refundable')}</span>
                <Money value={detail.data.availableDepositBase} currency={base} className="font-semibold" />
              </div>
            )}
            {type === 'customer_credit' && (
              <p className="text-xs text-muted sm:col-span-2">{t('receivables.refunds.creditHint')}</p>
            )}
          </>
        )}
        <Field label={t('receivables.refunds.amount')} required error={touched ? fm(errors.amount) : null} className="sm:col-span-2">
          {(id, desc) => <AmountInput id={id} aria-describedby={desc} currency={base} value={amount} invalid={touched && !!errors.amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label={t('common.reason')} required error={touched ? fm(errors.reason) : null} className="sm:col-span-2">
          {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={3} maxLength={500} value={reason} invalid={touched && !!errors.reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
