import type { TaxMode } from '../markets';
import { CurrencyCode, Dec, RoundingMode, d, money, roundMoney } from '../money';

export interface TaxInput {
  amount: string;
  amountIncludesTax: boolean;
  mode: TaxMode;
  ratePct: string;
  /** Vehicle cost — required for the margin scheme. */
  cost?: string;
  currency: CurrencyCode;
  rounding?: RoundingMode;
}

export interface TaxResult {
  net: string;
  tax: string;
  gross: string;
  /** Amount the rate was applied to (net price, or margin for the margin scheme). */
  taxableBase: string;
}

/**
 * Line-level tax. This is a calculation utility, not a certification of compliance with any
 * tax authority (see docs/DECISIONS.md B-009).
 */
export function computeTax(input: TaxInput): TaxResult {
  const { currency: cur } = input;
  const mode = input.rounding ?? 'half_up';
  const amount = roundMoney(input.amount, cur, mode);
  const rate = d(input.ratePct);
  if (rate.isNegative()) throw new Error('Tax rate cannot be negative');
  if (amount.isNegative()) throw new Error('Amount cannot be negative');

  if (input.mode === 'none' || rate.isZero()) {
    const s = money(amount, cur, mode);
    return { net: s, tax: money(0, cur), gross: s, taxableBase: s };
  }

  if (input.mode === 'standard') {
    if (input.amountIncludesTax) {
      const tax = roundMoney(amount.times(rate).dividedBy(rate.plus(100)), cur, mode);
      const net = amount.minus(tax);
      return { net: money(net, cur), tax: money(tax, cur), gross: money(amount, cur), taxableBase: money(net, cur) };
    }
    const tax = roundMoney(amount.times(rate).dividedBy(100), cur, mode);
    return { net: money(amount, cur), tax: money(tax, cur), gross: money(amount.plus(tax), cur), taxableBase: money(amount, cur) };
  }

  // Margin scheme: tax applies only to the positive margin over the vehicle's cost.
  if (input.cost === undefined) throw new Error('Margin scheme requires the vehicle cost');
  const cost = roundMoney(input.cost, cur, mode);
  const margin = Dec.max(amount.minus(cost), 0);
  if (input.amountIncludesTax) {
    const tax = roundMoney(margin.times(rate).dividedBy(rate.plus(100)), cur, mode);
    return {
      net: money(amount.minus(tax), cur),
      tax: money(tax, cur),
      gross: money(amount, cur),
      taxableBase: money(margin.minus(tax), cur),
    };
  }
  const tax = roundMoney(margin.times(rate).dividedBy(100), cur, mode);
  return { net: money(amount, cur), tax: money(tax, cur), gross: money(amount.plus(tax), cur), taxableBase: money(margin, cur) };
}
