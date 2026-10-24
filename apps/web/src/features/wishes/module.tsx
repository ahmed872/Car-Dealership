import { Heart } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { VehicleInterestedTab } from './VehicleInterestedTab';
import { WishDetailPage } from './WishDetailPage';
import { WishesListPage } from './WishesListPage';
import { WishFormPage } from './WishFormPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the wishes feature. */
export const wishesModule: FeatureModule = {
  routes: [
    { path: 'wishes', element: <Guard anyOf={['customers.read']}><WishesListPage /></Guard> },
    { path: 'wishes/new', element: <Guard anyOf={['customers.manage']}><WishFormPage /></Guard> },
    { path: 'wishes/:id', element: <Guard anyOf={['customers.read']}><WishDetailPage /></Guard> },
  ],
  nav: [{ group: 'crm', item: { to: '/app/wishes', labelKey: 'wishes.nav', icon: Heart, anyOf: ['customers.read'] } }],
  vehicleTabs: [{ key: 'interested', labelKey: 'wishes.vehicleTab.tab', anyOf: ['customers.read'], component: VehicleInterestedTab }],
};
