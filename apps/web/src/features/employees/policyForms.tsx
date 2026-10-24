import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addDays, zCommissionPolicyCreate, zCommissionPolicyVersion } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, todayIso } from '@/lib/format';
import type { PolicyGroup, PolicyVersion } from './api';
import { issuesToFields, serverFieldErrors, useEmpError, useEmpFieldMessage, useEmpMutation } from './kit';
import { buildRule, emptyRuleForm, PreviewCalculator, RuleBuilder, RuleForm, ruleToForm } from './rules';

const CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Splits field errors into the policy's own fields and the rule's (keys relative to the rule). */
function splitErrors(errs: Record<string, string>) {
  const top: Record<string, string> = {};
  const rule: Record<string, string> = {};
  for (const [k, v] of Object.entries(errs)) {
    if (k.startsWith('rule.')) rule[k.slice(5)] = v;
    else if (k === 'rule') rule.type ??= v;
    else top[k] = v;
  }
  return { top, rule };
}

/** Rule builder with a live calculator for the rule being edited (outside the form: no nested forms). */
function RuleSection({
  form,
  setForm,
  errors,
  setErrors,
}: {
  form: RuleForm;
  setForm: (patch: Partial<RuleForm>) => void;
  errors: Record<string, string>;
  setErrors: (e: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-5 space-y-5">
      <section>
        <h3 className="mb-3 text-[14px] font-semibold text-ink">{t('employees.policies.rule')}</h3>
        <RuleBuilder form={form} onChange={setForm} errors={errors} />
      </section>
      <section className="rounded-xl border border-dashed border-line-strong p-3 sm:p-4">
        <h3 className="text-[14px] font-semibold text-ink">{t('employees.preview.title')}</h3>
        <p className="mb-3 text-xs text-muted">{t('employees.preview.subtitle')}</p>
        <PreviewCalculator
          source={{
            rule: () => {
              const built = buildRule(form);
              setErrors(built.errors);
              return built.rule;
            },
          }}
        />
      </section>
    </div>
  );
}

// ── Create ────────────────────────────────────────────────────────────────────────────────

export function CreatePolicyModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: PolicyVersion) => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const msg = useEmpFieldMessage();
  const describe = useEmpError();
  const today = todayIso(me?.tenant?.settings.timezone);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [rule, setRule] = useState<RuleForm>(emptyRuleForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const create = useEmpMutation<Record<string, unknown>, PolicyVersion>({
    path: '/commission-policies',
    invalidate: [['commission-policies'], ['employees']],
    success: t('employees.policies.created'),
    toastError: false,
    onSuccess: (p) => onCreated(p),
  });

  const clear = (k: string) => setErrors((e) => (e[k] ? Object.fromEntries(Object.entries(e).filter(([x]) => x !== k)) : e));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const errs: Record<string, string> = {};
    const c = code.trim();
    if (!c) errs.code = 'required';
    else if (!CODE_RE.test(c)) errs.code = 'invalid_code';
    if (name.trim().length < 2) errs.name = name.trim() ? 'tooSmall' : 'required';
    if (effectiveFrom && effectiveFrom < today) errs.effectiveFrom = 'retroactive_change';
    const built = buildRule(rule);
    setRuleErrors(built.errors);
    setErrors(errs);
    if (Object.keys(errs).length || !built.rule) return;
    const body = { code: c, name: name.trim(), rule: built.rule, ...(effectiveFrom ? { effectiveFrom } : {}) };
    const parsed = zCommissionPolicyCreate.safeParse(body);
    if (!parsed.success) {
      const split = splitErrors(issuesToFields(parsed.error.issues, 'rule.'));
      setErrors(split.top);
      setRuleErrors(split.rule);
      return;
    }
    try {
      await create.mutateAsync(body);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'policy_code_taken') return setErrors({ code: 'policy_code_taken' });
      const split = splitErrors(serverFieldErrors(err));
      setErrors(split.top);
      setRuleErrors(split.rule);
      if (!Object.keys(split.top).length && !Object.keys(split.rule).length) setFormError(describe(err));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('employees.policies.createTitle')}
      description={t('employees.policies.subtitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="policy-create-form" loading={create.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="policy-create-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label={t('employees.policies.name')} required error={msg(errors.name)}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} invalid={!!errors.name} maxLength={120} value={name} onChange={(e) => (setName(e.target.value), clear('name'))} />
          )}
        </Field>
        <Field label={t('employees.policies.code')} required hint={t('employees.policies.codeHint')} error={msg(errors.code)}>
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              invalid={!!errors.code}
              dir="ltr"
              className="font-mono text-start"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={40}
              placeholder="sales_standard"
              value={code}
              onChange={(e) => (setCode(e.target.value.toLowerCase()), clear('code'))}
            />
          )}
        </Field>
        <Field label={t('employees.policies.effectiveFrom')} hint={t('employees.policies.effectiveFromDefault')} error={msg(errors.effectiveFrom)}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} invalid={!!errors.effectiveFrom} type="date" min={today} value={effectiveFrom} onChange={(e) => (setEffectiveFrom(e.target.value), clear('effectiveFrom'))} />
          )}
        </Field>
      </form>
      <RuleSection
        form={rule}
        setForm={(patch) => {
          setRule((r) => ({ ...r, ...patch }));
          setRuleErrors({});
        }}
        errors={ruleErrors}
        setErrors={setRuleErrors}
      />
      {formError && (
        <Alert tone="danger" className="mt-4">
          {formError}
        </Alert>
      )}
    </Modal>
  );
}

