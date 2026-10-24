import { convert, CurrencyCode, d, DEFAULT_FX_MAX_DEVIATION_PCT, FxSettings, TenantSettings } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { unprocessable } from '../../common/errors';

export interface Fx {
  currency: CurrencyCode;
  /** Base-currency units per one unit of `currency`, as a decimal string. */
  rate: string;
  toBase(amount: string): string;
}

/**
 * The company's FX policy. Settings stored before reference rates existed have no `fx` section;
 * they read as "no reference rates, default tolerance" (foreign amounts refused until set).
 */
export function fxSettings(settings: TenantSettings): FxSettings {
  const fx = (settings as Partial<TenantSettings>).fx;
  return { referenceRates: fx?.referenceRates ?? {}, maxDeviationPct: fx?.maxDeviationPct ?? DEFAULT_FX_MAX_DEVIATION_PCT };
}

/**
 * Refuses a stated rate for a foreign currency unless the company has a reference rate for it and
 * the rate lies within the company tolerance: |rate − reference| / reference × 100 ≤ maxDeviationPct
 * (F6: an arbitrary rate turns a small foreign receipt into a large base-currency credit).
 */
export function assertRateInBand(ctx: TenantContext, currency: CurrencyCode, rate: string): void {
  const { referenceRates, maxDeviationPct } = fxSettings(ctx.tenant.settings);
  const reference = referenceRates[currency];
  if (!reference || d(reference).lte(0)) {
    throw unprocessable(
      'fx_reference_missing',
      `No reference exchange rate is set for ${currency}; an administrator must set the ${currency} reference rate in company settings before ${currency} amounts can be recorded`,
      { currency },
    );
  }
  const deviationPct = d(rate).minus(reference).abs().dividedBy(reference).times(100);
  if (deviationPct.gt(maxDeviationPct)) {
    throw unprocessable(
      'fx_rate_out_of_band',
      `The ${currency} exchange rate ${d(rate).toString()} deviates ${deviationPct.toDecimalPlaces(2).toString()}% from the company reference rate ${reference}; at most ${maxDeviationPct}% is allowed`,
      { currency, rate: d(rate).toFixed(8), reference, maxDeviationPct, deviationPct: deviationPct.toDecimalPlaces(4).toFixed(4) },
    );
  }
}

/**
 * Resolves the exchange rate for a transaction. Base-currency transactions always use rate 1;
 * foreign-currency transactions must state their rate explicitly (no silent market lookups, and
 * no silent default to the reference rate), and the stated rate must lie within the company's
 * tolerance band around its reference rate for that currency.
 *
 * `opts.recorded`: the rate belongs to a document that was band-checked when it was recorded and
 * whose base amount is already fixed (e.g. an acquisition being approved books its stored base);
 * it is not checked again against today's reference. Never set it for a rate from the request.
 */
export function resolveFx(ctx: TenantContext, currency: CurrencyCode, rate?: string | null, opts: { recorded?: boolean } = {}): Fx {
  const base = ctx.tenant.baseCurrency;
  const mode = ctx.tenant.settings.rounding;
  if (currency === base) {
    if (rate && !d(rate).eq(1)) throw unprocessable('fx_rate_invalid', 'Base-currency amounts must use an exchange rate of 1');
    return { currency, rate: '1', toBase: (a) => convert(a, '1', base, mode) };
  }
  if (!rate || d(rate).lte(0)) {
    throw unprocessable('exchange_rate_required', `An exchange rate from ${currency} to ${base} is required`);
  }
  if (!opts.recorded) assertRateInBand(ctx, currency, rate);
  return { currency, rate: d(rate).toFixed(8), toBase: (a) => convert(a, rate, base, mode) };
}
