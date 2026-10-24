import { BadgePercent, IdCard, UserRound } from 'lucide-react';
import { PERMISSIONS, Permission } from '@autohub/shared';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { EmployeeProfilePage } from './EmployeeProfilePage';
import { EmployeesListPage } from './EmployeesListPage';
import { PoliciesPage } from './PoliciesPage';
import { PolicyDetailPage } from './PolicyDetailPage';

/** Every member may open their own profile (GET /employees/:userId is @Authenticated for oneself). */
const ANY_MEMBER = Object.keys(PERMISSIONS) as Permission[];
const POLICY_READERS: Permission[] = ['commissions.read', 'commissions.manage_policies'];

/** Routes, nav items, vehicle tabs and header widgets contributed by the employees feature. */
export const employeesModule: FeatureModule = {
  routes: [
    { path: 'employees', element: <Guard anyOf={['users.read']}><EmployeesListPage /></Guard> },
    { path: 'employees/me', element: <Guard anyOf={ANY_MEMBER}><EmployeeProfilePage /></Guard> },
    { path: 'employees/:userId', element: <Guard anyOf={['users.read']}><EmployeeProfilePage /></Guard> },
    { path: 'commission-policies', element: <Guard anyOf={POLICY_READERS}><PoliciesPage /></Guard> },
    { path: 'commission-policies/:code', element: <Guard anyOf={POLICY_READERS}><PolicyDetailPage /></Guard> },
  ],
  nav: [
    { group: 'admin', item: { to: '/app/employees', labelKey: 'employees.nav', icon: IdCard, anyOf: ['users.read'] } },
    { group: 'admin', item: { to: '/app/commission-policies', labelKey: 'employees.policiesNav', icon: BadgePercent, anyOf: POLICY_READERS } },
    { group: 'admin', item: { to: '/app/employees/me', labelKey: 'employees.myProfileNav', icon: UserRound, anyOf: ANY_MEMBER } },
  ],
};
