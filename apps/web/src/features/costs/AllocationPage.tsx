import clsx from 'clsx';
import { CheckCircle2, Layers, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  ALLOCATION_METHODS,
  allocateProportionally,
  convert,
  CURRENCY_CODES,
  CurrencyCode,
  d,
  sum,
  todayInZone,
} from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, errorMessage } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/format';
import { useFxRateField, withFxHint } from '@/lib/fx';
import { useApiMutation } from '@/lib/hooks';
import {
  categoryName,
  isPositiveMoney,
  isRate,
  previewBase,
  SupplierLite,
  useCashAccountOptions,
  useServerFieldErrors,
  useTenantDefaults,
  useVehicleCategories,
  VehicleCostRow,
  VehicleCostSummary,
} from './api';
import {
  CostStatusBadge,
  initialPayNow,
  payNowBody,
  PayNowFields,
  PayNowState,
  PickedVehicle,
  SupplierPicker,
  VehicleSearch,
} from './components';

type Method = (typeof ALLOCATION_METHODS)[number];
const MAX = 100;

interface AllocationResult {
  batchId: string;
  costs: VehicleCostRow[];
  allocated: string[];
}

const FIELD_FOR_CODE: Record<string, string> = {
  manual_total_mismatch: 'manualAmounts',
  no_purchase_prices: 'method',
  exchange_rate_required: 'exchangeRate',
  fx_rate_invalid: 'exchangeRate',
  supplier_inactive: 'supplierId',
  category_not_vehicle: 'categoryId',
  pay_now_base_currency: 'payNow.cashAccountId',
  cannot_pay_unapproved: 'payNow.cashAccountId',
  supplier_mismatch: 'payNow.cashAccountId',
};

