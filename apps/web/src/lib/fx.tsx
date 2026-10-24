import { ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { d } from '@autohub/shared';
import { useAuth } from './auth';
import { useApi } from './hooks';

/** The part of GET /company this module reads. GET /company always includes `fx` (older /auth/me settings may not). */
interface CompanyFx {
  settings: { fx?: { referenceRates?: Record<string, string>; maxDeviationPct?: string } };
}

/** The rates the API accepts for a currency: reference ± maxDeviationPct, rounded inwards to 8 places. */
export interface FxBand {
  reference: string;
  min: string;
  max: string;
  maxDeviationPct: string;
}

const ROUND_UP = 0;
const ROUND_DOWN = 1;
/** Numbers inside a sentence keep their left-to-right order in Arabic (Unicode isolate). */
const ltr = (v: string) => `⁦${v}⁩`;

/** The company's FX policy (reference rates and tolerance) from GET /company. */
export function useFxPolicy() {
  const { currency: base } = useAuth();
  const q = useApi<CompanyFx>(['company'], '/company', undefined, { staleTime: 5 * 60_000 });
  const fx = q.data?.settings.fx;
  const band = (currency: string | null | undefined): FxBand | null => {
    if (!currency || currency === base || !fx) return null;
    const reference = fx.referenceRates?.[currency];
    if (!reference || !d(reference).gt(0)) return null;
    const pct = d(fx.maxDeviationPct ?? '0');
    const share = pct.div(100);
    return {
      reference: d(reference).toFixed(),
      min: d(reference).times(d(1).minus(share)).toDecimalPlaces(8, ROUND_UP).toFixed(),
      max: d(reference).times(d(1).plus(share)).toDecimalPlaces(8, ROUND_DOWN).toFixed(),
      maxDeviationPct: pct.toFixed(),
    };
  };
  return { base, loaded: !!q.data, band };
}

/**
 * A foreign-currency rate field: prefilled with the company reference rate while the user has not
 * typed one (also when the currency changes), plus a hint with the range the API accepts. The rate
 * stays editable and is always sent explicitly; the API enforces the band (fx_rate_out_of_band).
 */
export function useFxRateField(currency: string | null | undefined, rate: string, setRate: (v: string) => void) {
  const { t } = useTranslation();
  const fx = useFxPolicy();
  const band = fx.band(currency);
  const autoFilled = useRef<string | null>(null);
  useEffect(() => {
    if (!band) return;
    if (rate.trim() === '' || rate === autoFilled.current) {
      autoFilled.current = band.reference;
      if (rate !== band.reference) setRate(band.reference);
    }
    // Only a change of currency or reference rate prefills; typing never does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, band?.reference]);
  const foreign = !!currency && currency !== fx.base;
  const hint = !foreign || !fx.loaded
    ? undefined
    : band
      ? t('fx.band', { min: ltr(band.min), max: ltr(band.max), pct: ltr(band.maxDeviationPct), ref: ltr(band.reference) })
      : t('fx.noReference', { currency });
  return { band, hint };
}

/** A field hint followed, on its own line, by the allowed-rate hint (when there is one). */
export function withFxHint(primary: ReactNode, fxHint: string | undefined): ReactNode {
  if (!fxHint) return primary;
  if (!primary) return fxHint;
  return (
    <>
      <span className="block">{primary}</span>
      <span className="block">{fxHint}</span>
    </>
  );
}
