import { Layers } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { AllocationPage } from './AllocationPage';
import { VehicleCostsTab } from './VehicleCostsTab';

/** Routes, nav items, vehicle tabs and header widgets contributed by the costs feature. */
export const costsModule: FeatureModule = {
  routes: [
    {
      path: 'costs/allocate',
      element: (
        <Guard anyOf={['costs.create']}>
          <AllocationPage />
        </Guard>
      ),
    },
  ],
  nav: [
    {
      group: 'purchasing',
      item: {
        to: '/app/costs/allocate',
        labelKey: 'costs.allocation.navLabel',
        icon: Layers,
        anyOf: ['costs.create'],
      },
    },
  ],
  // GET /vehicles/:id/costs requires costs.read (vehicles.view_cost alone is refused by the API).
  vehicleTabs: [{ key: 'costs', labelKey: 'costs.tab', anyOf: ['costs.read'], component: VehicleCostsTab }],
};
