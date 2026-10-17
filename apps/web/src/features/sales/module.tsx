import { HandCoins } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { SaleDetailPage } from './SaleDetailPage';
import { SaleFormPage } from './SaleFormPage';
import { SalesListPage } from './SalesListPage';
import { VehicleSalesTab } from './VehicleSalesTab';

/** Routes, nav items, vehicle tabs and header widgets contributed by the sales feature. */
export const salesModule: FeatureModule = {
  routes: [
    { path: 'sales', element: <Guard anyOf={['sales.read']}><SalesListPage /></Guard> },
    { path: 'sales/new', element: <Guard anyOf={['sales.create']}><SaleFormPage /></Guard> },
    { path: 'sales/:id', element: <Guard anyOf={['sales.read']}><SaleDetailPage /></Guard> },
    { path: 'sales/:id/edit', element: <Guard anyOf={['sales.create']}><SaleFormPage /></Guard> },
  ],
  nav: [{ group: 'sales', item: { to: '/app/sales', labelKey: 'nav.salesOrders', icon: HandCoins, anyOf: ['sales.read'] } }],
  vehicleTabs: [{ key: 'sales', labelKey: 'sales.vehicleTab.tab', anyOf: ['sales.read'], component: VehicleSalesTab }],
};
