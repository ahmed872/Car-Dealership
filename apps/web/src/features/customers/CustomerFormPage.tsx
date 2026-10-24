import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LEAD_SOURCES, normalizeCustomerPhone, normalizeEmail, normalizeNationalId } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { FormSection, PageHeader } from '@/components/ui/Layout';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { Customer, crmErrorMessage, DuplicateCandidate, DuplicateResult, fieldErrorsOf, useCrmMutation, useCustomer } from './api';
import { AssigneeSelect, AssigneeDirectoryNotice } from './components';

interface FormState {
  type: 'individual' | 'company';
  fullName: string;
  companyName: string;
  phone: string;
  whatsapp: string;
  phoneAlt: string;
  email: string;
  nationalId: string;
  nationality: string;
  commercialRegistration: string;
  taxNumber: string;
  city: string;
  address: string;
  dateOfBirth: string;
  preferredLanguage: 'ar' | 'en';
  source: string;
  branchId: string;
  assignedUserId: string;
  marketingConsent: boolean;
  tags: string;
  notes: string;
}

const TEXT_FIELDS = [
  'fullName',
  'companyName',
  'email',
  'nationality',
  'commercialRegistration',
  'taxNumber',
  'city',
  'address',
  'dateOfBirth',
  'notes',
] as const;
const PHONE_FIELDS = ['phone', 'whatsapp', 'phoneAlt'] as const;

const phoneInput = (p: string | null) => (p ? `+${p}` : '');

function fromCustomer(c: Customer): FormState {
  return {
    type: c.type,
    fullName: c.fullName,
    companyName: c.companyName ?? '',
    phone: phoneInput(c.phone),
    whatsapp: phoneInput(c.whatsapp),
    phoneAlt: phoneInput(c.phoneAlt),
    email: c.email ?? '',
    nationalId: '',
    nationality: c.nationality ?? '',
    commercialRegistration: c.commercialRegistration ?? '',
    taxNumber: c.taxNumber ?? '',
    city: c.city ?? '',
    address: c.address ?? '',
    dateOfBirth: c.dateOfBirth ?? '',
    preferredLanguage: c.preferredLanguage,
    source: c.source ?? '',
    branchId: c.branchId ?? '',
    assignedUserId: c.assignedUserId ?? '',
    marketingConsent: c.marketingConsent,
    tags: c.tags.join(', '),
    notes: c.notes ?? '',
  };
}

const parseTags = (s: string) => [...new Set(s.split(/[,،]/).map((x) => x.trim()).filter(Boolean))];

