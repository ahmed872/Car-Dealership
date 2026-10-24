import { CalendarDays } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { AppointmentDetailPage } from './AppointmentDetailPage';
import { AppointmentsPage } from './AppointmentsPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the appointments feature. */
export const appointmentsModule: FeatureModule = {
  routes: [
    { path: 'appointments', element: <Guard anyOf={['appointments.read']}><AppointmentsPage /></Guard> },
    { path: 'appointments/:id', element: <Guard anyOf={['appointments.read']}><AppointmentDetailPage /></Guard> },
  ],
  nav: [{ group: 'crm', item: { to: '/app/appointments', labelKey: 'nav.appointments', icon: CalendarDays, anyOf: ['appointments.read'] } }],
};
