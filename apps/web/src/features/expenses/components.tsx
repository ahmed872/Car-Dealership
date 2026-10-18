import clsx from 'clsx';
import { Search, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Tone } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Feedback';
import { useAuth } from '@/lib/auth';
import { useApi, useDebounced } from '@/lib/hooks';
import type { ExpenseStatus, Paged } from './api';

const STATUS_TONE: Record<ExpenseStatus, Tone> = {
  pending_approval: 'warning',
  posted: 'success',
  rejected: 'danger',
  reversed: 'neutral',
};

export function ExpenseStatusBadge({ status }: { status: ExpenseStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`expenses.status.${status}`)}</Badge>;
}

export interface SupplierLite {
  id: string;
  name: string;
  phone: string | null;
}

/**
 * Optional supplier for an expense: search active suppliers (GET /suppliers, needs suppliers.read)
 * and pick one; without the permission the expense is recorded as a direct purchase.
 */
export function SupplierPicker({
  value,
  onChange,
  error,
}: {
  value: SupplierLite | null;
  onChange: (s: SupplierLite | null) => void;
  error?: string | null;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('suppliers.read');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const q = useDebounced(search, 300);
  const listId = useId();
  const res = useApi<Paged<SupplierLite & { isActive: boolean }>>(
    ['suppliers', 'expense-picker'],
    allowed && !value && open ? '/suppliers' : null,
    { q: q || undefined, active: 'true', pageSize: 8 },
    { placeholderData: (p) => p },
  );
  const items = res.data?.items ?? [];

  return (
    <Field
      label={t('expenses.form.supplier')}
      hint={allowed ? t('expenses.form.supplierHint') : t('expenses.form.supplierNoPermission')}
      error={error}
    >
      {(id, describedBy) =>
        value ? (
          <div className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-1.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{value.name}</p>
              {value.phone && (
                <p className="num truncate text-xs text-muted" dir="ltr">
                  {value.phone}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onChange(null)}
              className="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-ink"
              aria-label={t('expenses.form.supplierClear')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="relative">
            <Search
              className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-subtle"
              aria-hidden
            />
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={!!error}
              disabled={!allowed}
              className="ps-9"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              autoComplete="off"
              placeholder={t('expenses.form.supplierSearch')}
              value={search}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onChange={(e) => {
                setSearch(e.target.value);
                setOpen(true);
              }}
            />
            {open && allowed && (
              <ul
                id={listId}
                role="listbox"
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-pop"
              >
                {res.isLoading && !res.data ? (
                  <li className="px-3 py-2">
                    <Spinner />
                  </li>
                ) : items.length === 0 ? (
                  <li className="px-3 py-2 text-sm text-muted">{t('expenses.form.supplierNone')}</li>
                ) : (
                  items.map((s) => (
                    <li key={s.id} role="option" aria-selected={false}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          onChange({ id: s.id, name: s.name, phone: s.phone });
                          setSearch('');
                          setOpen(false);
                        }}
                        className={clsx(
                          'flex w-full flex-col items-start px-3 py-2 text-start hover:bg-surface-2',
                        )}
                      >
                        <span className="text-sm text-ink">{s.name}</span>
                        {s.phone && (
                          <span className="num text-xs text-muted" dir="ltr">
                            {s.phone}
                          </span>
                        )}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        )
      }
    </Field>
  );
}
