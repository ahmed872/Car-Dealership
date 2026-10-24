import { BadgePercent, CalendarClock, GitBranchPlus, PowerOff, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader, Spinner } from '@/components/ui/Feedback';
import { Field, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { PolicyGroup, PolicyVersion, useEmployees, usePolicies, useRoleLabel, VersionState, versionState } from './api';
import { useEmpMutation } from './kit';
import { AddVersionModal } from './policyForms';
import { PreviewCalculator, RuleSummary } from './rules';

const STATE_TONE: Record<VersionState, Tone> = { current: 'success', scheduled: 'info', ended: 'neutral', inactive: 'danger' };

function VersionStateBadge({ state }: { state: VersionState }) {
  const { t } = useTranslation();
  return <Badge tone={STATE_TONE[state]}>{t(`employees.policies.states.${state}`)}</Badge>;
}

function Period({ v }: { v: PolicyVersion }) {
  const { t } = useTranslation();
  return (
    <span className="whitespace-nowrap">
      {v.effectiveTo
        ? t('employees.policies.period', { from: fmtDate(v.effectiveFrom), to: fmtDate(v.effectiveTo) })
        : t('employees.policies.periodOpen', { from: fmtDate(v.effectiveFrom) })}
    </span>
  );
}

/** One version as a block: number, validity window, rule. */
function VersionBlock({ v, state }: { v: PolicyVersion; state: VersionState }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{t('employees.policies.versionN', { version: v.version })}</span>
        <VersionStateBadge state={state} />
        <span className="text-xs text-muted">
          <Period v={v} />
        </span>
      </div>
      <RuleSummary rule={v.rule} />
    </div>
  );
}