export function AllocationPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { tz, rounding, base } = useTenantDefaults();
  const cats = useVehicleCategories();
  const willPost = can('costs.approve');
  const canPay = can('supplier_payments.create');
  const canReadCosts = can('costs.read');
  const accounts = useCashAccountOptions(willPost && canPay);
  const sfe = useServerFieldErrors();

  const [vehicles, setVehicles] = useState<PickedVehicle[]>([]);
  const [method, setMethod] = useState<Method>('equal');
  const [manual, setManual] = useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [total, setTotal] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>(base);
  const [rate, setRate] = useState('');
  const [costDate, setCostDate] = useState(() => todayInZone(tz));
  const [supplier, setSupplier] = useState<SupplierLite | null>(null);
  const [payNow, setPayNow] = useState<PayNowState>(initialPayNow);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const clearError = (k: string) => setErrors((e) => (e[k] ? { ...e, [k]: '' } : e));
  const [formError, setFormError] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey());
  const [result, setResult] = useState<{
    res: AllocationResult;
    vehicles: PickedVehicle[];
    currency: CurrencyCode;
  } | null>(null);

  const foreign = currency !== base;
  const fxField = useFxRateField(foreign ? currency : null, rate, setRate);
  const totalOk = isPositiveMoney(total);
  const rateOk = !foreign || isRate(rate);

  // Purchase-price weights, read from each vehicle's cost summary (same figure the server uses).
  const weightQueries = useQueries({
    queries: vehicles.map((v) => ({
      queryKey: ['vehicle-costs', v.id, null],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<VehicleCostSummary>(`/vehicles/${v.id}/costs`, { signal }),
      enabled: method === 'by_purchase_price' && canReadCosts,
      staleTime: 30_000,
    })),
  });
  const weights = weightQueries.map((q) => q.data?.totals.purchase);
  const weightsLoading =
    method === 'by_purchase_price' && canReadCosts && weightQueries.some((q) => q.isLoading);
  const weightsError = weightQueries.find((q) => q.error)?.error;

  const preview = useMemo(() => {
    if (vehicles.length === 0 || !totalOk) return null;
    try {
      let parts: string[] | null = null;
      if (method === 'equal')
        parts = allocateProportionally(
          total.trim(),
          vehicles.map(() => 1),
          currency,
        );
      else if (method === 'by_purchase_price') {
        if (!canReadCosts || weights.some((w) => w === undefined)) return null;
        if (weights.every((w) => d(w!).isZero())) return { parts: null, base: null, noWeights: true };
        parts = allocateProportionally(total.trim(), weights as string[], currency);
      } else {
        parts = vehicles.map((v) => manual[v.id]?.trim() ?? '');
      }
      let baseParts: string[] | null = null;
      if (!foreign) baseParts = parts;
      else if (isRate(rate) && parts.every((p) => isPositiveMoney(p) || (method !== 'manual' && p !== ''))) {
        const totalBase = convert(total.trim(), rate.trim(), base, rounding);
        baseParts = allocateProportionally(totalBase, parts, base);
      }
      return { parts, base: baseParts, noWeights: false };
    } catch {
      return null;
    }
  }, [
    vehicles,
    totalOk,
    total,
    method,
    currency,
    canReadCosts,
    weights,
    manual,
    foreign,
    rate,
    base,
    rounding,
  ]);

  const manualSum =
    method === 'manual'
      ? sum(vehicles.map((v) => (isPositiveMoney(manual[v.id] ?? '') ? manual[v.id]!.trim() : '0')))
      : null;
  const manualDiff = manualSum && totalOk ? d(total.trim()).minus(manualSum) : null;
  const hasZero = method !== 'manual' && (preview?.parts?.some((p) => d(p).isZero()) ?? false);

  const m = useApiMutation<Record<string, unknown>, AllocationResult>({
    path: '/vehicle-costs/allocate',
    idempotent: true,
    invalidate: [
      ['vehicle-costs'],
      ['vehicles'],
      ['vehicle'],
      ['approvals'],
      ['approvals-summary'],
      ['cash-accounts'],
    ],
    success: t('costs.success.allocated'),
  });

  const addVehicle = (v: PickedVehicle) => {
    setVehicles((xs) => (xs.some((x) => x.id === v.id) || xs.length >= MAX ? xs : [...xs, v]));
    setErrors((e) => ({ ...e, vehicleIds: '' }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (vehicles.length < 2) e.vehicleIds = t('costs.allocation.minVehicles');
    if (vehicles.length > MAX) e.vehicleIds = t('costs.allocation.maxVehicles');
    if (!categoryId) e.categoryId = t('costs.validation.required');
    if (description.trim().length < 2) e.description = t('costs.validation.too_short');
    if (!total.trim()) e.totalAmount = t('costs.validation.required');
    else if (!totalOk) e.totalAmount = t('costs.validation.must_be_positive');
    if (!rateOk) e.exchangeRate = t('costs.validation.exchange_rate_required');
    if (!costDate) e.costDate = t('costs.validation.invalid_date');
    if (method === 'manual') {
      for (const v of vehicles)
        if (!isPositiveMoney(manual[v.id] ?? ''))
          e[`manual.${v.id}`] = t('costs.validation.must_be_positive');
      if (!Object.keys(e).some((k) => k.startsWith('manual.')) && manualDiff && !manualDiff.isZero())
        e.manualAmounts = t('costs.allocation.mismatch');
    }
    if (method === 'by_purchase_price' && preview?.noWeights)
      e.method = t('costs.allocation.noPurchasePrices');
    if (payNow.enabled && !payNow.cashAccountId) e['payNow.cashAccountId'] = t('costs.validation.required');
    return e;
  };

  const submit = () => {
    const e = validate();
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    const picked = vehicles;
    m.mutate(
      {
        vehicleIds: picked.map((v) => v.id),
        method,
        ...(method === 'manual' ? { manualAmounts: picked.map((v) => manual[v.id]!.trim()) } : {}),
        categoryId,
        description: description.trim(),
        totalAmount: total.trim(),
        currency,
        ...(foreign ? { exchangeRate: rate.trim() } : {}),
        costDate,
        supplierId: supplier?.id ?? null,
        payNow: willPost && canPay ? payNowBody(payNow) : null,
        __idemKey: idemKey,
      },
      {
        onSuccess: (res) => setResult({ res, vehicles: picked, currency }),
        onError: (err) => {
          const fe = sfe.fromError(err);
          if (err instanceof ApiError && FIELD_FOR_CODE[err.code])
            fe[FIELD_FOR_CODE[err.code]!] = errorMessage(err, t);
          if (fe.vehicleIds === undefined && Object.keys(fe).some((k) => k.startsWith('vehicleIds.')))
            fe.vehicleIds = t('costs.validation.invalid_value');
          setErrors(fe);
          if (!Object.keys(fe).length) setFormError(errorMessage(err, t));
        },
      },
    );
  };

  const reset = () => {
    setResult(null);
    setVehicles([]);
    setManual({});
    setDescription('');
    setTotal('');
    setRate('');
    setSupplier(null);
    setPayNow(initialPayNow);
    setErrors({});
    setFormError(null);
    setIdemKey(newIdempotencyKey());
  };

  const breadcrumbs = [{ label: t('nav.purchasing') }, { label: t('costs.allocation.navLabel') }];

  if (result) {
    const byVehicle = new Map(result.vehicles.map((v) => [v.id, v]));
    const posted = result.res.costs.filter((c) => c.status === 'posted').length;
    const pending = result.res.costs.length - posted;
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title={t('costs.allocation.result.title')} />
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-success" />{' '}
                {t('costs.allocation.result.summary', { count: result.res.costs.length })}
              </span>
            }
            subtitle={[
              posted ? `${t('costs.allocation.result.posted')}: ${posted}` : null,
              pending ? `${t('costs.allocation.result.pending')}: ${pending}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            actions={<Button onClick={reset}>{t('costs.allocation.result.again')}</Button>}
          />
          <ul className="divide-y divide-line">
            {result.res.costs.map((c) => {
              const v = byVehicle.get(c.vehicleId);
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{v?.title ?? c.vehicleId}</p>
                    <p className="num text-xs text-muted">{v?.stockNumber}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="num font-medium">{fmtMoney(c.amountBase, base)}</span>
                    {c.currency !== base && (
                      <span className="num text-xs text-muted">{fmtMoney(c.amount, c.currency)}</span>
                    )}
                    <CostStatusBadge status={c.status} />
                    <Link
                      to={`/app/vehicles/${c.vehicleId}`}
                      className="text-[13px] font-medium text-brand-strong hover:underline"
                    >
                      {t('costs.allocation.result.open')}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={t('costs.allocation.title')}
        subtitle={t('costs.allocation.subtitle')}
      />
      {formError && (
        <Alert tone="danger" className="mb-4">
          {formError}
        </Alert>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader
              title={t('costs.allocation.vehicles')}
              subtitle={t('costs.allocation.vehiclesHint')}
              actions={
                vehicles.length > 0 && (
                  <Badge tone="brand">
                    {t('costs.allocation.selectedCount', { count: vehicles.length })}
                  </Badge>
                )
              }
            />
            <CardBody className="space-y-3">
              <Field label={t('costs.allocation.addVehicle')} error={errors.vehicleIds || null}>
                {(id, desc) => (
                  <VehicleSearch
                    id={id}
                    describedBy={desc}
                    invalid={!!errors.vehicleIds}
                    onPick={addVehicle}
                    exclude={vehicles.map((v) => v.id)}
                  />
                )}
              </Field>
              {vehicles.length >= MAX && (
                <p className="text-xs text-warning">{t('costs.allocation.maxVehicles')}</p>
              )}
            </CardBody>
            {vehicles.length === 0 ? (
              <EmptyState
                icon={<Layers className="h-5 w-5" />}
                title={t('costs.allocation.noneSelected')}
                description={t('costs.allocation.noneSelectedHint')}
              />
            ) : (
              <>
                <div className="scrollbar-thin relative overflow-x-auto border-t border-line">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead>
                      <tr className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
                        <th className="px-4 py-2.5 text-start font-semibold">
                          {t('costs.allocation.vehicle')}
                        </th>
                        {method === 'by_purchase_price' && (
                          <th className="px-4 py-2.5 text-end font-semibold">
                            {t('costs.allocation.weight')}
                          </th>
                        )}
                        <th className="px-4 py-2.5 text-end font-semibold">
                          {method === 'manual'
                            ? t('costs.allocation.manualAmount')
                            : t('costs.allocation.share')}
                        </th>
                        {foreign && (
                          <th className="px-4 py-2.5 text-end font-semibold">
                            {t('costs.allocation.shareBase')}
                          </th>
                        )}
                        <th className="px-2 py-2.5">
                          <span className="sr-only">{t('common.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {vehicles.map((v, i) => {
                        const part = preview?.parts?.[i];
                        const basePart = preview?.base?.[i];
                        const err = errors[`manual.${v.id}`];
                        return (
                          <tr key={v.id} className="border-b border-line last:border-0">
                            <td className="px-4 py-2.5">
                              <p className="font-medium">{v.title}</p>
                              <p className="num text-xs text-muted">
                                {v.stockNumber}
                                {v.branchName && ` · ${v.branchName}`}
                              </p>
                            </td>
                            {method === 'by_purchase_price' && (
                              <td className="num px-4 py-2.5 text-end text-muted">
                                {weights[i] !== undefined ? fmtMoney(weights[i]!, base) : '—'}
                              </td>
                            )}
                            <td className="px-4 py-2.5 text-end">
                              {method === 'manual' ? (
                                <div className="ms-auto w-40">
                                  <MoneyInput
                                    aria-label={`${t('costs.allocation.manualAmount')} — ${v.stockNumber}`}
                                    currency={currency}
                                    invalid={!!err}
                                    value={manual[v.id] ?? ''}
                                    onChange={(e) => {
                                      setManual((x) => ({ ...x, [v.id]: e.target.value }));
                                      clearError(`manual.${v.id}`);
                                      clearError('manualAmounts');
                                    }}
                                  />
                                  {err && <p className="mt-1 text-start text-xs text-danger">{err}</p>}
                                </div>
                              ) : (
                                <span
                                  className={clsx(
                                    'num font-medium',
                                    part && d(part).isZero() && 'text-muted',
                                  )}
                                >
                                  {part ? fmtMoney(part, currency) : '—'}
                                </span>
                              )}
                            </td>
                            {foreign && (
                              <td className="num px-4 py-2.5 text-end text-muted">
                                {basePart ? fmtMoney(basePart, base) : '—'}
                              </td>
                            )}
                            <td className="px-2 py-2.5 text-end">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`${t('costs.allocation.remove')} ${v.stockNumber}`}
                                title={t('costs.allocation.remove')}
                                onClick={() => setVehicles((xs) => xs.filter((x) => x.id !== v.id))}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-2 border-t border-line px-5 py-3 text-sm">
                  {method === 'manual' && manualSum && (
                    <>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted">{t('costs.allocation.manualSum')}</span>
                        <span className="num font-medium">{fmtMoney(manualSum.toFixed(2), currency)}</span>
                      </div>
                      {manualDiff && (
                        <div className="flex justify-between gap-3">
                          <span className="text-muted">{t('costs.allocation.difference')}</span>
                          <span
                            className={clsx(
                              'num font-medium',
                              manualDiff.isZero() ? 'text-success' : 'text-danger',
                            )}
                          >
                            {manualDiff.isZero()
                              ? t('costs.allocation.balanced')
                              : fmtMoney(manualDiff.toFixed(2), currency)}
                          </span>
                        </div>
                      )}
                      {errors.manualAmounts && (
                        <p className="text-xs font-medium text-danger">{errors.manualAmounts}</p>
                      )}
                    </>
                  )}
                  {method !== 'manual' && !totalOk && (
                    <p className="text-muted">{t('costs.allocation.enterTotal')}</p>
                  )}
                  {method === 'by_purchase_price' && !canReadCosts && (
                    <p className="text-warning">{t('costs.allocation.weightsNeedPermission')}</p>
                  )}
                  {weightsLoading && <p className="text-muted">{t('costs.allocation.weightsLoading')}</p>}
                  {weightsError ? <p className="text-danger">{errorMessage(weightsError, t)}</p> : null}
                  {preview?.noWeights && (
                    <p className="text-danger">{t('costs.allocation.noPurchasePrices')}</p>
                  )}
                  {hasZero && <p className="text-muted">{t('costs.allocation.zeroSkipped')}</p>}
                  {method !== 'manual' && preview?.parts && (
                    <p className="text-xs text-subtle">{t('costs.allocation.previewHint')}</p>
                  )}
                </div>
              </>
            )}
          </Card>

          <Card>
            <CardHeader title={t('costs.allocation.method')} />
            <CardBody>
              <div
                role="radiogroup"
                aria-label={t('costs.allocation.method')}
                className="grid gap-3 md:grid-cols-3"
              >
                {ALLOCATION_METHODS.map((k) => (
                  <label
                    key={k}
                    className={clsx(
                      'flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-sm transition-colors',
                      method === k ? 'border-brand bg-brand-soft/40' : 'border-line hover:border-line-strong',
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium text-ink">
                      <input
                        type="radio"
                        name="method"
                        value={k}
                        checked={method === k}
                        onChange={() => {
                          setMethod(k);
                          clearError('method');
                        }}
                        className="accent-[var(--brand-strong)]"
                      />
                      {t(`costs.allocation.methods.${k}`)}
                    </span>
                    <span className="text-xs text-muted">{t(`costs.allocation.methodHints.${k}`)}</span>
                  </label>
                ))}
              </div>
              {errors.method && <p className="mt-2 text-xs font-medium text-danger">{errors.method}</p>}
            </CardBody>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title={t('costs.allocation.invoice')} />
          <CardBody className="space-y-4">
            <Alert tone={willPost ? 'info' : 'warning'}>
              {willPost ? t('costs.allocation.willPost') : t('costs.allocation.willPend')}
            </Alert>
            <Field label={t('costs.form.category')} required error={errors.categoryId}>
              {(id, desc) => (
                <Select
                  id={id}
                  aria-describedby={desc}
                  invalid={!!errors.categoryId}
                  value={categoryId}
                  onChange={(e) => {
                    setCategoryId(e.target.value);
                    clearError('categoryId');
                  }}
                >
                  <option value="">
                    {cats.isLoading ? t('common.loading') : t('costs.form.categoryPlaceholder')}
                  </option>
                  {cats.list.map((c) => (
                    <option key={c.id} value={c.id}>
                      {categoryName(c, i18n.language)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('costs.form.description')} required error={errors.description}>
              {(id, desc) => (
                <Input
                  id={id}
                  aria-describedby={desc}
                  invalid={!!errors.description}
                  maxLength={300}
                  placeholder={t('costs.allocation.descriptionPlaceholder')}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    clearError('description');
                  }}
                />
              )}
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
              <Field label={t('costs.allocation.total')} required error={errors.totalAmount}>
                {(id, desc) => (
                  <MoneyInput
                    id={id}
                    aria-describedby={desc}
                    invalid={!!errors.totalAmount}
                    currency={currency}
                    value={total}
                    onChange={(e) => {
                      setTotal(e.target.value);
                      clearError('totalAmount');
                    }}
                  />
                )}
              </Field>
              <Field label={t('costs.form.currency')}>
                {(id) => (
                  <Select
                    id={id}
                    value={currency}
                    onChange={(e) => {
                      setCurrency(e.target.value as CurrencyCode);
                      clearError('exchangeRate');
                    }}
                  >
                    {CURRENCY_CODES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {foreign && (
              <Field
                label={t('costs.form.exchangeRate')}
                required
                error={errors.exchangeRate}
                hint={withFxHint(
                  previewBase(total, rate, base, rounding)
                    ? t('costs.form.baseAmount', {
                        amount: fmtMoney(previewBase(total, rate, base, rounding), base),
                      })
                    : t('costs.form.exchangeRateHint', { currency, base }),
                  fxField.hint,
                )}
              >
                {(id, desc) => (
                  <Input
                    id={id}
                    dir="ltr"
                    inputMode="decimal"
                    className="num"
                    aria-describedby={desc}
                    invalid={!!errors.exchangeRate}
                    value={rate}
                    onChange={(e) => {
                      setRate(e.target.value);
                      clearError('exchangeRate');
                    }}
                  />
                )}
              </Field>
            )}
            <Field label={t('costs.form.date')} required error={errors.costDate}>
              {(id, desc) => (
                <Input
                  id={id}
                  type="date"
                  aria-describedby={desc}
                  invalid={!!errors.costDate}
                  value={costDate}
                  onChange={(e) => {
                    setCostDate(e.target.value);
                    clearError('costDate');
                  }}
                />
              )}
            </Field>
            <SupplierPicker
              label={t('costs.form.supplier')}
              hint={t('costs.form.supplierHint')}
              value={supplier}
              onChange={(x) => {
                setSupplier(x);
                clearError('supplierId');
              }}
              error={errors.supplierId}
            />
            <PayNowFields
              value={payNow}
              onChange={(x) => {
                setPayNow(x);
                clearError('payNow.cashAccountId');
              }}
              accounts={accounts.data}
              loading={accounts.isLoading}
              error={errors['payNow.cashAccountId']}
              unavailable={
                !willPost ? t('costs.payNow.needsApproval') : !canPay ? t('costs.payNow.noPermission') : null
              }
            />
            <Button className="w-full justify-center" loading={m.isPending} onClick={submit}>
              {t('costs.allocation.submit')}
            </Button>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
