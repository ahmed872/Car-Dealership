import { z } from 'zod';
import { patchOf, zOptText, zText } from './common';
import { zAppointmentCreate } from './crm';

/** Type and branch are fixed once booked (cancel and book again instead). */
export const zAppointmentUpdate = patchOf(zAppointmentCreate.omit({ type: true, branchId: true })).extend({
  version: z.number().int().min(1),
});
export type AppointmentUpdateInput = z.infer<typeof zAppointmentUpdate>;
export type AppointmentCreateInput = z.infer<typeof zAppointmentCreate>;

export const zAppointmentCancel = z.object({ reason: zText(500).min(3), version: z.number().int().min(1).optional() });
export const zAppointmentComplete = z.object({ outcome: zOptText(1000), version: z.number().int().min(1).optional() });
export const zAppointmentNoShow = z.object({ note: zOptText(500), version: z.number().int().min(1).optional() });
export const zAppointmentConfirm = z.object({ version: z.number().int().min(1).optional() });

/** Longest calendar window one request may load. */
export const APPOINTMENT_MAX_WINDOW_DAYS = 62;
/** Longest single appointment. */
export const APPOINTMENT_MAX_HOURS = 12;
