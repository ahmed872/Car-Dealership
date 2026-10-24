import clsx from 'clsx';
import { Search, UserRound, X } from 'lucide-react';
import { ComponentProps, forwardRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BODY_TYPES, FUEL_TYPES, TRANSMISSIONS, WISH_CRITERIA, zWishCreate, zWishUpdate } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton, Spinner } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { FormSection } from '@/components/ui/Layout';
import { useMakes, useModels } from '@/features/vehicles/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney, fmtNumber, fmtPhone, todayIso } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';
import type { CustomerOption, Paged, Wish, WishStatus } from './api';
import { issuesToFields, useWishFieldMessage } from './kit';

/**
 * MoneyInput whose currency tag never covers the digits in Arabic: the kit's input is dir="ltr" but
 * places the tag at the page's inline end (the left in RTL), so the padding must follow it there.
 */
export const AmountInput = forwardRef<HTMLInputElement, ComponentProps<typeof MoneyInput>>(function AmountInput({ className, ...rest }, ref) {
  return <MoneyInput ref={ref} className={clsx(rest.currency && 'rtl:ps-14 rtl:pe-3', className)} {...rest} />;
});

const STATUS_TONE: Record<WishStatus, Tone> = { active: 'info', fulfilled: 'success', cancelled: 'neutral', expired: 'warning' };

export function WishStatusBadge({ status }: { status: WishStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`wishes.statuses.${status}`)}</Badge>;
}

/** Names of the make/model a wish refers to, in the current language. */
export interface WishNames {
  make?: string | null;
  model?: string | null;
}

/** Human-readable chips for the criteria a wish sets (shared by the list, detail and explain views). */
export function useCriteriaLabels() {
  const { t } = useTranslation();
  const { currency } = useAuth();
  return (w: Pick<Wish, (typeof WISH_CRITERIA)[number]>, names: WishNames) => {
    const out: Array<{ key: string; label: string; value: string }> = [];
    if (w.makeId) out.push({ key: 'makeId', label: t('wishes.criteria.makeId'), value: names.make ?? '—' });
    if (w.modelId) out.push({ key: 'modelId', label: t('wishes.criteria.modelId'), value: names.model ?? '—' });
    if (w.yearFrom != null && w.yearTo != null) {
      out.push({ key: 'years', label: t('wishes.criteria.yearFrom'), value: t('wishes.criteria.yearRange', { from: w.yearFrom, to: w.yearTo }) });
    } else if (w.yearFrom != null) {
      out.push({ key: 'yearFrom', label: t('wishes.criteria.yearFrom'), value: t('wishes.criteria.yearFromOnly', { year: w.yearFrom }) });
    } else if (w.yearTo != null) {
      out.push({ key: 'yearTo', label: t('wishes.criteria.yearTo'), value: t('wishes.criteria.yearToOnly', { year: w.yearTo }) });
    }
    if (w.maxPrice != null) out.push({ key: 'maxPrice', label: t('wishes.criteria.maxPrice'), value: t('wishes.criteria.upToPrice', { amount: fmtMoney(w.maxPrice, currency) }) });
    if (w.maxOdometerKm != null) out.push({ key: 'maxOdometerKm', label: t('wishes.criteria.maxOdometerKm'), value: t('wishes.criteria.upToKm', { km: fmtNumber(w.maxOdometerKm) }) });
    if (w.bodyType) out.push({ key: 'bodyType', label: t('wishes.criteria.bodyType'), value: t(`wishes.enums.bodyType.${w.bodyType}`, { defaultValue: w.bodyType }) });
    if (w.fuelType) out.push({ key: 'fuelType', label: t('wishes.criteria.fuelType'), value: t(`wishes.enums.fuelType.${w.fuelType}`, { defaultValue: w.fuelType }) });
    if (w.transmission) out.push({ key: 'transmission', label: t('wishes.criteria.transmission'), value: t(`wishes.enums.transmission.${w.transmission}`, { defaultValue: w.transmission }) });
    if (w.color) out.push({ key: 'color', label: t('wishes.criteria.color'), value: w.color });
    return out;
  };
}

