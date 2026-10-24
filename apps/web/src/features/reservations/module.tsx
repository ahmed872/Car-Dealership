import { BookmarkCheck } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { ReservationDetailPage } from './ReservationDetailPage';
import { ReservationsListPage } from './ReservationsListPage';
import { VehicleReservationTab } from './VehicleReservationTab';

/** Routes, nav items, vehicle tabs and header widgets contributed by the reservations feature. */
export const reservationsModule: FeatureModule = {
  routes: [
    { path: 'reservations', element: <Guard anyOf={['reservations.read']}><ReservationsListPage /></Guard> },
    { path: 'reservations/:id', element: <Guard anyOf={['reservations.read']}><ReservationDetailPage /></Guard> },
  ],
  nav: [{ group: 'sales', item: { to: '/app/reservations', labelKey: 'nav.reservations', icon: BookmarkCheck, anyOf: ['reservations.read'] } }],
  vehicleTabs: [{ key: 'reservation', labelKey: 'reservations.vehicleTab.tab', anyOf: ['reservations.read'], component: VehicleReservationTab }],
};
