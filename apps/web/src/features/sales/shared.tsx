import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ComponentProps, forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  convert,
  CurrencyCode,
  d,
  isValidMoney,
  money,
  PAYMENT_METHODS,
  PERMISSIONS,
  Permission,
  RATE_REGEX,
  RoundingMode,
  todayInZone,
  VEHICLE_STATUS_LABELS,
  VehicleStatus,
} from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert, errorMessage } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import {
  CashAccountOption,
  CommissionStatus,
  InstallmentLineStatus,
  PaymentMethod,
  PlanStatus,
  SalePaymentType,
  SaleStatus,
  SALES_MONEY_KEYS,
  useCashAccountOptions,
  VehicleSnapshot,
} from './api';

type T = (key: string, opts?: Record<string, unknown>) => string;

// ── Tenant money context ─────────────────────────────────────────────────────────────────

export function useTenantMoney() {
  const { me, currency } = useAuth();
  const rounding: RoundingMode = me?.tenant?.settings.rounding ?? 'half_up';
  const timezone = me?.tenant?.settings.timezone ?? 'UTC';
  return { base: currency, rounding, timezone, today: todayInZone(timezone) };
}

export const isMoney = (v: string | null | undefined): boolean => !!v && isValidMoney(v.trim());
export const isPositiveMoney = (v: string | null | undefined): boolean => !!v && isMoney(v) && d(v.trim()).gt(0);
export const isRate = (v: string | null | undefined): v is string => !!v && RATE_REGEX.test(v.trim()) && d(v.trim()).gt(0);

/** Base-currency equivalent exactly as the API computes it (convert with the tenant rounding mode). */
export function toBase(amount: string, currency: string, rate: string | null | undefined, base: CurrencyCode, mode: RoundingMode): string | null {
  if (!isMoney(amount)) return null;
  const rounded = money(amount.trim(), currency as CurrencyCode, mode);
  if (currency === base) return convert(rounded, '1', base, mode);
  if (!isRate(rate)) return null;
  return convert(rounded, rate.trim(), base, mode);
}

/** One Idempotency-Key per user action: created when the dialog mounts, reused on retry. */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(() => newIdempotencyKey());
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return [key, renew];
}

// ── Error translation ────────────────────────────────────────────────────────────────────

const MONEY_DETAIL_KEYS = ['amount', 'outstanding', 'due', 'credit', 'refundable', 'total', 'difference', 'expected', 'counted', 'unallocated', 'receiptBase', 'allocated'];

function permissionLabel(p: unknown, lang: 'ar' | 'en'): string {
  const list = (Array.isArray(p) ? p : [p]).filter((x): x is string => typeof x === 'string');
  return list.map((x) => (x in PERMISSIONS ? PERMISSIONS[x as Permission][lang] : x)).join(lang === 'en' ? ' / ' : ' أو ');
}

/**
 * Translates an API error for the sales, installments, commissions and cash-closing screens:
 * domain codes from `sales.errors.*` (with the server's detail values as placeholders), then the
 * global `errors.*` table, then the server's own message.
 */
export function salesErrorMessage(err: unknown, t: T, lang: string, currency: string): string {
  if (err instanceof ApiError) {
    const l = lang === 'en' ? 'en' : 'ar';
    const det = err.details ?? {};
    const code = err.code === 'forbidden' && typeof det.code === 'string' ? det.code : err.code;
    if (code === 'forbidden' && det.permission) {
      return t('sales.errors.missingPermission', { permission: permissionLabel(det.permission, l) });
    }
    const vars: Record<string, unknown> = { defaultValue: '' };
    for (const [k, v] of Object.entries(det)) {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      if (MONEY_DETAIL_KEYS.includes(k) && isMoney(String(v))) vars[k] = fmtMoney(String(v), typeof det.currency === 'string' ? det.currency : currency);
      else if (k === 'status') vars[k] = t(`sales.statusAny.${v}`, { defaultValue: String(v) });
      else if (k === 'vehicleStatus') vars[k] = VEHICLE_STATUS_LABELS[v as VehicleStatus]?.[l] ?? String(v);
      else if (k === 'closedThrough' || k === 'date') vars[k] = fmtDate(String(v));
      else vars[k] = v;
    }
    const own = t(`sales.errors.${code}`, vars);
    if (own) return own;
  }
  return errorMessage(err, t);
}

