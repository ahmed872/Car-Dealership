import { ArrowLeftRight, Wallet } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { CashAccountDetailPage } from './CashAccountDetailPage';
import { CashAccountsPage } from './CashAccountsPage';
import { TransferDetailPage } from './TransferDetailPage';
import { TransfersPage } from './TransfersPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the cash feature. */
export const cashModule: FeatureModule = {
  routes: [
    {
      path: 'cash/accounts',
      element: (
        <Guard anyOf={['cash.read']}>
          <CashAccountsPage />
        </Guard>
      ),
    },
    {
      path: 'cash/accounts/:id',
      element: (
        <Guard anyOf={['cash.read']}>
          <CashAccountDetailPage />
        </Guard>
      ),
    },
    {
      path: 'cash/transfers',
      element: (
        <Guard anyOf={['cash.read']}>
          <TransfersPage />
        </Guard>
      ),
    },
    {
      path: 'cash/transfers/:transferId',
      element: (
        <Guard anyOf={['cash.read']}>
          <TransferDetailPage />
        </Guard>
      ),
    },
  ],
  nav: [
    {
      group: 'finance',
      item: { to: '/app/cash/accounts', labelKey: 'nav.cash', icon: Wallet, anyOf: ['cash.read'] },
    },
    {
      group: 'finance',
      item: {
        to: '/app/cash/transfers',
        labelKey: 'cash.nav.transfers',
        icon: ArrowLeftRight,
        anyOf: ['cash.read'],
      },
    },
  ],
};
