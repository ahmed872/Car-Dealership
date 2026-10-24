import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { IntegrationsService } from './integrations.service';

/** Vehicle facts sent to the model (specifications only — never customer data, cost or notes). */
export interface ListingFacts {
  makeEn: string;
  makeAr: string;
  modelEn: string;
  modelAr: string;
  modelYear: number;
  trim: string | null;
  bodyType: string | null;
  fuelType: string | null;
  transmission: string | null;
  exteriorColor: string | null;
  odometerValue: number | null;
  odometerUnit: string;
  condition: string | null;
  specRegion: string | null;
  features: Array<{ en: string; ar: string }>;
}

export interface ListingText {
  ar: string;
  en: string;
  source: 'ai' | 'template';
  model?: string;
  fallbackReason?: string;
}

const L = {
  fuel: { petrol: ['Petrol', 'بنزين'], diesel: ['Diesel', 'ديزل'], hybrid: ['Hybrid', 'هايبرد'], plugin_hybrid: ['Plug-in hybrid', 'هايبرد قابل للشحن'], electric: ['Electric', 'كهربائي'], lpg: ['LPG', 'غاز مسال'], cng: ['CNG', 'غاز طبيعي'], other: ['Other', 'أخرى'] },
  gear: { automatic: ['Automatic', 'أوتوماتيك'], manual: ['Manual', 'عادي'], cvt: ['CVT', 'CVT'], dct: ['Dual-clutch', 'ثنائي القابض'], other: ['Other', 'أخرى'] },
  body: { sedan: ['Sedan', 'سيدان'], suv: ['SUV', 'دفع رباعي'], crossover: ['Crossover', 'كروس أوفر'], hatchback: ['Hatchback', 'هاتشباك'], coupe: ['Coupe', 'كوبيه'], convertible: ['Convertible', 'مكشوفة'], pickup: ['Pickup', 'بيك أب'], van: ['Van', 'فان'], wagon: ['Wagon', 'ستيشن'], bus: ['Bus', 'باص'], truck: ['Truck', 'شاحنة'], other: ['Other', 'أخرى'] },
} as const;
const pick = (map: Record<string, readonly [string, string]>, v: string | null, i: 0 | 1) => (v && map[v] ? map[v]![i] : null);
const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** The given parts as one sentence ending with a full stop, or null when there are none. */
const sentence = (parts: Array<string | null | false>, sep: string) => {
  const text = parts.filter(Boolean).join(sep);
  return text ? `${text}.` : null;
};

/** Plain, factual description built only from the facts (always available, no third party). */
export function templateDescription(f: ListingFacts): { ar: string; en: string } {
  const nameEn = [f.makeEn, f.modelEn, f.trim, f.modelYear].filter(Boolean).join(' ');
  const nameAr = [f.makeAr, f.modelAr, f.trim, f.modelYear].filter(Boolean).join(' ');
  const en = [
    `${nameEn}.`,
    sentence([pick(L.body, f.bodyType, 0), pick(L.gear, f.transmission, 0) && `${pick(L.gear, f.transmission, 0)} transmission`, pick(L.fuel, f.fuelType, 0)], ', '),
    f.exteriorColor ? `Colour: ${f.exteriorColor}.` : null,
    f.odometerValue !== null ? `Odometer: ${groupDigits(f.odometerValue)} ${f.odometerUnit}.` : null,
    f.features.length ? `Features: ${f.features.map((x) => x.en).join(', ')}.` : null,
  ].filter(Boolean);
  const ar = [
    `${nameAr}.`,
    sentence([pick(L.body, f.bodyType, 1), pick(L.gear, f.transmission, 1) && `ناقل حركة ${pick(L.gear, f.transmission, 1)}`, pick(L.fuel, f.fuelType, 1) && `وقود ${pick(L.fuel, f.fuelType, 1)}`], '، '),
    f.exteriorColor ? `اللون: ${f.exteriorColor}.` : null,
    f.odometerValue !== null ? `العداد: ${groupDigits(f.odometerValue)} ${f.odometerUnit === 'mi' ? 'ميل' : 'كم'}.` : null,
    f.features.length ? `المزايا: ${f.features.map((x) => x.ar).join('، ')}.` : null,
  ].filter(Boolean);
  return { en: en.join(' '), ar: ar.join(' ') };
}