/** Live "is this customer already on file?" panel: masked candidates, what matched, and whether a forced create is allowed. */
function DuplicatePanel({
  checking,
  candidates,
  blocking,
  forceAllowed,
  force,
  onForce,
  isEdit,
}: {
  checking: boolean;
  candidates: DuplicateCandidate[];
  blocking: boolean;
  forceAllowed: boolean;
  force: boolean;
  onForce: (v: boolean) => void;
  isEdit: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader
        title={t('customers.duplicates.title')}
        subtitle={t('customers.duplicates.subtitle')}
        actions={checking ? <Loader2 className="h-4 w-4 animate-spin text-muted" aria-label={t('common.loading')} /> : null}
      />
      <CardBody className="space-y-3">
        {candidates.length === 0 && checking ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('customers.duplicates.checking')}
          </p>
        ) : candidates.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
            {t('customers.duplicates.none')}
          </p>
        ) : (
          <>
            {blocking ? (
              <Alert tone={forceAllowed ? 'warning' : 'danger'} title={forceAllowed ? t('customers.duplicates.phoneTitle') : t('customers.duplicates.blockedTitle')}>
                {forceAllowed ? t('customers.duplicates.phoneHint') : t('customers.duplicates.blockedHint')}
              </Alert>
            ) : (
              <Alert tone="info">{t('customers.duplicates.softHint')}</Alert>
            )}
            <ul className="divide-y divide-line rounded-xl border border-line">
              {candidates.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {c.fullName}
                      {!c.isActive && <span className="ms-2 text-xs text-muted">({t('common.inactive')})</span>}
                    </p>
                    {c.companyName && c.canView && <p className="truncate text-xs text-muted">{c.companyName}</p>}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.matchedOn.map((f) => (
                        <Badge key={f} tone={f === 'nationalId' ? 'danger' : f === 'phone' ? 'warning' : 'info'}>
                          {t(`customers.duplicates.matched.${f}`)}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-subtle">
                      {t('customers.fields.assignedUser')}: {c.assignedUserName ?? t('customers.unassigned')}
                    </p>
                  </div>
                  {c.canView ? (
                    <Link to={`/app/customers/${c.id}`} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-strong hover:underline">
                      {t('common.open')} <ExternalLink className="h-3 w-3" aria-hidden />
                    </Link>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-subtle" title={t('customers.duplicates.hidden')}>
                      <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                      {t('customers.duplicates.restricted')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {blocking && forceAllowed && (
              <Checkbox
                checked={force}
                onChange={(e) => onForce(e.target.checked)}
                label={isEdit ? t('customers.duplicates.forceEdit') : t('customers.duplicates.force')}
                description={t('customers.duplicates.forceHint')}
              />
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

export function CustomerFormPage() {
  const { id } = useParams();
  const isEdit = !!id;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me, canAny, can } = useAuth();
  const market = me?.tenant?.market ?? null;
  const existing = useCustomer(id);
  const branches = useBranches();
  const canAssign = canAny('leads.assign', 'customers.read_all');
  const [f, setF] = useState<FormState | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [force, setForce] = useState(false);
  const [serverDup, setServerDup] = useState<DuplicateResult | null>(null);
  const [conflictErr, setConflictErr] = useState<string | null>(null);

  const original = useMemo(() => (existing.data ? fromCustomer(existing.data.customer) : null), [existing.data]);
  useEffect(() => {
    if (isEdit) {
      // Load the form once per stored version, so a background refetch never wipes edits.
      const v = existing.data?.customer.version ?? null;
      if (original && v !== loadedVersion) {
        setF(original);
        setLoadedVersion(v);
      }
      return;
    }
    if (f) return;
    const allowed = me?.allBranches ? (branches.data ?? []) : (branches.data ?? []).filter((b) => me?.branchIds.includes(b.id));
    if (!branches.data) return;
    setF({
      type: 'individual',
      fullName: '',
      companyName: '',
      phone: '',
      whatsapp: '',
      phoneAlt: '',
      email: '',
      nationalId: '',
      nationality: '',
      commercialRegistration: '',
      taxNumber: '',
      city: '',
      address: '',
      dateOfBirth: '',
      preferredLanguage: 'ar',
      source: '',
      branchId: me?.allBranches ? '' : (allowed.find((b) => b.isActive)?.id ?? ''),
      assignedUserId: me?.user.id ?? '',
      marketingConsent: false,
      tags: '',
      notes: '',
    });
  }, [isEdit, original, existing.data, loadedVersion, branches.data, me, f]);

  // Identifiers for the live duplicate check. On edit only the ones that changed are checked —
  // the server ignores unchanged identifiers too, so a legacy duplicate never blocks an edit.
  const identifiers = useMemo(() => {
    if (!f) return null;
    const changed = (k: keyof FormState) => !original || f[k] !== original[k];
    const val = (k: keyof FormState) => (changed(k) ? String(f[k]).trim() || null : null);
    const out = {
      phone: val('phone'),
      whatsapp: val('whatsapp'),
      phoneAlt: val('phoneAlt'),
      email: val('email'),
      nationalId: val('nationalId'),
      commercialRegistration: val('commercialRegistration'),
      taxNumber: val('taxNumber'),
      excludeId: id ?? null,
    };
    return Object.entries(out).some(([k, v]) => k !== 'excludeId' && v) ? out : null;
  }, [f, original, id]);
  const debouncedIds = useDebounced(identifiers, 500);
  const dupQ = useQuery({
    queryKey: ['customer-duplicates', debouncedIds],
    queryFn: () => api<DuplicateResult>('/customers/check-duplicates', { method: 'POST', body: debouncedIds }),
    enabled: !!debouncedIds,
    staleTime: 30_000,
  });
  useEffect(() => {
    setServerDup(null);
  }, [debouncedIds]);
  const live: DuplicateResult = serverDup ?? (debouncedIds && dupQ.data ? dupQ.data : { candidates: [], blocking: false, forceAllowed: false });

  const onError = (err: unknown) => {
    setConflictErr(null);
    if (err instanceof ApiError && err.code === 'customer_duplicate') {
      const det = err.details as { candidates?: Array<Pick<DuplicateCandidate, 'id' | 'fullName' | 'matchedOn' | 'canView'>>; forceAllowed?: boolean } | undefined;
      setServerDup({
        candidates: (det?.candidates ?? []).map((c) => ({ ...c, type: 'individual', companyName: null, isActive: true, branchId: null, assignedUserId: null, assignedUserName: null })),
        blocking: true,
        forceAllowed: !!det?.forceAllowed,
      });
      return false;
    }
    if (err instanceof ApiError && err.code === 'version_conflict') {
      setConflictErr(crmErrorMessage(err, t));
      return true;
    }
    const fe = fieldErrorsOf(err, t);
    setErrors(fe);
    return Object.keys(fe).length > 0;
  };
  const create = useCrmMutation<Record<string, unknown>, Customer>({
    path: '/customers',
    invalidate: [['customers']],
    success: t('customers.created'),
    onSuccess: (c) => navigate(`/app/customers/${c.id}`, { replace: true }),
    onError,
  });
  const update = useCrmMutation<Record<string, unknown>, Customer>({
    path: `/customers/${id}`,
    method: 'PATCH',
    invalidate: [['customers'], ['customer', id]],
    onSuccess: (c) => navigate(`/app/customers/${c.id}`, { replace: true }),
    onError,
  });

  if (isEdit && existing.isLoading) return <PageLoader />;
  if (isEdit && (existing.error || !existing.data)) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />;
  if (!f) return <PageLoader />;
  const c = existing.data?.customer;
  if (isEdit && c && !c.isActive) {
    return (
      <Alert tone="warning" title={t('customers.inactiveEditTitle')}>
        {t('customers.inactiveEditHint')}
      </Alert>
    );
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((prev) => (prev ? { ...prev, [k]: v } : prev));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: '' }));
  };

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (f.fullName.trim().length < 2) e.fullName = t('customers.validation.nameRequired');
    for (const p of PHONE_FIELDS) {
      if (f[p].trim() && !normalizeCustomerPhone(f[p], market)) e[p] = t('customers.errors.invalid_phone');
    }
    if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = t('customers.validation.invalidEmail');
    if (f.nationalId.trim() && !normalizeNationalId(f.nationalId)) e.nationalId = t('customers.errors.invalid_national_id');
    const tags = parseTags(f.tags);
    if (tags.length > 20 || tags.some((x) => x.length > 40)) e.tags = t('customers.validation.tags');
    return e;
  };

  const submit = () => {
    const e = validate();
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    const body: Record<string, unknown> = {};
    const str = (v: string) => (v.trim() ? v.trim() : null);
    if (!isEdit) {
      body.type = f.type;
      body.preferredLanguage = f.preferredLanguage;
      body.marketingConsent = f.marketingConsent;
      for (const k of TEXT_FIELDS) if (f[k].trim()) body[k] = f[k].trim();
      if (f.type !== 'company') delete body.companyName;
      for (const p of PHONE_FIELDS) if (f[p].trim()) body[p] = f[p].trim();
      if (f.nationalId.trim()) body.nationalId = f.nationalId.trim();
      if (f.source) body.source = f.source;
      if (f.branchId) body.branchId = f.branchId;
      if (canAssign) body.assignedUserId = f.assignedUserId || null;
      body.tags = parseTags(f.tags);
      body.force = force;
      create.mutate(body);
      return;
    }
    const o = original!;
    if (f.type !== o.type) body.type = f.type;
    if (f.preferredLanguage !== o.preferredLanguage) body.preferredLanguage = f.preferredLanguage;
    if (f.marketingConsent !== o.marketingConsent) body.marketingConsent = f.marketingConsent;
    for (const k of TEXT_FIELDS) if (f[k] !== o[k]) body[k] = k === 'fullName' ? f[k].trim() : str(f[k]);
    for (const p of PHONE_FIELDS) {
      const before = normalizeCustomerPhone(o[p], market);
      const after = f[p].trim() ? normalizeCustomerPhone(f[p], market) : null;
      if (before !== after) body[p] = str(f[p]);
    }
    if (f.email !== o.email && normalizeEmail(f.email) === normalizeEmail(o.email)) delete body.email;
    if (f.nationalId.trim()) body.nationalId = f.nationalId.trim();
    if (f.source !== o.source) body.source = f.source || null;
    if (f.branchId !== o.branchId) body.branchId = f.branchId || null;
    if (canAssign && f.assignedUserId !== o.assignedUserId) body.assignedUserId = f.assignedUserId || null;
    if (f.tags !== o.tags) body.tags = parseTags(f.tags);
    if (!Object.keys(body).length) {
      navigate(`/app/customers/${id}`);
      return;
    }
    body.version = c!.version;
    if (force) body.force = true;
    update.mutate(body);
  };

  const pending = create.isPending || update.isPending;
  const blockedByNid = live.blocking && !live.forceAllowed;
  const needsForce = live.blocking && live.forceAllowed && !force;
  const allowedBranches = (branches.data ?? []).filter((b) => (b.isActive || b.id === f.branchId) && (me?.allBranches || me?.branchIds.includes(b.id)));

  const text = (k: (typeof TEXT_FIELDS)[number] | 'nationalId', opts: { label: string; required?: boolean; ltr?: boolean; type?: string; hint?: string; max?: number; className?: string } ) => (
    <Field label={opts.label} required={opts.required} error={errors[k]} hint={opts.hint} className={opts.className}>
      {(fid, d) => (
        <Input
          id={fid}
          aria-describedby={d}
          type={opts.type ?? 'text'}
          dir={opts.ltr ? 'ltr' : undefined}
          className={clsx(opts.ltr && 'num text-start')}
          maxLength={opts.max}
          value={f[k]}
          onChange={(e) => set(k, e.target.value)}
          invalid={!!errors[k]}
        />
      )}
    </Field>
  );
  const phone = (k: (typeof PHONE_FIELDS)[number], label: string) => (
    <Field label={label} error={errors[k]} hint={k === 'phone' ? t('customers.hints.phone') : undefined}>
      {(fid, d) => (
        <Input
          id={fid}
          aria-describedby={d}
          type="tel"
          dir="ltr"
          inputMode="tel"
          autoComplete="off"
          className="num text-start"
          value={f[k]}
          maxLength={30}
          onChange={(e) => set(k, e.target.value)}
          invalid={!!errors[k]}
        />
      )}
    </Field>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('nav.customers'), to: '/app/customers' }, ...(c ? [{ label: c.fullName, to: `/app/customers/${c.id}` }] : []), { label: isEdit ? t('common.edit') : t('customers.add') }]}
        title={isEdit ? t('customers.editTitle') : t('customers.newTitle')}
      />
      {conflictErr && (
        <Alert tone="danger" className="mb-4" title={conflictErr}>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => (setConflictErr(null), setF(null), setLoadedVersion(null), existing.refetch())}>
            {t('customers.reload')}
          </Button>
        </Alert>
      )}
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardBody>
            <FormSection title={t('customers.sections.basic')} description={t('customers.sections.basicHint')}>
              <Field label={t('customers.fields.type')} required>
                {(fid) => (
                  <Select id={fid} value={f.type} onChange={(e) => set('type', e.target.value as FormState['type'])}>
                    <option value="individual">{t('customers.enums.type.individual')}</option>
                    <option value="company">{t('customers.enums.type.company')}</option>
                  </Select>
                )}
              </Field>
              {text('fullName', { label: f.type === 'company' ? t('customers.fields.contactName') : t('customers.fields.fullName'), required: true, max: 200 })}
              {f.type === 'company' && text('companyName', { label: t('customers.fields.companyName'), max: 200 })}
              <Field label={t('customers.fields.source')}>
                {(fid) => (
                  <Select id={fid} value={f.source} onChange={(e) => set('source', e.target.value)}>
                    <option value="">—</option>
                    {LEAD_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {t(`customers.enums.source.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('customers.fields.preferredLanguage')}>
                {(fid) => (
                  <Select id={fid} value={f.preferredLanguage} onChange={(e) => set('preferredLanguage', e.target.value as 'ar' | 'en')}>
                    <option value="ar">العربية</option>
                    <option value="en">English</option>
                  </Select>
                )}
              </Field>
            </FormSection>

            <FormSection title={t('customers.sections.contact')} description={t('customers.sections.contactHint')}>
              {phone('phone', t('customers.fields.phone'))}
              <div>
                {phone('whatsapp', t('customers.fields.whatsapp'))}
                {f.phone.trim() && f.whatsapp !== f.phone && (
                  <button type="button" className="mt-1 text-xs text-brand-strong hover:underline" onClick={() => set('whatsapp', f.phone)}>
                    {t('customers.sameAsPhone')}
                  </button>
                )}
              </div>
              {phone('phoneAlt', t('customers.fields.phoneAlt'))}
              {text('email', { label: t('customers.fields.email'), ltr: true, type: 'email', max: 120 })}
              {text('city', { label: t('customers.fields.city'), max: 80 })}
              {text('address', { label: t('customers.fields.address'), max: 300 })}
            </FormSection>

            <FormSection title={t('customers.sections.identity')} description={t('customers.sections.identityHint')}>
              {text('nationalId', {
                label: t('customers.fields.nationalId'),
                ltr: true,
                max: 40,
                hint: isEdit && c?.nationalIdMasked ? t('customers.hints.nationalIdKeep', { masked: `\u2066${c.nationalIdMasked}\u2069` }) : t('customers.hints.nationalId'),
              })}
              {text('nationality', { label: t('customers.fields.nationality'), max: 60 })}
              {f.type === 'individual' && text('dateOfBirth', { label: t('customers.fields.dateOfBirth'), type: 'date', ltr: true })}
              {text('commercialRegistration', { label: t('customers.fields.commercialRegistration'), ltr: true, max: 60 })}
              {text('taxNumber', { label: t('customers.fields.taxNumber'), ltr: true, max: 40 })}
            </FormSection>

            <FormSection title={t('customers.sections.ownership')} description={t('customers.sections.ownershipHint')}>
              <Field label={t('common.branch')} error={errors.branchId}>
                {(fid) => (
                  <Select id={fid} value={f.branchId} onChange={(e) => set('branchId', e.target.value)}>
                    {(me?.allBranches || !f.branchId) && <option value="">{t('customers.noBranch')}</option>}
                    {allowedBranches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {canAssign && (
                <Field label={t('customers.fields.assignedUser')} error={errors.assignedUserId}>
                  {(fid) => (
                    <>
                      <AssigneeSelect id={fid} value={f.assignedUserId} onChange={(v) => set('assignedUserId', v)} branchId={f.branchId || null} perm="customers.read" />
                      <AssigneeDirectoryNotice />
                    </>
                  )}
                </Field>
              )}
              <Field label={t('customers.fields.tags')} error={errors.tags} hint={t('customers.hints.tags')} className="sm:col-span-2">
                {(fid, d) => <Input id={fid} aria-describedby={d} value={f.tags} onChange={(e) => set('tags', e.target.value)} invalid={!!errors.tags} />}
              </Field>
              <Field label={t('common.notes')} error={errors.notes} className="sm:col-span-2">
                {(fid) => <Textarea id={fid} rows={3} maxLength={4000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />}
              </Field>
              <Checkbox
                className="sm:col-span-2"
                checked={f.marketingConsent}
                onChange={(e) => set('marketingConsent', e.target.checked)}
                label={t('customers.fields.marketingConsent')}
                description={t('customers.hints.marketingConsent')}
              />
            </FormSection>
          </CardBody>
        </Card>

        <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <DuplicatePanel
            checking={dupQ.isFetching}
            candidates={live.candidates}
            blocking={live.blocking}
            forceAllowed={live.forceAllowed}
            force={force}
            onForce={setForce}
            isEdit={isEdit}
          />
          {dupQ.error ? <Alert tone="warning">{crmErrorMessage(dupQ.error, t)}</Alert> : null}
          {Object.values(errors).some(Boolean) && (
            <Alert tone="danger" title={t('errors.validation_failed')}>
              {t('customers.validation.fixFields')}
            </Alert>
          )}
          <Card>
            <CardBody className="space-y-3">
              {blockedByNid && (
                <p className="flex items-start gap-2 text-[13px] text-danger">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {t('customers.duplicates.cannotSave')}
                </p>
              )}
              {needsForce && <p className="text-[13px] text-warning">{t('customers.duplicates.confirmFirst')}</p>}
              <div className="flex flex-wrap gap-2">
                <Button className="flex-1 justify-center" loading={pending} disabled={blockedByNid || needsForce || (!isEdit && !can('customers.manage'))} onClick={submit}>
                  {isEdit ? t('common.save') : t('customers.createAction')}
                </Button>
                <Button variant="secondary" onClick={() => navigate(isEdit ? `/app/customers/${id}` : '/app/customers')}>
                  {t('common.cancel')}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
