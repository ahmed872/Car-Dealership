import { useTranslation } from 'react-i18next';
import { d, isValidMoney, SPEC_REGIONS, validateVin } from '@autohub/shared';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { useMakes, useModels } from '@/features/vehicles/api';
import { useFieldMessage, useTenantMoney } from './shared';

/** A trade-in as edited in the form (strings until submitted). */
export interface TradeInDraft {
  key: string;
  agreedValue: string;
  makeId: string;
  modelId: string;
  modelYear: string;
  odometerValue: string;
  odometerUnit: 'km' | 'mi';
  exteriorColor: string;
  specRegion: string;
  vin: string;
  notes: string;
}

export function emptyTradeIn(): TradeInDraft {
  return {
    key: crypto.randomUUID(),
    agreedValue: '',
    makeId: '',
    modelId: '',
    modelYear: '',
    odometerValue: '',
    odometerUnit: 'km',
    exteriorColor: '',
    specRegion: '',
    vin: '',
    notes: '',
  };
}

/** zTradeInInput body (agreed value, vehicle per zTradeInVehicle, notes). */
export function tradeInBody(x: TradeInDraft) {
  return {
    agreedValue: x.agreedValue.trim(),
    vehicle: {
      makeId: x.makeId,
      modelId: x.modelId,
      modelYear: x.modelYear.trim() === '' ? undefined : Number(x.modelYear),
      odometerValue: x.odometerValue.trim() === '' ? undefined : Number(x.odometerValue),
      odometerUnit: x.odometerUnit,
      exteriorColor: x.exteriorColor.trim() || null,
      specRegion: x.specRegion || null,
      vin: x.vin.trim() || null,
      condition: 'used' as const,
    },
    notes: x.notes.trim() || null,
  };
}

/**
 * Client checks mirroring the API (zTradeInInput) and the VIN rules the vehicle is created with at
 * confirmation, so a bad trade-in is caught now rather than when the sale is confirmed.
 */
export function validateTradeIn(x: TradeInDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!x.agreedValue.trim()) e.agreedValue = 'required';
  else if (!isValidMoney(x.agreedValue.trim())) e.agreedValue = 'invalid_amount';
  else if (!d(x.agreedValue.trim()).gt(0)) e.agreedValue = 'must_be_positive';
  if (!x.makeId) e['vehicle.makeId'] = 'required';
  if (!x.modelId) e['vehicle.modelId'] = 'required';
  const year = Number(x.modelYear);
  if (!x.modelYear.trim()) e['vehicle.modelYear'] = 'required';
  else if (!Number.isInteger(year) || year < 1950 || year > 2100) e['vehicle.modelYear'] = 'invalid_year';
  const odo = Number(x.odometerValue);
  if (!x.odometerValue.trim()) e['vehicle.odometerValue'] = 'required';
  else if (!Number.isInteger(odo) || odo < 0 || odo > 3_000_000) e['vehicle.odometerValue'] = 'invalid';
  const vin = x.vin.trim();
  if (vin) {
    if (year && year < 1981) {
      if (!/^[A-Z0-9]{5,17}$/.test(vin)) e['vehicle.vin'] = 'invalid_vin';
    } else if (!validateVin(vin, { enforceCheckDigit: x.specRegion === 'american' || x.specRegion === 'canadian' }).valid) {
      e['vehicle.vin'] = 'invalid_vin';
    }
  }
  return e;
}

/**
 * Fields of one trade-in. `errors` is keyed by the API path relative to the trade-in
 * (`agreedValue`, `vehicle.modelYear`, …).
 */
