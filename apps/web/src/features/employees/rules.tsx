import clsx from 'clsx';
import { Calculator, Plus, Trash2 } from 'lucide-react';
import { ComponentProps, FormEvent, forwardRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { COMMISSION_EARN_ON, COMMISSION_TYPES, CommissionEarnOn, CommissionType, d, MONEY_REGEX, zCommissionRule } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, MoneyInput, Select } from '@/components/ui/Field';
import { useAuth } from '@/lib/auth';
import { fmtMoney, fmtPct } from '@/lib/format';
import type { PreviewResult, StoredRule } from './api';
import { issuesToFields, useEmpFieldMessage, useEmpMutation } from './kit';

/**
 * MoneyInput whose currency tag never covers the digits in Arabic: the kit's input is dir="ltr" but
 * places the tag at the page's inline end (the left in RTL), so the padding must follow it there.
 */
export const AmountInput = forwardRef<HTMLInputElement, ComponentProps<typeof MoneyInput>>(function AmountInput({ className, ...rest }, ref) {
  return <MoneyInput ref={ref} className={clsx(rest.currency && 'rtl:ps-14 rtl:pe-3', className)} {...rest} />;
});

// ── Summary ───────────────────────────────────────────────────────────────────────────────

/** One-line description of a rule plus its conditions, in the current language. */
export function useRuleText() {
  const { t } = useTranslation();
  const { currency } = useAuth();
  return (rule: StoredRule) => {
    const base = t(`employees.rule.tierBasesInline.${rule.tierBase ?? 'profit'}`);
    const main =
      rule.type === 'pct_of_profit' || rule.type === 'pct_of_sale'
        ? t(`employees.rule.summary.${rule.type}`, { rate: rule.ratePct ?? '0' })
        : rule.type === 'fixed'
          ? t('employees.rule.summary.fixed', { amount: fmtMoney(rule.fixedAmount ?? '0', currency) })
          : rule.tierMode === 'marginal'
            ? t('employees.rule.summary.tieredMarginal', { base })
            : t('employees.rule.summary.tieredWhole', { base });
    const extras: string[] = [];
    if (rule.minAmount) extras.push(t('employees.rule.summary.min', { amount: fmtMoney(rule.minAmount, currency) }));
    if (rule.capAmount) extras.push(t('employees.rule.summary.cap', { amount: fmtMoney(rule.capAmount, currency) }));
    if (rule.requirePositiveProfit) extras.push(t('employees.rule.summary.positive'));
    extras.push(t('employees.rule.summary.earnOn', { when: t(`employees.rule.earnOns.${rule.earnOn ?? 'full_payment'}`) }));
    const tiers = rule.type === 'tiered' ? (rule.tiers ?? []).map((x) => t('employees.rule.summary.tier', { from: fmtMoney(x.from, currency), rate: x.ratePct })) : [];
    return { main, extras, tiers };
  };
}

