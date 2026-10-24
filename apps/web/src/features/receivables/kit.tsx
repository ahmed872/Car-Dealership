import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Search, X } from 'lucide-react';
import { ComponentProps, forwardRef, KeyboardEvent, ReactNode, useCallback, useEffect, useId, useState } from 'react';
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
import { Button } from '@/components/ui/Button';
import { Alert, errorMessage } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';

/**
 * Building blocks shared by the appointments, reservations and receivables screens: tenant money
 * context, Idempotency-Key per user action, domain error translation, searchable pickers and the
 * cash-account / payment-method selects. Strings live in the `receivables.kit` namespace.
 */

export type TFn = (key: string, opts?: Record<string, unknown>) => string;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CashAccountOption {
  id: string;
  type: 'cashbox' | 'bank';
  name: string;
  currency: string;
  branchId: string | null;
}

export const useCashAccountOptions = (enabled = true) =>
  useApi<CashAccountOption[]>(['cash-accounts', 'options'], enabled ? '/cash-accounts/options' : null, undefined, { staleTime: 60_000 });

// ── Tenant money / time context ──────────────────────────────────────────────────────────

export function useTenantMoney() {
  const { me, currency } = useAuth();
  const rounding: RoundingMode = me?.tenant?.settings.rounding ?? 'half_up';
  const timezone = me?.tenant?.settings.timezone ?? 'UTC';
  return { base: currency, rounding, timezone, today: todayInZone(timezone) };
}

export const isMoney = (v: string | null | undefined): boolean => !!v && isValidMoney(v.trim());
export const isPositiveMoney = (v: string | null | undefined): boolean => !!v && isMoney(v) && d(v.trim()).gt(0);
export const isRate = (v: string | null | undefined): v is string => !!v && RATE_REGEX.test(v.trim()) && d(v.trim()).gt(0);

/** Base-currency equivalent exactly as the API computes it (money() then convert() with the tenant rounding). */
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

const MONEY_DETAIL_KEYS = ['amount', 'outstanding', 'refundable', 'receiptBase', 'allocated', 'available', 'required'];
const DATETIME_DETAIL_KEYS = ['startsAt', 'endsAt'];

function permissionLabel(p: unknown, lang: 'ar' | 'en'): string {
  const list = (Array.isArray(p) ? p : [p]).filter((x): x is string => typeof x === 'string');
  return list.map((x) => (x in PERMISSIONS ? PERMISSIONS[x as Permission][lang] : x)).join(lang === 'en' ? ' / ' : ' أو ');
}

export type ErrorNs = 'appointments' | 'reservations' | 'receivables';

/**
 * Translates an API error: the feature's own `<ns>.errors.<code>` (server detail values as
 * placeholders), then the shared `receivables.errors.<code>`, then the global `errors.*`, and
 * finally the server's message.
 */
export function domainErrorMessage(err: unknown, ns: ErrorNs, t: TFn, lang: string, currency: string, timezone: string): string {
  if (err instanceof ApiError) {
    const l = lang === 'en' ? 'en' : 'ar';
    const det = err.details ?? {};
    // assertPermission sends { permission }, the route guard { missing: [...] }.
    const perm = det.permission ?? det.missing;
    if (err.code === 'forbidden' && perm) {
      return t('receivables.errors.missingPermission', { permission: permissionLabel(perm, l) });
    }
    const vars: Record<string, unknown> = { defaultValue: '' };
    for (const [k, v] of Object.entries(det)) {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      if (MONEY_DETAIL_KEYS.includes(k) && isMoney(String(v))) vars[k] = fmtMoney(String(v), currency);
      else if (DATETIME_DETAIL_KEYS.includes(k)) vars[k] = fmtDateTime(String(v), timezone);
      else if (k === 'vehicleStatus') vars[k] = VEHICLE_STATUS_LABELS[v as VehicleStatus]?.[l] ?? String(v);
      else if (k === 'status') vars[k] = t(`receivables.kit.anyStatus.${v}`, { defaultValue: String(v) });
      else if (k === 'reason') vars[k] = t(`receivables.kit.assigneeReason.${v}`, { defaultValue: String(v) });
      else vars[k] = v;
    }
    // A missing placeholder value would leave "{{x}}" in the text; fall back to the generic one.
    const own = t(`${ns}.errors.${err.code}`, vars) || t(`receivables.errors.${err.code}`, vars);
    if (own && !own.includes('{{')) return own;
  }
  return errorMessage(err, t);
}

