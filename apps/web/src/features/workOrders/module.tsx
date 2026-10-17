import { Wrench } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { VehicleWorkOrdersTab } from './VehicleWorkOrdersTab';
import { WorkOrderDetailPage } from './WorkOrderDetailPage';
import { WorkOrdersListPage } from './WorkOrdersListPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the workOrders feature. */
export const workOrdersModule: FeatureModule = {
  routes: [
    {
      path: 'work-orders',
      element: (
        <Guard anyOf={['work_orders.read']}>
          <WorkOrdersListPage />
        </Guard>
      ),
    },
    {
      path: 'work-orders/:id',
      element: (
        <Guard anyOf={['work_orders.read']}>
          <WorkOrderDetailPage />
        </Guard>
      ),
    },
  ],
  nav: [
    {
      group: 'inventory',
      item: { to: '/app/work-orders', labelKey: 'nav.workOrders', icon: Wrench, anyOf: ['work_orders.read'] },
    },
  ],
  vehicleTabs: [
    {
      key: 'workOrders',
      labelKey: 'workOrders.tab',
      anyOf: ['work_orders.read'],
      component: VehicleWorkOrdersTab,
    },
  ],
};