export function TradeInFields({
  value,
  onChange,
  errors,
}: {
  value: TradeInDraft;
  onChange: (v: TradeInDraft) => void;
  errors: Record<string, string>;
}) {
  const { t, i18n } = useTranslation();
  const { base } = useTenantMoney();
  const fm = useFieldMessage();
  const makes = useMakes();
  const models = useModels(value.makeId || null);
  const set = (patch: Partial<TradeInDraft>) => onChange({ ...value, ...patch });
  const name = (x: { nameEn: string; nameAr: string }) => (i18n.language === 'en' ? x.nameEn : x.nameAr);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label={t('sales.tradeIn.agreedValue')} required error={fm(errors.agreedValue)} hint={t('sales.tradeIn.agreedValueHint')}>
        {(id, desc) => (
          <MoneyInput id={id} aria-describedby={desc} currency={base} value={value.agreedValue} invalid={!!errors.agreedValue} onChange={(e) => set({ agreedValue: e.target.value })} />
        )}
      </Field>
      <Field label={t('vehicles.make')} required error={fm(errors['vehicle.makeId'])}>
        {(id) => (
          <Select id={id} value={value.makeId} invalid={!!errors['vehicle.makeId']} onChange={(e) => set({ makeId: e.target.value, modelId: '' })}>
            <option value="">{t('sales.tradeIn.chooseMake')}</option>
            {(makes.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {name(m)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('vehicles.model')} required error={fm(errors['vehicle.modelId'])}>
        {(id) => (
          <Select id={id} value={value.modelId} disabled={!value.makeId} invalid={!!errors['vehicle.modelId']} onChange={(e) => set({ modelId: e.target.value })}>
            <option value="">{t('sales.tradeIn.chooseModel')}</option>
            {(models.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {name(m)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('vehicles.modelYear')} required error={fm(errors['vehicle.modelYear'])}>
        {(id) => (
          <Input id={id} dir="ltr" inputMode="numeric" className="num" maxLength={4} value={value.modelYear} invalid={!!errors['vehicle.modelYear']} onChange={(e) => set({ modelYear: e.target.value.replace(/\D/g, '') })} />
        )}
      </Field>
      <Field label={t('vehicles.odometer')} required error={fm(errors['vehicle.odometerValue'])}>
        {(id) => (
          <div className="flex gap-2">
            <Input
              id={id}
              dir="ltr"
              inputMode="numeric"
              className="num min-w-0 flex-1"
              value={value.odometerValue}
              invalid={!!errors['vehicle.odometerValue']}
              onChange={(e) => set({ odometerValue: e.target.value.replace(/\D/g, '') })}
            />
            <Select aria-label={t('vehicles.odometerUnit')} className="w-24" value={value.odometerUnit} onChange={(e) => set({ odometerUnit: e.target.value as 'km' | 'mi' })}>
              <option value="km">{t('sales.tradeIn.km')}</option>
              <option value="mi">{t('sales.tradeIn.mi')}</option>
            </Select>
          </div>
        )}
      </Field>
      <Field label={t('vehicles.exteriorColor')} error={fm(errors['vehicle.exteriorColor'])}>
        {(id) => <Input id={id} maxLength={40} value={value.exteriorColor} onChange={(e) => set({ exteriorColor: e.target.value })} />}
      </Field>
      <Field label={t('vehicles.specRegion')} error={fm(errors['vehicle.specRegion'])}>
        {(id) => (
          <Select id={id} value={value.specRegion} onChange={(e) => set({ specRegion: e.target.value })}>
            <option value="">—</option>
            {SPEC_REGIONS.map((s) => (
              <option key={s} value={s}>
                {t(`vehicles.enums.specRegion.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('vehicles.vin')} error={fm(errors['vehicle.vin'])} className="lg:col-span-2">
        {(id) => <Input id={id} dir="ltr" className="num uppercase" maxLength={20} value={value.vin} invalid={!!errors['vehicle.vin']} onChange={(e) => set({ vin: e.target.value.toUpperCase() })} />}
      </Field>
      <Field label={t('common.notes')} className="sm:col-span-2 lg:col-span-3">
        {(id) => <Textarea id={id} rows={2} maxLength={500} value={value.notes} onChange={(e) => set({ notes: e.target.value })} />}
      </Field>
    </div>
  );
}