export function useDomainError(ns: ErrorNs) {
  const { t, i18n } = useTranslation();
  const { currency } = useAuth();
  const { timezone } = useTenantMoney();
  return useCallback((err: unknown) => domainErrorMessage(err, ns, t as TFn, i18n.language, currency, timezone), [ns, t, i18n.language, currency, timezone]);
}

/** A zod issue's machine code: our schemas use snake_case messages (`invalid_amount`); built-ins use the issue code. */
function issueCode(message: string | undefined, code: string): string {
  return message && /^[a-z_]+$/.test(message) ? message : code;
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

/** Translates a field validation code (client check or server issue). */
export function useFieldMessage(ns: ErrorNs) {
  const { t } = useTranslation();
  return useCallback(
    (code: string | undefined | null): string | null => {
      if (!code) return null;
      return (
        t(`receivables.validation.${code}`, { defaultValue: '' }) ||
        t(`${ns}.errors.${code}`, { defaultValue: '' }) ||
        t(`receivables.errors.${code}`, { defaultValue: '' }) ||
        t(`errors.${code}`, { defaultValue: '' }) ||
        t('receivables.validation.invalid')
      );
    },
    [t, ns],
  );
}

export const isVersionConflict = (e: unknown) => e instanceof ApiError && e.code === 'version_conflict';

// ── Mutations ────────────────────────────────────────────────────────────────────────────

interface MutationOpts<TVars, TRes> {
  ns: ErrorNs;
  path: string | ((vars: TVars) => string);
  method?: 'POST' | 'PATCH';
  invalidate: unknown[][];
  success?: string | ((res: TRes) => string | null) | null;
  onSuccess?: (res: TRes, vars: TVars) => void;
  /** Send an Idempotency-Key (routes the API marks @Idempotent). One key per user action. */
  idempotent?: boolean;
  /** Show the error as a toast (default true); dialogs that render the error inline pass false. */
  toastError?: boolean;
  body?: (vars: TVars) => unknown;
}

/**
 * Same contract as useApiMutation (@/lib/hooks): toasts, cache invalidation, Idempotency-Key per
 * user action. Errors are translated with the feature's domain codes.
 */
export function useDomainMutation<TVars = unknown, TRes = unknown>(opts: MutationOpts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  const describe = useDomainError(opts.ns);
  return useMutation<TRes, unknown, TVars & { __idemKey?: string }>({
    mutationFn: (vars) => {
      const { __idemKey, ...rest } = vars as TVars & { __idemKey?: string };
      const path = typeof opts.path === 'function' ? opts.path(rest as TVars) : opts.path;
      const body = opts.body ? opts.body(rest as TVars) : rest;
      return api<TRes>(path, { method: opts.method ?? 'POST', body, idempotencyKey: opts.idempotent ? __idemKey : undefined });
    },
    onSuccess: async (res, vars) => {
      await Promise.all(opts.invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg = typeof opts.success === 'function' ? opts.success(res) : opts.success === undefined ? t('common.savedSuccessfully') : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars as TVars);
    },
    onError: (err) => {
      if (opts.toastError !== false) toast.error(describe(err));
    },
  });
}

/** Every query that shows customer money (receipts, refunds, reservation deposits, cash balances). */
export const MONEY_KEYS: unknown[][] = [['receipts'], ['receipt'], ['refunds'], ['reservations'], ['reservation'], ['cash-accounts'], ['customer'], ['vehicle'], ['approvals']];

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

export function vehicleLabel(
  v: { modelYear: number | null; makeEn: string | null; makeAr: string | null; modelEn: string | null; modelAr: string | null },
  lang: string,
): string {
  return [lang === 'en' ? v.makeEn : v.makeAr, lang === 'en' ? v.modelEn : v.modelAr, v.modelYear].filter(Boolean).join(' ');
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
      <option value="">{t('receivables.kit.chooseAccount')}</option>
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {a.currency} ({t(`receivables.kit.accountType.${a.type}`)})
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
          {t(`receivables.kit.methods.${m}`)}
        </option>
      ))}
    </Select>
  );
}