/** Employees whose profile points at this policy (users.read). */
function PolicyEmployeesCard({ code }: { code: string }) {
  const { t } = useTranslation();
  const q = useEmployees();
  const roleLabel = useRoleLabel();
  const rows = q.data?.filter((e) => e.policyCode === code);
  // A plain list: the side column is too narrow for a table.
  return (
    <Card>
      <CardHeader title={t('employees.policies.employeesOn')} subtitle={rows ? t('employees.count', { count: rows.length }) : undefined} />
      {q.isLoading ? (
        <CardBody>
          <Spinner />
        </CardBody>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !rows?.length ? (
        <EmptyState icon={<Users className="h-5 w-5" />} title={t('employees.policies.noEmployees')} />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((e) => (
            <li key={e.userId} className="flex min-w-0 flex-col px-5 py-3">
              <Link to={`/app/employees/${e.userId}`} className="truncate text-sm font-medium text-ink hover:text-brand-strong hover:underline">
                {e.fullName}
              </Link>
              <span className="truncate text-xs text-muted">{e.profile?.jobTitle ?? roleLabel(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function VersionCalculatorCard({ group, today }: { group: PolicyGroup; today: string }) {
  const { t } = useTranslation();
  const versions = (group.versions ?? []).filter((v) => v.isActive && versionState(v, today) !== 'ended');
  const fallback = group.current ?? group.scheduled[0] ?? group.versions?.[0] ?? null;
  const [id, setId] = useState(fallback?.id ?? '');
  const chosen = group.versions?.find((v) => v.id === id) ?? fallback;
  return (
    <Card>
      <CardHeader title={t('employees.preview.title')} subtitle={t('employees.preview.subtitle')} />
      <CardBody className="space-y-3">
        {versions.length > 1 && (
          <Field label={t('employees.policies.version')}>
            {(fid) => (
              <Select id={fid} value={id} onChange={(e) => setId(e.target.value)}>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {t('employees.policies.versionN', { version: v.version })} — {t(`employees.policies.states.${versionState(v, today)}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <PreviewCalculator key={chosen?.id ?? 'none'} source={{ policyId: chosen?.id ?? '' }} disabled={!chosen} />
      </CardBody>
    </Card>
  );
}

/** A commission policy (all its versions), by code. */
export function PolicyDetailPage() {
  const { code } = useParams<{ code: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const q = usePolicies();
  const [versioning, setVersioning] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const today = todayIso(me?.tenant?.settings.timezone);
  const group = q.data?.find((p) => p.code === code);
  const latest = group?.versions?.[0];
  const deactivate = useEmpMutation<{ reason: string }, { ok: boolean }>({
    path: `/commission-policies/${latest?.id ?? ''}/deactivate`,
    invalidate: [['commission-policies'], ['employees']],
    success: t('employees.policies.deactivated'),
    onSuccess: () => setDeactivating(false),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!group) {
    return (
      <EmptyState
        icon={<BadgePercent className="h-5 w-5" />}
        title={t('employees.policies.notFound')}
        action={
          <Button variant="secondary" onClick={() => navigate('/app/commission-policies')}>
            {t('employees.policies.back')}
          </Button>
        }
      />
    );
  }

  const manage = can('commissions.manage_policies') && group.isActive;
  const history = group.versions ?? [];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('employees.policies.title'), to: '/app/commission-policies' }, { label: group.name }]}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="truncate">{group.name}</span>
            <Badge tone={group.isActive ? 'success' : 'neutral'}>{group.isActive ? t('employees.policies.active') : t('employees.policies.inactive')}</Badge>
          </span>
        }
        subtitle={
          <span dir="ltr" className="font-mono text-xs">
            {group.code}
          </span>
        }
        actions={
          manage && (
            <>
              <Button icon={<GitBranchPlus className="h-4 w-4" />} onClick={() => setVersioning(true)}>
                {t('employees.policies.addVersion')}
              </Button>
              <Button variant="ghost" className="text-danger" icon={<PowerOff className="h-4 w-4" />} onClick={() => setDeactivating(true)}>
                {t('employees.policies.deactivate')}
              </Button>
            </>
          )
        }
      />

      {!group.isActive && (
        <Alert tone="warning" className="mb-4">
          {t('employees.policies.inactiveNotice')}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title={t('employees.policies.current')} />
            <CardBody>
              {group.current ? (
                <VersionBlock v={group.current} state="current" />
              ) : (
                <p className="text-sm text-muted">{t('employees.policies.noCurrent')}</p>
              )}
            </CardBody>
          </Card>

          {group.scheduled.length > 0 && (
            <Card>
              <CardHeader title={t('employees.policies.scheduled')} />
              <CardBody className="space-y-5">
                {group.scheduled.map((v) => (
                  <div key={v.id} className="flex gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info">
                      <CalendarClock className="h-4 w-4" aria-hidden />
                    </span>
                    <VersionBlock v={v} state="scheduled" />
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title={t('employees.policies.history')} subtitle={t('employees.policies.historyHint')} />
            {/* A list rather than a table: a rule (with its tiers and limits) needs the width. */}
            <ul className="divide-y divide-line">
              {history.map((v) => (
                <li key={v.id} className="space-y-1.5 px-5 py-4">
                  <VersionBlock v={v} state={versionState(v, today)} />
                  <p className="text-xs text-subtle">
                    {v.name !== group.name && <span className="text-muted">{v.name} · </span>}
                    {t('employees.policies.createdAt')} {fmtDateTime(v.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <VersionCalculatorCard group={group} today={today} />
          {can('users.read') && <PolicyEmployeesCard code={group.code} />}
        </div>
      </div>

      {versioning && <AddVersionModal group={group} open={versioning} onClose={() => setVersioning(false)} />}
      <ConfirmDialog
        open={deactivating}
        onClose={() => setDeactivating(false)}
        onConfirm={(reason) => deactivate.mutate({ reason })}
        title={t('employees.policies.deactivateTitle')}
        message={
          <>
            <p className="font-medium text-ink">{group.name}</p>
            <p className="mt-1">{t('employees.policies.deactivateMessage')}</p>
          </>
        }
        confirmLabel={t('employees.policies.deactivate')}
        tone="danger"
        requireReason
        loading={deactivate.isPending}
      />
    </>
  );
}
