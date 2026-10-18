import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ComponentProps, forwardRef, ReactNode, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { convert, CurrencyCode, d, isValidMoney, money, RATE_REGEX, RoundingMode } from '@autohub/shared';
import { errorMessage } from '@/components/ui/Feedback';
import { Input, MoneyInput } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useBranches } from '@/pages/settings/BranchesPage';

/**
 * Small helpers shared by the cash, expenses and accounting features (all three are owned by the
 * finance pages): error translation, an idempotent mutation hook, money inputs and FX previews.
 * Money stays a decimal string everywhere; arithmetic uses @autohub/shared (never JS numbers).
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Detail values the API attaches to finance errors, usable as {{placeholders}} in messages. */
const DETAIL_KEYS = ['available', 'required', 'date', 'balance', 'expected', 'amountTo', 'paid', 'status'];
const NAMESPACES = ['cash', 'expenses', 'accounting'];

/** Translates an API error: the finance namespaces first, then the global errors.* table, then the server's message. */
export function finErrorMessage(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const vars: Record<string, unknown> = { defaultValue: '' };
    for (const k of DETAIL_KEYS) {
      const v = err.details?.[k];
      if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
    }
    for (const ns of NAMESPACES) {
      const own = t(`${ns}.errors.${err.code}`, vars);
      if (own) return own;
    }
  }
  return errorMessage(err, t);
}

export function useFinError() {
  const { t } = useTranslation();
  return useCallback((err: unknown) => finErrorMessage(err, t as T), [t]);
}

export type FieldErrors = Record<string, string>;

/** Field errors from a zod safeParse (client) — keyed by dotted path, value = message code. */
export function issuesToErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const key = i.path.map(String).join('.');
    if (key && !out[key]) out[key] = i.message;
  }
  return out;
}