const SYSTEM = [
  'You write short listing descriptions for a car dealership website, in Arabic and English.',
  'Use only the facts provided. Do not invent equipment, history, accident status, warranty, service records, financing or prices.',
  'Arabic: Modern Standard Arabic suitable for buyers in Saudi Arabia, the UAE and Egypt. English: plain and clear.',
  'Each version: 2 to 4 sentences, no headings, no emoji, no markdown.',
  'Answer exactly in this form: <ar>Arabic text</ar><en>English text</en>',
].join('\n');

/** Free text from vehicle records goes into the prompt: keep it short and free of markup. */
function sanitizeFacts(f: ListingFacts): ListingFacts {
  const clean = (v: string | null) => (v === null ? null : v.replace(/[<>{}[\]`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60));
  return {
    ...f,
    trim: clean(f.trim),
    exteriorColor: clean(f.exteriorColor),
    features: f.features.slice(0, 40).map((x) => ({ en: clean(x.en) ?? '', ar: clean(x.ar) ?? '' })),
  };
}

export interface AiTextConfig {
  enabled: boolean;
  apiKey: string | null;
  /** True when the platform's key is used (the company entered none): subject to a daily quota. */
  platformKey: boolean;
}

/**
 * Listing descriptions with Claude (D-035). Used only when the company enabled `ai_text` (their key,
 * or the platform key if one is configured). Any refusal, error, timeout or malformed answer falls
 * back to the template, so publishing never depends on the AI provider. `config` reads the settings
 * inside a transaction; `listingDescription` makes the network call and must run with no
 * transaction open (it can take up to `timeoutMs`).
 */
@Injectable()
export class AiTextService {
  private readonly logger = new Logger(AiTextService.name);
  /** Overridable for tests (a local stub); undefined uses the SDK default endpoint. */
  baseURL: string | undefined = undefined;
  timeoutMs = 20_000;

  constructor(private readonly integrations: IntegrationsService) {}

  async config(): Promise<AiTextConfig> {
    const cfg = await this.integrations.resolve('ai_text');
    const apiKey = cfg.secret ?? getEnv().ANTHROPIC_API_KEY ?? null;
    return { enabled: cfg.enabled, apiKey, platformKey: !cfg.secret && !!apiKey };
  }

  async listingDescription(rawFacts: ListingFacts, cfg: AiTextConfig): Promise<ListingText> {
    const facts = sanitizeFacts(rawFacts);
    const fallback = (reason: string): ListingText => ({ ...templateDescription(rawFacts), source: 'template', fallbackReason: reason });
    if (!cfg.enabled) return fallback('not_enabled');
    const apiKey = cfg.apiKey;
    if (!apiKey) return fallback('no_api_key');
    const model = getEnv().ANTHROPIC_MODEL;
    try {
      const client = new Anthropic({ apiKey, baseURL: this.baseURL, timeout: this.timeoutMs, maxRetries: 0 });
      const res = await client.beta.messages.create({
        model,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: `Vehicle facts (JSON):\n${JSON.stringify(facts)}` }],
      });
      if (res.stop_reason === 'refusal') return fallback('refused');
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const ar = /<ar>([\s\S]*?)<\/ar>/.exec(text)?.[1]?.trim();
      const en = /<en>([\s\S]*?)<\/en>/.exec(text)?.[1]?.trim();
      if (!ar || !en || ar.length > 4000 || en.length > 4000) return fallback('unparseable');
      return { ar, en, source: 'ai', model: res.model };
    } catch (e) {
      const status = e instanceof Anthropic.APIError ? (e.status ?? 'network') : 'network';
      this.logger.warn(`AI description failed (${status}): ${(e as Error).message}`);
      return fallback(`error:${status}`);
    }
  }
}
