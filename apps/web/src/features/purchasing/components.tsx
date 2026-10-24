import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ChevronDown, Search, X } from 'lucide-react';
import { ComponentProps, forwardRef, KeyboardEvent, ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { FieldValues, Path, Resolver, useForm, UseFormSetError } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { z } from 'zod';
import {
  convert,
  CurrencyCode,
  d,
  isValidMoney,
  money,
  RATE_REGEX,
  RoundingMode,
  SUPPLIER_TYPES,
  zSupplierCreate,
  zSupplierUpdate,
} from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';
import {
  AcquisitionStatus,
  OwnershipTransferStatus,
  Paged,
  PayableTargetType,
  Supplier,
  SupplierDuplicate,
  SupplierPaymentStatus,
  useApAccess,
  useSupplier,
} from './api';
import { usePurchasingMutation } from './mutation';

// ── Status badges ────────────────────────────────────────────────────────────────────────

const ACQ_TONE: Record<AcquisitionStatus, Tone> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'success',
  cancelled: 'danger',
};

export function AcquisitionStatusBadge({ status }: { status: AcquisitionStatus }) {
  const { t } = useTranslation();
  return <Badge tone={ACQ_TONE[status] ?? 'neutral'}>{t(`purchasing.enums.acquisitionStatus.${status}`)}</Badge>;
}

const OWNERSHIP_TONE: Record<OwnershipTransferStatus, Tone> = { pending: 'neutral', in_progress: 'info', completed: 'success' };

export function OwnershipBadge({ status }: { status: OwnershipTransferStatus }) {
  const { t } = useTranslation();
  return <Badge tone={OWNERSHIP_TONE[status] ?? 'neutral'}>{t(`purchasing.enums.ownership.${status}`)}</Badge>;
}

export function PaymentStatusBadge({ status }: { status: SupplierPaymentStatus }) {
  const { t } = useTranslation();
  return <Badge tone={status === 'posted' ? 'success' : 'danger'}>{t(`purchasing.enums.paymentStatus.${status}`)}</Badge>;
}

export function Money({ value, currency, className }: { value: string | null | undefined; currency: string; className?: string }) {
  return <span className={clsx('num whitespace-nowrap', className)}>{fmtMoney(value, currency)}</span>;
}

export function acquisitionVehicleTitle(
  v: { makeEn: string; makeAr: string; modelEn: string; modelAr: string; modelYear: number },
  lang: string,
): string {
  return [lang === 'en' ? v.makeEn : v.makeAr, lang === 'en' ? v.modelEn : v.modelAr, v.modelYear].filter(Boolean).join(' ');
}

/**
 * MoneyInput whose currency tag never covers the digits in Arabic: the kit's input is dir="ltr" but
 * places the tag at the page's inline end (the left in RTL), so the padding must follow it there.
 */
export const AmountInput = forwardRef<HTMLInputElement, ComponentProps<typeof MoneyInput>>(function AmountInput({ className, ...rest }, ref) {
  return <MoneyInput ref={ref} className={clsx(rest.currency && 'rtl:ps-14 rtl:pe-3', className)} {...rest} />;
});

// ── Money / FX helpers (decimal arithmetic only — never floats) ─────────────────────────

export function useTenantMoney() {
  const { me, currency } = useAuth();
  const rounding: RoundingMode = me?.tenant?.settings.rounding ?? 'half_up';
  const timezone = me?.tenant?.settings.timezone;
  return { base: currency, rounding, timezone };
}

export const isRate = (v: string | null | undefined): v is string => !!v && RATE_REGEX.test(v.trim()) && d(v.trim()).gt(0);
export const isMoney = (v: string | null | undefined): v is string => !!v && isValidMoney(v.trim());
export const isPositiveMoney = (v: string | null | undefined): v is string => isMoney(v) && d(v.trim()).gt(0);

/** Base-currency equivalent exactly as the API computes it (convert with the tenant rounding mode). */
export function toBase(amount: string | null | undefined, currency: string, rate: string | null | undefined, base: CurrencyCode, mode: RoundingMode): string | null {
  if (!isMoney(amount)) return null;
  if (currency === base) return money(amount.trim(), base, mode);
  if (!isRate(rate)) return null;
  return convert(amount.trim(), rate.trim(), base, mode);
}

