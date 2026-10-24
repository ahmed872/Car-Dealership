import { BadgePercent, Mail, Pencil, UserRound } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { zEmployeeProfileUpdate } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList, StatCard } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney, fmtNumber, fmtPhone } from '@/lib/format';
import { assignableVersion, EmployeeDetail, EmployeeProfile, useEmployee, usePolicies, useRoleLabel } from './api';
import { issuesToFields, serverFieldErrors, useEmpError, useEmpFieldMessage, useEmpMutation } from './kit';
import { RuleSummary } from './rules';

interface ProfileForm {
  employeeCode: string;
  jobTitle: string;
  phone: string;
  hireDate: string;
  monthlyTargetUnits: string;
  monthlyTargetAmount: string;
  /** Policy code; the request carries the id of its assignable version. */
  policyCode: string;
  notes: string;
}

function toForm(e: EmployeeDetail): ProfileForm {
  const p = e.profile;
  return {
    employeeCode: p?.employeeCode ?? '',
    jobTitle: p?.jobTitle ?? '',
    phone: p?.phone ?? '',
    hireDate: p?.hireDate ?? '',
    monthlyTargetUnits: p?.monthlyTargetUnits != null ? String(p.monthlyTargetUnits) : '',
    monthlyTargetAmount: p?.monthlyTargetAmount ?? '',
    policyCode: e.policyCode ?? '',
    notes: p?.notes ?? '',
  };
}