export function useSalesError() {
  const { t, i18n } = useTranslation();
  const { currency } = useAuth();
  return useCallback((err: unknown) => salesErrorMessage(err, t as T, i18n.language, currency), [t, i18n.language, currency]);
}

/** A zod issue's machine code: our schemas use snake_case messages (`invalid_amount`); built-ins use the issue code. */
export function issueCode(message: string | undefined, code: string): string {
  return message && /^[a-z_]+$/.test(message) ? message : code;
}

/** Field errors from zod issues (client-side safeParse): { 'installmentTerms.count': 'too_small', … }. */
export function zodFieldErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; code: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const path = i.path.map(String).join('.');
    if (path && !out[path]) out[path] = issueCode(i.message, i.code);
  }
  return out;
}

/** Field errors from a `validation_failed` response, or from a domain error naming a field. */
export function serverFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  if (err.code !== 'validation_failed') {
    const field = err.details?.field;
    return typeof field === 'string' ? { [field]: err.code } : {};
  }
  const issues = (err.details as { issues?: Array<{ path: string; message: string; code: string }> } | undefined)?.issues ?? [];
  const out: Record<string, string> = {};
  for (const i of issues) if (i.path && !out[i.path]) out[i.path] = issueCode(i.message, i.code);
  return out;
}

/** Translates a field validation message (zod message or server issue code). */
export function useFieldMessage() {
  const { t } = useTranslation();
  return useCallback(
    (code: string | undefined | null): string | null => {
      if (!code) return null;
      return (
        t(`sales.validation.${code}`, { defaultValue: '' }) ||
        t(`sales.errors.${code}`, { defaultValue: '' }) ||
        t(`errors.${code}`, { defaultValue: '' }) ||
        t('sales.validation.invalid')
      );
    },
    [t],
  );
}

interface MutationOpts<TVars, TRes> {
  path: string | ((vars: TVars) => string);
  method?: 'POST' | 'PATCH';
  invalidate?: unknown[][];
  success?: string | ((res: TRes) => string | null) | null;
  onSuccess?: (res: TRes, vars: TVars) => void;
  /** Send an Idempotency-Key (routes the API marks @Idempotent). One key per user action. */
  idempotent?: boolean;
  /** Show the error as a toast (default true); dialogs that render the error inline pass false. */
  toastError?: boolean;
}

/**
 * Same contract as useApiMutation (@/lib/hooks) — toasts, cache invalidation, Idempotency-Key per
 * user action — but errors are translated with the sales domain codes (salesErrorMessage).
 */
export function useSalesMutation<TVars = unknown, TRes = unknown>(opts: MutationOpts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  const describe = useSalesError();
  return useMutation<TRes, unknown, TVars & { __idemKey?: string }>({
    mutationFn: (vars) => {
      const { __idemKey, ...rest } = vars as TVars & { __idemKey?: string };
      const path = typeof opts.path === 'function' ? opts.path(rest as TVars) : opts.path;
      return api<TRes>(path, { method: opts.method ?? 'POST', body: rest, idempotencyKey: opts.idempotent ? __idemKey : undefined });
    },
    onSuccess: async (res, vars) => {
      await Promise.all((opts.invalidate ?? SALES_MONEY_KEYS).map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg = typeof opts.success === 'function' ? opts.success(res) : opts.success === undefined ? t('common.savedSuccessfully') : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars as TVars);
    },
    onError: (err) => {
      if (opts.toastError !== false) toast.error(describe(err));
    },
  });
}

// ── Display helpers ──────────────────────────────────────────────────────────────────────

export function Money({ value, currency, className }: { value: string | null | undefined; currency?: string; className?: string }) {
  const { currency: base } = useAuth();
  return <span className={clsx('num whitespace-nowrap', className)}>{fmtMoney(value, currency ?? base)}</span>;
}

/**
 * MoneyInput whose currency tag never covers the digits in Arabic: the kit's input is dir="ltr" but
 * places the tag at the page's inline end (the left in RTL), so the padding must follow it there.
 */
