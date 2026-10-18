import { Receipt } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { ExpenseDetailPage } from './ExpenseDetailPage';
import { ExpensesPage } from './ExpensesPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the expenses feature. */
export const expensesModule: FeatureModule = {
  routes: [
    {
      path: 'expenses',
      element: (
        <Guard anyOf={['expenses.read']}>
          <ExpensesPage />
        </Guard>
      ),
    },
    {
      path: 'expenses/:id',
      element: (
        <Guard anyOf={['expenses.read']}>
          <ExpenseDetailPage />
        </Guard>
      ),
    },
  ],
  nav: [
    {
      group: 'finance',
      item: { to: '/app/expenses', labelKey: 'nav.expenses', icon: Receipt, anyOf: ['expenses.read'] },
    },
  ],
};
