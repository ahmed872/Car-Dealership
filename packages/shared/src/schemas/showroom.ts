import { z } from 'zod';
import { zIsoDate, zOptText, zPhone, zText, zUuid } from './common';

export const INTEGRATION_PROVIDER_KEYS = ['vin_decoder', 'ai_text', 'messaging', 'ocr'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDER_KEYS)[number];
export const MESSAGING_PROVIDERS = ['log', 'webhook'] as const;

/** Staff edit of a vehicle's public listing content. */
export const zListingUpdate = z.object({
  titleAr: zOptText(160),
  titleEn: zOptText(160),
  descriptionAr: zOptText(4000),
  descriptionEn: zOptText(4000),
  /** Where the description text came from when staff saved a generated suggestion unchanged. */
  descriptionSource: z.enum(['manual', 'ai', 'template']).optional(),
  version: z.number().int().min(1).optional(),
});
export type ListingUpdateInput = z.infer<typeof zListingUpdate>;

export const zShowroomVehicleQuery = z.object({
  q: z.string().trim().max(80).optional(),
  makeId: zUuid.optional(),
  modelId: zUuid.optional(),
  yearFrom: z.coerce.number().int().min(1950).max(2100).optional(),
  yearTo: z.coerce.number().int().min(1950).max(2100).optional(),
  priceMax: z.string().regex(/^\d{1,13}(\.\d{1,2})?$/).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
});

/** Public inquiry / test-drive request. `website` is a honeypot: humans leave it empty. */
export const zShowroomInquiry = z.object({
  kind: z.enum(['inquiry', 'test_drive']).default('inquiry'),
  listingId: zUuid.optional(),
  name: zText(120).min(2),
  phone: zPhone,
  email: z.string().trim().email().max(120).optional().nullable(),
  message: zOptText(1000),
  preferredDate: zIsoDate.optional().nullable(),
  consent: z.literal(true),
  website: z.string().max(200).optional(),
});
export type ShowroomInquiryInput = z.infer<typeof zShowroomInquiry>;

const zConfigValue = z.union([z.string().max(500), z.number(), z.boolean()]);
export const zIntegrationUpdate = z.object({
  enabled: z.boolean(),
  /** Non-secret options (e.g. messaging provider, webhook URL). */
  config: z.record(z.string().max(40), zConfigValue).optional(),
  /** New secret (API key, signing secret); null removes it; omitted keeps the stored one. */
  secret: z.string().trim().min(8).max(500).nullable().optional(),
});
export type IntegrationUpdateInput = z.infer<typeof zIntegrationUpdate>;

export const zQrQuery = z.object({ format: z.enum(['svg', 'png']).default('svg') });
