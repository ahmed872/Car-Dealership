import { Users } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { CustomerDetailPage } from './CustomerDetailPage';
import { CustomerFormPage } from './CustomerFormPage';
import { CustomersListPage } from './CustomersListPage';

/**
 * Customers (CRM master data). The list and the 360 view follow the API's visibility rules: a
 * sales rep sees only their own customers, managers with customers.read_all see the branch.
 */
export const customersModule: FeatureModule = {
  routes: [
    { path: 'customers', element: <Guard anyOf={['customers.read']}><CustomersListPage /></Guard> },
    { path: 'customers/new', element: <Guard anyOf={['customers.manage']}><CustomerFormPage /></Guard> },
    { path: 'customers/:id', element: <Guard anyOf={['customers.read']}><CustomerDetailPage /></Guard> },
    { path: 'customers/:id/edit', element: <Guard anyOf={['customers.manage']}><CustomerFormPage /></Guard> },
  ],
  nav: [{ group: 'crm', item: { to: '/app/customers', labelKey: 'nav.customers', icon: Users, anyOf: ['customers.read'] } }],
};
