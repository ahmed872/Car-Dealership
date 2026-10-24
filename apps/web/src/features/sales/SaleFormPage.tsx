import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Calculator, Car, Plus, Trash2, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  addMonths,
  d,
  INSTALLMENT_METHODS,
  InstallmentMethod,
  SALE_PAYMENT_TYPES,
  Schedule,
  VehicleStatus,
  zSaleCreate,
  zSalePreview,
  zSaleUpdate,
} from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { useVehicle } from '@/features/vehicles/api';
import { VehicleStatusBadge, vehicleTitle } from '@/features/vehicles/components';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtPct } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';
import { useAssignableMembers } from '@/lib/members';
import { InstallmentTerms, SaleDetail, SalePaymentType, SalePreview, useSale } from './api';
import { CustomerPicker, VehiclePicker } from './pickers';
import {
  AmountInput,
  FailureAlert,
  isMoney,
  Money,
  Row,
  serverFieldErrors,
  sumMoney,
  useFieldMessage,
  useSalesError,
  useSalesMutation,
  useTenantMoney,
  vehicleSnapshotTitle,
  zodFieldErrors,
} from './shared';
import { emptyTradeIn, TradeInDraft, TradeInFields, tradeInBody, validateTradeIn } from './TradeInFields';

const EDITABLE = ['draft', 'pending_approval', 'approved'];
const FREQUENCIES = ['1', '2', '3', '6', '12'] as const;

interface FormState {
  vehicleId: string;
  customerId: string;
  salespersonId: string;
  saleDate: string;
  paymentType: SalePaymentType;
  agreedPrice: string;
  downPayment: string;
  method: InstallmentMethod;
  annualRatePct: string;
  count: string;
  frequencyMonths: (typeof FREQUENCIES)[number];
  firstDueDate: string;
  feesTotal: string;
  efProvider: string;
  efReference: string;
  efAmount: string;
  tradeIns: TradeInDraft[];
  notes: string;
}

interface VehicleInfo {
  id: string;
  title: string;
  stockNumber: string;
  vin: string | null;
  status: VehicleStatus | null;
  askingPrice: string | null;
  /** Decides who may be the salesperson (they must reach the vehicle's branch). */
  branchId: string | null;
}

function termsOf(s: FormState): InstallmentTerms {
  return {
    method: s.method,
    annualRatePct: s.method === 'zero_interest' ? '0' : s.annualRatePct.trim(),
    count: s.count.trim() === '' ? 0 : Number(s.count),
    frequencyMonths: Number(s.frequencyMonths) as InstallmentTerms['frequencyMonths'],
    firstDueDate: s.firstDueDate,
    ...(s.feesTotal.trim() ? { feesTotal: s.feesTotal.trim() } : {}),
  };
}

function paymentFields(s: FormState) {
  return {
    paymentType: s.paymentType,
    downPayment: s.paymentType === 'installments' ? s.downPayment.trim() : null,
    installmentTerms: s.paymentType === 'installments' ? termsOf(s) : null,
    externalFinance:
      s.paymentType === 'external_finance' ? { provider: s.efProvider.trim(), reference: s.efReference.trim() || null, amount: s.efAmount.trim() } : null,
  };
}

export function SaleFormPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const sale = useSale(id);
  if (!id) return <SaleForm sale={null} onReload={() => undefined} />;
  if (sale.isLoading) return <PageLoader />;
  if (sale.error || !sale.data) {
    return (
      <Card>
        <ErrorState error={sale.error} onRetry={() => sale.refetch()} />
      </Card>
    );
  }
  if (!EDITABLE.includes(sale.data.status)) {
    return (
      <Card>
        <EmptyState
          title={t('sales.form.notEditable')}
          description={t('sales.form.notEditableHint', { status: t(`sales.status.${sale.data.status}`) })}
          action={
            <Link to={`/app/sales/${sale.data.id}`} className="text-sm font-medium text-brand-strong hover:underline">
              {t('sales.form.backToSale')}
            </Link>
          }
        />
      </Card>
    );
  }
  // Re-mount on a new version so a reload after a conflict starts from the stored values.
  return <SaleForm key={sale.data.version} sale={sale.data} onReload={() => void sale.refetch()} />;
}

