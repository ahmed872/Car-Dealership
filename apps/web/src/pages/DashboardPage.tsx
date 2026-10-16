import { Building2, ShieldCheck, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { StatCard } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

interface Company {
  usage: { users: number; branches: number; vehicles: number };
  subscription: { plan: { nameAr: string; nameEn: string } } | null;
}

/** Phase 1 dashboard: real counts only. Operational KPIs arrive with the modules that produce them. */
export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const company = useApi<Company>(['company'], '/company');
  const u = company.data?.usage;
  return (
    <>
      <PageHeader
        title={t('dashboard.welcome', { name: me?.user.fullName })}
        subtitle={t('dashboard.subtitle')}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('nav.branches')}
          value={u?.branches ?? '—'}
          icon={<Building2 className="h-5 w-5" />}
          tone="info"
          onClick={can('branches.manage') ? () => navigate('/app/settings/branches') : undefined}
        />
        <StatCard
          label={t('nav.users')}
          value={u?.users ?? '—'}
          icon={<Users className="h-5 w-5" />}
          tone="brand"
          onClick={can('users.read') ? () => navigate('/app/settings/users') : undefined}
        />
        <StatCard
          label={t('settings.plan')}
          value={
            company.data?.subscription
              ? i18n.language === 'en'
                ? company.data.subscription.plan.nameEn
                : company.data.subscription.plan.nameAr
              : '—'
          }
          icon={<ShieldCheck className="h-5 w-5" />}
          tone="success"
        />
      </div>
    </>
  );
}