// ── Form helpers ─────────────────────────────────────────────────────────────────────────

const KNOWN_VALIDATION = new Set([
  'required',
  'invalid_amount',
  'must_be_positive',
  'must_be_non_negative',
  'invalid_rate',
  'invalid_date',
  'invalid_phone',
  'invalid_national_id',
  'invalid_email',
  'to_before_from',
  'exchange_rate_required',
  'empty_update',
]);

/** Turns a react-hook-form / zod error into a translated message. */
export function useFieldError() {
  const { t } = useTranslation();
  return useCallback(
    (e?: { type?: string | number; message?: string }): string | null => {
      if (!e) return null;
      const msg = e.message ?? '';
      // Domain error codes the API attached to a field (e.g. vin_in_stock) use the global errors.* table.
      if (e.type === 'server') {
        return t(`purchasing.errors.${msg}`, { defaultValue: t(`errors.${msg}`, { defaultValue: t('purchasing.validation.invalid') }) });
      }
      if (KNOWN_VALIDATION.has(msg)) return t(`purchasing.validation.${msg}`);
      switch (e.type) {
        case 'required':
        case 'invalid_type':
          return t('purchasing.validation.required');
        case 'too_small':
          return t('purchasing.validation.too_small');
        case 'too_big':
          return t('purchasing.validation.too_big');
        default:
          return t('purchasing.validation.invalid');
      }
    },
    [t],
  );
}

/** Maps API `validation_failed` issues ({path, message, code}) onto form fields. */
export function applyServerErrors<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>, prefix = ''): void {
  if (!(err instanceof ApiError) || err.code !== 'validation_failed') return;
  const issues = (err.details as { issues?: Array<{ path: string; message: string; code: string }> } | undefined)?.issues ?? [];
  for (const i of issues) {
    if (i.path) setError(`${prefix}${i.path}` as Path<T>, { type: i.code, message: i.message });
  }
}

/** Empty inputs become `undefined` so optional zod fields stay absent instead of failing. */
export const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
export const emptyToNull = (v: unknown) => (v === '' ? null : v);

/** One Idempotency-Key per user action: created when the form/dialog mounts, reused on retry. */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(() => newIdempotencyKey());
  const renew = useCallback(() => setKey(newIdempotencyKey()), []);
  return [key, renew];
}

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
        className="w-auto min-w-[150px]"
        value={from}
        max={to || undefined}
        onChange={(e) => onChange({ from: e.target.value })}
        aria-label={t('common.from')}
      />
      <span className="text-xs text-muted">{t('common.to')}</span>
      <Input
        type="date"
        className="w-auto min-w-[150px]"
        value={to}
        min={from || undefined}
        onChange={(e) => onChange({ to: e.target.value })}
        aria-label={t('common.to')}
      />
    </div>
  );
}

export function Stat({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('min-w-0', className)}>
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-1 text-sm font-medium text-ink">{children}</div>
    </div>
  );
}