/**
 * Account + amount + (rate) + method + reference + date for money received from a customer.
 * The amount is in the account's currency; foreign accounts need a rate and show the base value.
 */
export interface MoneyInValue {
  account: CashAccountOption | null;
  amount: string;
  rate: string;
  method: PaymentMethod;
  reference: string;
  date: string;
}

export function emptyMoneyIn(today: string, amount = ''): MoneyInValue {
  return { account: null, amount, rate: '', method: 'cash', reference: '', date: today };
}

export function useMoneyIn(v: MoneyInValue) {
  const { base, rounding } = useTenantMoney();
  const currency = v.account?.currency ?? base;
  const foreign = currency !== base;
  const amountBase = toBase(v.amount, currency, foreign ? v.rate : '1', base, rounding);
  const errors = {
    account: !v.account ? 'required' : null,
    amount: !isPositiveMoney(v.amount) ? (v.amount.trim() ? 'must_be_positive' : 'required') : null,
    rate: foreign && !isRate(v.rate) ? 'invalid_rate' : null,
  };
  const valid = !errors.account && !errors.amount && !errors.rate && amountBase !== null && d(amountBase).gt(0);
  return { currency, foreign, amountBase, errors, valid };
}

/** Payload fields for zDepositInput / zReceiptCreate from a MoneyInValue. */
export function moneyInPayload(v: MoneyInValue, foreign: boolean) {
  return {
    cashAccountId: v.account!.id,
    amount: v.amount.trim(),
    ...(foreign ? { exchangeRate: v.rate.trim() } : {}),
    method: v.method,
    reference: v.reference.trim() || null,
    receivedAt: v.date,
  };
}

