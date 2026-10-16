import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Permission } from '@autohub/shared';
import { EmptyState, PageLoader } from '@/components/ui/Feedback';
import { useAuth } from '@/lib/auth';
import { AccountPage } from '@/pages/AccountPage';
import { LoginPage } from '@/pages/auth/LoginPage';
import { SelectCompanyPage } from '@/pages/auth/SelectCompanyPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { PlatformPage } from '@/pages/PlatformPage';
import { AuditPage } from '@/pages/settings/AuditPage';
import { BranchesPage } from '@/pages/settings/BranchesPage';
import { CompanySettingsPage } from '@/pages/settings/CompanySettingsPage';
import { RolesPage } from '@/pages/settings/RolesPage';
import { UsersPage } from '@/pages/settings/UsersPage';
import { AppShell } from './AppShell';
import { featureRoutes } from './feature-routes';

function RequireTenant() {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!me.tenant) return <Navigate to={me.user.isPlatformAdmin ? '/platform' : '/select-company'} replace />;
  return <Outlet />;
}

function RequirePlatformAdmin() {
  const { me, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace />;
  if (!me.user.isPlatformAdmin) return <Navigate to="/app" replace />;
  return <Outlet />;
}

/** Client-side gate for better UX; the API enforces the same permissions. */
export function Guard({ anyOf, children }: { anyOf: Permission[]; children: ReactNode }) {
  const { canAny } = useAuth();
  const { t } = useTranslation();
  if (!canAny(...anyOf)) return <EmptyState title={t('errors.forbidden')} />;
  return <>{children}</>;
}

function NotFound() {
  const { t } = useTranslation();
  return <EmptyState title="404" description={t('errors.not_found')} />;
}

export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/app" replace /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/select-company', element: <SelectCompanyPage /> },
  { element: <RequirePlatformAdmin />, children: [{ path: '/platform', element: <PlatformPage /> }] },
  ...featureRoutes.public,
  {
    element: <RequireTenant />,
    children: [
      {
        path: '/app',
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'account', element: <AccountPage /> },
          {
            path: 'settings/company',
            element: (
              <Guard anyOf={['settings.read', 'settings.manage']}>
                <CompanySettingsPage />
              </Guard>
            ),
          },
          {
            path: 'settings/branches',
            element: (
              <Guard anyOf={['branches.manage', 'settings.read']}>
                <BranchesPage />
              </Guard>
            ),
          },
          {
            path: 'settings/users',
            element: (
              <Guard anyOf={['users.read']}>
                <UsersPage />
              </Guard>
            ),
          },
          {
            path: 'settings/roles',
            element: (
              <Guard anyOf={['users.read', 'roles.manage']}>
                <RolesPage />
              </Guard>
            ),
          },
          {
            path: 'settings/audit',
            element: (
              <Guard anyOf={['audit.read']}>
                <AuditPage />
              </Guard>
            ),
          },
          ...featureRoutes.app,
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
