import type { RESERVATION_STATUSES, VehicleStatus } from '@autohub/shared';
import type { Refund } from '@/features/receivables/api';

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export type RefundPolicy = 'refundable' | 'non_refundable' | 'partial';

/** GET /reservations items. */
export interface ReservationListItem {
  id: string;
  number: string;
  status: ReservationStatus;
  reservedAt: string;
  expiresAt: string;
  agreedPrice: string | null;
  depositAmount: string;
  receivedBase: string;
  forfeitedBase: string;
  refundPolicy: RefundPolicy;
  refundablePct: string;
  extendedCount: number;
  branchId: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  vehicleId: string;
  stockNumber: string;
  modelYear: number;
  makeEn: string;
  makeAr: string;
  modelEn: string;
  modelAr: string;
  salesUserName: string | null;
}

/** GET /reservations/:id. */
export interface ReservationDetail {
  id: string;
  number: string;
  vehicleId: string;
  customerId: string;
  branchId: string;
  leadId: string | null;
  salesUserId: string | null;
  status: ReservationStatus;
  priorVehicleStatus: string;
  reservedAt: string;
  expiresAt: string;
  agreedPrice: string | null;
  depositAmount: string;
  forfeitedBase: string;
  refundPolicy: RefundPolicy;
  refundablePct: string;
  notes: string | null;
  extendedCount: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  expiredAt: string | null;
  convertedAt: string | null;
  saleId: string | null;
  createdAt: string;
  version: number;
  customer: { id: string; fullName: string; phone: string | null } | null;
  vehicle: {
    id: string;
    stockNumber: string;
    status: VehicleStatus;
    askingPrice: string | null;
    modelYear: number;
    makeEn: string;
    makeAr: string;
    modelEn: string;
    modelAr: string;
  } | null;
  receivedBase: string;
  availableDepositBase: string;
  receipts: Array<{
    receiptId: string;
    number: string;
    receivedAt: string;
    status: 'posted' | 'voided';
    method: string;
    amount: string;
    currency: string;
    targetId: string;
    amountBase: string;
  }>;
  refunds: Refund[];
}

/** POST /reservations response: the reservation row plus the deposit receipt (if any). */
export interface ReservationCreated {
  id: string;
  number: string;
  receipt: { id: string; number: string } | null;
}

/** POST /reservations/:id/cancel response. */
export interface ReservationCancelled {
  id: string;
  number: string;
  forfeitedBase: string;
  refund: Refund | null;
}

/** Keys of every query showing reservation state (invalidated after reservation changes). */
export const RESERVATION_KEYS: unknown[][] = [['reservations'], ['reservation'], ['vehicle'], ['vehicles'], ['refunds'], ['receipts'], ['customer'], ['cash-accounts'], ['approvals']];
