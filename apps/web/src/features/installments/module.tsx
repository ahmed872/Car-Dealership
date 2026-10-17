import { CalendarClock } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { InstallmentPlanPage } from './InstallmentPlanPage';
import { InstallmentsListPage } from './InstallmentsListPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the installments feature. */
export const installmentsModule: FeatureModule = {
  routes: [
    { path: 'installments', element: <Guard anyOf={['installments.read']}><InstallmentsListPage /></Guard> },
    { path: 'installments/:id', element: <Guard anyOf={['installments.read']}><InstallmentPlanPage /></Guard> },
  ],
  nav: [{ group: 'sales', item: { to: '/app/installments', labelKey: 'nav.installments', icon: CalendarClock, anyOf: ['installments.read'] } }],
};
