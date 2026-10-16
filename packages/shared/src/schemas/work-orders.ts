import { z } from 'zod';
import { zMoneyNonNeg, zOptText, zText, zUuid } from './common';
import {
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_TYPES,
  zWorkOrderApprove,
  zWorkOrderCreate,
  zWorkOrderItem,
  zWorkOrderListQuery,
} from './purchasing';

/**
 * Work orders (workshop / preparation jobs). Base input schemas (create, item, approve, list) live
 * in ./purchasing next to the table enums; this file adds the module's remaining inputs and types.
 *
 * Lifecycle: open → in_progress (start) → awaiting_approval (complete, ≥1 item) → completed
 * (approve: every item with a total > 0 becomes one posted vehicle cost). There is no separate
 * "approved" status: `completed` is the final, approved state. An order awaiting approval can be
 * sent back to in_progress (reject); cancel is possible only before approval.
 *
 * Amounts (unit cost, line totals, estimate) are in the company base currency. A line total is
 * quantity × unit cost rounded to the currency's minor units with the tenant rounding mode
 * (default half-up), e.g. 2.5 × 10.01 = 25.025 → 25.03.
 */

/**
 * PATCH /work-orders/:id. Same fields as zWorkOrderUpdate but WITHOUT defaults: zWorkOrderUpdate
 * (= zWorkOrderCreate.partial()) keeps `priority`'s default, so a PATCH that omits priority would
 * silently reset it to "normal". Absent keys here leave the stored value unchanged.
 */
export const zWorkOrderPatch = z.object({
  type: z.enum(WORK_ORDER_TYPES).optional(),
  priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
  title: zText(200).min(2).optional(),
  description: zOptText(4000),
  assignedUserId: zUuid.optional().nullable(),
  supplierId: zUuid.optional().nullable(),
  estimatedCost: zMoneyNonNeg.optional().nullable(),
});

/** PATCH /work-orders/:id/items/:itemId — any subset of the item fields; the total is recomputed. */
export const zWorkOrderItemUpdate = zWorkOrderItem.partial();

/** GET /work-orders — the base list query plus branch / type / priority / supplier filters. */
export const zWorkOrderListFilter = zWorkOrderListQuery.extend({
  branchId: zUuid.optional(),
  type: z.enum(WORK_ORDER_TYPES).optional(),
  priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
  supplierId: zUuid.optional(),
});

export const WORK_ORDER_SORT_KEYS = ['createdAt', 'updatedAt', 'number', 'priority', 'status'] as const;
export type WorkOrderSortKey = (typeof WORK_ORDER_SORT_KEYS)[number];

export type WorkOrderCreateInput = z.infer<typeof zWorkOrderCreate>;
export type WorkOrderPatchInput = z.infer<typeof zWorkOrderPatch>;
export type WorkOrderItemInput = z.infer<typeof zWorkOrderItem>;
export type WorkOrderItemUpdateInput = z.infer<typeof zWorkOrderItemUpdate>;
export type WorkOrderApproveInput = z.infer<typeof zWorkOrderApprove>;
export type WorkOrderListFilter = z.infer<typeof zWorkOrderListFilter>;
