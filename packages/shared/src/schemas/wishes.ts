import { z } from 'zod';
import { d } from '../money';
import { patchOf, zOptText, zPaginationQuery, zUuid } from './common';
import { WISH_STATUSES, zWishInput } from './crm';
import { BODY_TYPES, FUEL_TYPES, TRANSMISSIONS } from './vehicles';

const criteria = {
  bodyType: z.enum(BODY_TYPES).optional().nullable(),
  fuelType: z.enum(FUEL_TYPES).optional().nullable(),
  transmission: z.enum(TRANSMISSIONS).optional().nullable(),
};

/** Fields that narrow the search; a wish needs at least one (a wish for "any car" matches everything). */
export const WISH_CRITERIA = ['makeId', 'modelId', 'yearFrom', 'yearTo', 'maxPrice', 'maxOdometerKm', 'bodyType', 'fuelType', 'transmission', 'color'] as const;

const zWishBase = zWishInput.extend(criteria);
const hasCriterion = (w: Record<string, unknown>) => WISH_CRITERIA.some((k) => w[k] !== undefined && w[k] !== null && w[k] !== '');
const yearsOrdered = (w: { yearFrom?: number | null; yearTo?: number | null }) => w.yearFrom == null || w.yearTo == null || w.yearFrom <= w.yearTo;

export const zWishCreate = zWishBase
  .refine(hasCriterion, { message: 'Choose at least one criterion (make, model, year, price, …)', path: ['makeId'] })
  .refine(yearsOrdered, { message: '"Year from" cannot be after "year to"', path: ['yearTo'] });
export type WishCreateInput = z.infer<typeof zWishCreate>;

export const zWishUpdate = patchOf(zWishBase.omit({ customerId: true })).refine(yearsOrdered, { message: '"Year from" cannot be after "year to"', path: ['yearTo'] });
export type WishUpdateInput = z.infer<typeof zWishUpdate>;

export const zWishListQuery = zPaginationQuery.extend({
  customerId: zUuid.optional(),
  status: z.enum(WISH_STATUSES).optional(),
  mine: z.enum(['true', 'false']).optional(),
});
export const zWishClose = z.object({ note: zOptText(500), vehicleId: zUuid.optional().nullable() });

// ── Matching (pure; the API job and the UI share it) ────────────────────────────────────

export interface WishCriteria {
  makeId?: string | null;
  modelId?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  maxPrice?: string | null;
  maxOdometerKm?: number | null;
  bodyType?: string | null;
  fuelType?: string | null;
  transmission?: string | null;
  color?: string | null;
}

export interface MatchableVehicle {
  makeId: string;
  modelId: string;
  modelYear: number;
  askingPrice: string | null;
  odometerValue: number;
  odometerUnit: string;
  bodyType: string | null;
  fuelType: string | null;
  transmission: string | null;
  exteriorColor: string | null;
}

export type WishMismatch = (typeof WISH_CRITERIA)[number];

const KM_PER_MILE = 1.609344;

/**
 * Which of the wish's criteria the vehicle fails (empty = match). A criterion the vehicle has no
 * data for (no asking price, unknown body type) counts as a mismatch: matches must be certain.
 */
export function wishMismatches(w: WishCriteria, v: MatchableVehicle): WishMismatch[] {
  const out: WishMismatch[] = [];
  if (w.makeId && w.makeId !== v.makeId) out.push('makeId');
  if (w.modelId && w.modelId !== v.modelId) out.push('modelId');
  if (w.yearFrom != null && v.modelYear < w.yearFrom) out.push('yearFrom');
  if (w.yearTo != null && v.modelYear > w.yearTo) out.push('yearTo');
  if (w.maxPrice != null && (v.askingPrice == null || d(v.askingPrice).gt(d(w.maxPrice)))) out.push('maxPrice');
  if (w.maxOdometerKm != null) {
    const km = v.odometerUnit === 'mi' ? Math.round(v.odometerValue * KM_PER_MILE) : v.odometerValue;
    if (km > w.maxOdometerKm) out.push('maxOdometerKm');
  }
  if (w.bodyType && w.bodyType !== v.bodyType) out.push('bodyType');
  if (w.fuelType && w.fuelType !== v.fuelType) out.push('fuelType');
  if (w.transmission && w.transmission !== v.transmission) out.push('transmission');
  if (w.color) {
    const want = w.color.trim().toLocaleLowerCase();
    if (!v.exteriorColor || !v.exteriorColor.toLocaleLowerCase().includes(want)) out.push('color');
  }
  return out;
}

export function matchesWish(w: WishCriteria, v: MatchableVehicle): boolean {
  return wishMismatches(w, v).length === 0;
}
