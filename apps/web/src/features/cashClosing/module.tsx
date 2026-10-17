import { LockKeyhole } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { CashClosingPage } from './CashClosingPage';

/** Routes, nav items, vehicle tabs and header widgets contributed by the cashClosing feature. */
export const cashClosingModule: FeatureModule = {
  routes: [{ path: 'cash-closing', element: <Guard anyOf={['cash.close', 'cash.read']}><CashClosingPage /></Guard> }],
  nav: [{ group: 'finance', item: { to: '/app/cash-closing', labelKey: 'cashClosing.nav', icon: LockKeyhole, anyOf: ['cash.close', 'cash.read'] } }],
};