// ── New version ───────────────────────────────────────────────────────────────────────────

/** The earliest date a new version may start: today, and after the latest version's start. */
export function earliestVersionStart(latest: PolicyVersion | undefined, today: string): string {
  if (!latest) return today;
  const after = addDays(latest.effectiveFrom, 1);
  return after > today ? after : today;
}

export function AddVersionModal({ group, open, onClose }: { group: PolicyGroup; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const msg = useEmpFieldMessage();
  const describe = useEmpError();
  const latest = group.versions?.[0] ?? group.scheduled[group.scheduled.length - 1] ?? group.current ?? undefined;
  const today = todayIso(me?.tenant?.settings.timezone);
  const minDate = earliestVersionStart(latest, today);
  const [name, setName] = useState(latest?.name ?? group.name);
  const [effectiveFrom, setEffectiveFrom] = useState(minDate);
  const [reason, setReason] = useState('');
  const [rule, setRule] = useState<RuleForm>(() => (latest ? ruleToForm(latest.rule) : emptyRuleForm));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [overlapDate, setOverlapDate] = useState<string | null>(null);
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const add = useEmpMutation<Record<string, unknown>, PolicyVersion>({
    path: `/commission-policies/${latest?.id ?? ''}/versions`,
    invalidate: [['commission-policies'], ['employees']],
    success: (p) => t('employees.policies.versionCreated', { version: p.version }),
    toastError: false,
    onSuccess: onClose,
  });

  const clear = (k: string) => setErrors((e) => (e[k] ? Object.fromEntries(Object.entries(e).filter(([x]) => x !== k)) : e));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!latest) return;
    setFormError(null);
    setOverlapDate(null);
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = name.trim() ? 'tooSmall' : 'required';
    if (!effectiveFrom) errs.effectiveFrom = 'required';
    else if (effectiveFrom < today) errs.effectiveFrom = 'retroactive_change';
    else if (effectiveFrom <= latest.effectiveFrom) {
      errs.effectiveFrom = 'version_overlap';
      setOverlapDate(latest.effectiveFrom);
    }
    if (reason.trim().length < 3) errs.reason = 'reasonShort';
    const built = buildRule(rule);
    setRuleErrors(built.errors);
    setErrors(errs);
    if (Object.keys(errs).length || !built.rule) return;
    const body = { name: name.trim(), rule: built.rule, effectiveFrom, reason: reason.trim() };
    const parsed = zCommissionPolicyVersion.safeParse(body);
    if (!parsed.success) {
      const split = splitErrors(issuesToFields(parsed.error.issues, 'rule.'));
      setErrors(split.top);
      setRuleErrors(split.rule);
      return;
    }
    try {
      await add.mutateAsync(body);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_overlap' && typeof err.details?.latestEffectiveFrom === 'string') {
        setOverlapDate(err.details.latestEffectiveFrom);
      }
      const split = splitErrors(serverFieldErrors(err));
      setErrors(split.top);
      setRuleErrors(split.rule);
      if (!Object.keys(split.top).length && !Object.keys(split.rule).length) setFormError(describe(err));
    }
  };

  const fromError =
    errors.effectiveFrom === 'version_overlap' && overlapDate ? t('employees.policies.mustStartAfter', { date: fmtDate(overlapDate) }) : msg(errors.effectiveFrom);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('employees.policies.versionTitle')}
      description={`${group.name} · ${t('employees.policies.versionN', { version: (latest?.version ?? 0) + 1 })}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="policy-version-form" loading={add.isPending} disabled={!latest}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Alert tone="info" className="mb-4">
        {t('employees.policies.versionHint')}
      </Alert>
      <form id="policy-version-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label={t('employees.policies.name')} required error={msg(errors.name)}>
          {(id, d) => <Input id={id} aria-describedby={d} invalid={!!errors.name} maxLength={120} value={name} onChange={(e) => (setName(e.target.value), clear('name'))} />}
        </Field>
        <Field
          label={t('employees.policies.effectiveFrom')}
          required
          hint={latest ? t('employees.policies.mustStartAfter', { date: fmtDate(latest.effectiveFrom) }) : t('employees.policies.effectiveFromHint')}
          error={fromError}
        >
          {(id, d) => (
            <Input id={id} aria-describedby={d} invalid={!!errors.effectiveFrom} type="date" min={minDate} value={effectiveFrom} onChange={(e) => (setEffectiveFrom(e.target.value), clear('effectiveFrom'))} />
          )}
        </Field>
        <Field label={t('employees.policies.reason')} required error={msg(errors.reason)} className="sm:col-span-2">
          {(id, d) => <Textarea id={id} aria-describedby={d} invalid={!!errors.reason} rows={2} maxLength={500} value={reason} onChange={(e) => (setReason(e.target.value), clear('reason'))} />}
        </Field>
      </form>
      <RuleSection
        form={rule}
        setForm={(patch) => {
          setRule((r) => ({ ...r, ...patch }));
          setRuleErrors({});
        }}
        errors={ruleErrors}
        setErrors={setRuleErrors}
      />
      {formError && (
        <Alert tone="danger" className="mt-4">
          {formError}
        </Alert>
      )}
    </Modal>
  );
}
