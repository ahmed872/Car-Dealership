import { TenantSettings } from '@autohub/shared';
import { DbService } from '../../db/db.service';
import { ListingFacts } from '../integrations/ai-text.service';

/** Vehicle statuses the public showroom may show (sold, pending sale and pre-stock never). */
export function visibleStatuses(settings: TenantSettings): string[] {
  return settings.showroom.showReserved ? ['available', 'reserved'] : ['available'];
}

/** The company's document language (older settings may lack documents.defaultLocale). */
export function companyLocale(settings: TenantSettings): 'ar' | 'en' {
  return settings.documents?.defaultLocale ?? settings.locale;
}

/**
 * The public page of a listing and the WhatsApp chat link to the company about it. The chat's
 * prefilled text (title — link) exists in both languages: `whatsappUrls` for the viewer's language
 * (staff pages and the public page pick the one matching their UI), `whatsappUrl` in the company's
 * document language for callers that cannot choose.
 */
export function publicLinks(
  publicWebUrl: string,
  slug: string,
  listingId: string,
  titles: { ar: string; en: string },
  whatsappNumber: string | null | undefined,
  defaultLocale: 'ar' | 'en',
) {
  const url = `${publicWebUrl.replace(/\/$/, '')}/showroom/${encodeURIComponent(slug)}/vehicles/${listingId}`;
  const digits = (whatsappNumber ?? '').replace(/\D/g, '');
  const chat = (title: string) => `https://wa.me/${digits}?text=${encodeURIComponent(`${title} — ${url}`)}`;
  const whatsappUrls = digits ? { ar: chat(titles.ar), en: chat(titles.en) } : null;
  return { url, whatsappUrl: whatsappUrls ? whatsappUrls[defaultLocale] : null, whatsappUrls };
}

/** Specification facts of a vehicle (the only data the AI adapter ever receives). */
export async function listingFacts(dbs: DbService, vehicleId: string): Promise<ListingFacts> {
  const [v] = await dbs.query<{
    make_en: string;
    make_ar: string;
    model_en: string;
    model_ar: string;
    model_year: number;
    trim: string | null;
    body_type: string | null;
    fuel_type: string | null;
    transmission: string | null;
    exterior_color: string | null;
    odometer_value: number | null;
    odometer_unit: string;
    condition: string | null;
    spec_region: string | null;
  }>(
    `SELECT mk.name_en AS make_en, mk.name_ar AS make_ar, md.name_en AS model_en, md.name_ar AS model_ar, v.model_year, v.trim,
            v.body_type, v.fuel_type, v.transmission, v.exterior_color, v.odometer_value, v.odometer_unit, v.condition, v.spec_region
       FROM vehicles v JOIN vehicle_makes mk ON mk.id = v.make_id JOIN vehicle_models md ON md.id = v.model_id
      WHERE v.id = $1`,
    [vehicleId],
  );
  const feats = await dbs.query<{ en: string; ar: string }>(
    `SELECT f.name_en AS en, f.name_ar AS ar FROM vehicle_feature_links l JOIN features f ON f.id = l.feature_id WHERE l.vehicle_id = $1 ORDER BY f.name_en`,
    [vehicleId],
  );
  return {
    makeEn: v!.make_en,
    makeAr: v!.make_ar,
    modelEn: v!.model_en,
    modelAr: v!.model_ar,
    modelYear: v!.model_year,
    trim: v!.trim,
    bodyType: v!.body_type,
    fuelType: v!.fuel_type,
    transmission: v!.transmission,
    exteriorColor: v!.exterior_color,
    odometerValue: v!.odometer_value,
    odometerUnit: v!.odometer_unit,
    condition: v!.condition,
    specRegion: v!.spec_region,
    features: feats,
  };
}
