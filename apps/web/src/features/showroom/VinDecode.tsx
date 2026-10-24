import { ScanLine } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { UseFormSetValue } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useShowroomError, VinSuggestion } from './api';

type VehicleFormValues = Record<string, string | boolean | string[]>;

/**
 * Applies a VIN suggestion to the vehicle form: make, model, model year and trim (only values the
 * decoder returned and the catalog knows). The model is set once the new make's models have loaded.
 */
export function useVinApply(setValue: UseFormSetValue<VehicleFormValues>, models: Array<{ id: string }> | undefined) {
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  useEffect(() => {
    if (pendingModel && models?.some((m) => m.id === pendingModel)) {
      setValue('modelId', pendingModel, { shouldDirty: true });
      setPendingModel(null);
    }
  }, [pendingModel, models, setValue]);
  return useCallback(
    (s: VinSuggestion) => {
      if (s.makeId) {
        setValue('makeId', s.makeId, { shouldDirty: true });
        setValue('modelId', '');
        setPendingModel(s.modelId);
      }
      if (s.modelYear) setValue('modelYear', String(s.modelYear), { shouldDirty: true });
      if (s.trim) setValue('trim', s.trim, { shouldDirty: true });
    },
    [setValue],
  );
}

/** "Decode VIN" next to the VIN field: shows the decoder's suggestions; nothing changes until applied. */
export function VinDecodeButton({ vin, onApply }: { vin: string; onApply: (s: VinSuggestion) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const describe = useShowroomError();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VinSuggestion | null>(null);
  const value = vin.trim().toUpperCase();
  const ready = value.length === 17;

  const decode = async () => {
    setBusy(true);
    try {
      setResult(await api<VinSuggestion>(`/integrations/vin-decode/${encodeURIComponent(value)}`));
    } catch (e) {
      toast.error(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const rows: Array<[string, string | number | null, boolean?]> = result
    ? [
        ['make', result.make, !!result.make && !result.makeId],
        ['model', result.model, !!result.model && !result.modelId],
        ['modelYear', result.modelYear],
        ['trim', result.trim],
        ['bodyClass', result.bodyClass],
        ['fuelType', result.fuelType],
        ['transmission', result.transmission],
        ['engine', result.engine],
        ['driveType', result.driveType],
        ['doors', result.doors],
        ['plantCountry', result.plantCountry],
      ]
    : [];
  const empty = result && rows.every(([, v]) => v === null || v === '');

  return (
    <>
      <Button variant="secondary" icon={<ScanLine className="h-4 w-4" />} loading={busy} disabled={!ready} title={ready ? undefined : t('showroom.vin.needVin')} onClick={decode}>
        {busy ? t('showroom.vin.decoding') : t('showroom.vin.decode')}
      </Button>
      <Modal
        open={result !== null}
        onClose={() => setResult(null)}
        title={t('showroom.vin.title')}
        description={t('showroom.vin.source')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResult(null)}>
              {t('common.close')}
            </Button>
            <Button
              disabled={!result || (!result.makeId && !result.modelYear && !result.trim)}
              onClick={() => {
                if (result) onApply(result);
                setResult(null);
                toast.success(t('showroom.vin.applied'));
              }}
            >
              {t('showroom.vin.apply')}
            </Button>
          </>
        }
      >
        {result && (
          <div className="space-y-3">
            <p dir="ltr" className="num text-start text-sm font-medium tracking-wide">
              {result.vin}
            </p>
            {empty ? (
              <Alert tone="info">{t('showroom.vin.nothing')}</Alert>
            ) : (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {rows
                  .filter(([, v]) => v !== null && v !== '')
                  .map(([k, v, missing]) => (
                    <div key={k} className="min-w-0">
                      <dt className="text-xs text-muted">{t(`showroom.vin.${k}`)}</dt>
                      <dd className="text-sm break-words" dir="auto">
                        {v}
                      </dd>
                      {missing && <dd className="text-xs text-warning">{t('showroom.vin.notInCatalog')}</dd>}
                    </div>
                  ))}
              </dl>
            )}
            {result.warnings && (
              <div>
                <p className="text-xs text-muted">{t('showroom.vin.warnings')}</p>
                <p lang="en" dir="ltr" className="text-start text-xs">
                  {result.warnings}
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
