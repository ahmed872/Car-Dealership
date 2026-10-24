import type { APPOINTMENT_STATUSES, APPOINTMENT_TYPES } from '@autohub/shared';

export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export interface AppointmentVehicle {
  id: string;
  stockNumber: string | null;
  modelYear: number | null;
  makeEn: string | null;
  makeAr: string | null;
  modelEn: string | null;
  modelAr: string | null;
}

interface AppointmentCommon {
  id: string;
  type: AppointmentType;
  status: AppointmentStatus;
  branchId: string;
  branchName: string;
  startsAt: string;
  endsAt: string;
  assignedUserId: string | null;
  assigneeName: string | null;
  vehicle: AppointmentVehicle | null;
  version: number;
}

/** Someone else's booking: only who is busy, when, and with which vehicle. */
export interface BusyAppointment extends AppointmentCommon {
  restricted: true;
}

export interface FullAppointment extends AppointmentCommon {
  restricted: false;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  leadId: string | null;
  leadNumber: string | null;
  title: string | null;
  notes: string | null;
  outcome: string | null;
  cancelReason: string | null;
  driverLicenseNumber: string | null;
  driverLicenseExpiry: string | null;
  odometerOut: number | null;
  odometerIn: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type Appointment = BusyAppointment | FullAppointment;

export interface AppointmentList {
  items: Appointment[];
  truncated: boolean;
}

export const APPOINTMENT_KEYS: unknown[][] = [['appointments'], ['appointment'], ['customer'], ['vehicle'], ['lead']];

/** Booked appointments can still be changed. */
export const BOOKED: AppointmentStatus[] = ['scheduled', 'confirmed'];
