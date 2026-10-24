import clsx from 'clsx';
import { CalendarPlus, HandCoins, Timer, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { d, money, PERCENT_REGEX } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import {
  AmountInput,
  CustomerPicker,
  emptyMoneyIn,
  isMoney,
  isPositiveMoney,
  LeadOption,
  LeadPicker,
  Money,
  MoneyInFields,
  moneyInPayload,
  MoneyInValue,
  Row,
  useDomainError,
  useDomainMutation,
  useFieldMessage,
  useIdempotencyKey,
  useMoneyIn,
  useTenantMoney,
  VehicleOption,
  VehiclePicker,
  vehicleOptionTitle,
} from '@/features/receivables/kit';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { RefundPolicy, RESERVATION_KEYS, ReservationCancelled, ReservationCreated, ReservationDetail, ReservationStatus } from './api';

const DAY = 86_400_000;

// ── Badges & labels ──────────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<ReservationStatus, Tone> = { active: 'brand', converted: 'success', expired: 'warning', cancelled: 'neutral' };

export function ReservationStatusBadge({ status }: { status: ReservationStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`reservations.status.${status}`)}</Badge>;
}

/** Hours until a reservation expires (negative once past). */
export function hoursLeft(expiresAt: string, now = Date.now()): number {
  return (new Date(expiresAt).getTime() - now) / 3_600_000;
}

/** "Expires in 2 days" / "expires in 5 hours" / "overdue" for active reservations. */
export function ExpiryHint({ expiresAt, status, className }: { expiresAt: string; status: ReservationStatus; className?: string }) {
  const { t } = useTranslation();
  if (status !== 'active') return null;
  const h = hoursLeft(expiresAt);
  const tone = h <= 0 ? 'text-danger' : h <= 48 ? 'text-warning' : 'text-muted';
  const text = h <= 0 ? t('reservations.expiry.overdue') : h < 24 ? t('reservations.expiry.hours', { n: Math.max(1, Math.floor(h)) }) : t('reservations.expiry.days', { n: Math.floor(h / 24) });
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs', tone, className)}>
      <Timer className="h-3.5 w-3.5" aria-hidden />
      {text}
    </span>
  );
}

export function policyText(policy: RefundPolicy, pct: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (policy === 'partial') return t('reservations.policy.partialPct', { pct: d(pct).toString() });
  return t(`reservations.policy.${policy}`);
}

// ── Create ───────────────────────────────────────────────────────────────────────────────

/**
 * Reserve an available vehicle for a customer (POST /reservations), optionally recording the
 * deposit right away. The vehicle becomes "reserved" until the reservation is converted,
 * cancelled or expires.
 */
