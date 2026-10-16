import type { CurrencyCode } from './money';

export const MARKET_CODES = ['EG', 'SA', 'AE'] as const;
export type MarketCode = (typeof MARKET_CODES)[number];

export const TAX_MODES = ['none', 'standard', 'margin'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export interface MarketProfile {
  code: MarketCode;
  nameEn: string;
  nameAr: string;
  currency: CurrencyCode;
  timezone: string;
  phoneCountryCode: string;
  defaultLocale: 'ar' | 'en';
  /** Defaults only — every value is overridable in tenant settings. Not a compliance claim. */
  taxDefaults: {
    mode: TaxMode;
    ratePct: string;
    pricesIncludeTax: boolean;
    labelEn: string;
    labelAr: string;
  };
  plate: { hintEn: string; hintAr: string; maxLength: number };
  vehicleRequiredFields: string[];
  defaultSpecRegion: string;
}

export const MARKETS: Record<MarketCode, MarketProfile> = {
  EG: {
    code: 'EG',
    nameEn: 'Egypt',
    nameAr: 'مصر',
    currency: 'EGP',
    timezone: 'Africa/Cairo',
    phoneCountryCode: '+20',
    defaultLocale: 'ar',
    taxDefaults: {
      mode: 'standard',
      ratePct: '14',
      pricesIncludeTax: true,
      labelEn: 'VAT',
      labelAr: 'ضريبة القيمة المضافة',
    },
    plate: {
      hintEn: 'Arabic letters + digits, e.g. "ط ص ر 1234"',
      hintAr: 'حروف وأرقام، مثال: "ط ص ر 1234"',
      maxLength: 20,
    },
    vehicleRequiredFields: ['makeId', 'modelId', 'modelYear'],
    defaultSpecRegion: 'local_agent',
  },
  SA: {
    code: 'SA',
    nameEn: 'Saudi Arabia',
    nameAr: 'المملكة العربية السعودية',
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    phoneCountryCode: '+966',
    defaultLocale: 'ar',
    taxDefaults: {
      mode: 'standard',
      ratePct: '15',
      pricesIncludeTax: true,
      labelEn: 'VAT',
      labelAr: 'ضريبة القيمة المضافة',
    },
    plate: {
      hintEn: '3 letters + up to 4 digits, e.g. "ABD 1234"',
      hintAr: '3 حروف وحتى 4 أرقام، مثال: "أ ب د 1234"',
      maxLength: 20,
    },
    vehicleRequiredFields: ['makeId', 'modelId', 'modelYear'],
    defaultSpecRegion: 'gcc',
  },
  AE: {
    code: 'AE',
    nameEn: 'United Arab Emirates',
    nameAr: 'الإمارات العربية المتحدة',
    currency: 'AED',
    timezone: 'Asia/Dubai',
    phoneCountryCode: '+971',
    defaultLocale: 'ar',
    taxDefaults: {
      mode: 'standard',
      ratePct: '5',
      pricesIncludeTax: true,
      labelEn: 'VAT',
      labelAr: 'ضريبة القيمة المضافة',
    },
    plate: {
      hintEn: 'Emirate + code letter + digits, e.g. "Dubai A 12345"',
      hintAr: 'الإمارة + رمز + أرقام، مثال: "دبي A 12345"',
      maxLength: 20,
    },
    vehicleRequiredFields: ['makeId', 'modelId', 'modelYear'],
    defaultSpecRegion: 'gcc',
  },
};

/** Normalises a phone number to E.164 using the market's country code when no "+" prefix is present. */
export function normalizePhone(raw: string, market: MarketCode): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '').replace(/^00/, '+');
  // Convert Arabic-Indic and Eastern Arabic-Indic digits to ASCII.
  const ascii = cleaned.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
  let e164: string;
  if (ascii.startsWith('+')) e164 = ascii;
  else {
    const cc = MARKETS[market].phoneCountryCode;
    e164 = cc + ascii.replace(/^0+/, '');
  }
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}
