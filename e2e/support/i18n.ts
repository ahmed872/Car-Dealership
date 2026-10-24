import { CURRENCIES, type CurrencyCode, d } from '@autohub/shared';
// The app's own dictionaries: expected labels come from the same source the UI renders.
import ar from '../../apps/web/src/i18n/ar';
import en from '../../apps/web/src/i18n/en';
import type { Lang } from './env';

const DICTS = { ar, en } as const;

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** i18next-style lookup with {{name}} interpolation; throws on a missing key so typos fail loudly. */
export function translator(lang: Lang): Translate {
  return (key, params = {}) => {
    let node: unknown = DICTS[lang];
    for (const part of key.split('.')) {
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    }
    if (typeof node !== 'string') throw new Error(`i18n key "${key}" not found for ${lang}`);
    return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
      if (!(name in params)) throw new Error(`i18n key "${key}" needs {{${name}}}`);
      return String(params[name]);
    });
  };
}

/**
 * Money exactly as the UI's fmtMoney renders it: grouped Latin digits isolated with LRI…PDI, the
 * symbol after the figure in Arabic and before it in English.
 */
export function money(value: string, lang: Lang, currency: CurrencyCode = 'SAR'): string {
  const def = CURRENCIES[currency];
  const dec = d(value);
  const [i, f] = dec.abs().toFixed(def.minorUnits).split('.');
  const grouped = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const num = `⁦${dec.isNegative() ? '-' : ''}${grouped}${f ? `.${f}` : ''}⁩`;
  return lang === 'ar' ? `${num} ${def.symbolAr}` : `${def.symbolEn} ${num}`;
}

/** Escapes text for use inside a RegExp. */
export const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Arabic script characters (labels rendered in Arabic contain them; English labels do not). */
export const ARABIC = /[؀-ۿ]/;
