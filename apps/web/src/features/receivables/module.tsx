import { ReceiptText, Undo2 } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { ReceiptDetailPage } from './ReceiptDetailPage';
import { ReceiptsPage } from './ReceiptsPage';
import { RefundsPage } from './RefundsPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the receivables feature. */
export const receivablesModule: FeatureModule = {
  routes: [
    { path: 'receipts', element: <Guard anyOf={['payments.read']}><ReceiptsPage /></Guard> },
    { path: 'receipts/:id', element: <Guard anyOf={['payments.read']}><ReceiptDetailPage /></Guard> },
    { path: 'refunds', element: <Guard anyOf={['payments.read']}><RefundsPage /></Guard> },
  ],
  nav: [
    { group: 'finance', item: { to: '/app/receipts', labelKey: 'nav.payments', icon: ReceiptText, anyOf: ['payments.read'] } },
    { group: 'finance', item: { to: '/app/refunds', labelKey: 'receivables.nav.refunds', icon: Undo2, anyOf: ['payments.read'] } },
  ],
};
