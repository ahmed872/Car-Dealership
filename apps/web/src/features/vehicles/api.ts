import type { VehicleStatus } from '@autohub/shared';
import { useApi } from '@/lib/hooks';

export interface VehicleListItem {
  id: string;
  stockNumber: string;
  vin: string | null;
  plateNumber: string | null;
  status: VehicleStatus;
  branchId: string;
  branchName: string;
  makeNameEn: string;
  makeNameAr: string;
  modelNameEn: string;
  modelNameAr: string;
  trim: string | null;
  modelYear: number;
  condition: string;
  exteriorColor: string | null;
  odometerValue: number;
  odometerUnit: 'km' | 'mi';
  fuelType: string | null;
  transmission: string | null;
  askingPrice: string | null;
  stockedAt: string;
  statusChangedAt: string;
  primaryPhotoId: string | null;
  costTotal: string | null;
  daysInStock: number | null;
}

export interface Vehicle {
  id: string;
  branchId: string;
  stockNumber: string;
  vin: string | null;
  engineNumber: string | null;
  plateNumber: string | null;
  plateRegion: string | null;
  makeId: string;
  modelId: string;
  trim: string | null;
  modelYear: number;
  registrationYear: number | null;
  condition: string;
  bodyType: string | null;
  exteriorColor: string | null;
  interiorColor: string | null;
  doors: number | null;
  seats: number | null;
  fuelType: string | null;
  engineCapacityCc: number | null;
  cylinders: number | null;
  horsepower: number | null;
  transmission: string | null;
  drivetrain: string | null;
  odometerValue: number;
  odometerUnit: 'km' | 'mi';
  originCountry: string | null;
  specRegion: string | null;
  ownershipStatus: string;
  documentsStatus: string;
  warrantyType: string;
  warrantyUntil: string | null;
  warrantyNotes: string | null;
  locationLabel: string | null;
  acquisitionId: string | null;
  acquiredAt: string | null;
  stockedAt: string;
  status: VehicleStatus;
  statusChangedAt: string;
  askingPrice: string | null;
  minPrice: string | null;
  targetMarginPct: string | null;
  internalNotes: string | null;
  version: number;
}

export interface Media {
  id: string;
  fileId: string;
  kind: 'photo' | 'video';
  category: string;
  sortOrder: number;
  isPrimary: boolean;
  isPublic: boolean;
  caption: string | null;
}

export interface VehicleDocument {
  id: string;
  fileId: string | null;
  docType: string;
  docNumber: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  isSensitive: boolean;
  notes: string | null;
  restricted: boolean;
}

export interface VehicleDetail {
  vehicle: Vehicle;
  make: { id: string; nameEn: string; nameAr: string };
  model: { id: string; nameEn: string; nameAr: string };
  branch: { id: string; name: string };
  features: Array<{ id: string; code: string; nameEn: string; nameAr: string; category: string }>;
  media: Media[];
  documents: VehicleDocument[];
  inspections: Array<{ id: string; versionNo: number; type: string; status: string; overallResult: string | null; startedAt: string; completedAt: string | null; inspectorName: string | null }>;
  statusHistory: Array<{ id: string; fromStatus: string | null; toStatus: string; reason: string | null; source: string; createdAt: string; actorName: string | null }>;
  priceHistory: Array<{ id: string; field: string; oldValue: string | null; newValue: string | null; reason: string | null; createdAt: string; actorName: string | null }>;
  odometer: Array<{ id: string; value: number; unit: string; readAt: string; source: string; isCorrection: boolean; notes: string | null }>;
  activeTransfer: { id: string; number: string; toBranchId: string; shippedAt: string } | null;
  daysInStock: number | null;
}

export interface Make {
  id: string;
  nameEn: string;
  nameAr: string;
  custom: string | null;
}
export interface Model {
  id: string;
  makeId: string;
  nameEn: string;
  nameAr: string;
  bodyType: string | null;
}
export interface Feature {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  category: string;
}

export const useMakes = () => useApi<Make[]>(['catalog', 'makes'], '/catalog/makes', undefined, { staleTime: 10 * 60_000 });
export const useModels = (makeId: string | null | undefined) =>
  useApi<Model[]>(['catalog', 'models', makeId], makeId ? '/catalog/models' : null, { makeId: makeId ?? undefined }, { staleTime: 10 * 60_000 });
export const useFeatures = () => useApi<Feature[]>(['catalog', 'features'], '/catalog/features', undefined, { staleTime: 10 * 60_000 });
export const useVehicle = (id: string | undefined) => useApi<VehicleDetail>(['vehicle', id], id ? `/vehicles/${id}` : null);

export function fileUrl(fileId: string): string {
  return `/api/v1/files/${fileId}`;
}
