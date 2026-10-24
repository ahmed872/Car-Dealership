import type { CurrencyCode, VehicleStatus } from '@autohub/shared';
import {
  WORK_ORDER_ITEM_KINDS,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  WORK_ORDER_TYPES,
} from '@autohub/shared';
import type { Tone } from '@/components/ui/Badge';
import type { CostStatus, PaymentMethod } from '@/features/costs/api';
import { useApi } from '@/lib/hooks';
import { useAssignableMembers } from '@/lib/members';

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
export type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];
export type WorkOrderItemKind = (typeof WORK_ORDER_ITEM_KINDS)[number];

/** Row of GET /work-orders and GET /vehicles/:id/work-orders. */
export interface WorkOrderListItem {
  id: string;
  number: string;
  type: WorkOrderType;
  priority: WorkOrderPriority;
  title: string;
  status: WorkOrderStatus;
  estimatedCost: string | null;
  startedAt: string | null;
  completedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  vehicleId: string;
  branchId: string;
  stockNumber: string;
  vin: string | null;
  vehicleStatus: VehicleStatus;
  modelYear: number;
  makeEn: string;
  makeAr: string;
  modelEn: string;
  modelAr: string;
  assignedUserId: string | null;
  assigneeName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  itemCount: number;
  itemsTotal: string;
  postedTotal: string;
}

export interface WorkOrderItem {
  id: string;
  workOrderId: string;
  kind: WorkOrderItemKind;
  description: string;
  quantity: string;
  unitCost: string;
  total: string;
  hours: string | null;
  supplierId: string | null;
  categoryId: string;
  costId: string | null;
  createdAt: string;
  categoryCode: string;
  categoryEn: string;
  categoryAr: string;
  supplierName: string | null;
  cost: {
    id: string;
    status: CostStatus | null;
    amountBase: string | null;
    supplierId: string | null;
    paidBase: string;
    outstandingBase: string;
  } | null;
}

export interface WorkOrderPayment {
  paymentId: string;
  number: string;
  paidAt: string;
  status: 'posted' | 'voided';
  method: PaymentMethod;
  targetId: string;
  amountBase: string;
}

/** GET /work-orders/:id */
export interface WorkOrderDetail {
  id: string;
  number: string;
  vehicleId: string;
  type: WorkOrderType;
  priority: WorkOrderPriority;
  title: string;
  description: string | null;
  assignedUserId: string | null;
  supplierId: string | null;
  status: WorkOrderStatus;
  estimatedCost: string | null;
  startedAt: string | null;
  completedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Moves on every change to the order or its items; sent back on approve (stale screens are refused). */
  version: number;
  branchId: string;
  vehicle: {
    id: string;
    stockNumber: string;
    vin: string | null;
    status: VehicleStatus;
    modelYear: number;
    makeEn: string;
    makeAr: string;
    modelEn: string;
    modelAr: string;
  };
  assigneeName: string | null;
  approvedByName: string | null;
  supplierName: string | null;
  currency: CurrencyCode;
  totals: { items: string; posted: string; paid: string; outstanding: string };
  items: WorkOrderItem[];
  payments: WorkOrderPayment[];
}

export const EDITABLE_STATUSES: ReadonlySet<WorkOrderStatus> = new Set(['open', 'in_progress']);

export const statusTone: Record<WorkOrderStatus, Tone> = {
  open: 'info',
  in_progress: 'accent',
  awaiting_approval: 'warning',
  completed: 'success',
  cancelled: 'neutral',
};

export const priorityTone: Record<WorkOrderPriority, Tone> = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
};

export function woVehicleTitle(
  v: { makeEn: string; makeAr: string; modelEn: string; modelAr: string; modelYear: number },
  lang: string,
): string {
  return lang === 'en'
    ? `${v.makeEn} ${v.modelEn} ${v.modelYear}`
    : `${v.makeAr} ${v.modelAr} ${v.modelYear}`;
}

export const useWorkOrder = (id: string | undefined) =>
  useApi<WorkOrderDetail>(['work-order', id], id ? `/work-orders/${id}` : null);

/**
 * Staff who can be given work orders: active members whose role holds work_orders.manage and who
 * can reach `branchId` (the vehicle's branch; without it, the caller's branches). From
 * GET /members/assignable, so no member-directory permission is needed.
 */
export function useWorkOrderAssignees(branchId?: string | null) {
  const q = useAssignableMembers('work_orders.manage', branchId);
  return { ...q, list: q.data ?? [] };
}
