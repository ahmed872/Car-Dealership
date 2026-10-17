import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import {
  ACQUISITION_SOURCES,
  CONDITIONS,
  CURRENCIES,
  CURRENCY_CODES,
  PAYMENT_METHODS,
  SPEC_REGIONS,
  validateVin,
  zAcquisitionCreate,
} from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { FormSection, PageHeader } from '@/components/ui/Layout';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney, todayIso } from '@/lib/format';
import { useBranches } from '@/pages/settings/BranchesPage';
import { useMakes, useModels } from '@/features/vehicles/api';
import { AcquisitionCreated } from './api';
import { usePurchasingMutation } from './mutation';
import {
  applyServerErrors,
  emptyToNull,
  emptyToUndefined,
  isRate,
  SupplierFormModal,
  SupplierPicker,
  toBase,
  useFieldError,
  useIdempotencyKey,
  useTenantMoney,
  AmountInput,
} from './components';

type FormIn = z.input<typeof zAcquisitionCreate>;
type FormOut = z.output<typeof zAcquisitionCreate>;

/** Domain error codes the API returns for a specific field. */
const FIELD_FOR_CODE: Record<string, keyof FormIn | `vehicle.${string}`> = {
  supplier_inactive: 'supplierId',
  exchange_rate_required: 'exchangeRate',
  fx_rate_invalid: 'exchangeRate',
  branch_inactive: 'branchId',
  vin_in_stock: 'vehicle.vin',
  invalid_vin: 'vehicle.vin',
  model_make_mismatch: 'vehicle.modelId',
};

