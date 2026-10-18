import { useTranslation } from 'react-i18next';
import type { LEAD_SOURCES, LOST_REASONS, PAYMENT_PREFERENCES, PipelineStageKind } from '@autohub/shared';
import type { InteractionType } from '@/features/customers/api';
import { useApi } from '@/lib/hooks';

export type LeadStatus = 'open' | 'won' | 'lost';
export type LeadSource = (typeof LEAD_SOURCES)[number];
export type LostReason = (typeof LOST_REASONS)[number];
export type PaymentPreference = (typeof PAYMENT_PREFERENCES)[number];

/** A pipeline stage as GET /pipeline-stages presents it. */
export interface Stage {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  sortOrder: number;
  kind: PipelineStageKind;
  probabilityPct: number;
  isActive: boolean;
  isDefault: boolean;
  isTerminal: boolean;
}

/** Card / row of GET /leads, /leads/board and /leads/follow-ups. */
export interface LeadCard {
  id: string;
  number: string;
  status: LeadStatus;
  source: LeadSource;
  stageId: string;
  stageCode: string;
  stageNameEn: string;
  stageNameAr: string;
  stageKind: PipelineStageKind;
  branchId: string;
  branchName: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  assignedUserId: string | null;
  assigneeName: string | null;
  vehicleId: string | null;
  vehicleStockNumber: string | null;
  vehicleModelYear: number | null;
  vehicleMakeEn: string | null;
  vehicleMakeAr: string | null;
  vehicleModelEn: string | null;
  vehicleModelAr: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  paymentPreference: PaymentPreference | null;
  expectedCloseDate: string | null;
  nextFollowUpAt: string | null;
  lastActivityAt: string | null;
  lostReason: LostReason | null;
  createdAt: string;
  closedAt: string | null;
  version: number;
}

export interface BoardColumn {
  stage: Stage;
  count: number;
  budgetMaxTotal: string;
  leads: LeadCard[];
}

export interface Board {
  columns: BoardColumn[];
  totals: { count: number; budgetMaxTotal: string };
}

export interface FollowUps {
  overdue: number;
  dueToday: number;
  dueBefore: string;
  items: Array<LeadCard & { overdue: boolean }>;
}

/** The lead row returned by the write endpoints. */
export interface Lead {
  id: string;
  number: string;
  customerId: string;
  branchId: string;
  source: LeadSource;
  stageId: string;
  status: LeadStatus;
  assignedUserId: string | null;
  vehicleId: string | null;
  interestNotes: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  paymentPreference: PaymentPreference | null;
  expectedCloseDate: string | null;
  lostReason: LostReason | null;
  lostNotes: string | null;
  wonSaleId: string | null;
  lastActivityAt: string | null;
  nextFollowUpAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  version: number;
}

export type HistoryEvent = 'created' | 'reopened' | 'won' | 'lost' | 'reassigned' | 'stage_changed';

export interface LeadDetail extends Lead {
  stage: Stage | null;
  customer: {
    id: string;
    type: 'individual' | 'company';
    fullName: string;
    companyName: string | null;
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    preferredLanguage: 'ar' | 'en';
  } | null;
  assignee: { id: string; fullName: string } | null;
  vehicle: {
    id: string;
    stockNumber: string;
    status: string;
    branchId: string;
    modelYear: number;
    exteriorColor: string | null;
    odometerValue: number;
    odometerUnit: string;
    askingPrice: string | null;
    makeEn: string;
    makeAr: string;
    modelEn: string;
    modelAr: string;
  } | null;
  history: Array<{
    id: string;
    fromStageId: string | null;
    fromStageCode: string | null;
    fromStageNameEn: string | null;
    fromStageNameAr: string | null;
    toStageId: string;
    toStageCode: string | null;
    toStageNameEn: string | null;
    toStageNameAr: string | null;
    fromStatus: LeadStatus | null;
    toStatus: LeadStatus;
    note: string | null;
    changedBy: string | null;
    changedByName: string | null;
    changedAt: string;
    event: HistoryEvent;
  }>;
  interactions: Array<{
    id: string;
    type: InteractionType;
    direction: 'inbound' | 'outbound' | null;
    summary: string;
    outcome: string | null;
    occurredAt: string;
    nextFollowUpAt: string | null;
    vehicleId: string | null;
    userId: string | null;
    userName: string | null;
  }>;
  reservations: Array<{
    id: string;
    number: string;
    status: 'active' | 'converted' | 'expired' | 'cancelled';
    vehicleId: string;
    stockNumber: string;
    reservedAt: string;
    expiresAt: string;
    depositAmount: string;
    agreedPrice: string | null;
  }>;
}

export const useStages = (includeInactive = false) =>
  useApi<Stage[]>(['pipeline-stages', includeInactive], '/pipeline-stages', includeInactive ? { includeInactive: 'true' } : undefined, {
    staleTime: 60_000,
  });

export const useLead = (id: string | undefined) => useApi<LeadDetail>(['lead', id], id ? `/leads/${id}` : null);

/** Every query key a lead change can affect. */
export const LEAD_KEYS: unknown[][] = [['lead'], ['leads'], ['leads-board'], ['follow-ups'], ['customer'], ['customers']];

/** Localised stage name (works for Stage rows and the stage columns of cards/history). */
export function useStageName() {
  const { i18n } = useTranslation();
  const en = i18n.language === 'en';
  return (s: { nameEn?: string | null; nameAr?: string | null; code?: string | null } | null | undefined) =>
    (en ? s?.nameEn : s?.nameAr) || s?.nameEn || s?.code || '—';
}

/** Localised "Make Model Year" of a lead's vehicle of interest. */
export function vehicleLabel(
  v: { makeEn?: string | null; makeAr?: string | null; modelEn?: string | null; modelAr?: string | null; modelYear?: number | null },
  lang: string,
): string {
  const make = lang === 'en' ? v.makeEn : v.makeAr;
  const model = lang === 'en' ? v.modelEn : v.modelAr;
  return [make, model, v.modelYear].filter(Boolean).join(' ');
}

export function cardVehicleLabel(c: LeadCard, lang: string): string | null {
  if (!c.vehicleId) return null;
  return vehicleLabel(
    { makeEn: c.vehicleMakeEn, makeAr: c.vehicleMakeAr, modelEn: c.vehicleModelEn, modelAr: c.vehicleModelAr, modelYear: c.vehicleModelYear },
    lang,
  );
}
