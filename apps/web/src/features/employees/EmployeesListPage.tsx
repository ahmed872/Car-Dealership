import { BadgePercent, Search, UserRound, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/format';
import { EmployeeRow, useEmployees, useRoleLabel } from './api';

/** Members of the company with their employee profiles (users.read). */
export function EmployeesListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currency, canAny } = useAuth();
  const q = useEmployees();
  const roleLabel = useRoleLabel();
  const [search, setSearch] = useState('');
  const rows = useMemo(() => {
    const s = search.trim().toLocaleLowerCase();
    if (!q.data || !s) return q.data;
    return q.data.filter((e) => [e.fullName, e.email, e.profile?.employeeCode, e.profile?.jobTitle].some((x) => x?.toLocaleLowerCase().includes(s)));
  }, [q.data, search]);

  return (
    <>
      <PageHeader
        title={t('employees.title')}
        subtitle={t('employees.subtitle')}
        actions={
          <>
            {canAny('commissions.read', 'commissions.manage_policies') && (
              <Button variant="secondary" icon={<BadgePercent className="h-4 w-4" />} onClick={() => navigate('/app/commission-policies')}>
                {t('employees.policiesNav')}
              </Button>
            )}
            <Button variant="secondary" icon={<UserRound className="h-4 w-4" />} onClick={() => navigate('/app/employees/me')}>
              {t('employees.myProfile')}
            </Button>
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input type="search" className="ps-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('employees.search')} aria-label={t('common.search')} />
          </div>
          {q.data && <span className="num text-[13px] text-muted">{t('employees.count', { count: rows?.length ?? 0 })}</span>}
        </div>
        <DataTable<EmployeeRow>
          rows={rows}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(e) => e.userId}
          onRowClick={(e) => navigate(`/app/employees/${e.userId}`)}
          empty={<EmptyState icon={<Users className="h-5 w-5" />} title={search ? t('employees.noMatch') : t('employees.empty')} />}
          columns={[
            {
              key: 'employee',
              header: t('employees.columns.employee'),
              cell: (e) => (
                <div className="min-w-0">
                  <Link to={`/app/employees/${e.userId}`} onClick={(ev) => ev.stopPropagation()} className="block max-w-[220px] truncate font-medium text-ink hover:text-brand-strong hover:underline">
                    {e.fullName}
                  </Link>
                  <span dir="ltr" className="block max-w-[220px] truncate text-start text-xs text-muted">
                    {e.email}
                  </span>
                </div>
              ),
            },
            { key: 'code', header: t('employees.columns.code'), cell: (e) => <span className="num">{e.profile?.employeeCode ?? '—'}</span> },
            {
              key: 'title',
              header: t('employees.columns.jobTitle'),
              hideOnMobile: true,
              cell: (e) => (e.profile ? (e.profile.jobTitle ?? '—') : <span className="text-xs text-subtle">{t('employees.noProfile')}</span>),
            },
            { key: 'role', header: t('employees.columns.role'), hideOnMobile: true, cell: (e) => roleLabel(e) },
            {
              key: 'policy',
              header: t('employees.columns.policy'),
              cell: (e) =>
                e.policyCode ? (
                  <span className="block max-w-[180px] truncate" title={e.policyCode}>
                    {e.policyName}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'target',
              header: t('employees.columns.target'),
              align: 'end',
              hideOnMobile: true,
              cell: (e) => (
                <div className="num whitespace-nowrap text-end">
                  {e.profile?.monthlyTargetAmount ? <span className="block">{fmtMoney(e.profile.monthlyTargetAmount, currency)}</span> : null}
                  {e.profile?.monthlyTargetUnits != null ? <span className="block text-xs text-muted">{t('employees.targetUnits', { count: e.profile.monthlyTargetUnits })}</span> : null}
                  {!e.profile?.monthlyTargetAmount && e.profile?.monthlyTargetUnits == null && '—'}
                </div>
              ),
            },
            {
              key: 'status',
              header: t('employees.columns.status'),
              cell: (e) => <Badge tone={e.membershipStatus === 'active' ? 'success' : 'danger'}>{t(`employees.membership.${e.membershipStatus}`)}</Badge>,
            },
          ]}
        />
      </Card>
    </>
  );
}