export function RuleSummary({ rule, className, compact }: { rule: StoredRule; className?: string; compact?: boolean }) {
  const text = useRuleText()(rule);
  return (
    <div className={clsx('min-w-0', className)}>
      <p className="text-sm font-medium text-ink">{text.main}</p>
      {!compact && text.tiers.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted">
          {text.tiers.map((x) => (
            <li key={x} className="num">
              {x}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {text.extras.map((x) => (
          <span key={x} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[11.5px] text-muted">
            {x}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Builder ───────────────────────────────────────────────────────────────────────────────

export interface RuleForm {
  type: CommissionType;
  ratePct: string;
  fixedAmount: string;
  tierBase: 'profit' | 'sale';
  tierMode: 'whole' | 'marginal';
  tiers: Array<{ from: string; ratePct: string }>;
  minAmount: string;
  capAmount: string;
  requirePositiveProfit: boolean;
  earnOn: CommissionEarnOn;
}

export const emptyRuleForm: RuleForm = {
  type: 'pct_of_profit',
  ratePct: '',
  fixedAmount: '',
  tierBase: 'profit',
  tierMode: 'whole',
  tiers: [{ from: '0', ratePct: '' }],
  minAmount: '',
  capAmount: '',
  requirePositiveProfit: true,
  earnOn: 'full_payment',
};

export function ruleToForm(r: StoredRule): RuleForm {
  return {
    type: r.type,
    ratePct: r.ratePct ?? '',
    fixedAmount: r.fixedAmount ?? '',
    tierBase: r.tierBase ?? 'profit',
    tierMode: r.tierMode ?? 'whole',
    tiers: r.tiers?.length ? r.tiers.map((x) => ({ from: x.from, ratePct: x.ratePct })) : [{ from: '0', ratePct: '' }],
    minAmount: r.minAmount ?? '',
    capAmount: r.capAmount ?? '',
    requirePositiveProfit: !!r.requirePositiveProfit,
    earnOn: r.earnOn ?? 'full_payment',
  };
}

/** The request's rule: only the fields its type uses; checked with the shared schema. */
export function buildRule(f: RuleForm): { rule: StoredRule | null; errors: Record<string, string> } {
  const rule: Record<string, unknown> = { type: f.type, earnOn: f.earnOn, requirePositiveProfit: f.requirePositiveProfit };
  if (f.type === 'pct_of_profit' || f.type === 'pct_of_sale') rule.ratePct = f.ratePct.trim();
  if (f.type === 'fixed') rule.fixedAmount = f.fixedAmount.trim();
  if (f.type === 'tiered') {
    rule.tierBase = f.tierBase;
    rule.tierMode = f.tierMode;
    rule.tiers = f.tiers.map((x) => ({ from: x.from.trim(), ratePct: x.ratePct.trim() }));
  }
  if (f.minAmount.trim()) rule.minAmount = f.minAmount.trim();
  if (f.capAmount.trim()) rule.capAmount = f.capAmount.trim();
  const errors: Record<string, string> = {};
  if ((f.type === 'pct_of_profit' || f.type === 'pct_of_sale') && !f.ratePct.trim()) errors.ratePct = 'required';
  if (f.type === 'fixed' && !f.fixedAmount.trim()) errors.fixedAmount = 'required';
  if (f.type === 'tiered') {
    f.tiers.forEach((x, i) => {
      if (!x.from.trim()) errors[`tiers.${i}.from`] = 'required';
      if (!x.ratePct.trim()) errors[`tiers.${i}.ratePct`] = 'required';
    });
  }
  // Amounts are checked before the schema: its consistency check parses them as decimals.
  const amount = (k: string, v: string) => {
    if (v.trim() && !MONEY_REGEX.test(v.trim())) errors[k] = 'invalid_amount';
    else if (v.trim().startsWith('-')) errors[k] = 'must_be_non_negative';
  };
  if (f.type === 'fixed') amount('fixedAmount', f.fixedAmount);
  if (f.type === 'tiered') f.tiers.forEach((x, i) => amount(`tiers.${i}.from`, x.from));
  amount('minAmount', f.minAmount);
  amount('capAmount', f.capAmount);
  if (Object.keys(errors).length) return { rule: null, errors };
  try {
    const parsed = zCommissionRule.safeParse(rule);
    if (!parsed.success) return { rule: null, errors: issuesToFields(parsed.error.issues) };
    return { rule: parsed.data as StoredRule, errors: {} };
  } catch {
    // The consistency check parses amounts; a malformed one that slipped through is just invalid.
    return { rule: null, errors: { type: 'invalid' } };
  }
}

/** Rule editor: calculation type, its parameters, limits and when the commission is earned. */
export function RuleBuilder({ form, onChange, errors }: { form: RuleForm; onChange: (patch: Partial<RuleForm>) => void; errors: Record<string, string> }) {
  const { t } = useTranslation();
  const { currency } = useAuth();
  const msg = useEmpFieldMessage();
  const err = (k: string) => msg(errors[k]);
  const pctInput = (value: string, set: (v: string) => void, id: string, describedBy: string | undefined, invalid: boolean) => (
    <div className="relative">
      <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="decimal" dir="ltr" className="num pe-9 text-start rtl:ps-9 rtl:pe-3" placeholder="0" value={value} onChange={(e) => set(e.target.value)} />
      <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-muted">%</span>
    </div>
  );
  const setTier = (i: number, patch: Partial<{ from: string; ratePct: string }>) => onChange({ tiers: form.tiers.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <div className="space-y-4">
      <Field label={t('employees.rule.type')} required error={err('type')}>
        {(id) => (
          <div id={id} role="radiogroup" aria-label={t('employees.rule.type')} className="grid gap-2 sm:grid-cols-2">
            {COMMISSION_TYPES.map((ty) => (
              <button
                key={ty}
                type="button"
                role="radio"
                aria-checked={form.type === ty}
                onClick={() => onChange({ type: ty })}
                className={clsx(
                  'rounded-lg border px-3 py-2 text-start text-sm transition-colors',
                  form.type === ty ? 'border-brand bg-brand-soft font-medium text-ink' : 'border-line text-muted hover:border-line-strong hover:text-ink',
                )}
              >
                {t(`employees.rule.types.${ty}`)}
              </button>
            ))}
          </div>
        )}
      </Field>

      {(form.type === 'pct_of_profit' || form.type === 'pct_of_sale') && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('employees.rule.ratePct')} required error={err('ratePct')}>
            {(id, dsc) => pctInput(form.ratePct, (v) => onChange({ ratePct: v }), id, dsc, !!errors.ratePct)}
          </Field>
        </div>
      )}

      {form.type === 'fixed' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('employees.rule.fixedAmount')} required error={err('fixedAmount')}>
            {(id, dsc) => <AmountInput id={id} aria-describedby={dsc} invalid={!!errors.fixedAmount} currency={currency} value={form.fixedAmount} onChange={(e) => onChange({ fixedAmount: e.target.value })} />}
          </Field>
        </div>
      )}

      {form.type === 'tiered' && (
        <div className="space-y-4 rounded-xl border border-line p-3 sm:p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('employees.rule.tierBase')}>
              {(id) => (
                <Select id={id} value={form.tierBase} onChange={(e) => onChange({ tierBase: e.target.value as RuleForm['tierBase'] })}>
                  {(['profit', 'sale'] as const).map((b) => (
                    <option key={b} value={b}>
                      {t(`employees.rule.tierBases.${b}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('employees.rule.tierMode')}>
              {(id) => (
                <Select id={id} value={form.tierMode} onChange={(e) => onChange({ tierMode: e.target.value as RuleForm['tierMode'] })}>
                  {(['whole', 'marginal'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`employees.rule.tierModes.${m}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <fieldset>
            <legend className="label">{t('employees.rule.tiers')}</legend>
            <p className="mb-2 text-xs text-muted">{t('employees.rule.tierHint')}</p>
            <div className="space-y-2">
              {form.tiers.map((tier, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)_auto] items-start gap-2">
                  <Field label={i === 0 ? t('employees.rule.tierFrom') : undefined} error={err(`tiers.${i}.from`)}>
                    {(id, dsc) => (
                      <AmountInput id={id} aria-describedby={dsc} aria-label={t('employees.rule.tierFrom')} invalid={!!errors[`tiers.${i}.from`]} currency={currency} value={tier.from} onChange={(e) => setTier(i, { from: e.target.value })} />
                    )}
                  </Field>
                  <Field label={i === 0 ? t('employees.rule.tierRate') : undefined} error={err(`tiers.${i}.ratePct`)}>
                    {(id, dsc) => pctInput(tier.ratePct, (v) => setTier(i, { ratePct: v }), id, dsc, !!errors[`tiers.${i}.ratePct`])}
                  </Field>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={clsx(i === 0 && 'mt-[22px]')}
                    disabled={form.tiers.length <= 1}
                    onClick={() => onChange({ tiers: form.tiers.filter((_, j) => j !== i) })}
                    aria-label={t('employees.rule.removeTier')}
                    title={t('employees.rule.removeTier')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            {errors.tiers && (
              <p role="alert" className="mt-1 text-xs font-medium text-danger">
                {err('tiers')}
              </p>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              icon={<Plus className="h-4 w-4" />}
              disabled={form.tiers.length >= 20}
              onClick={() => onChange({ tiers: [...form.tiers, { from: '', ratePct: '' }] })}
            >
              {t('employees.rule.addTier')}
            </Button>
          </fieldset>
        </div>
      )}

      <fieldset className="space-y-4">
        <legend className="mb-2 text-[13px] font-semibold text-ink">{t('employees.rule.limits')}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('employees.rule.minAmount')} error={err('minAmount')}>
            {(id, dsc) => <AmountInput id={id} aria-describedby={dsc} invalid={!!errors.minAmount} currency={currency} value={form.minAmount} onChange={(e) => onChange({ minAmount: e.target.value })} />}
          </Field>
          <Field label={t('employees.rule.capAmount')} error={err('capAmount')}>
            {(id, dsc) => <AmountInput id={id} aria-describedby={dsc} invalid={!!errors.capAmount} currency={currency} value={form.capAmount} onChange={(e) => onChange({ capAmount: e.target.value })} />}
          </Field>
          <Field label={t('employees.rule.earnOn')}>
            {(id) => (
              <Select id={id} value={form.earnOn} onChange={(e) => onChange({ earnOn: e.target.value as CommissionEarnOn })}>
                {COMMISSION_EARN_ON.map((x) => (
                  <option key={x} value={x}>
                    {t(`employees.rule.earnOns.${x}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Checkbox
          label={t('employees.rule.requirePositiveProfit')}
          description={t('employees.rule.requirePositiveProfitHint')}
          checked={form.requirePositiveProfit}
          onChange={(e) => onChange({ requirePositiveProfit: e.target.checked })}
        />
      </fieldset>
    </div>
  );
}

// ── Preview ───────────────────────────────────────────────────────────────────────────────

type PreviewSource = { policyId: string } | { rule: () => StoredRule | null };

/**
 * Commission calculator (POST /commission-policies/preview): a saved policy version, or the rule
 * being edited. Amounts stay strings end to end; the server computes with the tenant's currency.
 */
export function PreviewCalculator({ source, disabled, className }: { source: PreviewSource; disabled?: boolean; className?: string }) {
  const { t } = useTranslation();
  const { currency } = useAuth();
  const msg = useEmpFieldMessage();
  const [saleNet, setSaleNet] = useState('');
  const [grossProfit, setGrossProfit] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ruleInvalid, setRuleInvalid] = useState(false);
  const preview = useEmpMutation<Record<string, unknown>, PreviewResult>({ path: '/commission-policies/preview', success: null });

  const run = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const errs: Record<string, string> = {};
    if (!saleNet.trim()) errs.saleNet = 'required';
    else if (!MONEY_REGEX.test(saleNet.trim())) errs.saleNet = 'invalid_amount';
    else if (saleNet.trim().startsWith('-')) errs.saleNet = 'must_be_non_negative';
    if (!grossProfit.trim()) errs.grossProfit = 'required';
    else if (!MONEY_REGEX.test(grossProfit.trim())) errs.grossProfit = 'invalid_amount';
    setErrors(errs);
    let src: Record<string, unknown>;
    if ('policyId' in source) src = { policyId: source.policyId };
    else {
      const rule = source.rule();
      setRuleInvalid(!rule);
      if (!rule) return;
      src = { rule };
    }
    if (Object.keys(errs).length) return;
    preview.reset();
    preview.mutate({ ...src, saleNet: saleNet.trim(), grossProfit: grossProfit.trim() });
  };

  const res = preview.data?.result;
  const noProfit = !!res && !!preview.data?.rule.requirePositiveProfit && d(preview.variables?.grossProfit as string).lte(0);
  const rate = res && preview.data?.rule.type !== 'fixed' && !d(res.base).isZero() ? d(res.amount).div(d(res.base)).times(100).toFixed(2) : null;

  return (
    <form onSubmit={run} className={clsx('space-y-3', className)} noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('employees.preview.saleNet')} error={msg(errors.saleNet)}>
          {(id, dsc) => <AmountInput id={id} aria-describedby={dsc} invalid={!!errors.saleNet} currency={currency} value={saleNet} onChange={(e) => setSaleNet(e.target.value)} />}
        </Field>
        <Field label={t('employees.preview.grossProfit')} hint={t('employees.preview.grossProfitHint')} error={msg(errors.grossProfit)}>
          {(id, dsc) => <AmountInput id={id} aria-describedby={dsc} invalid={!!errors.grossProfit} currency={currency} placeholder="0.00" value={grossProfit} onChange={(e) => setGrossProfit(e.target.value)} />}
        </Field>
      </div>
      {ruleInvalid && <Alert tone="warning">{t('employees.preview.fixRule')}</Alert>}
      <Button type="submit" variant="secondary" icon={<Calculator className="h-4 w-4" />} loading={preview.isPending} disabled={disabled}>
        {t('employees.preview.calculate')}
      </Button>
      {res && (
        <div aria-live="polite" className="grid gap-3 rounded-xl border border-line bg-surface-2/50 p-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted">{t('employees.preview.base')}</p>
            <p className="num mt-0.5 whitespace-nowrap text-sm font-medium text-ink">{fmtMoney(res.base, currency)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">{t('employees.preview.amount')}</p>
            <p className="num mt-0.5 whitespace-nowrap text-lg font-semibold text-success">{fmtMoney(res.amount, currency)}</p>
            {rate && <p className="num text-xs text-muted">{t('employees.preview.effectiveRate', { rate: fmtPct(rate, 2) })}</p>}
          </div>
          {noProfit && <p className="text-xs text-warning sm:col-span-2">{t('employees.preview.noProfit')}</p>}
        </div>
      )}
    </form>
  );
}