/** Moves focus (and scroll) to the first invalid field of the open dialog after a render. */
export function focusFirstInvalid(): void {
  setTimeout(() => {
    const el = document.querySelector<HTMLElement>('dialog[open] [aria-invalid="true"]');
    el?.focus();
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 0);
}

/** Field errors the API returned with `validation_failed` (details.issues[{path, message}]). */
export function serverFieldErrors(err: unknown): FieldErrors {
  if (!(err instanceof ApiError) || err.code !== 'validation_failed') return {};
  const issues =
    (err.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues ?? [];
  const out: FieldErrors = {};
  for (const i of issues) if (i.path && !out[i.path]) out[i.path] = i.message;
  return out;
}

const KNOWN_CODES = new Set([
  'invalid_amount',
  'must_be_positive',
  'must_be_non_negative',
  'invalid_rate',
  'invalid_date',
  'to_before_from',
]);

/** Translates a validation message code (zod message or server issue) into readable text. */
export function useValidationText() {
  const { t } = useTranslation();
  return useCallback(
    (code: string | undefined | null): string | null => {
      if (!code) return null;
      if (KNOWN_CODES.has(code)) return t(`cash.validation.${code}`);
      if (code === 'required') return t('cash.validation.required');
      if (/expected string|received undefined|Invalid input|expected nonoptional/i.test(code))
        return t('cash.validation.required');
      if (/too small|>=/i.test(code)) return t('cash.validation.tooShort');
      if (/too big|<=/i.test(code)) return t('cash.validation.tooLong');
      if (/uuid/i.test(code)) return t('cash.validation.required');
      return t('cash.validation.invalid');
    },
    [t],
  );
}

interface FinMutationOpts<TVars, TRes> {
  path: string | ((vars: TVars) => string);
  method?: 'POST' | 'PATCH';
  invalidate?: unknown[][];
  success?: string | ((res: TRes) => string | null) | null;
  onSuccess?: (res: TRes, vars: TVars) => void;
  /** Send an Idempotency-Key: one key per user action, reused on retry and renewed after success. */
  idempotent?: boolean;
  body?: (vars: TVars) => unknown;
  /** Show failures as a toast (default). Forms that render the error inline pass false. */
  toastError?: boolean;
}

/**
 * Same contract as useApiMutation (@/lib/hooks) but translates finance error codes and manages the
 * Idempotency-Key itself: a failed request is rolled back on the server together with its key, so
 * retrying with the same key is safe; a successful one renews the key for the next action.
 */
export function useFinMutation<TVars = unknown, TRes = unknown>(opts: FinMutationOpts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  const key = useRef<string>(newIdempotencyKey());
  return useMutation<TRes, unknown, TVars>({
    mutationFn: (vars) => {
      const path = typeof opts.path === 'function' ? opts.path(vars) : opts.path;
      return api<TRes>(path, {
        method: opts.method ?? 'POST',
        body: opts.body ? opts.body(vars) : vars,
        idempotencyKey: opts.idempotent ? key.current : undefined,
      });
    },
    onSuccess: async (res, vars) => {
      key.current = newIdempotencyKey();
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg =
        typeof opts.success === 'function'
          ? opts.success(res)
          : opts.success === undefined
            ? t('common.savedSuccessfully')
            : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars);
    },
    onError: (err) => {
      if (opts.toastError !== false) toast.error(finErrorMessage(err, t as T));
    },
  });
}

/** Query keys of everything a money movement can change (balances, cash books, ledger reports). */
export const MONEY_KEYS: unknown[][] = [
  ['cash-accounts'],
  ['cash-book'],
  ['cash-transfers'],
  ['cash-transfer'],
  ['ledger'],
  ['expenses'],
  ['expenses-summary'],
  ['expense'],
  ['approvals'],
  ['approvals-summary'],
];

// ── Money ────────────────────────────────────────────────────────────────────────────────

export function useTenantMoney() {
  const { me, currency } = useAuth();
  const rounding: RoundingMode = me?.tenant?.settings.rounding ?? 'half_up';
  const timezone = me?.tenant?.settings.timezone;
  return { base: currency, rounding, timezone };
}

export const isRate = (v: string | null | undefined): v is string =>
  !!v && RATE_REGEX.test(v.trim()) && d(v.trim()).gt(0);
export const isMoney = (v: string | null | undefined): v is string => !!v && isValidMoney(v.trim());
export const isPositiveMoney = (v: string | null | undefined): v is string => isMoney(v) && d(v.trim()).gt(0);

/** Base-currency value exactly as the API computes it (convert with the tenant rounding mode). */
export function toBase(
  amount: string | null | undefined,
  currency: string,
  rate: string | null | undefined,
  base: CurrencyCode,
  mode: RoundingMode,
): string | null {
  if (!isMoney(amount)) return null;
  if (currency === base) return money(amount.trim(), base, mode);
  if (!isRate(rate)) return null;
  return convert(amount.trim(), rate.trim(), base, mode);
}

/** A money figure: Latin digits, isolated direction, optional tone for negatives. */
export function Money({
  value,
  currency,
  className,
  signed,
  toneNegative,
}: {
  value: string | null | undefined;
  currency: string;
  className?: string;
  signed?: boolean;
  toneNegative?: boolean;
}) {
  const negative = !!value && toneNegative && d(value).isNegative();
  return (
    <span className={clsx('num whitespace-nowrap', negative && 'text-danger', className)}>
      {fmtMoney(value, currency, { sign: signed })}
    </span>
  );
}

/**
 * MoneyInput whose currency tag never covers the digits in Arabic: the kit's input is dir="ltr" but
 * places the tag at the page's inline end (the left in RTL), so the padding must follow it there.
 */
export const AmountInput = forwardRef<HTMLInputElement, ComponentProps<typeof MoneyInput>>(
  function AmountInput({ className, ...rest }, ref) {
    return (
      <MoneyInput ref={ref} className={clsx(rest.currency && 'rtl:ps-14 rtl:pe-3', className)} {...rest} />
    );
  },
);

/** Exchange-rate entry (base units per one foreign unit), LTR digits. */
export const RateInput = forwardRef<HTMLInputElement, ComponentProps<typeof Input>>(function RateInput(
  { className, ...rest },
  ref,
) {
  return (
    <Input
      ref={ref}
      inputMode="decimal"
      autoComplete="off"
      dir="ltr"
      placeholder="0.00000000"
      className={clsx('num text-start', className)}
      {...rest}
    />
  );
});

export function DateRange({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (v: { from?: string; to?: string }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="date"
        className="w-auto min-w-[140px] flex-1 sm:flex-none"
        value={from}
        max={to || undefined}
        onChange={(e) => onChange({ from: e.target.value })}
        aria-label={t('common.from')}
      />
      <span className="text-xs text-muted">{t('common.to')}</span>
      <Input
        type="date"
        className="w-auto min-w-[140px] flex-1 sm:flex-none"
        value={to}
        min={from || undefined}
        onChange={(e) => onChange({ to: e.target.value })}
        aria-label={t('common.to')}
      />
    </div>
  );
}

/** Label/value pair used in summary strips. */
export function Stat({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('min-w-0', className)}>
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-1 text-sm font-medium text-ink">{children}</div>
    </div>
  );
}

/** Wraps user text (e.g. an Arabic account name) in a bidi isolate so it never reorders the sentence around it. */
export const iso = (s: string | null | undefined): string => `\u2068${s ?? ''}\u2069`;

/**
 * Descriptions the API generates for journal entries and cash-book rows are English templates
 * ("Transfer A → B", "Reversal: …", "Supplier payment SPY-…"). Known templates are re-worded in the
 * current language with the same values; anything else (user text) is shown as stored.
 */
const DESC_PATTERNS: Array<[RegExp, string, string[]]> = [
  [/^Transfer (.+) → (.+?): (.+)$/s, 'transferNotes', ['from', 'to', 'notes']],
  [/^Transfer (.+) → (.+)$/s, 'transfer', ['from', 'to']],
  [/^Reversal: (.+)$/s, 'reversal', ['reason']],
  [/^Reversal (\S+): (.+)$/s, 'reversalOf', ['number', 'reason']],
  [/^Opening balance — (.+)$/s, 'opening', ['name']],
  [/^Supplier payment (\S+)$/, 'supplierPayment', ['number']],
  [/^Purchase (\S+) cancelled: (.+)$/s, 'purchaseCancelled', ['number', 'reason']],
  [/^Purchase (\S+)$/, 'purchase', ['number']],
  [/^Cost of sale (\S+)$/, 'costOfSale', ['number']],
  [/^Sale (\S+)$/, 'sale', ['number']],
  [/^Receipt (\S+) — (.+)$/s, 'receipt', ['number', 'name']],
  [/^Refund (\S+)$/, 'refund', ['number']],
  [/^Commission clawback (\S+)$/, 'commissionClawback', ['number']],
  [/^Commission (\S+)$/, 'commission', ['number']],
  [/^Trade-in on sale (\S+)$/, 'tradeIn', ['number']],
  [/^Forfeited deposit — reservation (\S+)$/, 'forfeitedDeposit', ['number']],
  [/^Cash over at closing (\d{4}-\d{2}-\d{2})$/, 'cashOver', ['date']],
  [/^Cash short at closing (\d{4}-\d{2}-\d{2})$/, 'cashShort', ['date']],
  [/^Write-off (\S+): (.+)$/s, 'writeOff', ['number', 'reason']],
  [/^Installments of (\S+) unwound$/, 'installmentsUnwound', ['number']],
  [/^Interest waived on early settlement of (\S+)$/, 'interestWaived', ['number']],
  [/^(\S+): payment voided after the sale was closed$/, 'paymentVoidedClosed', ['number']],
  [/^(\S+): payment voided, receivable re-opened$/, 'paymentVoidedReopened', ['number']],
  [/^(\S+): payments applied to the receivable$/, 'paymentsApplied', ['number']],
  [/^(\S+): payments returned to customer credit$/, 'paymentsToCredit', ['number']],
  [/^(\S+): write-off of reversed cost undone$/, 'writeOffUndone', ['number']],
];

export function useLedgerText() {
  const { t, i18n } = useTranslation();
  return useCallback(
    (text: string | null | undefined): string => {
      if (!text) return '';
      if (i18n.language === 'en') return text;
      const reword = (s: string): string | null => {
        for (const [re, key, names] of DESC_PATTERNS) {
          const m = re.exec(s);
          if (!m) continue;
          const vars: Record<string, string> = {};
          names.forEach((n, i) => (vars[n] = n === 'date' ? fmtDate(m[i + 1]!) : iso(m[i + 1]!)));
          return t(`accounting.desc.${key}`, vars);
        }
        return null;
      };
      const whole = reword(text);
      if (whole) return whole;
      // "<document number>: <template>" (e.g. a vehicle cost "STK-…: Purchase PO-…").
      const prefixed = /^([A-Z]{2,5}-\d{4}-\d+): (.+)$/s.exec(text);
      const rest = prefixed ? reword(prefixed[2]!) : null;
      return rest ? `${prefixed![1]}: ${rest}` : text;
    },
    [t, i18n.language],
  );
}

/** Ledger account name in the current language. */
export function accountName(a: { nameAr: string; nameEn: string }, lang: string): string {
  return lang === 'en' ? a.nameEn : a.nameAr;
}

/** Branches the signed-in user may work in (all for company-wide users), active first. */
export function useAccessibleBranches() {
  const { me } = useAuth();
  const q = useBranches();
  const all = q.data ?? [];
  const list = me?.allBranches ? all : all.filter((b) => me?.branchIds.includes(b.id));
  return { ...q, branches: list, all };
}