/** Compact criteria summary: make/model first, then the rest as chips. */
export function CriteriaChips({ wish, names, className }: { wish: Wish; names: WishNames; className?: string }) {
  const { t } = useTranslation();
  const labels = useCriteriaLabels()(wish, names);
  if (!labels.length) return <span className="text-muted">{t('wishes.criteria.none')}</span>;
  // Spans only: the chips also render inside the page header's subtitle paragraph.
  return (
    <span className={clsx('flex flex-wrap gap-1.5', className)}>
      {labels.map((l) => (
        <span key={l.key} title={l.label} className="inline-flex max-w-full items-center rounded-md border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink">
          <span className="truncate">{l.value}</span>
        </span>
      ))}
    </span>
  );
}

/** Search-as-you-type customer picker (GET /customers?q=); shows the chosen customer as a card. */
export function CustomerPicker({
  value,
  selected,
  onChange,
  error,
  disabled,
}: {
  value: string;
  selected: CustomerOption | null;
  onChange: (c: CustomerOption | null) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 300);
  const results = useApi<Paged<CustomerOption>>(['customers', 'picker'], value || debounced.length < 2 ? null : '/customers', { q: debounced, pageSize: 8 });

  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-2/60 p-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-strong">
          <UserRound className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {selected ? (
            <>
              <p className="truncate font-medium text-ink">{selected.fullName}</p>
              {(selected.phone || selected.companyName) && (
                <p className="truncate text-xs text-muted">
                  {selected.phone && <span dir="ltr" className="num">{fmtPhone(selected.phone)}</span>}
                  {selected.phone && selected.companyName && ' · '}
                  {selected.companyName}
                </p>
              )}
            </>
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
        </div>
        {!disabled && (
          <Button variant="ghost" size="sm" icon={<X className="h-4 w-4" />} onClick={() => onChange(null)}>
            {t('wishes.fields.changeCustomer')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Field label={t('wishes.fields.customer')} required error={error} className="sm:col-span-2">
      {(id, d) => (
        <div>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input
              id={id}
              aria-describedby={d}
              invalid={!!error}
              type="search"
              className="ps-9"
              autoComplete="off"
              placeholder={t('wishes.fields.customerSearch')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {debounced.length >= 2 && (
            <div className="mt-2 overflow-hidden rounded-xl border border-line">
              {results.isLoading ? (
                <div className="p-3">
                  <Spinner />
                </div>
              ) : results.data?.items.length ? (
                <ul role="listbox" aria-label={t('wishes.fields.customer')} className="max-h-64 divide-y divide-line overflow-y-auto">
                  {results.data.items.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => onChange(c)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start hover:bg-surface-2 focus-visible:bg-surface-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{c.fullName}</span>
                          {c.companyName && <span className="block truncate text-xs text-muted">{c.companyName}</span>}
                        </span>
                        {c.phone && (
                          <span dir="ltr" className="num shrink-0 text-xs text-muted">
                            {fmtPhone(c.phone)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-3 text-sm text-muted">{t('common.noResults')}</p>
              )}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

// ── Wish form ─────────────────────────────────────────────────────────────────────────────

export interface WishFormState {
  makeId: string;
  modelId: string;
  yearFrom: string;
  yearTo: string;
  maxPrice: string;
  maxOdometerKm: string;
  bodyType: string;
  fuelType: string;
  transmission: string;
  color: string;
  expiresAt: string;
  notes: string;
}

export const emptyWishForm: WishFormState = {
  makeId: '',
  modelId: '',
  yearFrom: '',
  yearTo: '',
  maxPrice: '',
  maxOdometerKm: '',
  bodyType: '',
  fuelType: '',
  transmission: '',
  color: '',
  expiresAt: '',
  notes: '',
};

export function wishToForm(w: Wish): WishFormState {
  return {
    makeId: w.makeId ?? '',
    modelId: w.modelId ?? '',
    yearFrom: w.yearFrom != null ? String(w.yearFrom) : '',
    yearTo: w.yearTo != null ? String(w.yearTo) : '',
    maxPrice: w.maxPrice ?? '',
    maxOdometerKm: w.maxOdometerKm != null ? String(w.maxOdometerKm) : '',
    bodyType: w.bodyType ?? '',
    fuelType: w.fuelType ?? '',
    transmission: w.transmission ?? '',
    color: w.color ?? '',
    expiresAt: w.expiresAt ?? '',
    notes: w.notes ?? '',
  };
}

const INT_FIELDS = ['yearFrom', 'yearTo', 'maxOdometerKm'] as const;
const TEXT_FIELDS = ['makeId', 'modelId', 'bodyType', 'fuelType', 'transmission', 'color', 'expiresAt', 'notes'] as const;

/**
 * Builds the request body and validates it with the shared zod schema. Empty inputs become null
 * (cleared) so an edit can remove a criterion; on create the server treats null as "not set".
 */
export function buildWishPayload(
  f: WishFormState,
  mode: { kind: 'create'; customerId: string } | { kind: 'edit' },
): { payload: Record<string, unknown> | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  for (const k of TEXT_FIELDS) body[k] = f[k].trim() === '' ? null : f[k].trim();
  for (const k of INT_FIELDS) {
    const v = f[k].trim();
    if (v === '') body[k] = null;
    else if (!/^\d+$/.test(v)) errors[k] = 'integer';
    else body[k] = Number(v);
  }
  body.maxPrice = f.maxPrice.trim() === '' ? null : f.maxPrice.trim();
  if (mode.kind === 'create') body.customerId = mode.customerId;
  if (mode.kind === 'create' && !mode.customerId) errors.customerId = 'customerRequired';
  const hasCriterion = WISH_CRITERIA.some((k) => body[k] !== null && body[k] !== undefined && body[k] !== '');
  if (!hasCriterion && !errors.yearFrom && !errors.yearTo && !errors.maxOdometerKm) errors.makeId = 'needCriterion';
  const parsed = mode.kind === 'create' ? zWishCreate.safeParse(body) : zWishUpdate.safeParse(body);
  if (!parsed.success) {
    for (const [k, v] of Object.entries(issuesToFields(parsed.error.issues))) errors[k] ??= v;
  }
  if (Object.keys(errors).length) return { payload: null, errors };
  return { payload: body, errors };
}

/** The criteria fields of a wish (create page and edit dialog). */
export function WishFields({
  form,
  setForm,
  errors,
  compact,
}: {
  form: WishFormState;
  setForm: (patch: Partial<WishFormState>) => void;
  errors: Record<string, string>;
  /** Plain grid without section headings (edit dialog). */
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { currency, me } = useAuth();
  const msg = useWishFieldMessage();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const makes = useMakes();
  const models = useModels(form.makeId || null);
  const today = todayIso(me?.tenant?.settings.timezone);
  const err = (k: string) => msg(errors[k]);

  const enumSelect = (key: 'bodyType' | 'fuelType' | 'transmission', values: readonly string[]) => (
    <Field label={t(`wishes.fields.${key}`)} error={err(key)}>
      {(id, d) => (
        <Select id={id} aria-describedby={d} invalid={!!errors[key]} value={form[key]} onChange={(e) => setForm({ [key]: e.target.value })}>
          <option value="">{t('wishes.fields.any')}</option>
          {values.map((v) => (
            <option key={v} value={v}>
              {t(`wishes.enums.${key}.${v}`)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const intInput = (key: 'yearFrom' | 'yearTo' | 'maxOdometerKm', opts: { min: number; max: number }) => (
    <Field label={t(`wishes.fields.${key}`)} error={err(key)}>
      {(id, d) => (
        <Input
          id={id}
          aria-describedby={d}
          invalid={!!errors[key]}
          type="number"
          inputMode="numeric"
          dir="ltr"
          className="num text-start"
          min={opts.min}
          max={opts.max}
          step={1}
          value={form[key]}
          onChange={(e) => setForm({ [key]: e.target.value })}
        />
      )}
    </Field>
  );

  const vehicle = (
    <>
      <Field label={t('wishes.fields.make')} error={err('makeId')}>
        {(id, d) => (
          <Select id={id} aria-describedby={d} invalid={!!errors.makeId} value={form.makeId} onChange={(e) => setForm({ makeId: e.target.value, modelId: '' })}>
            <option value="">{t('wishes.fields.anyMake')}</option>
            {makes.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {lang === 'en' ? m.nameEn : `${m.nameAr} · ${m.nameEn}`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('wishes.fields.model')} error={err('modelId')} hint={!form.makeId ? t('wishes.fields.chooseMakeFirst') : undefined}>
        {(id, d) => (
          <Select id={id} aria-describedby={d} invalid={!!errors.modelId} disabled={!form.makeId} value={form.modelId} onChange={(e) => setForm({ modelId: e.target.value })}>
            <option value="">{t('wishes.fields.anyModel')}</option>
            {models.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {lang === 'en' ? m.nameEn : `${m.nameAr} · ${m.nameEn}`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {intInput('yearFrom', { min: 1950, max: 2100 })}
      {intInput('yearTo', { min: 1950, max: 2100 })}
    </>
  );
  const budget = (
    <>
      <Field label={t('wishes.fields.maxPrice')} error={err('maxPrice')}>
        {(id, d) => <AmountInput id={id} aria-describedby={d} invalid={!!errors.maxPrice} currency={currency} value={form.maxPrice} onChange={(e) => setForm({ maxPrice: e.target.value })} />}
      </Field>
      {intInput('maxOdometerKm', { min: 0, max: 2_000_000 })}
    </>
  );
  const specs = (
    <>
      {enumSelect('bodyType', BODY_TYPES)}
      {enumSelect('fuelType', FUEL_TYPES)}
      {enumSelect('transmission', TRANSMISSIONS)}
      <Field label={t('wishes.fields.color')} hint={t('wishes.fields.colorHint')} error={err('color')}>
        {(id, d) => <Input id={id} aria-describedby={d} invalid={!!errors.color} maxLength={40} value={form.color} onChange={(e) => setForm({ color: e.target.value })} />}
      </Field>
    </>
  );
  const other = (
    <>
      <Field label={t('wishes.fields.expiresAt')} hint={t('wishes.fields.expiresHint')} error={err('expiresAt')}>
        {(id, d) => <Input id={id} aria-describedby={d} invalid={!!errors.expiresAt} type="date" min={today} value={form.expiresAt} onChange={(e) => setForm({ expiresAt: e.target.value })} />}
      </Field>
      <Field label={t('wishes.fields.notes')} error={err('notes')} className="sm:col-span-2">
        {(id, d) => <Textarea id={id} aria-describedby={d} rows={3} maxLength={1000} value={form.notes} onChange={(e) => setForm({ notes: e.target.value })} />}
      </Field>
    </>
  );

  if (compact) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {vehicle}
        {budget}
        {specs}
        {other}
      </div>
    );
  }
  return (
    <>
      <FormSection title={t('wishes.sections.vehicle')} description={t('wishes.sections.vehicleHint')}>
        {vehicle}
      </FormSection>
      <FormSection title={t('wishes.sections.budget')} description={t('wishes.sections.budgetHint')}>
        {budget}
      </FormSection>
      <FormSection title={t('wishes.sections.specs')} description={t('wishes.sections.specsHint')}>
        {specs}
      </FormSection>
      <FormSection title={t('wishes.sections.other')} description={t('wishes.sections.otherHint')}>
        {other}
      </FormSection>
    </>
  );
}