export function MoneyInFields({
  value,
  onChange,
  touched,
  amountError,
  className,
}: {
  value: MoneyInValue;
  onChange: (v: MoneyInValue) => void;
  touched: boolean;
  /** Extra amount validation from the caller (e.g. exceeds outstanding). */
  amountError?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const { base, today } = useTenantMoney();
  const accounts = useCashAccountOptions();
  const fm = useFieldMessage('receivables');
  const { currency, foreign, amountBase, errors } = useMoneyIn(value);
  const set = (patch: Partial<MoneyInValue>) => onChange({ ...value, ...patch });

  // A single base-currency account is the common case: preselect it.
  useEffect(() => {
    if (!value.account && accounts.data) {
      const baseAccounts = accounts.data.filter((a) => a.currency === base);
      if (baseAccounts.length === 1) onChange({ ...value, account: baseAccounts[0]! });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.data]);

  const amountErr = errors.amount ?? amountError ?? null;
  return (
    <div className={clsx('grid gap-4 sm:grid-cols-2', className)}>
      <Field label={t('receivables.kit.account')} required error={touched ? fm(errors.account) : null} className="sm:col-span-2">
        {(id, desc) => (
          <CashAccountSelect id={id} describedBy={desc} value={value.account?.id ?? ''} accounts={accounts.data} invalid={touched && !!errors.account} onChange={(a) => set({ account: a })} />
        )}
      </Field>
      {accounts.data && accounts.data.length === 0 && (
        <Alert tone="warning" className="sm:col-span-2">
          {t('receivables.kit.noAccounts')}
        </Alert>
      )}
      <Field
        label={t('receivables.kit.amount')}
        required
        error={touched ? fm(amountErr) : null}
        hint={foreign ? t('receivables.kit.amountInAccountCurrency', { currency }) : undefined}
      >
        {(id, desc) => (
          <AmountInput id={id} aria-describedby={desc} currency={currency} value={value.amount} invalid={touched && !!amountErr} onChange={(e) => set({ amount: e.target.value })} />
        )}
      </Field>
      {foreign && (
        <Field label={t('receivables.kit.rate', { from: currency, to: base })} required error={touched ? fm(errors.rate) : null}>
          {(id, desc) => (
            <Input id={id} aria-describedby={desc} dir="ltr" inputMode="decimal" className="num" value={value.rate} invalid={touched && !!errors.rate} onChange={(e) => set({ rate: e.target.value })} />
          )}
        </Field>
      )}
      {foreign && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm sm:col-span-2">
          <span className="text-muted">{t('receivables.kit.baseEquivalent')}</span>
          <Money value={amountBase} currency={base} className="font-medium" />
        </div>
      )}
      <Field label={t('receivables.kit.method')}>{(id) => <MethodSelect id={id} value={value.method} onChange={(m) => set({ method: m })} />}</Field>
      <Field label={t('common.reference')}>{(id) => <Input id={id} value={value.reference} maxLength={80} onChange={(e) => set({ reference: e.target.value })} />}</Field>
      <Field label={t('receivables.kit.date')} hint={t('receivables.kit.dateHint')}>
        {(id, desc) => <Input id={id} aria-describedby={desc} type="date" value={value.date} max={today} onChange={(e) => set({ date: e.target.value })} />}
      </Field>
    </div>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────────────────

/** Reason dialog with an inline error area (ConfirmDialog cannot show server errors). */
export function ReasonModal({
  title,
  message,
  confirmLabel,
  minLength = 3,
  required = true,
  label,
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
  /** When false the text is optional (e.g. an approval note). */
  required?: boolean;
  label?: ReactNode;
  tone?: 'danger' | 'primary';
  loading?: boolean;
  error?: ReactNode;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const short = required && reason.trim().length < minLength;
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
        <Field label={label ?? t('common.reason')} required={required} hint={required ? t('receivables.validation.minChars', { n: minLength }) : t('common.optional')}>
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
    <Alert tone="warning" title={t('receivables.kit.staleTitle')}>
      <p>{t('receivables.kit.staleBody')}</p>
      <Button size="sm" variant="secondary" className="mt-2" onClick={onReload}>
        {t('receivables.kit.reload')}
      </Button>
    </Alert>
  );
}

// ── Searchable pickers ───────────────────────────────────────────────────────────────────

interface Option {
  id: string;
  title: string;
  hint?: string;
  aside?: ReactNode;
  disabled?: boolean;
}

/**
 * Searchable combobox over a paged API list (keyboard: ↑/↓, Enter, Escape). The list loads only
 * while the input is focused; the selected option's label comes from the parent.
 */
export function SearchCombobox<T>({
  id,
  describedBy,
  invalid,
  placeholder,
  selectedLabel,
  value,
  path,
  query,
  queryKey,
  toOption,
  onSelect,
  onClear,
  disabled,
}: {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  placeholder: string;
  selectedLabel: string;
  value: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  queryKey: string;
  toOption: (item: T) => Option;
  onSelect: (item: T) => void;
  onClear?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(text, 250);
  const results = useApi<Paged<T>>([queryKey, 'picker'], open ? path : null, { ...query, q: debounced.trim() || undefined, pageSize: 10 }, { placeholderData: (p) => p });
  const items = results.data?.items ?? [];
  const options = items.map(toOption);
  useEffect(() => setActive(0), [debounced]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onSelect(items[i]!);
    setOpen(false);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && options[active]) {
        e.preventDefault();
        choose(active);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setText('');
    }
  };

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={describedBy}
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        invalid={invalid}
        disabled={disabled}
        autoComplete="off"
        className="ps-9 pe-14"
        placeholder={placeholder}
        value={open ? text : selectedLabel}
        onFocus={() => {
          setOpen(true);
          setText('');
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setOpen(true);
          setText(e.target.value);
        }}
        onKeyDown={onKey}
      />
      <div className="absolute inset-y-0 end-2 flex items-center gap-1">
        {onClear && value && !open && !disabled && (
          <button type="button" className="rounded p-1 text-subtle hover:text-ink" aria-label={t('receivables.kit.clear')} onClick={onClear}>
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <ChevronDown className="pointer-events-none h-4 w-4 text-subtle" aria-hidden />
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="scrollbar-thin absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-pop"
        >
          {results.isLoading && <li className="px-3 py-2 text-sm text-muted">{t('common.loading')}</li>}
          {results.error ? <li className="px-3 py-2 text-sm text-danger">{t('receivables.kit.searchFailed')}</li> : null}
          {!results.isLoading && !results.error && options.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t('common.noResults')}</li>}
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.id === value}
              aria-disabled={o.disabled || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={clsx(
                'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm',
                i === active && 'bg-surface-2',
                o.id === value && 'font-semibold',
                o.disabled && 'cursor-not-allowed opacity-55',
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-ink">{o.title}</span>
                {o.hint && <span className="num block truncate text-xs text-muted">{o.hint}</span>}
              </span>
              {o.aside && <span className="shrink-0">{o.aside}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface CustomerOption {
  id: string;
  fullName: string;
  phone: string | null;
  city: string | null;
  isActive: boolean;
}

interface PickerProps<T> {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  value: string;
  selectedLabel: string;
  onSelect: (item: T) => void;
  onClear?: () => void;
  disabled?: boolean;
}

export function CustomerPicker(props: PickerProps<CustomerOption>) {
  const { t } = useTranslation();
  return (
    <SearchCombobox<CustomerOption>
      {...props}
      placeholder={t('receivables.kit.customerSearch')}
      path="/customers"
      queryKey="customers"
      toOption={(c) => ({ id: c.id, title: c.fullName, hint: [c.phone, c.city].filter(Boolean).join(' · ') || undefined, disabled: !c.isActive })}
    />
  );
}

export interface VehicleOption {
  id: string;
  stockNumber: string;
  vin: string | null;
  status: VehicleStatus;
  branchId: string;
  branchName: string;
  makeNameEn: string;
  makeNameAr: string;
  modelNameEn: string;
  modelNameAr: string;
  trim: string | null;
  modelYear: number;
  odometerValue: number;
  odometerUnit: 'km' | 'mi';
  askingPrice: string | null;
}

export function vehicleOptionTitle(v: Pick<VehicleOption, 'makeNameEn' | 'makeNameAr' | 'modelNameEn' | 'modelNameAr' | 'trim' | 'modelYear'>, lang: string): string {
  return [lang === 'en' ? v.makeNameEn : v.makeNameAr, lang === 'en' ? v.modelNameEn : v.modelNameAr, v.trim, v.modelYear].filter(Boolean).join(' ');
}

/** Stock vehicles, optionally limited to some statuses (comma list) and a branch. */
export function VehiclePicker({ status, branchId, ...props }: PickerProps<VehicleOption> & { status?: string; branchId?: string }) {
  const { t, i18n } = useTranslation();
  const { currency } = useAuth();
  const l = i18n.language === 'en' ? 'en' : 'ar';
  return (
    <SearchCombobox<VehicleOption>
      {...props}
      placeholder={t('receivables.kit.vehicleSearch')}
      path="/vehicles"
      query={{ status, branchId }}
      queryKey="vehicles"
      toOption={(v) => ({
        id: v.id,
        title: vehicleOptionTitle(v, i18n.language),
        hint: [v.stockNumber, v.branchName, v.askingPrice ? fmtMoney(v.askingPrice, currency) : null].filter(Boolean).join(' · '),
        aside: <span className="text-xs text-muted">{VEHICLE_STATUS_LABELS[v.status]?.[l] ?? v.status}</span>,
      })}
    />
  );
}

export interface LeadOption {
  id: string;
  number: string;
  status: string;
  branchId: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  vehicleId: string | null;
}

export function LeadPicker(props: PickerProps<LeadOption>) {
  const { t } = useTranslation();
  return (
    <SearchCombobox<LeadOption>
      {...props}
      placeholder={t('receivables.kit.leadSearch')}
      path="/leads"
      query={{ status: 'open' }}
      queryKey="leads"
      toOption={(l) => ({ id: l.id, title: `${l.number} · ${l.customerName}`, hint: l.customerPhone ?? undefined })}
    />
  );
}
