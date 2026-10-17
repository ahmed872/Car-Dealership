import { FileBarChart2 } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { ReportPage } from './ReportPage';
import { ReportsHubPage } from './ReportsHubPage';

/**
 * Reports hub and report pages. The hub is offered to holders of reports.view or
 * reports.financial; each report page re-checks the exact permissions its API route requires.
 */
export const reportsModule: FeatureModule = {
  routes: [
    { path: 'reports', element: <Guard anyOf={['reports.view', 'reports.financial']}><ReportsHubPage /></Guard> },
    { path: 'reports/:key', element: <Guard anyOf={['reports.view', 'reports.financial']}><ReportPage /></Guard> },
  ],
  nav: [{ group: 'finance', item: { to: '/app/reports', labelKey: 'nav.reports', icon: FileBarChart2, anyOf: ['reports.view', 'reports.financial'] } }],
};