function SaleForm({ sale, onReload }: { sale: SaleDetail | null; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { me, can } = useAuth();
  const { base, today } = useTenantMoney();
  const fm = useFieldMessage();
  const describe = useSalesError();
  const settings = me?.tenant?.settings;
  const installmentsEnabled = !!settings?.installments.enabled;
  const isEdit = !!sale;

  const [s, setS] = useState<FormState>(() => {
    const terms = sale?.installmentTerms;
    return {
      vehicleId: sale?.vehicleId ?? params.get('vehicleId') ?? '',
      customerId: sale?.customerId ?? params.get('customerId') ?? '',
      salespersonId: sale?.salespersonId ?? me?.user.id ?? '',
      saleDate: sale?.saleDate ?? today,
      paymentType: sale?.paymentType ?? 'cash',
      agreedPrice: sale?.agreedPrice ?? '',
      downPayment: sale?.downPayment ?? '',
      method: terms?.method ?? (settings?.installments.defaultMethod as InstallmentMethod | undefined) ?? 'flat',
      annualRatePct: terms?.annualRatePct ?? '',
      count: terms ? String(terms.count) : '12',
      frequencyMonths: terms ? (String(terms.frequencyMonths) as FormState['frequencyMonths']) : '1',
      firstDueDate: terms?.firstDueDate ?? addMonths(today, 1),
      feesTotal: terms?.feesTotal ?? '',
      efProvider: sale?.externalFinance?.provider ?? '',
      efReference: sale?.externalFinance?.reference ?? '',
      efAmount: sale?.externalFinance?.amount ?? '',
      tradeIns: [],
      notes: sale?.notes ?? '',
    };
  });
  const set = (patch: Partial<FormState>) => setS((prev) => ({ ...prev, ...patch }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);

  // ── Vehicle and customer labels (picked, prefilled from ?vehicleId= / ?customerId=, or the sale) ──
  const [vehicle, setVehicle] = useState<VehicleInfo | null>(
    sale
      ? {
          id: sale.vehicleId,
          title: vehicleSnapshotTitle(sale.vehicleSnapshot, i18n.language),
          stockNumber: sale.vehicleSnapshot.stockNumber,
          vin: sale.vehicleSnapshot.vin,
          status: null,
          askingPrice: sale.askingPrice,
          branchId: sale.branchId,
        }
      : null,
  );
  const [customerName, setCustomerName] = useState(sale?.customerSnapshot.fullName ?? '');
  const prefillVehicle = useVehicle(!sale && s.vehicleId && vehicle?.id !== s.vehicleId ? s.vehicleId : undefined);
  useEffect(() => {
    const v = prefillVehicle.data;
    if (v && v.vehicle.id === s.vehicleId) {
      setVehicle({
        id: v.vehicle.id,
        title: vehicleTitle({ modelYear: v.vehicle.modelYear, makeNameEn: v.make.nameEn, makeNameAr: v.make.nameAr, modelNameEn: v.model.nameEn, modelNameAr: v.model.nameAr, trim: v.vehicle.trim }, i18n.language),
        stockNumber: v.vehicle.stockNumber,
        vin: v.vehicle.vin,
        status: v.vehicle.status,
        askingPrice: v.vehicle.askingPrice,
        branchId: v.vehicle.branchId,
      });
    }
  }, [prefillVehicle.data, s.vehicleId, i18n.language]);
  const prefillCustomer = useApi<{ customer: { id: string; fullName: string } }>(
    ['customer', s.customerId],
    !sale && s.customerId && !customerName ? `/customers/${s.customerId}` : null,
  );
  useEffect(() => {
    if (prefillCustomer.data && prefillCustomer.data.customer.id === s.customerId) setCustomerName(prefillCustomer.data.customer.fullName);
  }, [prefillCustomer.data, s.customerId]);

  // Selling on behalf of someone else needs leads.assign; the staff who may sell (sales.create) in
  // the vehicle's branch come from GET /members/assignable.
  const canAssign = can('leads.assign');
  const members = useAssignableMembers('sales.create', vehicle?.branchId ?? sale?.branchId ?? null, canAssign);
  const activeMembers = members.data ?? [];

  // ── Preview (debounced POST /sales/preview) ──
  const pendingTradeInTotal = sale
    ? sumMoney(sale.tradeIns.filter((x) => x.status !== 'cancelled').map((x) => x.agreedValue))
    : sumMoney(s.tradeIns.map((x) => x.agreedValue));
  const previewBody = {
    vehicleId: s.vehicleId,
    customerId: s.customerId,
    agreedPrice: s.agreedPrice.trim(),
    ...(s.saleDate ? { saleDate: s.saleDate } : {}),
    ...paymentFields(s),
    ...(d(pendingTradeInTotal).gt(0) ? { tradeInTotal: pendingTradeInTotal } : {}),
  };
  const previewReady = zSalePreview.safeParse(previewBody).success;
  const previewKey = useDebounced(previewReady ? JSON.stringify(previewBody) : '', 450);
  const preview = useQuery<SalePreview>({
    queryKey: ['sale-preview', previewKey],
    queryFn: ({ signal }) => api<SalePreview>('/sales/preview', { method: 'POST', body: JSON.parse(previewKey), signal }),
    enabled: previewKey !== '' && can('sales.create'),
    retry: false,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // ── Submit ──
  const create = useSalesMutation<Record<string, unknown>, SaleDetail>({
    path: '/sales',
    toastError: false,
    invalidate: [['sales'], ['vehicle'], ['vehicles']],
    success: (r) => t('sales.form.created', { number: r.number }),
    onSuccess: (r) => navigate(`/app/sales/${r.id}`),
  });
  const update = useSalesMutation<Record<string, unknown>, SaleDetail>({
    path: `/sales/${sale?.id}`,
    method: 'PATCH',
    toastError: false,
    invalidate: [['sales'], ['sale', sale?.id]],
    success: t('sales.form.updated'),
    onSuccess: (r) => navigate(`/app/sales/${r.id}`),
  });

  const buildEditBody = (): Record<string, unknown> => {
    const ef = sale?.externalFinance;
    // Re-sending unchanged external-finance terms would reset the provider's decision to pending.
    const efUnchanged =
      sale?.paymentType === 'external_finance' &&
      s.paymentType === 'external_finance' &&
      !!ef &&
      ef.provider === s.efProvider.trim() &&
      (ef.reference ?? '') === s.efReference.trim() &&
      isMoney(s.efAmount) &&
      d(ef.amount).eq(s.efAmount.trim());
    return {
      agreedPrice: s.agreedPrice.trim(),
      saleDate: s.saleDate || undefined,
      notes: s.notes.trim() || null,
      ...(efUnchanged ? {} : paymentFields(s)),
      ...(canAssign && s.salespersonId && s.salespersonId !== sale?.salespersonId ? { salespersonId: s.salespersonId } : {}),
      version: sale!.version,
    };
  };

  const submit = () => {
    setFailure(null);
    const errs: Record<string, string> = {};
    let body: Record<string, unknown>;
    if (sale) {
      body = buildEditBody();
      const r = zSaleUpdate.safeParse(body);
      if (!r.success) Object.assign(errs, zodFieldErrors(r.error.issues));
    } else {
      body = {
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        agreedPrice: s.agreedPrice.trim(),
        saleDate: s.saleDate || undefined,
        ...paymentFields(s),
        ...(canAssign && s.salespersonId && s.salespersonId !== me?.user.id ? { salespersonId: s.salespersonId } : {}),
        tradeIns: s.tradeIns.map(tradeInBody),
        notes: s.notes.trim() || null,
      };
      s.tradeIns.forEach((x, i) => {
        for (const [k, v] of Object.entries(validateTradeIn(x))) errs[`tradeIns.${i}.${k}`] = v;
      });
      const r = zSaleCreate.safeParse(body);
      if (!r.success) for (const [k, v] of Object.entries(zodFieldErrors(r.error.issues))) errs[k] ??= v;
      if (!s.vehicleId) errs.vehicleId = 'required';
      if (!s.customerId) errs.customerId = 'required';
    }
    if (!s.agreedPrice.trim()) errs.agreedPrice = 'required';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const onError = (e: unknown) => {
      setFailure(e);
      setErrors(serverFieldErrors(e));
    };
    if (sale) update.mutate(body, { onError });
    else create.mutate(body, { onError });
  };

  const err = (path: string) => fm(errors[path]);
  const tradeInErrors = (i: number) => {
    const prefix = `tradeIns.${i}.`;
    return Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
  };

  const title = sale ? t('sales.form.editTitle', { number: sale.number }) : t('sales.form.newTitle');
  const reservedNote = vehicle?.status === 'reserved';
  const unsellable = vehicle?.status && !['available', 'reserved', 'sale_pending'].includes(vehicle.status);

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: t('sales.title'), to: '/app/sales' },
          ...(sale ? [{ label: sale.number, to: `/app/sales/${sale.id}` }] : []),
          { label: sale ? t('common.edit') : t('sales.new') },
        ]}
        title={title}
        subtitle={sale ? undefined : t('sales.form.subtitle')}
      />

      {sale?.status === 'pending_approval' && (
        <Alert tone="warning" className="mb-4">
          {t('sales.form.editPendingWarning')}
        </Alert>
      )}
      {sale?.status === 'approved' && (
        <Alert tone="info" className="mb-4">
          {t('sales.form.editApprovedWarning')}
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          {failure !== null && <FailureAlert error={failure} onReload={onReload} />}

          <Card>
            <CardHeader title={t('sales.form.sections.parties')} subtitle={t('sales.form.sections.partiesHint')} />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label={t('sales.fields.vehicle')} required error={err('vehicleId')} className="sm:col-span-2">
                {(id, desc) =>
                  sale ? (
                    <Input id={id} value={`${vehicle?.title ?? ''} · ${vehicle?.stockNumber ?? ''}`} disabled />
                  ) : (
                    <VehiclePicker
                      id={id}
                      describedBy={desc}
                      invalid={!!errors.vehicleId}
                      value={s.vehicleId}
                      selectedLabel={vehicle && vehicle.id === s.vehicleId ? `${vehicle.title} · ${vehicle.stockNumber}` : ''}
                      onSelect={(v) => {
                        set({ vehicleId: v.id });
                        setVehicle({ id: v.id, title: vehicleTitle(v, i18n.language), stockNumber: v.stockNumber, vin: v.vin, status: v.status, askingPrice: v.askingPrice, branchId: v.branchId });
                      }}
                      onClear={() => {
                        set({ vehicleId: '' });
                        setVehicle(null);
                      }}
                    />
                  )
                }
              </Field>
              {vehicle && vehicle.id === s.vehicleId && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm sm:col-span-2">
                  <Car className="h-4 w-4 text-muted" aria-hidden />
                  <span className="font-medium">{vehicle.title}</span>
                  <span className="num text-muted">{vehicle.stockNumber}</span>
                  {vehicle.vin && <span className="num text-xs text-muted">{vehicle.vin}</span>}
                  {vehicle.status && <VehicleStatusBadge status={vehicle.status} />}
                  <span className="ms-auto text-muted">
                    {t('sales.fields.askingPrice')}: <Money value={vehicle.askingPrice} className="font-medium text-ink" />
                  </span>
                </div>
              )}
              {!sale && prefillVehicle.error ? (
                <Alert tone="danger" className="sm:col-span-2">
                  {describe(prefillVehicle.error)}
                </Alert>
              ) : null}
              {reservedNote && (
                <Alert tone="info" className="sm:col-span-2">
                  {t('sales.form.reservedNote')}
                </Alert>
              )}
              {unsellable && (
                <Alert tone="warning" className="sm:col-span-2">
                  {t('sales.form.unsellableNote')}
                </Alert>
              )}
              <Field label={t('sales.fields.customer')} required error={err('customerId')}>
                {(id, desc) =>
                  sale ? (
                    <Input id={id} value={customerName} disabled />
                  ) : (
                    <CustomerPicker
                      id={id}
                      describedBy={desc}
                      invalid={!!errors.customerId}
                      value={s.customerId}
                      selectedLabel={customerName}
                      onSelect={(c) => {
                        set({ customerId: c.id });
                        setCustomerName(c.fullName);
                      }}
                      onClear={() => {
                        set({ customerId: '' });
                        setCustomerName('');
                      }}
                    />
                  )
                }
              </Field>
              <Field label={t('sales.fields.saleDate')} error={err('saleDate')}>
                {(id) => <Input id={id} type="date" value={s.saleDate} onChange={(e) => set({ saleDate: e.target.value })} />}
              </Field>
              {canAssign && (
                <Field label={t('sales.fields.salesperson')} hint={t('sales.form.salespersonHint')} error={err('salespersonId')}>
                  {(id, desc) => (
                    <Select id={id} aria-describedby={desc} value={s.salespersonId} onChange={(e) => set({ salespersonId: e.target.value })}>
                      {/* The current salesperson stays selectable even when outside the list. */}
                      {!activeMembers.some((m) => m.id === s.salespersonId) && (
                        <option value={s.salespersonId}>{s.salespersonId === sale?.salespersonId ? (sale.salespersonName ?? '—') : me?.user.fullName}</option>
                      )}
                      {activeMembers.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.fullName}
                          {m.id === me?.user.id ? ` (${t('sales.form.you')})` : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('sales.form.sections.price')} subtitle={t('sales.form.sections.priceHint')} />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('sales.fields.agreedPrice')}
                required
                error={err('agreedPrice')}
                hint={settings?.tax.pricesIncludeTax ? t('sales.form.priceIncludesTax') : t('sales.form.priceExcludesTax')}
              >
                {(id, desc) => (
                  <AmountInput id={id} aria-describedby={desc} currency={base} value={s.agreedPrice} invalid={!!errors.agreedPrice} onChange={(e) => set({ agreedPrice: e.target.value })} />
                )}
              </Field>
              <div className="sm:col-span-2">
                <p className="label">{t('sales.fields.paymentType')}</p>
                <div role="radiogroup" aria-label={t('sales.fields.paymentType')} className="grid gap-2 sm:grid-cols-3">
                  {SALE_PAYMENT_TYPES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={s.paymentType === p}
                      onClick={() => set({ paymentType: p })}
                      className={clsx(
                        'rounded-xl border px-4 py-3 text-start text-sm transition-colors',
                        s.paymentType === p ? 'border-brand bg-brand-soft text-ink' : 'border-line hover:border-line-strong',
                      )}
                    >
                      <span className="block font-medium">{t(`sales.paymentType.${p}`)}</span>
                      <span className="mt-0.5 block text-xs text-muted">{t(`sales.form.paymentTypeHint.${p}`)}</span>
                    </button>
                  ))}
                </div>
                {s.paymentType === 'installments' && !installmentsEnabled && (
                  <Alert tone="warning" className="mt-3">
                    {t('sales.form.installmentsOffHint')}
                  </Alert>
                )}
              </div>

              {s.paymentType === 'installments' && (
                <>
                  <Field label={t('sales.fields.downPayment')} required error={err('downPayment')} hint={t('sales.form.downPaymentHint')}>
                    {(id, desc) => (
                      <AmountInput id={id} aria-describedby={desc} currency={base} value={s.downPayment} invalid={!!errors.downPayment} onChange={(e) => set({ downPayment: e.target.value })} />
                    )}
                  </Field>
                  <Field label={t('sales.fields.instMethod')} error={err('installmentTerms.method')}>
                    {(id) => (
                      <Select id={id} value={s.method} onChange={(e) => set({ method: e.target.value as InstallmentMethod })}>
                        {INSTALLMENT_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {t(`sales.instMethod.${m}`)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('sales.fields.annualRate')} required={s.method !== 'zero_interest'} error={err('installmentTerms.annualRatePct')}>
                    {(id) => (
                      <Input
                        id={id}
                        dir="ltr"
                        inputMode="decimal"
                        className="num"
                        disabled={s.method === 'zero_interest'}
                        value={s.method === 'zero_interest' ? '0' : s.annualRatePct}
                        invalid={!!errors['installmentTerms.annualRatePct']}
                        onChange={(e) => set({ annualRatePct: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label={t('sales.fields.count')} required error={err('installmentTerms.count')}>
                    {(id) => (
                      <Input
                        id={id}
                        dir="ltr"
                        inputMode="numeric"
                        className="num"
                        maxLength={3}
                        value={s.count}
                        invalid={!!errors['installmentTerms.count']}
                        onChange={(e) => set({ count: e.target.value.replace(/\D/g, '') })}
                      />
                    )}
                  </Field>
                  <Field label={t('sales.fields.frequency')}>
                    {(id) => (
                      <Select id={id} value={s.frequencyMonths} onChange={(e) => set({ frequencyMonths: e.target.value as FormState['frequencyMonths'] })}>
                        {FREQUENCIES.map((f) => (
                          <option key={f} value={f}>
                            {t(`sales.frequency.m${f}`)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('sales.fields.firstDueDate')} required error={err('installmentTerms.firstDueDate')}>
                    {(id) => <Input id={id} type="date" value={s.firstDueDate} onChange={(e) => set({ firstDueDate: e.target.value })} />}
                  </Field>
                  <Field label={t('sales.fields.feesTotal')} hint={t('sales.form.feesHint')} error={err('installmentTerms.feesTotal')}>
                    {(id, desc) => (
                      <AmountInput id={id} aria-describedby={desc} currency={base} value={s.feesTotal} invalid={!!errors['installmentTerms.feesTotal']} onChange={(e) => set({ feesTotal: e.target.value })} />
                    )}
                  </Field>
                </>
              )}

              {s.paymentType === 'external_finance' && (
                <>
                  <Field label={t('sales.fields.efProvider')} required error={err('externalFinance.provider')}>
                    {(id) => <Input id={id} maxLength={120} value={s.efProvider} invalid={!!errors['externalFinance.provider']} onChange={(e) => set({ efProvider: e.target.value })} />}
                  </Field>
                  <Field label={t('sales.fields.efReference')} error={err('externalFinance.reference')}>
                    {(id) => <Input id={id} maxLength={80} value={s.efReference} onChange={(e) => set({ efReference: e.target.value })} />}
                  </Field>
                  <Field label={t('sales.fields.efAmount')} required error={err('externalFinance.amount')} hint={t('sales.form.efAmountHint')}>
                    {(id, desc) => (
                      <AmountInput id={id} aria-describedby={desc} currency={base} value={s.efAmount} invalid={!!errors['externalFinance.amount']} onChange={(e) => set({ efAmount: e.target.value })} />
                    )}
                  </Field>
                  {isEdit && sale?.externalFinance?.status === 'approved' && (
                    <Alert tone="info" className="sm:col-span-2">
                      {t('sales.form.efDecisionKept')}
                    </Alert>
                  )}
                </>
              )}
            </CardBody>
          </Card>

          {!sale ? (
            <Card>
              <CardHeader
                title={t('sales.form.sections.tradeIns')}
                subtitle={t('sales.form.sections.tradeInsHint')}
                actions={
                  s.tradeIns.length < 3 && (
                    <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => set({ tradeIns: [...s.tradeIns, emptyTradeIn()] })}>
                      {t('sales.tradeIn.add')}
                    </Button>
                  )
                }
              />
              {s.tradeIns.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">{t('sales.tradeIn.none')}</p>
              ) : (
                <div className="divide-y divide-line">
                  {s.tradeIns.map((x, i) => (
                    <div key={x.key} className="p-5">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold">{t('sales.tradeIn.numbered', { n: i + 1 })}</h3>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          icon={<Trash2 className="h-4 w-4" />}
                          onClick={() => set({ tradeIns: s.tradeIns.filter((y) => y.key !== x.key) })}
                        >
                          {t('common.delete')}
                        </Button>
                      </div>
                      <TradeInFields value={x} errors={tradeInErrors(i)} onChange={(v) => set({ tradeIns: s.tradeIns.map((y) => (y.key === x.key ? v : y)) })} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ) : (
            <Alert tone="info">{t('sales.form.tradeInsOnDetail')}</Alert>
          )}

          <Card>
            <CardBody>
              <Field label={t('common.notes')} error={err('notes')}>
                {(id) => <Textarea id={id} rows={3} maxLength={2000} value={s.notes} onChange={(e) => set({ notes: e.target.value })} />}
              </Field>
            </CardBody>
          </Card>

        </div>

        <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <PreviewPanel
            ready={previewReady}
            loading={preview.isFetching}
            error={preview.error}
            data={preview.data && previewKey ? preview.data : undefined}
            paymentType={s.paymentType}
            tradeInTotal={pendingTradeInTotal}
            hasReservation={reservedNote || !!sale?.reservationId}
            customer={customerName}
          />
        </aside>
      </div>
      {/* After the grid so the calculation comes before the actions on phones. */}
      <div className="mt-5 flex flex-wrap justify-end gap-2 lg:me-[400px]">
        <Button variant="secondary" onClick={() => navigate(sale ? `/app/sales/${sale.id}` : '/app/sales')}>
          {t('common.cancel')}
        </Button>
        <Button onClick={submit} loading={create.isPending || update.isPending}>
          {sale ? t('common.save') : t('sales.form.create')}
        </Button>
      </div>
    </>
  );
}

function PreviewPanel({
  ready,
  loading,
  error,
  data,
  paymentType,
  tradeInTotal,
  hasReservation,
  customer,
}: {
  ready: boolean;
  loading: boolean;
  error: unknown;
  data: SalePreview | undefined;
  paymentType: SalePaymentType;
  tradeInTotal: string;
  hasReservation: boolean;
  customer: string;
}) {
  const { t } = useTranslation();
  const describe = useSalesError();
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Calculator className="h-4 w-4 text-muted" aria-hidden />
            {t('sales.preview.title')}
          </span>
        }
        actions={loading ? <Spinner label={t('sales.preview.updating')} /> : undefined}
      />
      <CardBody className="space-y-4">
        {customer && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <UserRound className="h-4 w-4" aria-hidden />
            <span className="truncate">{customer}</span>
          </p>
        )}
        {!ready && <p className="text-sm text-muted">{t('sales.preview.notReady')}</p>}
        {ready && error ? <Alert tone="danger">{describe(error)}</Alert> : null}
        {ready && !error && data && (
          <>
            <dl className="divide-y divide-line">
              <Row label={t('sales.fields.askingPrice')}>
                <Money value={data.askingPrice} />
              </Row>
              <Row label={t('sales.fields.agreedPrice')}>
                <Money value={data.agreedPrice} />
              </Row>
              <Row label={t('sales.fields.discount')} tone={d(data.discountAmount).gt(0) ? 'warning' : undefined}>
                <Money value={data.discountAmount} /> <span className="num text-xs">({fmtPct(data.discountPct, 2)})</span>
              </Row>
              <Row label={t('sales.fields.net')}>
                <Money value={data.netAmount} />
              </Row>
              <Row label={t('sales.fields.taxWithRate', { rate: fmtPct(data.taxRatePct, 2) })}>
                <Money value={data.taxAmount} />
              </Row>
              <Row label={t('sales.fields.gross')} strong>
                <Money value={data.grossAmount} />
              </Row>
              {paymentType === 'installments' && (
                <>
                  <Row label={t('sales.fields.downPayment')}>
                    <Money value={data.downPayment} />
                  </Row>
                  <Row label={t('sales.fields.financed')}>
                    <Money value={data.financedAmount} />
                  </Row>
                </>
              )}
              {d(tradeInTotal).gt(0) && (
                <Row label={t('sales.fields.tradeInCredit')}>
                  <Money value={tradeInTotal} />
                </Row>
              )}
              <Row label={t('sales.fields.dueBeforeDelivery')} strong>
                <Money value={data.dueBeforeDelivery} />
              </Row>
            </dl>
            {data.taxMode !== 'none' && <p className="text-xs text-muted">{t(`sales.preview.taxMode.${data.taxMode}`, { defaultValue: '' })}</p>}
            {hasReservation && <p className="text-xs text-muted">{t('sales.preview.depositNote')}</p>}
            {data.requiresApproval ? (
              <Alert tone="warning" title={t('sales.preview.needsApproval')}>
                {data.approvalPermission === 'sales.approve_below_floor' ? t('sales.preview.belowFloor') : t('sales.preview.overLimit')}
              </Alert>
            ) : (
              <Alert tone="success">{t('sales.preview.withinLimit')}</Alert>
            )}
            {data.schedule && <ScheduleSummary schedule={data.schedule} />}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function ScheduleSummary({ schedule }: { schedule: Schedule }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const lines = all ? schedule.lines : schedule.lines.slice(0, 6);
  const tot = schedule.totals;
  const lineTotal = useMemo(() => schedule.lines[0]?.total, [schedule]);
  return (
    <div className="rounded-xl border border-line">
      <div className="border-b border-line px-4 py-3">
        <p className="text-sm font-semibold">{t('sales.preview.schedule')}</p>
        <p className="mt-0.5 text-xs text-muted">
          {t('sales.preview.scheduleSummary', { n: schedule.lines.length })} <Money value={lineTotal} />
        </p>
      </div>
      <dl className="divide-y divide-line px-4">
        <Row label={t('sales.fields.principal')}>
          <Money value={tot.principal} />
        </Row>
        <Row label={t('sales.fields.interest')}>
          <Money value={tot.interest} />
        </Row>
        {d(tot.fees).gt(0) && (
          <Row label={t('sales.fields.fees')}>
            <Money value={tot.fees} />
          </Row>
        )}
        <Row label={t('sales.preview.totalPayable')} strong>
          <Money value={tot.total} />
        </Row>
      </dl>
      <div className="scrollbar-thin overflow-x-auto border-t border-line">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-2/60 text-muted">
              <th className="px-3 py-2 text-start font-semibold">#</th>
              <th className="px-3 py-2 text-start font-semibold">{t('sales.fields.dueDate')}</th>
              <th className="px-3 py-2 text-end font-semibold">{t('sales.fields.interest')}</th>
              <th className="px-3 py-2 text-end font-semibold">{t('sales.fields.installment')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.seq} className="border-t border-line">
                <td className="num px-3 py-1.5">{l.seq}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(l.dueDate)}</td>
                <td className="px-3 py-1.5 text-end">
                  <Money value={l.interest} />
                </td>
                <td className="px-3 py-1.5 text-end font-medium">
                  <Money value={l.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {schedule.lines.length > 6 && (
        <div className="border-t border-line px-3 py-2 text-center">
          <Button size="sm" variant="ghost" onClick={() => setAll((x) => !x)}>
            {all ? t('sales.preview.showLess') : t('sales.preview.showAll', { n: schedule.lines.length })}
          </Button>
        </div>
      )}
    </div>
  );
}