export function ReservationFormModal({
  vehicle: fixedVehicle,
  onClose,
  onDone,
}: {
  vehicle?: VehicleOption;
  onClose: () => void;
  onDone?: (r: ReservationCreated) => void;
}) {
  const { t, i18n } = useTranslation();
  const { me, can } = useAuth();
  const { base, rounding, today } = useTenantMoney();
  const describe = useDomainError('reservations');
  const fm = useFieldMessage('reservations');
  const [idemKey] = useIdempotencyKey();
  const defaults = me?.tenant?.settings.reservation;
  const [vehicle, setVehicle] = useState<VehicleOption | null>(fixedVehicle ?? null);
  const [customer, setCustomer] = useState<{ id: string; fullName: string } | null>(null);
  const [lead, setLead] = useState<LeadOption | null>(null);
  const [days, setDays] = useState(String(defaults?.defaultDays ?? 7));
  const [agreedPrice, setAgreedPrice] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [policy, setPolicy] = useState<RefundPolicy>(defaults?.defaultRefundPolicy ?? 'refundable');
  const [pct, setPct] = useState(defaults?.defaultRefundablePct ?? '100');
  const [notes, setNotes] = useState('');
  const canReceive = can('payments.receive');
  const [withDeposit, setWithDeposit] = useState(false);
  const [deposit, setDeposit] = useState<MoneyInValue>(() => emptyMoneyIn(today));
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const mi = useMoneyIn(deposit);

  const daysN = Number(days);
  const required = depositAmount.trim() ? depositAmount.trim() : '0';
  const depositOver = withDeposit && mi.amountBase && isPositiveMoney(required) && d(mi.amountBase).gt(required);
  const errors = {
    vehicle: !vehicle ? 'required' : vehicle.status !== 'available' ? 'vehicle_not_available' : null,
    customer: !customer ? 'required' : null,
    days: !/^\d+$/.test(days) || daysN < 1 || daysN > 90 ? 'days_range' : null,
    agreedPrice: agreedPrice.trim() && !isPositiveMoney(agreedPrice) ? 'must_be_positive' : null,
    depositAmount: depositAmount.trim() && (!isMoney(depositAmount) || d(depositAmount.trim()).isNegative()) ? 'invalid_amount' : null,
    pct: policy === 'partial' && (!PERCENT_REGEX.test(pct.trim()) || d(pct.trim()).lt(0) || d(pct.trim()).gt(100)) ? 'invalid_percent' : null,
    deposit: depositOver ? 'exceeds_required' : null,
  };
  const valid = Object.values(errors).every((e) => !e) && (!withDeposit || mi.valid);

  const create = useDomainMutation<Record<string, unknown>, ReservationCreated>({
    ns: 'reservations',
    path: '/reservations',
    idempotent: true,
    toastError: false,
    invalidate: RESERVATION_KEYS,
    success: (r) => t('reservations.created', { number: r.number }),
    onSuccess: (r) => {
      onDone?.(r);
      onClose();
    },
  });

  const submit = () => {
    setTouched(true);
    if (!valid || !vehicle || !customer) return;
    setFailure(null);
    create.mutate(
      {
        vehicleId: vehicle.id,
        customerId: customer.id,
        leadId: lead?.id ?? null,
        days: daysN,
        agreedPrice: agreedPrice.trim() ? money(agreedPrice.trim(), base, rounding) : null,
        depositAmount: depositAmount.trim() ? money(depositAmount.trim(), base, rounding) : '0',
        refundPolicy: policy,
        ...(policy === 'partial' ? { refundablePct: pct.trim() } : {}),
        notes: notes.trim() || null,
        deposit: withDeposit ? moneyInPayload(deposit, mi.foreign) : null,
        __idemKey: idemKey,
      },
      { onError: setFailure },
    );
  };

  const expires = /^\d+$/.test(days) && daysN >= 1 ? new Date(Date.now() + daysN * DAY) : null;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('reservations.new')}
      description={t('reservations.newHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={submit} loading={create.isPending} disabled={touched && !valid}>
            {t('reservations.reserve')}
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
        <Field label={t('reservations.fields.vehicle')} required error={touched ? fm(errors.vehicle) : null} hint={t('reservations.vehicleHint')} className="sm:col-span-2">
          {(id, desc) => (
            <VehiclePicker
              id={id}
              describedBy={desc}
              status="available"
              invalid={touched && !!errors.vehicle}
              disabled={!!fixedVehicle}
              value={vehicle?.id ?? ''}
              selectedLabel={vehicle ? `${vehicleOptionTitle(vehicle, i18n.language)} · ${vehicle.stockNumber}` : ''}
              onSelect={setVehicle}
            />
          )}
        </Field>
        <Field label={t('reservations.fields.customer')} required error={touched ? fm(errors.customer) : null}>
          {(id, desc) => (
            <CustomerPicker
              id={id}
              describedBy={desc}
              invalid={touched && !!errors.customer}
              value={customer?.id ?? ''}
              selectedLabel={customer?.fullName ?? ''}
              onSelect={(c) => {
                setCustomer({ id: c.id, fullName: c.fullName });
                if (lead && lead.customerId !== c.id) setLead(null);
              }}
            />
          )}
        </Field>
        {can('leads.read') ? (
          <Field label={t('reservations.fields.lead')} hint={t('reservations.leadHint')}>
            {(id, desc) => (
              <LeadPicker
                id={id}
                describedBy={desc}
                value={lead?.id ?? ''}
                selectedLabel={lead ? `${lead.number} · ${lead.customerName}` : ''}
                onSelect={(l) => {
                  setLead(l);
                  setCustomer({ id: l.customerId, fullName: l.customerName });
                }}
                onClear={() => setLead(null)}
              />
            )}
          </Field>
        ) : (
          <div className="hidden sm:block" />
        )}
        <Field label={t('reservations.fields.days')} required error={touched ? fm(errors.days) : null} hint={expires ? t('reservations.expiresOn', { date: fmtDateTime(expires) }) : undefined}>
          {(id, desc) => <Input id={id} aria-describedby={desc} type="number" min={1} max={90} dir="ltr" className="num" value={days} invalid={touched && !!errors.days} onChange={(e) => setDays(e.target.value)} />}
        </Field>
        <Field label={t('reservations.fields.agreedPrice')} error={touched ? fm(errors.agreedPrice) : null} hint={vehicle?.askingPrice ? t('reservations.askingHint') : t('common.optional')}>
          {(id, desc) => (
            <div>
              <AmountInput id={id} aria-describedby={desc} currency={base} value={agreedPrice} invalid={touched && !!errors.agreedPrice} onChange={(e) => setAgreedPrice(e.target.value)} />
              {vehicle?.askingPrice && (
                <button type="button" className="mt-1 text-xs text-brand-strong hover:underline" onClick={() => setAgreedPrice(vehicle.askingPrice!)}>
                  <Money value={vehicle.askingPrice} currency={base} />
                </button>
              )}
            </div>
          )}
        </Field>
        <Field label={t('reservations.fields.depositAmount')} error={touched ? fm(errors.depositAmount) : null} hint={t('reservations.depositAmountHint')}>
          {(id, desc) => (
            <AmountInput
              id={id}
              aria-describedby={desc}
              currency={base}
              value={depositAmount}
              invalid={touched && !!errors.depositAmount}
              onChange={(e) => {
                const v = e.target.value;
                // Keep the received amount in step with the requirement until the user edits it.
                if (withDeposit && (deposit.amount === depositAmount || !deposit.amount)) setDeposit({ ...deposit, amount: v });
                setDepositAmount(v);
              }}
            />
          )}
        </Field>
        <Field label={t('reservations.fields.refundPolicy')}>
          {(id) => (
            <Select id={id} value={policy} onChange={(e) => setPolicy(e.target.value as RefundPolicy)}>
              {(['refundable', 'partial', 'non_refundable'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`reservations.policy.${p}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {policy === 'partial' ? (
          <Field label={t('reservations.fields.refundablePct')} required error={touched ? fm(errors.pct) : null}>
            {(id, desc) => <Input id={id} aria-describedby={desc} dir="ltr" inputMode="decimal" className="num" value={pct} invalid={touched && !!errors.pct} onChange={(e) => setPct(e.target.value)} />}
          </Field>
        ) : (
          <p className="self-end pb-2 text-xs text-muted">{t(`reservations.policyHint.${policy}`)}</p>
        )}
        <Field label={t('common.notes')} className="sm:col-span-2">
          {(id) => <Textarea id={id} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        {canReceive && (
          <div className="rounded-xl border border-line p-4 sm:col-span-2">
            <Checkbox
              label={t('reservations.receiveNow')}
              description={t('reservations.receiveNowHint')}
              checked={withDeposit}
              onChange={(e) => {
                setWithDeposit(e.target.checked);
                if (e.target.checked && !deposit.amount && isPositiveMoney(depositAmount)) setDeposit({ ...deposit, amount: depositAmount.trim() });
              }}
            />
            {withDeposit && (
              <div className="mt-4 space-y-3">
                <MoneyInFields value={deposit} onChange={setDeposit} touched={touched} amountError={errors.deposit} />
                {mi.amountBase && !isPositiveMoney(depositAmount) && <p className="text-xs text-muted">{t('reservations.depositBecomesRequired')}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Deposit ──────────────────────────────────────────────────────────────────────────────

/** Records (part of) the deposit later (POST /reservations/:id/deposits), up to what is still due. */
export function DepositModal({ reservation: r, onClose }: { reservation: ReservationDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const { base, today } = useTenantMoney();
  const describe = useDomainError('reservations');
  const [idemKey] = useIdempotencyKey();
  const outstanding = d(r.depositAmount).minus(r.receivedBase);
  const due = (outstanding.isNegative() ? d(0) : outstanding).toFixed(2);
  const [value, setValue] = useState<MoneyInValue>(() => emptyMoneyIn(today, d(due).gt(0) ? due : ''));
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const mi = useMoneyIn(value);
  const over = mi.amountBase && d(mi.amountBase).gt(due);
  const add = useDomainMutation<Record<string, unknown>, { number: string }>({
    ns: 'reservations',
    path: `/reservations/${r.id}/deposits`,
    idempotent: true,
    toastError: false,
    invalidate: RESERVATION_KEYS,
    success: (res) => t('reservations.depositRecorded', { number: res.number }),
    onSuccess: onClose,
  });
  const submit = () => {
    setTouched(true);
    if (!mi.valid || over) return;
    setFailure(null);
    add.mutate({ ...moneyInPayload(value, mi.foreign), __idemKey: idemKey }, { onError: setFailure });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('reservations.addDepositTitle', { number: r.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon={<HandCoins className="h-4 w-4" />} onClick={submit} loading={add.isPending} disabled={d(due).lte(0)}>
            {t('reservations.addDeposit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure !== null && <Alert tone="danger">{describe(failure)}</Alert>}
        <dl className="rounded-xl border border-line bg-surface-2/50 px-4 py-2">
          <Row label={t('reservations.money.required')}>
            <Money value={r.depositAmount} currency={base} />
          </Row>
          <Row label={t('reservations.money.received')}>
            <Money value={r.receivedBase} currency={base} />
          </Row>
          <Row label={t('reservations.money.outstanding')} strong>
            <Money value={due} currency={base} />
          </Row>
        </dl>
        {d(due).lte(0) ? (
          <Alert tone="info">{t('reservations.nothingDue')}</Alert>
        ) : (
          <MoneyInFields value={value} onChange={setValue} touched={touched} amountError={over ? 'exceeds_outstanding' : null} />
        )}
      </div>
    </Modal>
  );
}

// ── Extend ───────────────────────────────────────────────────────────────────────────────

export function ExtendModal({ reservation: r, onClose }: { reservation: ReservationDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const describe = useDomainError('reservations');
  const fm = useFieldMessage('reservations');
  const [days, setDays] = useState('3');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const n = Number(days);
  const errors = { days: !/^\d+$/.test(days) || n < 1 || n > 90 ? 'days_range' : null, reason: reason.trim().length < 3 ? 'min_reason' : null };
  const from = Math.max(new Date(r.expiresAt).getTime(), Date.now());
  const newExpiry = errors.days ? null : new Date(from + n * DAY);
  const extend = useDomainMutation<{ days: number; reason: string }>({
    ns: 'reservations',
    path: `/reservations/${r.id}/extend`,
    toastError: false,
    invalidate: RESERVATION_KEYS,
    success: t('reservations.extended', { number: r.number }),
    onSuccess: onClose,
  });
  const submit = () => {
    setTouched(true);
    if (errors.days || errors.reason) return;
    setFailure(null);
    extend.mutate({ days: n, reason: reason.trim() }, { onError: setFailure });
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('reservations.extendTitle', { number: r.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={extend.isPending}>
            {t('reservations.extend')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure !== null && <Alert tone="danger">{describe(failure)}</Alert>}
        <dl className="rounded-xl border border-line bg-surface-2/50 px-4 py-2">
          <Row label={t('reservations.fields.expiresAt')}>{fmtDateTime(r.expiresAt)}</Row>
          <Row label={t('reservations.newExpiry')} strong>
            {newExpiry ? fmtDateTime(newExpiry) : '—'}
          </Row>
        </dl>
        <Field label={t('reservations.extendDays')} required error={touched ? fm(errors.days) : null}>
          {(id, desc) => <Input id={id} aria-describedby={desc} type="number" min={1} max={90} dir="ltr" className="num" value={days} invalid={touched && !!errors.days} onChange={(e) => setDays(e.target.value)} />}
        </Field>
        <Field label={t('common.reason')} required error={touched ? fm(errors.reason) : null} hint={t('reservations.extendReasonHint')}>
          {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={3} maxLength={500} value={reason} invalid={touched && !!errors.reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

// ── Cancel ───────────────────────────────────────────────────────────────────────────────

type RefundMode = 'per_policy' | 'full' | 'none';

/** What cancelling does to the deposit held, computed exactly as the API does. */
export function cancelPreview(r: Pick<ReservationDetail, 'availableDepositBase' | 'refundablePct'>, mode: RefundMode, base: Parameters<typeof money>[1], rounding: Parameters<typeof money>[2]) {
  const available = d(r.availableDepositBase);
  const refund = mode === 'full' ? available : mode === 'none' ? d(0) : d(money(available.times(r.refundablePct).dividedBy(100), base, rounding));
  return { available: available.toFixed(2), refund: refund.toFixed(2), forfeit: available.minus(refund).toFixed(2) };
}

export function CancelReservationModal({ reservation: r, onClose, onDone }: { reservation: ReservationDetail; onClose: () => void; onDone?: (res: ReservationCancelled) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { base, rounding } = useTenantMoney();
  const describe = useDomainError('reservations');
  const fm = useFieldMessage('reservations');
  const [idemKey] = useIdempotencyKey();
  const [mode, setMode] = useState<RefundMode>('per_policy');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const hasDeposit = d(r.availableDepositBase).gt(0);
  const canOverride = can('refunds.approve');
  // Overriding the agreed policy needs refunds.approve (the API checks the same rule).
  const needsOverride = (m: RefundMode) => (m === 'full' && r.refundPolicy !== 'refundable') || (m === 'none' && r.refundPolicy !== 'non_refundable' && hasDeposit);
  const preview = cancelPreview(r, mode, base, rounding);
  const cancel = useDomainMutation<{ reason: string; refund: RefundMode }, ReservationCancelled>({
    ns: 'reservations',
    path: `/reservations/${r.id}/cancel`,
    idempotent: true,
    toastError: false,
    invalidate: RESERVATION_KEYS,
    success: (res) => (res.refund ? t('reservations.cancelledWithRefund', { number: r.number, refund: res.refund.number }) : t('reservations.cancelled', { number: r.number })),
    onSuccess: (res) => {
      onDone?.(res);
      onClose();
    },
  });
  const reasonErr = reason.trim().length < 3 ? 'min_reason' : null;
  const submit = () => {
    setTouched(true);
    if (reasonErr) return;
    setFailure(null);
    cancel.mutate({ reason: reason.trim(), refund: mode, __idemKey: idemKey }, { onError: setFailure });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('reservations.cancelTitle', { number: r.number })}
      description={t('reservations.cancelHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.back')}
          </Button>
          <Button variant="danger" icon={<XCircle className="h-4 w-4" />} onClick={submit} loading={cancel.isPending}>
            {t('reservations.cancelConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure !== null && <Alert tone="danger">{describe(failure)}</Alert>}
        {hasDeposit ? (
          <fieldset>
            <legend className="label">{t('reservations.refundMode')}</legend>
            <div className="grid gap-2">
              {(['per_policy', 'full', 'none'] as const).map((m) => {
                const locked = needsOverride(m) && !canOverride;
                return (
                  <label
                    key={m}
                    className={clsx(
                      'flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm',
                      mode === m ? 'border-brand bg-brand-soft/40' : 'border-line',
                      locked ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
                    )}
                  >
                    <input type="radio" name="refund-mode" className="mt-0.5 accent-[var(--brand-strong)]" checked={mode === m} disabled={locked} onChange={() => setMode(m)} />
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{m === 'per_policy' ? t('reservations.mode.per_policy', { policy: policyText(r.refundPolicy, r.refundablePct, t) }) : t(`reservations.mode.${m}`)}</span>
                      {needsOverride(m) && <span className="block text-xs text-muted">{canOverride ? t('reservations.overrideNote') : t('reservations.overrideLocked')}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : (
          <Alert tone="info">{t('reservations.noDepositHeld')}</Alert>
        )}
        {hasDeposit && (
          <dl className="rounded-xl border border-line bg-surface-2/50 px-4 py-2">
            <Row label={t('reservations.money.available')}>
              <Money value={preview.available} currency={base} />
            </Row>
            <Row label={t('reservations.money.toRefund')} tone="success">
              <Money value={preview.refund} currency={base} />
            </Row>
            <Row label={t('reservations.money.toForfeit')} tone={d(preview.forfeit).gt(0) ? 'danger' : 'muted'}>
              <Money value={preview.forfeit} currency={base} />
            </Row>
            {d(preview.refund).gt(0) && <p className="pb-1 text-xs text-muted">{t('reservations.refundNeedsApproval')}</p>}
          </dl>
        )}
        <Field label={t('common.reason')} required error={touched ? fm(reasonErr) : null}>
          {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={3} maxLength={500} value={reason} invalid={touched && !!reasonErr} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
