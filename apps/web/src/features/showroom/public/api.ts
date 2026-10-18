import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Shapes of the public showroom API (apps/api/src/modules/showroom/public-showroom.service.ts).
// It returns an explicit allow-list: never VIN, plate, stock number, cost or floor price.

export interface PublicCompany {
  name: string;
  legalNameAr: string | null;
  legalNameEn: string | null;
  headlineAr: string | null;
  headlineEn: string | null;
  whatsappNumber: string | null;
  phone: string | null;
  currency: string;
  showPrices: boolean;
  branches: Array<{ name: string; city: string | null }>;
}

export interface PublicVehicleCard {
  id: string;
  titleAr: string;
  titleEn: string;
  make: { en: string; ar: string };
  model: { en: string; ar: string };
  modelYear: number;
  trim: string | null;
  bodyType: string | null;
  fuelType: string | null;
  transmission: string | null;
  exteriorColor: string | null;
  odometer: { value: number; unit: string } | null;
  condition: string;
  specRegion: string | null;
  status: 'available' | 'reserved';
  price: { amount: string; currency: string } | null;
  branch: { name: string; city: string | null };
  photoUrl: string | null;
  share: { url: string; whatsappUrl: string | null };
}

export interface PublicVehicleDetail extends PublicVehicleCard {
  interiorColor: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  features: Array<{ en: string; ar: string }>;
  photos: Array<{ url: string; caption: string | null }>;
}

export interface PublicPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublicVehicleQuery {
  q?: string;
  yearFrom?: string;
  yearTo?: string;
  priceMax?: string;
  page: number;
  pageSize: number;
}

const base = (slug: string) => `/public/showroom/${encodeURIComponent(slug)}`;

export const usePublicCompany = (slug: string) =>
  useQuery({ queryKey: ['public-showroom', slug, 'company'], queryFn: ({ signal }) => api<PublicCompany>(base(slug), { signal }), staleTime: 60_000 });

export const usePublicVehicles = (slug: string, query: PublicVehicleQuery, enabled: boolean) =>
  useQuery({
    queryKey: ['public-showroom', slug, 'vehicles', query],
    queryFn: ({ signal }) => api<PublicPage<PublicVehicleCard>>(`${base(slug)}/vehicles`, { query: { ...query }, signal }),
    enabled,
    placeholderData: (p) => p,
  });

export const usePublicVehicle = (slug: string, listingId: string) =>
  useQuery({
    queryKey: ['public-showroom', slug, 'vehicle', listingId],
    queryFn: ({ signal }) => api<PublicVehicleDetail>(`${base(slug)}/vehicles/${encodeURIComponent(listingId)}`, { signal }),
  });

export interface InquiryInput {
  kind: 'inquiry' | 'test_drive';
  listingId?: string;
  name: string;
  phone: string;
  email?: string;
  message?: string;
  preferredDate?: string;
  consent: true;
  /** Honeypot: hidden from people; a filled value marks the request as automated. */
  website: string;
}

export const sendInquiry = (slug: string, body: InquiryInput) => api<{ status: 'received' }>(`${base(slug)}/inquiries`, { method: 'POST', body });

/** wa.me link to the company's WhatsApp number (digits only), or null. */
export function whatsappLink(number: string | null): string | null {
  const digits = (number ?? '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}
