import type { WISH_CRITERIA, WISH_STATUSES } from '@autohub/shared';
import { useApi } from '@/lib/hooks';

export type WishStatus = (typeof WISH_STATUSES)[number];
export type WishCriterion = (typeof WISH_CRITERIA)[number];

/** A customer_wishes row as the API returns it. */
export interface Wish {
  id: string;
  customerId: string;
  leadId: string | null;
  makeId: string | null;
  modelId: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  maxPrice: string | null;
  maxOdometerKm: number | null;
  bodyType: string | null;
  fuelType: string | null;
  transmission: string | null;
  color: string | null;
  notes: string | null;
  status: WishStatus;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /wishes item. */
export interface WishListItem extends Wish {
  customerName: string;
  customerPhone: string | null;
  makeEn: string | null;
  makeAr: string | null;
  modelEn: string | null;
  modelAr: string | null;
  openMatches: number;
}

export interface WishMatch {
  vehicleId: string;
  matchedAt: string;
  dismissedAt: string | null;
  stockNumber: string;
  status: string;
  modelYear: number;
  askingPrice: string | null;
  odometerValue: number;
  odometerUnit: string;
  exteriorColor: string | null;
  makeEn: string;
  makeAr: string;
  modelEn: string;
  modelAr: string;
  onSale: boolean;
}

/** GET /wishes/:id */
export interface WishDetail extends Wish {
  matches: WishMatch[];
}

/** GET /wishes/:id/explain/:vehicleId */
export interface WishExplain {
  matches: boolean;
  mismatches: WishCriterion[];
}

/** GET /wishes/for-vehicle/:vehicleId item. */
export interface InterestedCustomer {
  wishId: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  assignedUserId: string | null;
  maxPrice: string | null;
  notes: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Minimal customer row from GET /customers (search). */
export interface CustomerOption {
  id: string;
  fullName: string;
  companyName: string | null;
  phone: string | null;
  isActive: boolean;
}

export const useWish = (id: string | undefined) => useApi<WishDetail>(['wishes', 'detail', id], id ? `/wishes/${id}` : null);

/** Customer 360 (only the header fields are used here). */
export const useCustomerBrief = (id: string | null | undefined) =>
  useApi<{ customer: CustomerOption }>(['customers', 'brief', id], id ? `/customers/${id}` : null, undefined, { staleTime: 60_000 });