export const AmountInput = forwardRef<HTMLInputElement, ComponentProps<typeof MoneyInput>>(function AmountInput({ className, ...rest }, ref) {
  return <MoneyInput ref={ref} className={clsx(rest.currency && 'rtl:ps-14 rtl:pe-3', className)} {...rest} />;
});

export function Stat({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('min-w-0', className)}>
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-1 text-sm font-medium text-ink">{children}</div>
    </div>
  );
}

/** Label / value row for breakdown panels. */
export function Row({ label, children, strong, tone }: { label: ReactNode; children: ReactNode; strong?: boolean; tone?: 'success' | 'warning' | 'danger' | 'muted' }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className={clsx('text-[13px]', strong ? 'font-semibold text-ink' : 'text-muted')}>{label}</dt>
      <dd
        className={clsx(
          'text-end text-sm',
          strong && 'font-semibold',
          !tone && 'text-ink',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
          tone === 'muted' && 'text-muted',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export function vehicleSnapshotTitle(v: Pick<VehicleSnapshot, 'makeEn' | 'makeAr' | 'modelEn' | 'modelAr' | 'modelYear' | 'trim'>, lang: string): string {
  return [lang === 'en' ? v.makeEn : v.makeAr, lang === 'en' ? v.modelEn : v.modelAr, v.trim, v.modelYear].filter(Boolean).join(' ');
}

const SALE_TONE: Record<SaleStatus, Tone> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  confirmed: 'brand',
  delivered: 'success',
  cancelled: 'danger',
  returned: 'accent',
};

export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  const { t } = useTranslation();
  return <Badge tone={SALE_TONE[status] ?? 'neutral'}>{t(`sales.status.${status}`)}</Badge>;
}

export function PaymentTypeBadge({ type }: { type: SalePaymentType }) {
  const { t } = useTranslation();
  const tone: Tone = type === 'cash' ? 'neutral' : type === 'installments' ? 'accent' : 'info';
  return (
    <Badge tone={tone} dot={false}>
      {t(`sales.paymentType.${type}`)}
    </Badge>
  );
}

const PLAN_TONE: Record<PlanStatus, Tone> = { scheduled: 'neutral', active: 'info', settled: 'success', completed: 'success', cancelled: 'danger' };

export function PlanStatusBadge({ status }: { status: PlanStatus }) {
  const { t } = useTranslation();
  return <Badge tone={PLAN_TONE[status] ?? 'neutral'}>{t(`installments.planStatus.${status}`)}</Badge>;
}

const LINE_TONE: Record<InstallmentLineStatus, Tone> = { due: 'neutral', partial: 'info', overdue: 'danger', paid: 'success', waived: 'accent', cancelled: 'neutral' };

export function LineStatusBadge({ status }: { status: InstallmentLineStatus }) {
  const { t } = useTranslation();
  return <Badge tone={LINE_TONE[status] ?? 'neutral'}>{t(`installments.lineStatus.${status}`)}</Badge>;
}

const COMMISSION_TONE: Record<CommissionStatus, Tone> = { expected: 'neutral', earned: 'info', approved: 'brand', paid: 'success', reversed: 'danger', clawback: 'warning' };

export function CommissionStatusBadge({ status }: { status: CommissionStatus }) {
  const { t } = useTranslation();
  return <Badge tone={COMMISSION_TONE[status] ?? 'neutral'}>{t(`commissions.status.${status}`)}</Badge>;
}

/** The commission rule in the user's language (the server's `explanation` is English). */
export function commissionRuleText(rule: Record<string, unknown> | null | undefined, t: T): string | null {
  if (!rule || typeof rule.type !== 'string') return null;
  const rate = typeof rule.ratePct === 'string' ? rule.ratePct : '';
  const base = rule.tierBase === 'sale' ? t('commissions.rule.baseSale') : t('commissions.rule.baseProfit');
  return t(`commissions.rule.${rule.type}`, { rate, base, defaultValue: '' }) || null;
}

// ── Cash account / method pickers ────────────────────────────────────────────────────────

export function CashAccountSelect({
  id,
  value,
  onChange,
  accounts,
  baseOnly,
  invalid,
  describedBy,
}: {
  id?: string;
  value: string;
  onChange: (a: CashAccountOption | null) => void;
  accounts: CashAccountOption[] | undefined;
  baseOnly?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation();
  const { base } = useTenantMoney();
  const list = (accounts ?? []).filter((a) => !baseOnly || a.currency === base);
  return (
    <Select id={id} value={value} invalid={invalid} aria-describedby={describedBy} onChange={(e) => onChange(list.find((a) => a.id === e.target.value) ?? null)}>
      <option value="">{t('sales.payment.chooseAccount')}</option>
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {a.currency} ({t(`sales.payment.accountType.${a.type}`)})
        </option>
      ))}
    </Select>
  );
}