function EditProfileModal({ employee, open, onClose }: { employee: EmployeeDetail; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { currency, canAny } = useAuth();
  const msg = useEmpFieldMessage();
  const describe = useEmpError();
  const canPolicies = canAny('commissions.read', 'commissions.manage_policies');
  const policies = usePolicies(canPolicies);
  const [form, setFormState] = useState<ProfileForm>(() => toForm(employee));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = useEmpMutation<Record<string, unknown>, EmployeeProfile>({
    path: `/employees/${employee.userId}/profile`,
    method: 'PUT',
    invalidate: [['employees']],
    success: t('employees.profile.saved'),
    toastError: false,
    onSuccess: onClose,
  });
  const set = (patch: Partial<ProfileForm>) => {
    setFormState((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k === 'policyCode' ? 'commissionPolicyId' : k];
      return next;
    });
  };
  const initial = toForm(employee);
  const activePolicies = (policies.data ?? []).filter((p) => p.isActive);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const errs: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    for (const k of ['employeeCode', 'jobTitle', 'phone', 'hireDate', 'monthlyTargetAmount', 'notes'] as const) {
      if (form[k].trim() !== initial[k].trim()) body[k] = form[k].trim() === '' ? null : form[k].trim();
    }
    if (form.monthlyTargetUnits.trim() !== initial.monthlyTargetUnits) {
      const v = form.monthlyTargetUnits.trim();
      if (v === '') body.monthlyTargetUnits = null;
      else if (!/^\d+$/.test(v)) errs.monthlyTargetUnits = 'integer';
      else body.monthlyTargetUnits = Number(v);
    }
    if (canPolicies && form.policyCode !== initial.policyCode) {
      const group = activePolicies.find((p) => p.code === form.policyCode);
      body.commissionPolicyId = form.policyCode ? (group ? (assignableVersion(group)?.id ?? null) : null) : null;
    }
    const parsed = zEmployeeProfileUpdate.safeParse(body);
    if (!parsed.success) for (const [k, v] of Object.entries(issuesToFields(parsed.error.issues))) errs[k] ??= v;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    // An employee without a profile yet gets one even when nothing was typed (all fields empty).
    if (!Object.keys(body).length && employee.profile) return onClose();
    try {
      await save.mutateAsync(body);
    } catch (err) {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (!Object.keys(fields).length) setFormError(describe(err));
    }
  };

  const text = (k: 'employeeCode' | 'jobTitle' | 'phone', opts: { dir?: 'ltr'; max: number; type?: string }) => (
    <Field label={t(`employees.fields.${k}`)} error={msg(errors[k])}>
      {(id, d) => (
        <Input id={id} aria-describedby={d} invalid={!!errors[k]} dir={opts.dir} type={opts.type} className={opts.dir ? 'num text-start' : undefined} maxLength={opts.max} value={form[k]} onChange={(e) => set({ [k]: e.target.value })} />
      )}
    </Field>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('employees.profile.editTitle')}
      description={employee.fullName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="employee-form" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="employee-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        {text('employeeCode', { max: 30 })}
        {text('jobTitle', { max: 80 })}
        {text('phone', { dir: 'ltr', max: 30, type: 'tel' })}
        <Field label={t('employees.fields.hireDate')} error={msg(errors.hireDate)}>
          {(id, d) => <Input id={id} aria-describedby={d} invalid={!!errors.hireDate} type="date" value={form.hireDate} onChange={(e) => set({ hireDate: e.target.value })} />}
        </Field>
        <Field label={t('employees.fields.monthlyTargetUnits')} error={msg(errors.monthlyTargetUnits)}>
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              invalid={!!errors.monthlyTargetUnits}
              type="number"
              inputMode="numeric"
              min={0}
              max={10000}
              step={1}
              dir="ltr"
              className="num text-start"
              value={form.monthlyTargetUnits}
              onChange={(e) => set({ monthlyTargetUnits: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('employees.fields.monthlyTargetAmount')} error={msg(errors.monthlyTargetAmount)}>
          {(id, d) => <MoneyInput id={id} aria-describedby={d} invalid={!!errors.monthlyTargetAmount} currency={currency} value={form.monthlyTargetAmount} onChange={(e) => set({ monthlyTargetAmount: e.target.value })} />}
        </Field>
        <Field label={t('employees.fields.commissionPolicyId')} error={msg(errors.commissionPolicyId)} hint={!canPolicies ? t('employees.fields.policyNoAccess') : undefined} className="sm:col-span-2">
          {(id, d) => (
            <Select id={id} aria-describedby={d} invalid={!!errors.commissionPolicyId} disabled={!canPolicies || policies.isLoading} value={form.policyCode} onChange={(e) => set({ policyCode: e.target.value })}>
              <option value="">{t('employees.fields.noPolicy')}</option>
              {/* The assigned policy stays selectable (and visible) even when the list is unavailable. */}
              {initial.policyCode && !activePolicies.some((p) => p.code === initial.policyCode) && <option value={initial.policyCode}>{employee.policyName ?? initial.policyCode}</option>}
              {activePolicies.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name} ({p.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('employees.fields.notes')} error={msg(errors.notes)} className="sm:col-span-2">
          {(id, d) => <Textarea id={id} aria-describedby={d} rows={3} maxLength={1000} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />}
        </Field>
        {formError && (
          <Alert tone="danger" className="sm:col-span-2">
            {formError}
          </Alert>
        )}
      </form>
    </Modal>
  );
}

/** An employee's profile; `/employees/me` is the signed-in user's own (no users.read needed). */
export function EmployeeProfilePage() {
  const { userId: param } = useParams<{ userId: string }>();
  const { t } = useTranslation();
  const { me, can, canAny, currency } = useAuth();
  // `/employees/me` is a static route (no :userId param): it shows the signed-in user.
  const userId = !param || param === 'me' ? me?.user.id : param;
  const own = userId === me?.user.id;
  const q = useEmployee(userId);
  const roleLabel = useRoleLabel();
  const [editing, setEditing] = useState(false);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data;
  const p = e.profile;
  const canEdit = can('users.manage');
  const policy = e.commissionPolicy;

  return (
    <>
      <PageHeader
        breadcrumbs={can('users.read') ? [{ label: t('employees.title'), to: '/app/employees' }, { label: e.fullName }] : undefined}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="truncate">{own ? t('employees.profile.myTitle') : e.fullName}</span>
            <Badge tone={e.membershipStatus === 'active' ? 'success' : 'danger'}>{t(`employees.membership.${e.membershipStatus}`)}</Badge>
          </span>
        }
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {own && <span>{e.fullName} ·</span>}
            <span>{p?.jobTitle ?? roleLabel(e)}</span>
          </span>
        }
        actions={
          canEdit && (
            <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
              {t('employees.profile.edit')}
            </Button>
          )
        }
      />

      {!p && (
        <Alert tone="info" className="mb-4" title={t('employees.profile.notSetUp')}>
          {canEdit && (
            <button type="button" className="font-medium text-brand-strong hover:underline" onClick={() => setEditing(true)}>
              {t('employees.profile.notSetUpAction')}
            </button>
          )}
        </Alert>
      )}

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <StatCard
          tone="brand"
          icon={<UserRound className="h-5 w-5" />}
          label={t('employees.fields.monthlyTargetUnits')}
          value={p?.monthlyTargetUnits != null ? fmtNumber(p.monthlyTargetUnits) : '—'}
        />
        <StatCard
          tone="success"
          icon={<BadgePercent className="h-5 w-5" />}
          label={t('employees.fields.monthlyTargetAmount')}
          value={p?.monthlyTargetAmount ? fmtMoney(p.monthlyTargetAmount, currency) : '—'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('employees.profile.employment')} />
          <CardBody>
            <DescriptionList
              items={[
                { label: t('employees.fields.employeeCode'), value: p?.employeeCode ? <span className="num">{p.employeeCode}</span> : '—' },
                { label: t('employees.fields.jobTitle'), value: p?.jobTitle ?? '—' },
                { label: t('employees.fields.role'), value: roleLabel(e) },
                { label: t('employees.fields.hireDate'), value: fmtDate(p?.hireDate) },
                {
                  label: t('employees.fields.phone'),
                  value: p?.phone ? (
                    <a dir="ltr" className="num text-brand-strong hover:underline" href={`tel:${fmtPhone(p.phone)}`}>
                      {fmtPhone(p.phone)}
                    </a>
                  ) : (
                    '—'
                  ),
                },
                {
                  label: t('employees.fields.email'),
                  value: (
                    <a dir="ltr" className="inline-flex items-center gap-1 break-all text-brand-strong hover:underline" href={`mailto:${e.email}`}>
                      <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {e.email}
                    </a>
                  ),
                },
                { label: t('employees.fields.notes'), value: p?.notes ? <span className="whitespace-pre-line">{p.notes}</span> : '—', full: true },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={t('employees.profile.commission')}
            subtitle={t('employees.profile.commissionHint')}
            actions={
              policy &&
              canAny('commissions.read', 'commissions.manage_policies') && (
                <Link to={`/app/commission-policies/${policy.code}`} className="text-[13px] font-medium text-brand-strong hover:underline">
                  {t('employees.profile.openPolicy')}
                </Link>
              )
            }
          />
          <CardBody>
            {policy ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-ink">{policy.name}</p>
                  <Badge tone="brand" dot={false}>
                    {t('employees.profile.version', { version: policy.version })}
                  </Badge>
                </div>
                <p className="text-xs text-muted">{t('employees.profile.since', { date: fmtDate(policy.effectiveFrom) })}</p>
                <RuleSummary rule={policy.rule} />
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-sm text-muted">{t('employees.profile.noCommission')}</p>
                {e.policyCode && (
                  <p className="text-xs text-subtle">
                    {t('employees.profile.assignedPolicy')}: {e.policyName} ({e.policyCode})
                  </p>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {editing && <EditProfileModal employee={e} open={editing} onClose={() => setEditing(false)} />}
    </>
  );
}
