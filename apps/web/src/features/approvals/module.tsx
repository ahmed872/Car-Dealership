import { ClipboardCheck } from 'lucide-react';
import type { Permission } from '@autohub/shared';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { ApprovalsPage } from './ApprovalsPage';

/**
 * GET /approvals is open to any signed-in member and returns only what the caller may decide, so
 * the page is offered to anyone holding a decision permission (or approvals.read).
 */
const APPROVERS: Permission[] = [
  'approvals.read',
  'acquisitions.approve',
  'costs.approve',
  'expenses.approve',
  'work_orders.approve',
  'refunds.approve',
  'sales.approve_discount',
  'sales.approve_below_floor',
  'cash.adjust',
];

/** Routes, nav items, vehicle tabs and header widgets contributed by the approvals feature. */
export const approvalsModule: FeatureModule = {
  routes: [
    {
      path: 'approvals',
      element: (
        <Guard anyOf={APPROVERS}>
          <ApprovalsPage />
        </Guard>
      ),
    },
  ],
  nav: [
    {
      group: 'operations',
      item: { to: '/app/approvals', labelKey: 'nav.approvals', icon: ClipboardCheck, anyOf: APPROVERS },
    },
  ],
};
