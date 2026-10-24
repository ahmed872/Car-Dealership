import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { IntegrationProvider, VehicleStatus } from '@autohub/shared';
import { errorMessage } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import { useApi } from '@/lib/hooks';

// Response shapes mirror apps/api/src/modules/{showroom,integrations}/* exactly.

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type DescriptionSource = 'manual' | 'ai' | 'template';
export type VisibilityReason = 'showroom_disabled' | 'plan_without_showroom' | 'not_published' | 'status_not_listed';

/** GET /vehicles/:id/listing (and the result of PUT / publish / unpublish). */
export interface ListingState {
  vehicleId: string;
  stockNumber: string;
  vehicleStatus: VehicleStatus;
  listing: {
    id: string;
    isPublished: boolean;
    titleAr: string | null;
    titleEn: string | null;
    descriptionAr: string | null;
    descriptionEn: string | null;
    descriptionSource: DescriptionSource | null;
    publishedAt: string | null;
    version: number;
  } | null;
  visibility: { public: boolean; reasons: string[] };
  /** whatsappUrls: the chat text (title — link) per language; whatsappUrl: in the company's document language. */
  links: { url: string; whatsappUrl: string | null; whatsappUrls: { ar: string; en: string } | null } | null;
}

/** POST /vehicles/:id/listing/generate-description — a suggestion only, nothing is saved. */
export interface GeneratedDescription {
  suggestion: { descriptionAr: string; descriptionEn: string };
  generation: { source: 'ai' | 'template'; model: string | null; fallbackReason: string | null };
}

/** GET /showroom/listings items. */
export interface ListingRow {
  id: string;
  vehicleId: string;
  stockNumber: string;
  vehicleStatus: VehicleStatus;
  titleAr: string | null;
  titleEn: string | null;
  isPublished: boolean;
  /** null when the listing has no description text (nothing to attribute). */
  descriptionSource: DescriptionSource | null;
  publishedAt: string | null;
  publicPhotos: number;
  publiclyVisible: boolean;
}

/** GET /showroom/inquiries items. */
export interface InquiryRow {
  id: string;
  kind: 'inquiry' | 'test_drive';
  name: string;
  phone: string;
  email: string | null;
  message: string | null;
  preferredDate: string | null;
  customerId: string | null;
  leadId: string | null;
  unlinkedReason: string | null;
  createdAt: string;
  vehicleId: string | null;
  stockNumber: string | null;
}

/** GET /vehicles/:id/price-guidance — an estimate from the company's own recognised sales. */
export interface PriceGuidance {
  estimate: true;
  basis: 'own_sales';
  criteria: string;
  comparableCount: number;
  sufficient: boolean;
  agreedPrice: { min: string; median: string | null; max: string } | null;
  averageDaysToSell: number | null;
  askingPrice: string | null;
  askingVsMedianPct: string | null;
  comparables: Array<{ agreedPrice: string; saleDate: string; modelYear: number; odometer: number | null }>;
}

export type AgingActionCode = 'critical_age' | 'set_price' | 'publish_listing' | 'add_photos' | 'review_price';

/** GET /inventory/aging-recommendations */
export interface AgingRecommendations {
  basis: 'rules_and_own_sales';
  staleDaysWarning: number;
  staleDaysCritical: number;
  items: Array<{
    vehicleId: string;
    stockNumber: string;
    makeEn: string;
    makeAr: string;
    modelEn: string;
    modelAr: string;
    modelYear: number;
    trim: string | null;
    status: VehicleStatus;
    daysInStock: number;
    actions: Array<{ code: AgingActionCode | string; detail?: Record<string, unknown> }>;
  }>;
}

/** GET /integrations items. Secrets are write-only: only `hasSecret` / `secretLast4` come back. */
export interface IntegrationSetting {
  provider: IntegrationProvider;
  available: boolean;
  needsSecret: boolean;
  note: string;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
  hasSecret: boolean;
  secretLast4: string | null;
  updatedAt: string | null;
}

/** GET /integrations/vin-decode/:vin — field suggestions; the vehicle form decides what to keep. */
export interface VinSuggestion {
  source: 'nhtsa_vpic';
  vin: string;
  make: string | null;
  model: string | null;
  makeId: string | null;
  modelId: string | null;
  modelYear: number | null;
  trim: string | null;
  bodyClass: string | null;
  fuelType: string | null;
  transmission: string | null;
  engine: string | null;
  driveType: string | null;
  doors: string | null;
  plantCountry: string | null;
  warnings: string | null;
}

export const listingKey = (vehicleId: string) => ['showroom', 'listing', vehicleId];

export const useListing = (vehicleId: string) => useApi<ListingState>(listingKey(vehicleId), `/vehicles/${vehicleId}/listing`);

// ── Errors ───────────────────────────────────────────────────────────────────────────────

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Domain codes from `showroom.errors.*` first, then the global `errors.*` table, then the server text. */
export function showroomErrorMessage(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const own = t(`showroom.errors.${err.code}`, { defaultValue: '' });
    if (own) return own;
  }
  return errorMessage(err, t);
}

export function useShowroomError() {
  const { t } = useTranslation();
  return useCallback((err: unknown) => showroomErrorMessage(err, t as T), [t]);
}

interface MutationOpts<TVars, TRes> {
  path: string | ((vars: TVars) => string);
  method?: 'POST' | 'PUT' | 'PATCH';
  invalidate?: unknown[][];
  success?: string | null;
  onSuccess?: (res: TRes, vars: TVars) => void;
  onError?: (err: unknown) => void;
  body?: (vars: TVars) => unknown;
}

/** Same contract as useApiMutation (toasts, invalidation) with showroom error codes translated. */
export function useShowroomMutation<TVars = unknown, TRes = unknown>(opts: MutationOpts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  const describe = useShowroomError();
  return useMutation<TRes, unknown, TVars>({
    mutationFn: (vars) => {
      const path = typeof opts.path === 'function' ? opts.path(vars) : opts.path;
      return api<TRes>(path, { method: opts.method ?? 'POST', body: opts.body ? opts.body(vars) : (vars ?? {}) });
    },
    onSuccess: async (res, vars) => {
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg = opts.success === undefined ? t('common.savedSuccessfully') : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars);
    },
    onError: (err) => {
      toast.error(describe(err));
      opts.onError?.(err);
    },
  });
}
