import clsx from 'clsx';
import { Loader2, Search, X } from 'lucide-react';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, Paginated } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { useAuth } from '@/lib/auth';
import { useApi, useDebounced } from '@/lib/hooks';
import type { VehicleListItem } from '@/features/vehicles/api';
import { useStatusLabel, vehicleTitle } from '@/features/vehicles/components';
import { CashAccountOption, CostStatus, PaymentMethod, SupplierLite } from './api';

const statusTone: Record<CostStatus, Tone> = {
  pending_approval: 'warning',
  posted: 'success',
  reversed: 'neutral',
  rejected: 'danger',
};

export function CostStatusBadge({ status }: { status: CostStatus }) {
  const { t } = useTranslation();
  return <Badge tone={statusTone[status]}>{t(`costs.status.${status}`)}</Badge>;
}

// ── Search pickers ─────────────────────────────────────────────────────────────────────────

interface Option {
  key: string;
  label: string;
  sub?: string;
  disabled?: boolean;
  badge?: string;
}

/** Search box with a result list (combobox). Results come from the server, never invented. */
function SearchPicker({
  id,
  describedBy,
  invalid,
  placeholder,
  search,
  onSearch,
  options,
  loading,
  emptyText,
  onPick,
  disabled,
}: {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  placeholder: string;
  search: string;
  onSearch: (v: string) => void;
  options: Option[] | undefined;
  loading: boolean;
  emptyText: string;
  onPick: (key: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  useEffect(() => setActive(0), [options]);
  const enabled = options?.filter((o) => !o.disabled) ?? [];
  const pick = (o: Option) => {
    if (o.disabled) return;
    onPick(o.key);
    setOpen(false);
  };
  return (
    <div ref={wrap} className="relative">
      <Search
        className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle"
        aria-hidden
      />
      <Input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={describedBy}
        invalid={invalid}
        disabled={disabled}
        autoComplete="off"
        className="ps-9"
        placeholder={placeholder}
        value={search}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onSearch(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, Math.max(enabled.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open && enabled[active]) {
            e.preventDefault();
            pick(enabled[active]!);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          className="animate-in absolute inset-x-0 z-40 mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-pop"
        >
          {loading && !options ? (
            <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('common.loading')}
            </p>
          ) : options && options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted">{emptyText}</p>
          ) : (
            options?.map((o) => {
              const idx = enabled.indexOf(o);
              return (
                <button
                  key={o.key}
                  type="button"
                  role="option"
                  aria-selected={idx === active}
                  aria-disabled={o.disabled || undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                  className={clsx(
                    'flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm',
                    o.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-surface-2',
                    idx === active && !o.disabled && 'bg-surface-2',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">
                      <bdi>{o.label}</bdi>
                    </span>
                    {o.sub && <span className="num block truncate text-xs text-muted">{o.sub}</span>}
                  </span>
                  {o.badge && <span className="shrink-0 text-xs text-muted">{o.badge}</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Selected value shown as a removable chip. */
function Chip({
  label,
  sub,
  onClear,
  clearLabel,
}: {
  label: string;
  sub?: string | null;
  onClear?: () => void;
  clearLabel: string;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-ink">
          <bdi>{label}</bdi>
        </span>
        {sub && <span className="num block truncate text-xs text-muted">{sub}</span>}
      </span>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="rounded p-1 text-muted hover:bg-surface-3 hover:text-ink"
          aria-label={clearLabel}
          title={clearLabel}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** Supplier search (GET /suppliers, suppliers.read). Optional field: null = direct purchase. */
export function SupplierPicker({
  value,
  onChange,
  label,
  hint,
  error,
  disabled,
}: {
  value: SupplierLite | null;
  onChange: (s: SupplierLite | null) => void;
  label: string;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('suppliers.read');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const res = useApi<Paginated<SupplierLite & { isActive: boolean }>>(
    ['suppliers', 'picker'],
    allowed && !value ? '/suppliers' : null,
    { q: q || undefined, active: 'true', pageSize: 8 },
    { placeholderData: (p) => p },
  );
  return (
    <Field label={label} hint={allowed ? hint : t('costs.supplier.noPermission')} error={error}>
      {(id, describedBy) =>
        value ? (
          <Chip
            label={value.name}
            sub={value.phone}
            onClear={disabled ? undefined : () => onChange(null)}
            clearLabel={t('costs.supplier.clear')}
          />
        ) : (
          <SearchPicker
            id={id}
            describedBy={describedBy}
            invalid={!!error}
            disabled={!allowed || disabled}
            placeholder={t('costs.supplier.search')}
            search={search}
            onSearch={setSearch}
            loading={res.isFetching}
            options={res.data?.items.map((s) => ({ key: s.id, label: s.name, sub: s.phone ?? undefined }))}
            emptyText={t('costs.supplier.noResults')}
            onPick={(key) => {
              const s = res.data?.items.find((x) => x.id === key);
              if (s) onChange({ id: s.id, name: s.name, phone: s.phone });
              setSearch('');
            }}
          />
        )
      }
    </Field>
  );
}

export interface PickedVehicle {
  id: string;
  stockNumber: string;
  title: string;
  status: VehicleListItem['status'];
  branchId?: string;
  branchName?: string;
}

export function toPicked(v: VehicleListItem, lang: string): PickedVehicle {
  return {
    id: v.id,
    stockNumber: v.stockNumber,
    title: vehicleTitle(v, lang),
    status: v.status,
    branchId: v.branchId,
    branchName: v.branchName,
  };
}

/** Vehicle search (GET /vehicles). Vehicles whose status is in `blocked` cannot be picked. */
export function VehicleSearch({
  id,
  describedBy,
  invalid,
  onPick,
  exclude = [],
  blocked = ['removed'],
  scope = 'all',
}: {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  onPick: (v: PickedVehicle) => void;
  exclude?: string[];
  blocked?: string[];
  scope?: 'stock' | 'sold' | 'all';
}) {
  const { t, i18n } = useTranslation();
  const statusLabel = useStatusLabel();
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const res = useApi<Paginated<VehicleListItem>>(
    ['vehicles', 'picker'],
    '/vehicles',
    { q: q || undefined, scope, pageSize: 10, sort: '-stockedAt' },
    { placeholderData: (p) => p },
  );
  const options = res.data?.items
    .filter((v) => !exclude.includes(v.id))
    .map((v) => ({
      key: v.id,
      label: vehicleTitle(v, i18n.language),
      sub: [v.stockNumber, v.vin].filter(Boolean).join(' · '),
      disabled: blocked.includes(v.status),
      badge: statusLabel(v.status),
    }));
  return (
    <SearchPicker
      id={id}
      describedBy={describedBy}
      invalid={invalid}
      placeholder={t('costs.vehicle.search')}
      search={search}
      onSearch={setSearch}
      loading={res.isFetching}
      options={options}
      emptyText={t('costs.vehicle.noResults')}
      onPick={(key) => {
        const v = res.data?.items.find((x) => x.id === key);
        if (v) onPick(toPicked(v, i18n.language));
        setSearch('');
      }}
    />
  );
}

/** Single vehicle field: chip when chosen, search otherwise. */
export function VehiclePicker({
  value,
  onChange,
  label,
  error,
  blocked,
  fixed,
}: {
  value: PickedVehicle | null;
  onChange: (v: PickedVehicle | null) => void;
  label: string;
  error?: string | null;
  blocked?: string[];
  /** The vehicle is given by the context (e.g. Vehicle 360) and cannot be changed. */
  fixed?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Field label={label} required error={error}>
      {(id, describedBy) =>
        value ? (
          <Chip
            label={value.title}
            sub={[value.stockNumber, value.branchName].filter(Boolean).join(' · ')}
            onClear={fixed ? undefined : () => onChange(null)}
            clearLabel={t('costs.vehicle.clear')}
          />
        ) : (
          <VehicleSearch
            id={id}
            describedBy={describedBy}
            invalid={!!error}
            onPick={onChange}
            blocked={blocked}
          />
        )
      }
    </Field>
  );
}

// ── Pay now ────────────────────────────────────────────────────────────────────────────────

export interface PayNowState {
  enabled: boolean;
  cashAccountId: string;
  method: PaymentMethod;
  reference: string;
}

export const initialPayNow: PayNowState = {
  enabled: false,
  cashAccountId: '',
  method: 'cash',
  reference: '',
};

export function payNowBody(p: PayNowState) {
  return p.enabled
    ? { cashAccountId: p.cashAccountId, method: p.method, reference: p.reference.trim() || null }
    : null;
}

/**
 * "Pay now" toggle + account/method/reference. Only base-currency accounts can settle immediately
 * (server rule pay_now_base_currency); `unavailable` explains why the toggle is not offered.
 */
export function PayNowFields({
  value,
  onChange,
  accounts,
  loading,
  unavailable,
  error,
  label,
  hint,
}: {
  value: PayNowState;
  onChange: (v: PayNowState) => void;
  accounts: CashAccountOption[] | undefined;
  loading?: boolean;
  unavailable?: string | null;
  error?: string | null;
  label?: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const { currency } = useAuth();
  const usable = accounts?.filter((a) => a.currency === currency) ?? [];
  if (unavailable) return <p className="text-[13px] text-muted">{unavailable}</p>;
  const none = !loading && accounts !== undefined && usable.length === 0;
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface-2/50 p-3">
      <Checkbox
        label={label ?? t('costs.payNow.toggle')}
        description={none ? t('costs.payNow.noAccounts') : (hint ?? t('costs.payNow.toggleHint'))}
        checked={value.enabled}
        disabled={none}
        onChange={(e) =>
          onChange({
            ...value,
            enabled: e.target.checked,
            cashAccountId: value.cashAccountId || usable[0]?.id || '',
          })
        }
      />
      {value.enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('costs.payNow.account')} required error={error} className="sm:col-span-2">
            {(id, describedBy) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                invalid={!!error}
                value={value.cashAccountId}
                onChange={(e) => onChange({ ...value, cashAccountId: e.target.value })}
              >
                <option value="">{t('costs.payNow.accountPlaceholder')}</option>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {t(`costs.accountType.${a.type}`)} · {a.name} ({a.currency})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('costs.payNow.method')}>
            {(id) => (
              <Select
                id={id}
                value={value.method}
                onChange={(e) => onChange({ ...value, method: e.target.value as PaymentMethod })}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`costs.methods.${m}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('costs.payNow.reference')}>
            {(id) => (
              <Input
                id={id}
                maxLength={80}
                placeholder={t('costs.payNow.referencePlaceholder')}
                value={value.reference}
                onChange={(e) => onChange({ ...value, reference: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}
    </div>
  );
}

/** Small helper row "label: value" used inside cards. */
export function Row({
  label,
  value,
  strong,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx('flex items-center justify-between gap-3 py-1.5 text-sm', className)}>
      <span className="text-muted">{label}</span>
      <span className={clsx('num text-end', strong ? 'font-semibold text-ink' : 'text-ink')}>{value}</span>
    </div>
  );
}
