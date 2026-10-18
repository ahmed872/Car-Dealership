import { BookOpenCheck } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { JournalEntryPage } from './JournalEntryPage';
import { LedgerPage } from './LedgerPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the accounting feature. */
export const accountingModule: FeatureModule = {
  routes: [
    {
      path: 'accounting',
      element: (
        <Guard anyOf={['ledger.read']}>
          <LedgerPage />
        </Guard>
      ),
    },
    {
      path: 'accounting/entries/:id',
      element: (
        <Guard anyOf={['ledger.read']}>
          <JournalEntryPage />
        </Guard>
      ),
    },
  ],
  nav: [
    {
      group: 'finance',
      item: { to: '/app/accounting', labelKey: 'nav.ledger', icon: BookOpenCheck, anyOf: ['ledger.read'] },
    },
  ],
};