// ── Supplier picker (searchable combobox) ───────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function SupplierPicker({
  value,
  onChange,
  allowNone,
  clearable,
  invalid,
  id,
  describedBy,
  className,
  activeOnly = true,
}: {
  /** '' (nothing), 'none' (direct purchases) or a supplier id. */
  value: string;
  onChange: (value: string, supplier?: { id: string; name: string }) => void;
  allowNone?: boolean;
  clearable?: boolean;
  invalid?: boolean;
  id?: string;
  describedBy?: string;
  className?: string;
  activeOnly?: boolean;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [known, setKnown] = useState<{ id: string; name: string } | null>(null);
  const debounced = useDebounced(query, 250);
  const results = useApi<Paged<Supplier>>(
    ['suppliers', 'picker'],
    open ? '/suppliers' : null,
    { q: debounced.trim() || undefined, active: activeOnly ? 'true' : undefined, pageSize: 10 },
    { placeholderData: (p) => p },
  );
  const needsLookup = UUID_RE.test(value) && known?.id !== value;
  const lookup = useSupplier(needsLookup ? value : null);
  const selectedName =
    value === 'none' ? t('purchasing.payments.directPurchases') : known?.id === value ? known.name : (lookup.data?.name ?? '');

  const options: Array<{ id: string; name: string; hint?: string }> = [
    ...(allowNone ? [{ id: 'none', name: t('purchasing.payments.directPurchases'), hint: t('purchasing.payments.directPurchasesHint') }] : []),
    ...(results.data?.items ?? []).map((s) => ({ id: s.id, name: s.name, hint: [t(`purchasing.enums.supplierType.${s.type}`), s.phone].filter(Boolean).join(' · ') })),
  ];

  useEffect(() => setActive(0), [debounced]);

  const choose = (o: { id: string; name: string }) => {
    if (o.id !== 'none') setKnown({ id: o.id, name: o.name });
    onChange(o.id, o.id === 'none' ? undefined : o);
    setOpen(false);
    setQuery('');
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
        choose(options[active]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className={clsx('relative', className)}>
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
        autoComplete="off"
        className="ps-9 pe-14"
        placeholder={t('purchasing.suppliers.searchPlaceholder')}
        value={open ? query : selectedName}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
        }}
        onKeyDown={onKey}
      />
      <div className="absolute inset-y-0 end-2 flex items-center gap-1">
        {clearable && value && !open && (
          <button
            type="button"
            className="rounded p-1 text-subtle hover:text-ink"
            aria-label={t('common.clearFilters')}
            onClick={() => {
              setKnown(null);
              onChange('');
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <ChevronDown className="pointer-events-none h-4 w-4 text-subtle" aria-hidden />
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="scrollbar-thin absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-pop"
        >
          {results.isLoading && <li className="px-3 py-2 text-sm text-muted">{t('common.loading')}</li>}
          {results.error ? <li className="px-3 py-2 text-sm text-danger">{t('purchasing.suppliers.searchFailed')}</li> : null}
          {!results.isLoading && !results.error && options.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted">{t('common.noResults')}</li>
          )}
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.id === value}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
              className={clsx(
                'cursor-pointer px-3 py-2 text-sm',
                i === active ? 'bg-surface-2' : '',
                o.id === value && 'font-semibold',
              )}
            >
              <span className="block truncate text-ink">{o.name}</span>
              {o.hint && <span className="block truncate text-xs text-muted">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Supplier create / edit modal with duplicate warning ─────────────────────────────────

type SupplierFormValues = z.input<typeof zSupplierCreate>;

const MATCH_KEYS = { phone: 'phone', taxNumber: 'taxNumber', nationalId: 'nationalId', name: 'name' } as const;

function DuplicateWarning({
  values,
  excludeId,
  onUseExisting,
}: {
  values: { name?: string | null; phone?: string | null; taxNumber?: string | null; nationalId?: string | null };
  excludeId?: string;
  onUseExisting?: (d: SupplierDuplicate) => void;
}) {
  const { t, i18n } = useTranslation();
  const name = (values.name ?? '').trim();
  const phone = (values.phone ?? '').trim();
  const taxNumber = (values.taxNumber ?? '').trim();
  const nationalId = (values.nationalId ?? '').trim();
  // Debounce a string key (a fresh object every render would never settle).
  const key = JSON.stringify({
    name: name.length >= 2 ? name : undefined,
    phone: (phone.match(/\p{Nd}/gu)?.length ?? 0) >= 6 ? phone : undefined,
    taxNumber: taxNumber.length >= 3 ? taxNumber : undefined,
    nationalId: nationalId.length >= 3 ? nationalId : undefined,
  });
  const debounced = useDebounced(key, 450);
  const q = useMemo(
    () => JSON.parse(debounced) as { name?: string; phone?: string; taxNumber?: string; nationalId?: string },
    [debounced],
  );
  const any = !!(q.name || q.phone || q.taxNumber || q.nationalId);
  // POST: a national ID never goes into a URL (D-047).
  const dups = useQuery({
    queryKey: ['suppliers', 'duplicates', debounced, excludeId ?? null],
    queryFn: () => api<SupplierDuplicate[]>('/suppliers/check-duplicates', { method: 'POST', body: { ...q, excludeId } }),
    enabled: any,
    staleTime: 30_000,
  });
  if (!any || !dups.data?.length) return null;
  return (
    <Alert tone="warning" title={t('purchasing.suppliers.duplicatesTitle')} className="sm:col-span-2">
      <p>{t('purchasing.suppliers.duplicatesHint')}</p>
      <ul className="mt-2 space-y-1.5">
        {dups.data.map((dup) => (
          <li key={dup.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to={`/app/purchasing/suppliers/${dup.id}`} target="_blank" className="font-medium text-ink underline-offset-2 hover:underline">
              {dup.name}
            </Link>
            {!dup.isActive && <Badge tone="neutral">{t('common.inactive')}</Badge>}
            <span className="text-xs">
              {t('purchasing.suppliers.matchedOn')}: {dup.matchedOn.map((m) => t(`purchasing.suppliers.fields.${MATCH_KEYS[m]}`)).join(i18n.language === 'en' ? ', ' : '، ')}
            </span>
            {onUseExisting && dup.isActive && (
              <Button size="sm" variant="ghost" onClick={() => onUseExisting(dup)}>
                {t('purchasing.suppliers.useExisting')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

export function SupplierFormModal({
  supplier,
  onClose,
  onSaved,
  onUseExisting,
}: {
  /** Edit this supplier; omit to create. */
  supplier?: Supplier | null;
  onClose: () => void;
  onSaved?: (s: Supplier) => void;
  onUseExisting?: (d: SupplierDuplicate) => void;
}) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const isEdit = !!supplier;
  const resolver = useMemo(
    () => (isEdit ? zodResolver(zSupplierUpdate) : zodResolver(zSupplierCreate)) as unknown as Resolver<SupplierFormValues>,
    [isEdit],
  );
  const form = useForm<SupplierFormValues>({
    resolver,
    defaultValues: {
      type: supplier?.type ?? 'individual',
      name: supplier?.name ?? '',
      phone: supplier?.phone ?? '',
      email: supplier?.email ?? '',
      taxNumber: supplier?.taxNumber ?? '',
      // Never pre-filled: the stored ID is not sent to the browser. Empty on edit keeps it.
      nationalId: '',
      address: supplier?.address ?? '',
      city: supplier?.city ?? '',
      notes: supplier?.notes ?? '',
      isActive: supplier?.isActive ?? true,
    },
  });
  const errors = form.formState.errors;
  const save = usePurchasingMutation<SupplierFormValues, Supplier>({
    path: isEdit ? `/suppliers/${supplier!.id}` : '/suppliers',
    method: isEdit ? 'PATCH' : 'POST',
    invalidate: [['suppliers'], ['supplier', supplier?.id]],
    success: isEdit ? t('purchasing.suppliers.updated') : t('purchasing.suppliers.created'),
    onSuccess: (s) => {
      onSaved?.(s);
      onClose();
    },
  });
  const submit = form.handleSubmit((values) => {
    const body = { ...values };
    // Like the customer form: an empty national ID on edit leaves the stored one unchanged.
    if (isEdit && !body.nationalId) delete body.nationalId;
    save.mutate(body, { onError: (e) => applyServerErrors(e, form.setError) });
  });
  const watched = form.watch(['name', 'phone', 'taxNumber', 'nationalId']);

  const text = (
    name: 'name' | 'phone' | 'email' | 'taxNumber' | 'nationalId' | 'city',
    opts: { required?: boolean; dir?: 'ltr'; type?: string; hint?: string; autoComplete?: string } = {},
  ) => (
    <Field label={t(`purchasing.suppliers.fields.${name}`)} required={opts.required} hint={opts.hint} error={fieldError(errors[name])}>
      {(fid, desc) => (
        <Input id={fid} aria-describedby={desc} dir={opts.dir} type={opts.type} autoComplete={opts.autoComplete} invalid={!!errors[name]} {...form.register(name)} />
      )}
    </Field>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isEdit ? t('purchasing.suppliers.edit') : t('purchasing.suppliers.add')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="supplier-form" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="supplier-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label={t('purchasing.suppliers.fields.type')} required error={fieldError(errors.type)}>
          {(fid) => (
            <Select id={fid} {...form.register('type')}>
              {SUPPLIER_TYPES.map((s) => (
                <option key={s} value={s}>
                  {t(`purchasing.enums.supplierType.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {text('name', { required: true })}
        {text('phone', { dir: 'ltr', type: 'tel' })}
        {text('email', { dir: 'ltr', type: 'email' })}
        {text('taxNumber', { dir: 'ltr' })}
        {text('nationalId', {
          dir: 'ltr',
          autoComplete: 'off',
          hint:
            isEdit && supplier?.nationalIdMasked
              ? // Isolated left-to-right (LRI … PDI) so "••••1234" keeps its order inside Arabic text.
                t('purchasing.suppliers.hints.nationalIdKeep', { masked: `\u2066${supplier.nationalIdMasked}\u2069` })
              : t('purchasing.suppliers.hints.nationalId'),
        })}
        {text('city')}
        <Field label={t('purchasing.suppliers.fields.address')} error={fieldError(errors.address)}>
          {(fid) => <Input id={fid} {...form.register('address')} />}
        </Field>
        <Field label={t('common.notes')} className="sm:col-span-2" error={fieldError(errors.notes)}>
          {(fid) => <Textarea id={fid} rows={2} {...form.register('notes')} />}
        </Field>
        {isEdit && (
          <Checkbox
            className="sm:col-span-2"
            label={t('purchasing.suppliers.fields.isActive')}
            description={t('purchasing.suppliers.inactiveHint')}
            {...form.register('isActive')}
          />
        )}
        <DuplicateWarning
          values={{ name: watched[0], phone: watched[1], taxNumber: watched[2], nationalId: watched[3] }}
          excludeId={supplier?.id}
          onUseExisting={
            onUseExisting
              ? (dup) => {
                  onUseExisting(dup);
                  onClose();
                }
              : undefined
          }
        />
      </form>
    </Modal>
  );
}

export function NoPermissionNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

// ── Accounts-payable gate (AND of permissions, which <Guard anyOf> cannot express) ───────

/**
 * `read`: suppliers.read + payments.read (AP history, aging, statements).
 * `open`: that, or supplier_payments.create (open documents for paying).
 */
export function ApGate({ need, children }: { need: 'read' | 'open'; children: ReactNode }) {
  const { t } = useTranslation();
  const ap = useApAccess();
  const ok = need === 'read' ? ap.read : ap.open;
  if (!ok) return <EmptyState title={t('errors.forbidden')} description={t(need === 'read' ? 'purchasing.ap.needsRead' : 'purchasing.ap.needsOpen')} />;
  return <>{children}</>;
}

// ── Payable documents ────────────────────────────────────────────────────────────────────

const TARGET_TONE: Record<PayableTargetType, Tone> = { acquisition: 'brand', vehicle_cost: 'info', expense: 'accent' };

export function TargetTypeBadge({ type }: { type: PayableTargetType }) {
  const { t } = useTranslation();
  return (
    <Badge tone={TARGET_TONE[type]} dot={false}>
      {t(`purchasing.enums.targetType.${type}`)}
    </Badge>
  );
}

/** In-app link of a payable document, when the document has a page of its own here. */
export function documentHref(type: PayableTargetType, id: string, vehicleId?: string | null): string | null {
  if (type === 'acquisition') return `/app/purchasing/acquisitions/${id}`;
  if (type === 'vehicle_cost' && vehicleId) return `/app/vehicles/${vehicleId}`;
  return null;
}

/**
 * Document-currency amount equivalent to a base amount at the document's booking rate. Exact when
 * nothing has been paid yet; otherwise an estimate (the API keeps the settled document amount but
 * does not return it on open payables).
 */
export function docEquivalent(baseAmount: string, totalDoc: string, totalBase: string): string | null {
  if (!isMoney(baseAmount) || d(totalBase).isZero()) return null;
  return d(baseAmount).times(totalDoc).dividedBy(totalBase).toDecimalPlaces(2).toFixed(2);
}
