import { convert, CurrencyCode, d } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { unprocessable } from '../../common/errors';

export interface Fx {
  currency: CurrencyCode;
  /** Base-currency units per one unit of `currency`, as a decimal string. */
  rate: string;
  toBase(amount: string): string;
}

/**
 * Resolves the exchange rate for a transaction. Base-currency transactions always use rate 1;
 * foreign-currency transactions must state their rate explicitly (no silent market lookups).
 */
export function resolveFx(ctx: TenantContext, currency: CurrencyCode, rate?: string | null): Fx {
  const base = ctx.tenant.baseCurrency;
  const mode = ctx.tenant.settings.rounding;
  if (currency === base) {
    if (rate && !d(rate).eq(1)) throw unprocessable('fx_rate_invalid', 'Base-currency amounts must use an exchange rate of 1');
    return { currency, rate: '1', toBase: (a) => convert(a, '1', base, mode) };
  }
  if (!rate || d(rate).lte(0)) {
    throw unprocessable('exchange_rate_required', `An exchange rate from ${currency} to ${base} is required`);
  }
  return { currency, rate: d(rate).toFixed(8), toBase: (a) => convert(a, rate, base, mode) };
}
