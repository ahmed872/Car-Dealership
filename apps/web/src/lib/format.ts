import { CURRENCIES, CurrencyCode, d } from '@autohub/shared';
import i18n from '@/i18n';

const lang = () => (i18n.language === 'en' ? 'en' : 'ar');
// Latin digits in both languages keep financial tables unambiguous (see DECISIONS.md).
const locale = () => (lang() === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn');

export function fmtMoney(
  value: string | number | null | undefined,
  currency: CurrencyCode | string = 'SAR',
  opts: { sign?: boolean } = {},
): string {
  if (value === null || value === undefined || value === '') return '—';
  const def = CURRENCIES[currency as CurrencyCode];
  const dec = d(value);
  const fixed = dec.abs().toFixed(def?.minorUnits ?? 2);
  const [i, f] = fixed.split('.');
  const grouped = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = dec.isNegative() ? '-' : opts.sign && dec.gt(0) ? '+' : '';
  // LRI … PDI isolates the figure so signs/separators never reorder around Arabic symbols.
  const num = `\u2066${sign}${grouped}${f ? `.${f}` : ''}\u2069`;
  const sym = lang() === 'ar' ? (def?.symbolAr ?? currency) : (def?.symbolEn ?? currency);
  return lang() === 'ar' ? `${num} ${sym}` : `${sym} ${num}`;
}

export function fmtNumber(value: number | string | null | undefined, digits = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat(locale(), {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number(value));
}

export function fmtPct(value: string | number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || value === '') return '—';
  return `${fmtNumber(value, digits)}%`;
}

export function fmtDate(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, dd] = value.split('-').map(Number);
    return new Intl.DateTimeFormat(locale(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y!, m! - 1, dd)));
  }
  return new Intl.DateTimeFormat(locale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(new Date(value));
}

export function fmtDateTime(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}

export function daysSince(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

export function todayIso(timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
