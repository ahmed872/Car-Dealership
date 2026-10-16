import Decimal from 'decimal.js';

/**
 * All monetary arithmetic goes through this module. Amounts travel as strings
 * ("150000.00") and are never converted to JS numbers for calculation.
 */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });
export type Dec = Decimal;
export type DecimalInput = Decimal.Value;

export const CURRENCY_CODES = ['EGP', 'SAR', 'AED', 'USD', 'EUR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export interface CurrencyDef {
  code: CurrencyCode;
  minorUnits: number;
  symbolEn: string;
  symbolAr: string;
  nameEn: string;
  nameAr: string;
}

export const CURRENCIES: Record<CurrencyCode, CurrencyDef> = {
  EGP: { code: 'EGP', minorUnits: 2, symbolEn: 'EGP', symbolAr: 'ج.م', nameEn: 'Egyptian Pound', nameAr: 'جنيه مصري' },
  SAR: { code: 'SAR', minorUnits: 2, symbolEn: 'SAR', symbolAr: 'ر.س', nameEn: 'Saudi Riyal', nameAr: 'ريال سعودي' },
  AED: { code: 'AED', minorUnits: 2, symbolEn: 'AED', symbolAr: 'د.إ', nameEn: 'UAE Dirham', nameAr: 'درهم إماراتي' },
  USD: { code: 'USD', minorUnits: 2, symbolEn: 'USD', symbolAr: 'دولار', nameEn: 'US Dollar', nameAr: 'دولار أمريكي' },
  EUR: { code: 'EUR', minorUnits: 2, symbolEn: 'EUR', symbolAr: 'يورو', nameEn: 'Euro', nameAr: 'يورو' },
};

export const ROUNDING_MODES = ['half_up', 'half_even', 'down', 'up'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

const ROUNDING_MAP: Record<RoundingMode, Decimal.Rounding> = {
  half_up: Decimal.ROUND_HALF_UP,
  half_even: Decimal.ROUND_HALF_EVEN,
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
};

/** Strict format accepted at API boundaries: up to 16 integer digits and 2 decimals. */
export const MONEY_REGEX = /^-?\d{1,16}(\.\d{1,2})?$/;
export const RATE_REGEX = /^\d{1,10}(\.\d{1,8})?$/;
export const PERCENT_REGEX = /^-?\d{1,5}(\.\d{1,4})?$/;

export function d(value: DecimalInput): Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite number');
  if (typeof value === 'string' && value.trim() === '') return new Dec(0);
  return new Dec(value);
}

export function minorUnits(currency: CurrencyCode): number {
  const def = CURRENCIES[currency];
  if (!def) throw new Error(`Unsupported currency ${currency}`);
  return def.minorUnits;
}

export function roundMoney(value: DecimalInput, currency: CurrencyCode, mode: RoundingMode = 'half_up'): Decimal {
  return d(value).toDecimalPlaces(minorUnits(currency), ROUNDING_MAP[mode]);
}

/** Fixed-scale string representation suitable for numeric(18,2) columns and JSON. */
export function money(value: DecimalInput, currency: CurrencyCode, mode: RoundingMode = 'half_up'): string {
  return roundMoney(value, currency, mode).toFixed(minorUnits(currency));
}

export function sum(values: Iterable<DecimalInput>): Decimal {
  let total = new Dec(0);
  for (const v of values) total = total.plus(d(v));
  return total;
}

export function isZero(value: DecimalInput): boolean {
  return d(value).isZero();
}

export function cmp(a: DecimalInput, b: DecimalInput): -1 | 0 | 1 {
  return d(a).comparedTo(d(b)) as -1 | 0 | 1;
}

export function max(a: DecimalInput, b: DecimalInput): Decimal {
  return Decimal.max(d(a), d(b));
}

export function min(a: DecimalInput, b: DecimalInput): Decimal {
  return Decimal.min(d(a), d(b));
}

/** pct is a percentage (e.g. "15" for 15%). */
export function percentOf(amount: DecimalInput, pct: DecimalInput): Decimal {
  return d(amount).times(d(pct)).dividedBy(100);
}

/** Converts a foreign-currency amount to the base currency using `rate` (base units per 1 foreign unit). */
export function convert(
  amount: DecimalInput,
  rate: DecimalInput,
  toCurrency: CurrencyCode,
  mode: RoundingMode = 'half_up',
): string {
  if (d(rate).lte(0)) throw new Error('Exchange rate must be positive');
  return money(d(amount).times(d(rate)), toCurrency, mode);
}

/**
 * Splits `total` across `weights` so that the parts sum EXACTLY to the rounded total
 * (largest-remainder method). Used for shared-cost allocation and schedule splits.
 */
export function allocateProportionally(
  total: DecimalInput,
  weights: DecimalInput[],
  currency: CurrencyCode,
): string[] {
  if (weights.length === 0) throw new Error('No allocation targets');
  const scale = minorUnits(currency);
  const unit = new Dec(1).dividedBy(new Dec(10).pow(scale));
  const totalRounded = roundMoney(total, currency);
  const ws = weights.map((w) => d(w));
  if (ws.some((w) => w.isNegative())) throw new Error('Weights must be non-negative');
  const weightSum = sum(ws);
  const effective = weightSum.isZero() ? ws.map(() => new Dec(1)) : ws;
  const effSum = weightSum.isZero() ? new Dec(ws.length) : weightSum;

  const raw = effective.map((w) => totalRounded.times(w).dividedBy(effSum));
  const floored = raw.map((r) => r.toDecimalPlaces(scale, Decimal.ROUND_DOWN));
  let remainder = totalRounded.minus(sum(floored));
  const order = raw
    .map((r, i) => ({ i, frac: r.minus(floored[i]!) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  const result = [...floored];
  const step = totalRounded.isNegative() ? unit.negated() : unit;
  let k = 0;
  while (!remainder.isZero() && k < order.length * 2) {
    const idx = order[k % order.length]!.i;
    result[idx] = result[idx]!.plus(step);
    remainder = remainder.minus(step);
    k++;
  }
  return result.map((r) => r.toFixed(scale));
}

export function splitEvenly(total: DecimalInput, parts: number, currency: CurrencyCode): string[] {
  if (!Number.isInteger(parts) || parts <= 0) throw new Error('parts must be a positive integer');
  return allocateProportionally(
    total,
    Array.from({ length: parts }, () => 1),
    currency,
  );
}

export function isValidMoney(value: string): boolean {
  return MONEY_REGEX.test(value);
}

/** Locale-aware display formatting (UI only — never feed the result back into calculations). */
export function formatMoney(value: DecimalInput, currency: CurrencyCode, locale: 'ar' | 'en' = 'en'): string {
  const def = CURRENCIES[currency];
  const fixed = roundMoney(value, currency).toFixed(def.minorUnits);
  const [intPart, frac] = fixed.replace('-', '').split('.');
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = fixed.startsWith('-') ? '-' : '';
  const num = `${sign}${grouped}${frac ? `.${frac}` : ''}`;
  return locale === 'ar' ? `${num} ${def.symbolAr}` : `${def.symbolEn} ${num}`;
}
