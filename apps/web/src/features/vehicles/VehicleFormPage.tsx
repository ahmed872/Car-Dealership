import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BODY_TYPES,
  CONDITIONS,
  DOCUMENTS_STATUSES,
  DRIVETRAINS,
  FUEL_TYPES,
  OWNERSHIP_STATUSES,
  SPEC_REGIONS,
  TRANSMISSIONS,
  validateVin,
  WARRANTY_TYPES,
} from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { FormSection, PageHeader } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { useFeatures, useMakes, useModels, useVehicle, Vehicle } from './api';
import { useStatusLabel } from './components';
import { useVinApply, VinDecodeButton } from '@/features/showroom/VinDecode';

type FormValues = Record<string, string | boolean | string[]>;

const NUMERIC = ['modelYear', 'registrationYear', 'doors', 'seats', 'engineCapacityCc', 'cylinders', 'horsepower', 'odometerValue'];

function toPayload(v: FormValues, isEdit: boolean) {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed === '') out[k] = isEdit ? null : undefined;
      else out[k] = NUMERIC.includes(k) ? Number(trimmed) : trimmed;
    } else out[k] = val;
  }
  return out;
}

function QuickAdd({ kind, makeId, onDone }: { kind: 'make' | 'model'; makeId?: string; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const add = useApiMutation<Record<string, string>, { id: string }>({
    path: kind === 'make' ? '/catalog/makes' : '/catalog/models',
    invalidate: [['catalog']],
    onSuccess: (r) => onDone(r.id),
  });
  return (
    <div className="space-y-4">
      <Field label={t('vehicles.nameEn')} required>
        {(id) => <Input id={id} dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
      </Field>
      <Field label={t('vehicles.nameAr')} required>
        {(id) => <Input id={id} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
      </Field>
      <div className="flex justify-end">
        <Button loading={add.isPending} disabled={!nameEn.trim() || !nameAr.trim()} onClick={() => add.mutate(kind === 'make' ? { nameEn, nameAr } : { nameEn, nameAr, makeId: makeId! })}>
          {t('common.add')}
        </Button>
      </div>
    </div>
  );
}

export function VehicleFormPage() {
  const { id } = useParams();
  const isEdit = !!id;
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const existing = useVehicle(id);
  const branches = useBranches();
  const makes = useMakes();
  const features = useFeatures();
  const [quickAdd, setQuickAdd] = useState<'make' | 'model' | null>(null);
  const statusLabel = useStatusLabel();
  const lang = i18n.language;

  const form = useForm<FormValues>({
    defaultValues: {
      branchId: '',
      condition: 'used',
      odometerUnit: 'km',
      ownershipStatus: 'owned',
      documentsStatus: 'pending',
      warrantyType: 'none',
      initialStatus: 'incoming',
      specRegion: me?.tenant?.market === 'EG' ? 'local_agent' : 'gcc',
      vinNonStandard: false,
      featureIds: [],
    },
  });
  const makeId = form.watch('makeId') as string | undefined;
  const models = useModels(makeId);
  const applyVin = useVinApply(form.setValue, models.data);

  useEffect(() => {
    if (!isEdit && branches.data?.length && !form.getValues('branchId')) {
      const allowed = me?.allBranches ? branches.data : branches.data.filter((b) => me?.branchIds.includes(b.id));
      if (allowed[0]) form.setValue('branchId', allowed[0].id);
    }
  }, [branches.data, isEdit, form, me]);

  useEffect(() => {
    if (!existing.data) return;
    const v = existing.data.vehicle as Vehicle & Record<string, unknown>;
    const values: FormValues = { featureIds: existing.data.features.map((f) => f.id), vinNonStandard: false };
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number') values[k] = String(val);
      else if (typeof val === 'string' || typeof val === 'boolean') values[k] = val;
      else if (val === null) values[k] = '';
    }
    form.reset(values);
  }, [existing.data, form]);

  const vin = (form.watch('vin') as string) ?? '';
  const vinCheck = useMemo(() => {
    if (!vin || form.watch('vinNonStandard')) return null;
    return validateVin(vin, { enforceCheckDigit: ['american', 'canadian'].includes(form.watch('specRegion') as string) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vin, form.watch('vinNonStandard'), form.watch('specRegion')]);

  const save = useApiMutation<Record<string, unknown>, { id: string }>({
    path: isEdit ? `/vehicles/${id}` : '/vehicles',
    method: isEdit ? 'PATCH' : 'POST',
    invalidate: [['vehicles'], ['vehicle', id]],
    onSuccess: (r) => navigate(`/app/vehicles/${isEdit ? id : r.id}`),
  });
  const setFeatures = useApiMutation<{ featureIds: string[] }>({ path: `/vehicles/${id}/features`, method: 'PUT', success: null });

  if (isEdit && existing.isLoading) return <PageLoader />;
  if (isEdit && existing.error) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />;

  const enumSelect = (name: string, values: readonly string[], enumKey: string, opts: { allowEmpty?: boolean } = {}) => (
    <Field label={t(`vehicles.${name === 'engineCapacityCc' ? 'engineCapacity' : name}`)}>
      {(fid) => (
        <Select id={fid} {...form.register(name)}>
          {opts.allowEmpty !== false && <option value="">—</option>}
          {values.map((v) => (
            <option key={v} value={v}>
              {t(`vehicles.enums.${enumKey}.${v}`)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  const text = (name: string, opts: { dir?: 'ltr'; type?: string; required?: boolean; labelKey?: string } = {}) => (
    <Field label={t(`vehicles.${opts.labelKey ?? name}`)} required={opts.required}>
      {(fid) => <Input id={fid} dir={opts.dir} type={opts.type} className={opts.type === 'number' ? 'num' : undefined} {...form.register(name)} />}
    </Field>
  );

  const submit = form.handleSubmit(async (values) => {
    const payload = toPayload(values, isEdit);
    if (isEdit) {
      const { featureIds, branchId: _b, odometerValue: _o, odometerUnit: _u, initialStatus: _i, ...rest } = payload as Record<string, unknown>;
      for (const k of ['id', 'tenantId', 'stockNumber', 'status', 'statusChangedAt', 'stockedAt', 'createdAt', 'updatedAt', 'createdBy', 'askingPrice', 'minPrice', 'targetMarginPct', 'priceUpdatedAt', 'acquisitionId', 'supplierId', 'costLockedAt', 'removedReason']) {
        delete rest[k];
      }
      rest.version = existing.data!.vehicle.version;
      await setFeatures.mutateAsync({ featureIds: featureIds as string[] });
      save.mutate(rest);
    } else save.mutate(payload);
  });

  const featuresByCat = (features.data ?? []).reduce<Record<string, typeof features.data>>((acc, f) => {
    (acc[f.category] ??= []).push(f);
    return acc;
  }, {});
  const selectedFeatures = (form.watch('featureIds') as string[]) ?? [];

  return (
    <>
      <PageHeader
        title={isEdit ? t('vehicles.edit') : t('vehicles.add')}
        subtitle={isEdit ? existing.data?.vehicle.stockNumber : undefined}
        breadcrumbs={[{ label: t('nav.vehicles'), to: '/app/vehicles' }, { label: isEdit ? t('vehicles.edit') : t('vehicles.add') }]}
      />
      <Card>
        <CardBody>
          <form id="vehicle-form" onSubmit={submit} noValidate>
            <FormSection title={t('vehicles.sections.basic')} description={t('vehicles.sections.basicHint')}>
              {!isEdit && (
                <Field label={t('vehicles.branch')} required>
                  {(fid) => (
                    <Select id={fid} {...form.register('branchId', { required: true })}>
                      {branches.data
                        ?.filter((b) => b.isActive && (me?.allBranches || me?.branchIds.includes(b.id)))
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
              )}
              {enumSelect('condition', CONDITIONS, 'condition', { allowEmpty: false })}
              <Field label={t('vehicles.make')} required>
                {(fid) => (
                  <div className="flex gap-2">
                    <Select id={fid} {...form.register('makeId', { required: true, onChange: () => form.setValue('modelId', '') })}>
                      <option value="">—</option>
                      {makes.data?.map((m) => (
                        <option key={m.id} value={m.id}>
                          {lang === 'en' ? m.nameEn : `${m.nameAr} · ${m.nameEn}`}
                        </option>
                      ))}
                    </Select>
                    {can('vehicles.create') && <Button variant="secondary" size="icon" onClick={() => setQuickAdd('make')} aria-label={t('vehicles.addMake')} icon={<Plus className="h-4 w-4" />} />}
                  </div>
                )}
              </Field>
              <Field label={t('vehicles.model')} required>
                {(fid) => (
                  <div className="flex gap-2">
                    <Select id={fid} disabled={!makeId} {...form.register('modelId', { required: true })}>
                      <option value="">—</option>
                      {models.data?.map((m) => (
                        <option key={m.id} value={m.id}>
                          {lang === 'en' ? m.nameEn : `${m.nameAr} · ${m.nameEn}`}
                        </option>
                      ))}
                    </Select>
                    {can('vehicles.create') && (
                      <Button variant="secondary" size="icon" disabled={!makeId} onClick={() => setQuickAdd('model')} aria-label={t('vehicles.addModel')} icon={<Plus className="h-4 w-4" />} />
                    )}
                  </div>
                )}
              </Field>
              {text('trim')}
              {text('modelYear', { type: 'number', required: true })}
              <Field
                label={t('vehicles.vin')}
                className="sm:col-span-2"
                hint={vinCheck?.warnings.includes('check_digit') ? t('vehicles.vinCheckWarning') : undefined}
                error={vinCheck && !vinCheck.valid ? t('vehicles.vinInvalid') : null}
              >
                {(fid, d) => (
                  <div className="flex gap-2">
                    <Input id={fid} aria-describedby={d} dir="ltr" className="num min-w-0 flex-1 uppercase" maxLength={17} {...form.register('vin')} />
                    {!isEdit && can('vehicles.create') && <VinDecodeButton vin={vin} onApply={applyVin} />}
                  </div>
                )}
              </Field>
              <Checkbox className="sm:col-span-2" label={t('vehicles.vinNonStandard')} {...form.register('vinNonStandard')} />
              {text('engineNumber', { dir: 'ltr' })}
            </FormSection>

            <FormSection title={t('vehicles.sections.registration')}>
              {text('plateNumber')}
              {text('plateRegion')}
              {text('registrationYear', { type: 'number' })}
            </FormSection>

            <FormSection title={t('vehicles.sections.specs')}>
              {enumSelect('bodyType', BODY_TYPES, 'bodyType')}
              {enumSelect('fuelType', FUEL_TYPES, 'fuelType')}
              {enumSelect('transmission', TRANSMISSIONS, 'transmission')}
              {enumSelect('drivetrain', DRIVETRAINS, 'drivetrain')}
              {text('engineCapacityCc', { type: 'number', labelKey: 'engineCapacity' })}
              {text('cylinders', { type: 'number' })}
              {text('horsepower', { type: 'number' })}
              {text('doors', { type: 'number' })}
              {text('seats', { type: 'number' })}
              {text('exteriorColor')}
              {text('interiorColor')}
            </FormSection>

            <FormSection title={t('vehicles.sections.mileage')}>
              {!isEdit && (
                <>
                  {text('odometerValue', { type: 'number', required: true, labelKey: 'odometer' })}
                  <Field label={t('vehicles.odometerUnit')}>
                    {(fid) => (
                      <Select id={fid} {...form.register('odometerUnit')}>
                        <option value="km">km</option>
                        <option value="mi">mi</option>
                      </Select>
                    )}
                  </Field>
                </>
              )}
              {enumSelect('specRegion', SPEC_REGIONS, 'specRegion')}
              {text('originCountry')}
            </FormSection>

            <FormSection title={t('vehicles.sections.ownership')}>
              {enumSelect('ownershipStatus', OWNERSHIP_STATUSES, 'ownershipStatus', { allowEmpty: false })}
              {enumSelect('documentsStatus', DOCUMENTS_STATUSES, 'documentsStatus', { allowEmpty: false })}
              {enumSelect('warrantyType', WARRANTY_TYPES, 'warrantyType', { allowEmpty: false })}
              {text('warrantyUntil', { type: 'date' })}
              {text('acquiredAt', { type: 'date' })}
              {!isEdit && (
                <Field label={t('vehicles.initialStatus')}>
                  {(fid) => (
                    <Select id={fid} {...form.register('initialStatus')}>
                      {(['incoming', 'awaiting_inspection', 'in_preparation'] as const).map((s) => (
                        <option key={s} value={s}>
                          {statusLabel(s)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
            </FormSection>

            <FormSection title={t('vehicles.sections.notes')}>
              {text('locationLabel', { labelKey: 'location' })}
              <span />
              <Field label={t('vehicles.internalNotes')} className="sm:col-span-2">
                {(fid) => <Textarea id={fid} rows={3} {...form.register('internalNotes')} />}
              </Field>
            </FormSection>

            <FormSection title={t('vehicles.sections.features')}>
              <div className="space-y-4 sm:col-span-2">
                {Object.entries(featuresByCat).map(([cat, list]) => (
                  <fieldset key={cat}>
                    <legend className="mb-2 text-[13px] font-semibold text-muted">{t(`vehicles.enums.featureCategory.${cat}`)}</legend>
                    <div className="flex flex-wrap gap-2">
                      {list!.map((f) => {
                        const on = selectedFeatures.includes(f.id);
                        return (
                          <button
                            key={f.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              form.setValue('featureIds', on ? selectedFeatures.filter((x) => x !== f.id) : [...selectedFeatures, f.id], { shouldDirty: true })
                            }
                            className={
                              on
                                ? 'rounded-full border border-brand bg-brand-soft px-3 py-1 text-[13px] font-medium text-ink'
                                : 'rounded-full border border-line px-3 py-1 text-[13px] text-muted hover:border-line-strong hover:text-ink'
                            }
                          >
                            {on && '✓ '}
                            {lang === 'en' ? f.nameEn : f.nameAr}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>
            </FormSection>
          </form>
          {save.error ? <Alert tone="danger" className="mt-4">{t('errors.validation_failed')}</Alert> : null}
          <div className="sticky bottom-0 -mx-5 -mb-5 flex justify-end gap-2 border-t border-line bg-surface/95 px-5 py-3 backdrop-blur">
            <Button variant="secondary" onClick={() => navigate(-1)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="vehicle-form" loading={save.isPending || setFeatures.isPending} disabled={!!vinCheck && !vinCheck.valid}>
              {t('common.save')}
            </Button>
          </div>
        </CardBody>
      </Card>
      <Modal open={quickAdd !== null} onClose={() => setQuickAdd(null)} title={quickAdd === 'make' ? t('vehicles.addMake') : t('vehicles.addModel')} size="sm">
        {quickAdd && (
          <QuickAdd
            kind={quickAdd}
            makeId={makeId}
            onDone={(newId) => {
              form.setValue(quickAdd === 'make' ? 'makeId' : 'modelId', newId);
              if (quickAdd === 'make') form.setValue('modelId', '');
              setQuickAdd(null);
            }}
          />
        )}
      </Modal>
    </>
  );
}
