import type { REFUND_SOURCE_TYPES, REFUND_STATUSES, RECEIPT_TARGET_TYPES } from '@autohub/shared';

export type ReceiptStatus = 'posted' | 'voided';
export type ReceiptTargetType = (typeof RECEIPT_TARGET_TYPES)[number];
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export type RefundSourceType = (typeof REFUND_SOURCE_TYPES)[number];

/** GET /receipts items. */
export interface ReceiptListItem {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  cashAccountId: string;
  cashAccountName: string;
  amount: string;
  currency: string;
  amountBase: string;
  receivedAt: string;
  method: string;
  reference: string | null;
  status: ReceiptStatus;
  voidReason: string | null;
}

/** GET /receipts/:id. */
export interface ReceiptDetail {
  id: string;
  number: string;
  customerId: string;
  customerName: string | null;
  cashAccountId: string;
  branchId: string | null;
  amount: string;
  currency: string;
  exchangeRate: string;
  amountBase: string;
  receivedAt: string;
  method: string;
  reference: string | null;
  notes: string | null;
  status: ReceiptStatus;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  /** documentNumber: the reservation or sale number (an installment plan is known by its sale); null for customer credit. */
  allocations: Array<{ id: string; targetType: ReceiptTargetType; targetId: string; amountBase: string; documentNumber: string | null }>;
}

/** GET /refunds items and GET /refunds/:id (the list adds customerName). */
export interface Refund {
  id: string;
  number: string;
  customerId: string;
  customerName?: string;
  sourceType: RefundSourceType;
  sourceId: string;
  branchId: string | null;
  amountBase: string;
  reason: string;
  status: RefundStatus;
  requestedBy: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cashAccountId: string | null;
  method: string | null;
  reference: string | null;
  paidAt: string | null;
}

/** Link to the document behind a receipt allocation or refund source. */
export function targetLink(type: ReceiptTargetType | RefundSourceType, id: string, customerId: string): string | null {
  if (type === 'reservation') return `/app/reservations/${id}`;
  if (type === 'sale') return `/app/sales/${id}`;
  if (type === 'installment') return `/app/installments/${id}`;
  if (type === 'customer_credit') return `/app/customers/${customerId}`;
  return null;
}
