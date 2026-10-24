import { BadgePercent, CalendarClock, Calculator, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Field, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { assignableVersion, PolicyGroup, usePolicies } from './api';
import { CreatePolicyModal } from './policyForms';
import { PreviewCalculator, RuleSummary } from './rules';

/** Calculator over the saved policies: pick a policy, enter a deal, get the commission. */
function PolicyCalculatorCard({ policies }: { policies: PolicyGroup[] }) {
  const { t } = useTranslation();
  const options = policies.filter((p) => p.isActive && assignableVersion(p));
  const [code, setCode] = useState('');
  const chosen = options.find((p) => p.code === code) ?? null;
  const version = chosen ? assignableVersion(chosen) : null;
  return (
    <Card>
      <CardHeader title={t('employees.preview.title')} subtitle={t('employees.preview.subtitle')} />
      <CardBody className="space-y-3">
        <Field label={t('employees.preview.policy')}>
          {(id) => (
            <Select id={id} value={code} onChange={(e) => setCode(e.target.value)} disabled={!options.length}>
              <option value="">{t('employees.preview.choosePolicy')}</option>
              {options.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {version && (
          <div className="rounded-lg bg-surface-2/60 p-3">
            <p className="mb-1 text-xs text-muted">
              {t('employees.policies.versionN', { version: version.version })} · {t('employees.policies.effectiveFrom')} {fmtDate(version.effectiveFrom)}
            </p>
            <RuleSummary rule={version.rule} compact />
          </div>
        )}
        <PreviewCalculator key={version?.id ?? 'none'} source={{ policyId: version?.id ?? '' }} disabled={!version} />
      </CardBody>
    </Card>
  );
}

export function PoliciesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const q = usePolicies();
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const inactiveCount = q.data?.filter((p) => !p.isActive).length ?? 0;
  const rows = useMemo(() => q.data?.filter((p) => showInactive || p.isActive), [q.data, showInactive]);

  return (
    <>
      <PageHeader
        title={t('employees.policies.title')}
        subtitle={t('employees.policies.subtitle')}
        breadcrumbs={can('users.read') ? [{ label: t('employees.title'), to: '/app/employees' }, { label: t('employees.policies.title') }] : undefined}
        actions={
          <Can perm="commissions.manage_policies">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              {t('employees.policies.add')}
            </Button>
          </Can>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0">
          {inactiveCount > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
              <Checkbox
                label={`${t('employees.policies.showInactive')} (${inactiveCount})`}
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
            </div>
          )}
          <DataTable<PolicyGroup>
            rows={rows}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => q.refetch()}
            rowKey={(p) => p.code}
            onRowClick={(p) => navigate(`/app/commission-policies/${p.code}`)}
            empty={
              <EmptyState
                icon={<BadgePercent className="h-5 w-5" />}
                title={t('employees.policies.empty')}
                description={t('employees.policies.emptyHint')}
                action={
                  can('commissions.manage_policies') && (
                    <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                      {t('employees.policies.add')}
                    </Button>
                  )
                }
              />
            }
            columns={[
              {
                key: 'policy',
                header: t('employees.policies.name'),
                cell: (p) => (
                  <div className="min-w-0">
                    <Link
                      to={`/app/commission-policies/${p.code}`}
                      onClick={(e) => e.stopPropagation()}
                      className="block max-w-[220px] truncate font-medium text-ink hover:text-brand-strong hover:underline"
                    >
                      {p.name}
                    </Link>
                    <span dir="ltr" className="block text-start font-mono text-xs text-muted">
                      {p.code}
                    </span>
                    <span className="block text-xs text-subtle">{t('employees.policies.latestVersion', { version: p.latestVersion })}</span>
                  </div>
                ),
              },
              {
                key: 'rule',
                header: t('employees.policies.current'),
                cell: (p) => (
                  <div className="min-w-[240px] max-w-[360px] space-y-1.5">
                    {p.current ? (
                      <RuleSummary rule={p.current.rule} compact />
                    ) : (
                      <span className="text-[13px] text-muted">{t('employees.policies.noCurrent')}</span>
                    )}
                    {p.scheduled.length > 0 && (
                      <ul className="space-y-0.5 text-xs text-info">
                        {p.scheduled.map((v) => (
                          <li key={v.id} className="inline-flex items-center gap-1">
                            <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                            {t('employees.policies.scheduledFrom', { version: v.version, date: fmtDate(v.effectiveFrom) })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ),
              },
              {
                key: 'status',
                header: t('common.status'),
                cell: (p) => <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? t('employees.policies.active') : t('employees.policies.inactive')}</Badge>,
              },
            ]}
          />
        </Card>
        <div className="min-w-0">
          {q.data && q.data.some((p) => p.isActive) ? (
            <PolicyCalculatorCard policies={q.data} />
          ) : (
            <Card>
              <CardHeader title={t('employees.preview.title')} subtitle={t('employees.preview.subtitle')} />
              <CardBody>
                <EmptyState icon={<Calculator className="h-5 w-5" />} title={t('employees.preview.noPolicies')} />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
      {creating && (
        <CreatePolicyModal
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            navigate(`/app/commission-policies/${p.code}`);
          }}
        />
      )}
    </>
  );
}