export function AcquisitionFormPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const toast = useToast();
  const { me, can } = useAuth();
  const { base, rounding, timezone } = useTenantMoney();
  const fieldError = useFieldError();
  const branches = useBranches();
  const makes = useMakes();
  const [idemKey] = useIdempotencyKey();
  const [supplierModal, setSupplierModal] = useState(false);
  const lang = i18n.language;

  // Shared schema + the cross-field rule the API enforces (foreign currency needs a rate).
  const schema = useMemo(
    () =>
      zAcquisitionCreate.superRefine((v, ctx) => {
        if (v.currency !== base && !v.exchangeRate) {
          ctx.addIssue({ code: 'custom', path: ['exchangeRate'], message: 'exchange_rate_required' });
        }
      }),
    [base],
  );
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(schema),
    defaultValues: {
      branchId: undefined,
      supplierId: params.get('supplierId') || undefined,
      sourceType: 'individual',
      purchaseDate: todayIso(timezone),
      purchasePrice: '',
      currency: base,
      exchangeRate: undefined,
      paymentMethod: null,
      dueDate: null,
      notes: '',
      submit: false,
      vehicle: {
        makeId: undefined,
        modelId: undefined,
        trim: '',
        modelYear: undefined,
        vin: '',
        vinNonStandard: false,
        plateNumber: '',
        odometerValue: undefined,
        odometerUnit: 'km',
        exteriorColor: '',
        interiorColor: '',
        specRegion: me?.tenant?.market === 'EG' ? 'local_agent' : 'gcc',
        condition: 'used',
      },
    },
  });
  const errors = form.formState.errors;
  const vErr = errors.vehicle;

  const allowedBranches = useMemo(
    () => (branches.data ?? []).filter((b) => b.isActive && (me?.allBranches || me?.branchIds.includes(b.id))),
    [branches.data, me],
  );
  useEffect(() => {
    if (!form.getValues('branchId') && allowedBranches[0]) form.setValue('branchId', allowedBranches[0].id);
  }, [allowedBranches, form]);

  const makeId = form.watch('vehicle.makeId') as string | undefined;
  const models = useModels(makeId);
  const [currency, price, rate, vin, vinNonStandard, specRegion] = form.watch([
    'currency',
    'purchasePrice',
    'exchangeRate',
    'vehicle.vin',
    'vehicle.vinNonStandard',
    'vehicle.specRegion',
  ]);
  const foreign = currency !== base;
  const baseAmount = toBase(price, currency, rate, base, rounding);
  const vinCheck = useMemo(() => {
    const raw = (vin ?? '').trim();
    if (!raw || vinNonStandard) return null;
    return validateVin(raw, { enforceCheckDigit: specRegion === 'american' || specRegion === 'canadian' });
  }, [vin, vinNonStandard, specRegion]);

  const create = usePurchasingMutation<FormOut, AcquisitionCreated>({
    path: '/acquisitions',
    idempotent: true,
    invalidate: [['acquisitions'], ['vehicles'], ['approvals']],
    success: (r) => t('purchasing.acquisitions.created', { number: r.number }),
    onSuccess: (r) => {
      if (r.vehicle.warnings.includes('check_digit')) toast.info(t('purchasing.vehicle.vinCheckWarning'));
      navigate(`/app/purchasing/acquisitions/${r.id}`, { replace: true });
    },
  });

  const submit = form.handleSubmit((values) =>
    create.mutate(
      { ...values, exchangeRate: values.currency === base ? undefined : values.exchangeRate, __idemKey: idemKey },
      {
        onError: (e) => {
          applyServerErrors(e, form.setError);
          if (e instanceof ApiError && FIELD_FOR_CODE[e.code]) {
            form.setError(FIELD_FOR_CODE[e.code] as keyof FormIn, { type: 'server', message: e.code });
          }
        },
      },
    ),
  );

  const canCreateVehicle = can('vehicles.create');
  const vehicleText = (name: 'trim' | 'plateNumber' | 'exteriorColor' | 'interiorColor', labelKey: string) => (
    <Field label={t(labelKey)} error={fieldError(vErr?.[name])}>
      {(fid, desc) => <Input id={fid} aria-describedby={desc} {...form.register(`vehicle.${name}`)} />}
    </Field>
  );

  return (
    <>
      <PageHeader
        title={t('purchasing.acquisitions.add')}
        subtitle={t('purchasing.acquisitions.addHint')}
        breadcrumbs={[{ label: t('purchasing.acquisitions.title'), to: '/app/purchasing/acquisitions' }, { label: t('purchasing.acquisitions.add') }]}
      />
      {!canCreateVehicle && (
        <Alert tone="warning" className="mb-4">
          {t('purchasing.acquisitions.needsVehicleCreate')}
        </Alert>
      )}
      <Card>
        <CardBody>
          <form id="acquisition-form" onSubmit={submit} noValidate>
            <FormSection title={t('purchasing.acquisitions.sections.purchase')} description={t('purchasing.acquisitions.sections.purchaseHint')}>
              <Field label={t('common.branch')} required error={fieldError(errors.branchId)}>
                {(fid, desc) => (
                  <Select id={fid} aria-describedby={desc} invalid={!!errors.branchId} {...form.register('branchId', { setValueAs: emptyToUndefined })}>
                    <option value="">—</option>
                    {allowedBranches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('purchasing.acquisitions.supplier')} required error={fieldError(errors.supplierId)}>
                {(fid, desc) => (
                  <div className="flex gap-2">
                    <Controller
                      control={form.control}
                      name="supplierId"
                      render={({ field }) => (
                        <SupplierPicker
                          id={fid}
                          describedBy={desc}
                          className="min-w-0 flex-1"
                          invalid={!!errors.supplierId}
                          value={field.value ?? ''}
                          onChange={(v) => field.onChange(v || undefined)}
                        />
                      )}
                    />
                    {can('suppliers.manage') && (
                      <Button
                        variant="secondary"
                        size="icon"
                        onClick={() => setSupplierModal(true)}
                        aria-label={t('purchasing.suppliers.add')}
                        title={t('purchasing.suppliers.add')}
                        icon={<Plus className="h-4 w-4" />}
                      />
                    )}
                  </div>
                )}
              </Field>
              <Field label={t('purchasing.acquisitions.sourceType')} error={fieldError(errors.sourceType)}>
                {(fid) => (
                  <Select id={fid} {...form.register('sourceType')}>
                    {ACQUISITION_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {t(`purchasing.enums.source.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('purchasing.acquisitions.purchaseDate')} required error={fieldError(errors.purchaseDate)}>
                {(fid, desc) => <Input id={fid} type="date" aria-describedby={desc} invalid={!!errors.purchaseDate} {...form.register('purchaseDate')} />}
              </Field>
              <Field label={t('purchasing.acquisitions.price')} required error={fieldError(errors.purchasePrice)}>
                {(fid, desc) => (
                  <AmountInput id={fid} aria-describedby={desc} currency={currency} invalid={!!errors.purchasePrice} {...form.register('purchasePrice', { setValueAs: emptyToUndefined })} />
                )}
              </Field>
              <Field label={t('common.currency')}>
                {(fid) => (
                  <Select
                    id={fid}
                    {...form.register('currency', {
                      onChange: (e) => {
                        if (e.target.value === base) form.setValue('exchangeRate', undefined);
                      },
                    })}
                  >
                    {CURRENCY_CODES.map((c) => (
                      <option key={c} value={c}>
                        {c} — {lang === 'en' ? CURRENCIES[c].nameEn : CURRENCIES[c].nameAr}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {foreign && (
                <Field
                  label={t('purchasing.fx.rate', { from: currency, to: base })}
                  required
                  hint={t('purchasing.fx.rateHint', { from: currency, to: base })}
                  error={fieldError(errors.exchangeRate)}
                >
                  {(fid, desc) => (
                    <Input
                      id={fid}
                      aria-describedby={desc}
                      dir="ltr"
                      inputMode="decimal"
                      className="num"
                      invalid={!!errors.exchangeRate}
                      {...form.register('exchangeRate', { setValueAs: emptyToUndefined })}
                    />
                  )}
                </Field>
              )}
              <div className="rounded-xl border border-line bg-surface-2/60 px-4 py-3 sm:col-span-2" aria-live="polite">
                <p className="text-xs text-muted">{t('purchasing.fx.baseEquivalent', { currency: base })}</p>
                <p className="num mt-0.5 text-lg font-semibold">
                  {baseAmount ? fmtMoney(baseAmount, base) : '—'}
                  {foreign && isRate(rate) && price && (
                    <span className="ms-2 text-xs font-normal text-muted">
                      ({price} × {rate})
                    </span>
                  )}
                </p>
              </div>
              <Field label={t('purchasing.acquisitions.paymentMethod')}>
                {(fid) => (
                  <Select id={fid} {...form.register('paymentMethod', { setValueAs: emptyToNull })}>
                    <option value="">—</option>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t(`purchasing.enums.method.${m}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('purchasing.acquisitions.dueDate')} hint={t('purchasing.acquisitions.dueDateHint')} error={fieldError(errors.dueDate)}>
                {(fid, desc) => <Input id={fid} type="date" aria-describedby={desc} {...form.register('dueDate', { setValueAs: emptyToNull })} />}
              </Field>
              <Field label={t('common.notes')} className="sm:col-span-2" error={fieldError(errors.notes)}>
                {(fid) => <Textarea id={fid} rows={2} {...form.register('notes')} />}
              </Field>
            </FormSection>

            <FormSection title={t('purchasing.acquisitions.sections.vehicle')} description={t('purchasing.acquisitions.sections.vehicleHint')}>
              <Field label={t('purchasing.vehicle.make')} required error={fieldError(vErr?.makeId)}>
                {(fid, desc) => (
                  <Select
                    id={fid}
                    aria-describedby={desc}
                    invalid={!!vErr?.makeId}
                    {...form.register('vehicle.makeId', { setValueAs: emptyToUndefined, onChange: () => form.setValue('vehicle.modelId', undefined as unknown as string) })}
                  >
                    <option value="">—</option>
                    {makes.data?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {lang === 'en' ? m.nameEn : `${m.nameAr} · ${m.nameEn}`}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('purchasing.vehicle.model')} required error={fieldError(vErr?.modelId)}>
                {(fid, desc) => (
                  <Select id={fid} aria-describedby={desc} disabled={!makeId} invalid={!!vErr?.modelId} {...form.register('vehicle.modelId', { setValueAs: emptyToUndefined })}>
                    <option value="">—</option>
                    {models.data?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {lang === 'en' ? m.nameEn : `${m.nameAr} · ${m.nameEn}`}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {vehicleText('trim', 'purchasing.vehicle.trim')}
              <Field label={t('purchasing.vehicle.modelYear')} required error={fieldError(vErr?.modelYear)}>
                {(fid, desc) => (
                  <Input
                    id={fid}
                    aria-describedby={desc}
                    type="number"
                    inputMode="numeric"
                    min={1950}
                    max={2100}
                    className="num"
                    invalid={!!vErr?.modelYear}
                    {...form.register('vehicle.modelYear', { setValueAs: emptyToUndefined })}
                  />
                )}
              </Field>
              <Field
                label={t('purchasing.vehicle.vin')}
                className="sm:col-span-2"
                hint={vinCheck?.warnings.includes('check_digit') ? t('purchasing.vehicle.vinCheckWarning') : undefined}
                error={vErr?.vin ? fieldError(vErr.vin) : vinCheck && !vinCheck.valid ? t('purchasing.vehicle.vinInvalid') : null}
              >
                {(fid, desc) => <Input id={fid} aria-describedby={desc} dir="ltr" className="num uppercase" maxLength={17} {...form.register('vehicle.vin')} />}
              </Field>
              <Checkbox className="sm:col-span-2" label={t('purchasing.vehicle.vinNonStandard')} {...form.register('vehicle.vinNonStandard')} />
              <Field label={t('purchasing.vehicle.odometer')} required error={fieldError(vErr?.odometerValue)}>
                {(fid, desc) => (
                  <div className="flex gap-2">
                    <Input
                      id={fid}
                      aria-describedby={desc}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      className="num min-w-0 flex-1"
                      invalid={!!vErr?.odometerValue}
                      {...form.register('vehicle.odometerValue', { setValueAs: emptyToUndefined })}
                    />
                    <Select className="w-24" aria-label={t('purchasing.vehicle.odometerUnit')} {...form.register('vehicle.odometerUnit')}>
                      <option value="km">km</option>
                      <option value="mi">mi</option>
                    </Select>
                  </div>
                )}
              </Field>
              {vehicleText('plateNumber', 'purchasing.vehicle.plateNumber')}
              {vehicleText('exteriorColor', 'purchasing.vehicle.exteriorColor')}
              {vehicleText('interiorColor', 'purchasing.vehicle.interiorColor')}
              <Field label={t('purchasing.vehicle.specRegion')}>
                {(fid) => (
                  <Select id={fid} {...form.register('vehicle.specRegion', { setValueAs: emptyToNull })}>
                    <option value="">—</option>
                    {SPEC_REGIONS.map((s) => (
                      <option key={s} value={s}>
                        {t(`purchasing.enums.specRegion.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('purchasing.vehicle.condition')}>
                {(fid) => (
                  <Select id={fid} {...form.register('vehicle.condition')}>
                    {CONDITIONS.map((c) => (
                      <option key={c} value={c}>
                        {t(`purchasing.enums.condition.${c}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </FormSection>

            <FormSection title={t('purchasing.acquisitions.sections.approval')} description={t('purchasing.acquisitions.sections.approvalHint')}>
              <Checkbox
                className="sm:col-span-2"
                label={t('purchasing.acquisitions.submitNow')}
                description={t('purchasing.acquisitions.submitNowHint')}
                {...form.register('submit')}
              />
            </FormSection>
          </form>
          <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-wrap justify-end gap-2 border-t border-line bg-surface/95 px-5 py-3 backdrop-blur">
            <Button variant="secondary" onClick={() => navigate(-1)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="acquisition-form" loading={create.isPending} disabled={!canCreateVehicle || (!!vinCheck && !vinCheck.valid)}>
              {t('purchasing.acquisitions.save')}
            </Button>
          </div>
        </CardBody>
      </Card>
      {supplierModal && (
        <SupplierFormModal
          onClose={() => setSupplierModal(false)}
          onSaved={(s) => form.setValue('supplierId', s.id, { shouldValidate: true })}
          onUseExisting={(dup) => form.setValue('supplierId', dup.id, { shouldValidate: true })}
        />
      )}
    </>
  );
}
