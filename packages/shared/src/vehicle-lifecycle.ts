export const VEHICLE_STATUSES = [
  'incoming',
  'awaiting_inspection',
  'in_inspection',
  'in_preparation',
  'ready',
  'available',
  'reserved',
  'sale_pending',
  'sold',
  'delivered',
  'returned',
  'removed',
] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const VEHICLE_STATUS_LABELS: Record<VehicleStatus, { en: string; ar: string; tone: StatusTone }> = {
  incoming: { en: 'Incoming', ar: 'واردة حديثًا', tone: 'info' },
  awaiting_inspection: { en: 'Awaiting inspection', ar: 'في انتظار الفحص', tone: 'warning' },
  in_inspection: { en: 'In inspection', ar: 'تحت الفحص', tone: 'warning' },
  in_preparation: { en: 'In preparation', ar: 'قيد التجهيز / الصيانة', tone: 'warning' },
  ready: { en: 'Ready for display', ar: 'جاهزة للعرض', tone: 'info' },
  available: { en: 'Available', ar: 'متاحة للبيع', tone: 'success' },
  reserved: { en: 'Reserved', ar: 'محجوزة', tone: 'accent' },
  sale_pending: { en: 'Sale in progress', ar: 'قيد إتمام البيع', tone: 'accent' },
  sold: { en: 'Sold', ar: 'مباعة', tone: 'neutral' },
  delivered: { en: 'Delivered', ar: 'تم التسليم', tone: 'neutral' },
  returned: { en: 'Returned', ar: 'مرتجعة', tone: 'danger' },
  removed: { en: 'Removed from stock', ar: 'مستبعدة من المخزون', tone: 'danger' },
};

export type StatusTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

/** States that only workflows (reservation, sale, delivery, return) may set. */
export const SYSTEM_ONLY_STATUSES: ReadonlySet<VehicleStatus> = new Set([
  'reserved',
  'sale_pending',
  'sold',
  'delivered',
  'returned',
]);

const T: Record<VehicleStatus, VehicleStatus[]> = {
  incoming: ['awaiting_inspection', 'in_inspection', 'in_preparation', 'ready', 'available', 'removed'],
  awaiting_inspection: ['in_inspection', 'in_preparation', 'removed'],
  in_inspection: ['awaiting_inspection', 'in_preparation', 'ready', 'available', 'removed'],
  in_preparation: ['in_inspection', 'ready', 'available', 'removed'],
  ready: ['available', 'in_preparation', 'in_inspection', 'removed'],
  available: ['ready', 'in_preparation', 'in_inspection', 'reserved', 'sale_pending', 'removed'],
  reserved: ['available', 'sale_pending'],
  sale_pending: ['available', 'reserved', 'sold'],
  sold: ['delivered', 'available'],
  delivered: ['returned'],
  returned: ['awaiting_inspection', 'in_inspection', 'in_preparation', 'available', 'removed'],
  removed: [],
};

export const VEHICLE_TRANSITIONS: Readonly<Record<VehicleStatus, readonly VehicleStatus[]>> = T;

export interface TransitionCheck {
  ok: boolean;
  reason?: 'same_status' | 'not_allowed' | 'system_only';
}

/**
 * @param system true when called by a workflow (reservation/sale/delivery/return).
 *               Manual changes may not enter or leave system-controlled states.
 */
export function checkTransition(from: VehicleStatus, to: VehicleStatus, system: boolean): TransitionCheck {
  if (from === to) return { ok: false, reason: 'same_status' };
  if (!T[from].includes(to)) return { ok: false, reason: 'not_allowed' };
  if (!system) {
    if (SYSTEM_ONLY_STATUSES.has(to)) return { ok: false, reason: 'system_only' };
    // Leaving reserved/sale_pending/sold/delivered manually would bypass the workflow that owns them.
    if (['reserved', 'sale_pending', 'sold', 'delivered'].includes(from))
      return { ok: false, reason: 'system_only' };
  }
  return { ok: true };
}

/** Physically held by the dealership (counted in stock takes and capital-tied reports). */
export const ON_HAND_STATUSES: readonly VehicleStatus[] = [
  'incoming',
  'awaiting_inspection',
  'in_inspection',
  'in_preparation',
  'ready',
  'available',
  'reserved',
  'sale_pending',
  'sold',
  'returned',
];

/** Statuses that count as unsold inventory for aging and capital-tied metrics. */
export const UNSOLD_STATUSES: readonly VehicleStatus[] = [
  'incoming',
  'awaiting_inspection',
  'in_inspection',
  'in_preparation',
  'ready',
  'available',
  'reserved',
  'sale_pending',
  'returned',
];

export function isPreSaleStatus(s: VehicleStatus): boolean {
  return [
    'incoming',
    'awaiting_inspection',
    'in_inspection',
    'in_preparation',
    'ready',
    'available',
    'returned',
  ].includes(s);
}