export function MethodSelect({ id, value, onChange }: { id?: string; value: PaymentMethod; onChange: (m: PaymentMethod) => void }) {
  const { t } = useTranslation();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value as PaymentMethod)}>
      {PAYMENT_METHODS.map((m) => (
        <option key={m} value={m}>
          {t(`sales.method.${m}`)}
        </option>
      ))}
    </Select>
  );
}

// ── Receive a customer payment (POST /receipts, allocated to one document) ───────────────

/**
 * Records money received from the customer against a sale or an installment plan. The amount is
 * entered in the cash account's currency; foreign-currency accounts need the exchange rate and the
 * allocation is the base equivalent, computed exactly as the API does.
 */
export function ReceivePaymentModal({
  title,
  description,
  customerId,
  targetType,
  targetId,
  defaultAmount,
  maxBase,
  onClose,
  onDone,
}: {
  title: ReactNode;
  description?: ReactNode;
  customerId: string;
  targetType: 'sale' | 'installment';
  targetId: string;
  /** Prefilled amount (base currency). */
  defaultAmount: string;
  /** What the document can still take (base currency). */
  maxBase: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const { base, rounding, today } = useTenantMoney();
  const describe = useSalesError();
  const accounts = useCashAccountOptions();
  const [idemKey] = useIdempotencyKey();
  const [account, setAccount] = useState<CashAccountOption | null>(null);
  const [amount, setAmount] = useState(defaultAmount);
  const [rate, setRate] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [receivedAt, setReceivedAt] = useState(today);
  const [notes, setNotes] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  // A single base-currency account is the common case: preselect it.
  useEffect(() => {
    if (!account && accounts.data) {
      const baseAccounts = accounts.data.filter((a) => a.currency === base);
      if (baseAccounts.length === 1) setAccount(baseAccounts[0]!);
    }
  }, [accounts.data, account, base]);

  const currency = account?.currency ?? base;
  const foreign = currency !== base;
  const amountBase = toBase(amount, currency, foreign ? rate : '1', base, rounding);
  const over = amountBase !== null && d(amountBase).gt(maxBase);
  const errors = {
    account: !account ? 'required' : null,
    amount: !isPositiveMoney(amount) ? (amount.trim() ? 'must_be_positive' : 'required') : over ? 'exceeds_outstanding' : null,
    rate: foreign && !isRate(rate) ? 'invalid_rate' : null,
  };
  const valid = !errors.account && !errors.amount && !errors.rate && amountBase !== null && d(amountBase).gt(0);
  const fm = useFieldMessage();

  const receive = useSalesMutation<Record<string, unknown>, { number: string }>({
    path: '/receipts',
    idempotent: true,
    toastError: false,
    success: (r) => t('sales.payment.recorded', { number: r.number }),
    onSuccess: () => {
      onDone?.();
      onClose();
    },
  });

  const submit = () => {
    setTouched(true);
    if (!valid || !account || amountBase === null) return;
    setFailure(null);
    receive.mutate(
      {
        customerId,
        cashAccountId: account.id,
        amount: amount.trim(),
        ...(foreign ? { exchangeRate: rate.trim() } : {}),
        method,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
        receivedAt,
        allocations: [{ targetType, targetId, amountBase }],
        __idemKey: idemKey,
      },
      { onError: (e) => setFailure(e) },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={receive.isPending} disabled={touched && !valid}>
            {t('sales.payment.submit')}
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
          <span className="text-muted">{t('sales.payment.outstanding')}</span>
          <Money value={maxBase} currency={base} className="font-semibold" />
        </div>
        <Field label={t('sales.payment.account')} required error={touched ? fm(errors.account) : null} className="sm:col-span-2">
          {(id, desc) => (
            <CashAccountSelect id={id} describedBy={desc} value={account?.id ?? ''} accounts={accounts.data} invalid={touched && !!errors.account} onChange={setAccount} />
          )}
        </Field>
        {accounts.data && accounts.data.length === 0 && (
          <Alert tone="warning" className="sm:col-span-2">
            {t('sales.payment.noAccounts')}
          </Alert>
        )}
        <Field label={t('sales.payment.amount')} required error={touched ? fm(errors.amount) : null} hint={foreign ? t('sales.payment.amountInAccountCurrency', { currency }) : undefined}>
          {(id, desc) => <AmountInput id={id} aria-describedby={desc} currency={currency} value={amount} invalid={touched && !!errors.amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        {foreign ? (
          <Field label={t('sales.payment.rate', { from: currency, to: base })} required error={touched ? fm(errors.rate) : null}>
            {(id, desc) => <Input id={id} aria-describedby={desc} dir="ltr" inputMode="decimal" className="num" value={rate} invalid={touched && !!errors.rate} onChange={(e) => setRate(e.target.value)} />}
          </Field>
        ) : (
          <Field label={t('sales.payment.method')}>{(id) => <MethodSelect id={id} value={method} onChange={setMethod} />}</Field>
        )}
        {foreign && (
          <>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm sm:col-span-2">
              <span className="text-muted">{t('sales.payment.baseEquivalent')}</span>
              <Money value={amountBase} currency={base} className="font-medium" />
            </div>
            <Field label={t('sales.payment.method')}>{(id) => <MethodSelect id={id} value={method} onChange={setMethod} />}</Field>
          </>
        )}
        <Field label={t('common.reference')}>{(id) => <Input id={id} value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />}</Field>
        <Field label={t('sales.payment.date')} hint={t('sales.payment.dateHint')}>
          {(id, desc) => <Input id={id} aria-describedby={desc} type="date" value={receivedAt} max={today} onChange={(e) => setReceivedAt(e.target.value)} />}
        </Field>
        <Field label={t('common.notes')} className="sm:col-span-2">
          {(id) => <Textarea id={id} rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/** Reason dialog with a minimum length (ConfirmDialog only enforces 3 characters). */
export function ReasonModal({
  title,
  message,
  confirmLabel,
  minLength = 3,
  tone = 'danger',
  loading,
  error,
  onClose,
  onConfirm,
  children,
}: {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel: ReactNode;
  minLength?: number;
  tone?: 'danger' | 'primary';
  loading?: boolean;
  error?: ReactNode;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const short = reason.trim().length < minLength;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={loading} disabled={short} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {message && <div className="text-sm text-muted">{message}</div>}
        {children}
        <Field label={t('common.reason')} required hint={t('sales.validation.minChars', { n: minLength })}>
          {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/** Alert for a 409 version_conflict: the record changed since it was loaded. */
export function StaleAlert({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert tone="warning" title={t('sales.stale.title')}>
      <p>{t('sales.stale.body')}</p>
      <Button size="sm" variant="secondary" className="mt-2" onClick={onReload}>
        {t('sales.stale.reload')}
      </Button>
    </Alert>
  );
}

export const isVersionConflict = (e: unknown) => e instanceof ApiError && e.code === 'version_conflict';

/** Shows an API failure inline: a reload prompt for version conflicts, the translated message otherwise. */
export function FailureAlert({ error, onReload }: { error: unknown; onReload: () => void }) {
  const describe = useSalesError();
  if (error === null || error === undefined) return null;
  if (isVersionConflict(error)) return <StaleAlert onReload={onReload} />;
  return <Alert tone="danger">{describe(error)}</Alert>;
}

/** Sum of decimal strings without floats. */
export function sumMoney(values: Array<string | null | undefined>): string {
  return values.reduce((acc: ReturnType<typeof d>, v) => (isMoney(v) ? acc.plus(v!.trim()) : acc), d(0)).toFixed(2);
}

export function useMemoJson<T>(value: T): T {
  const key = JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key]);
}
