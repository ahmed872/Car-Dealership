import { BadgePercent } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { CommissionsPage } from './CommissionsPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the commissions feature. */
export const commissionsModule: FeatureModule = {
  routes: [{ path: 'commissions', element: <Guard anyOf={['commissions.read', 'commissions.read_own']}><CommissionsPage /></Guard> }],
  nav: [
    {
      group: 'sales',
      item: { to: '/app/commissions', labelKey: 'nav.commissions', icon: BadgePercent, anyOf: ['commissions.read', 'commissions.read_own'] },
    },
  ],
};
