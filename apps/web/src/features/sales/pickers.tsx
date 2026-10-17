import clsx from 'clsx';
import { ChevronDown, Search, X } from 'lucide-react';
import { KeyboardEvent, ReactNode, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VehicleStatus } from '@autohub/shared';
import { Input } from '@/components/ui/Field';
import { VehicleStatusBadge, vehicleTitle } from '@/features/vehicles/components';
import type { VehicleListItem } from '@/features/vehicles/api';
import { fmtMoney } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import type { Paged } from './api';

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
function SearchCombobox<T>({
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
          <button type="button" className="rounded p-1 text-subtle hover:text-ink" aria-label={t('common.clearFilters')} onClick={onClear}>
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
          {results.error ? <li className="px-3 py-2 text-sm text-danger">{t('sales.form.searchFailed')}</li> : null}
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

/** Vehicles that can be sold: available, or reserved (only for the reserving customer). */
export function VehiclePicker({
  id,
  describedBy,
  invalid,
  value,
  selectedLabel,
  onSelect,
  onClear,
}: {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  value: string;
  selectedLabel: string;
  onSelect: (v: VehicleListItem) => void;
  onClear?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { currency } = useAuth();
  return (
    <SearchCombobox<VehicleListItem>
      id={id}
      describedBy={describedBy}
      invalid={invalid}
      value={value}
      selectedLabel={selectedLabel}
      placeholder={t('sales.form.vehicleSearch')}
      path="/vehicles"
      query={{ status: 'available,reserved' }}
      queryKey="vehicles"
      onSelect={onSelect}
      onClear={onClear}
      toOption={(v) => ({
        id: v.id,
        title: vehicleTitle(v, i18n.language),
        hint: [v.stockNumber, v.vin, v.askingPrice ? fmtMoney(v.askingPrice, currency) : null].filter(Boolean).join(' · '),
        aside: <VehicleStatusBadge status={v.status as VehicleStatus} />,
      })}
    />
  );
}

export interface CustomerOption {
  id: string;
  fullName: string;
  phone: string | null;
  city: string | null;
  isActive: boolean;
}

export function CustomerPicker({
  id,
  describedBy,
  invalid,
  value,
  selectedLabel,
  onSelect,
  onClear,
}: {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  value: string;
  selectedLabel: string;
  onSelect: (c: CustomerOption) => void;
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SearchCombobox<CustomerOption>
      id={id}
      describedBy={describedBy}
      invalid={invalid}
      value={value}
      selectedLabel={selectedLabel}
      placeholder={t('sales.form.customerSearch')}
      path="/customers"
      queryKey="customers"
      onSelect={onSelect}
      onClear={onClear}
      toOption={(c) => ({ id: c.id, title: c.fullName, hint: [c.phone, c.city].filter(Boolean).join(' · ') || undefined, disabled: !c.isActive })}
    />
  );
}
