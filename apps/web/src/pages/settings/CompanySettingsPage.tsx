import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CURRENCY_CODES, type TenantSettings } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { FormSection, PageHeader } from '@/components/ui/Layout';
import { fmtDate } from '@/lib/format';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi, useApiMutation } from '@/lib/hooks';

interface Company {
  id: string;
  name: string;
  slug: string;
  market: 'EG' | 'SA' | 'AE';
  baseCurrency: string;
  settings: TenantSettings;
  subscription: {
    status: string;
    trialEndsAt: string | null;
    plan: {
      code: string;
      nameAr: string;
      nameEn: string;
      maxUsers: number | null;
      maxBranches: number | null;
      maxVehicles: number | null;
    };
  } | null;
  usage: { users: number; branches: number; vehicles: number };
}

type FormValues = { name: string; settings: TenantSettings };

export function CompanySettingsPage() {
  const { t, i18n } = useTranslation();
  const { can, refresh } = useAuth();
  const q = useApi<Company>(['company'], '/company');
  const editable = can('settings.manage');
  const form = useForm<FormValues>();
  useEffect(() => {
    if (q.data) form.reset({ name: q.data.name, settings: q.data.settings });
  }, [q.data, form]);
  const save = useApiMutation<FormValues>({
    path: '/company',
    method: 'PATCH',
    invalidate: [['company']],
    onSuccess: () => void refresh(),
    body: (v) => ({
      name: v.name,
      settings: {
        ...v.settings,
        reservation: { ...v.settings.reservation, defaultDays: Number(v.settings.reservation.defaultDays) },
        inventory: {
          ...v.settings.inventory,
          staleDaysWarning: Number(v.settings.inventory.staleDaysWarning),
          staleDaysCritical: Number(v.settings.inventory.staleDaysCritical),
        },
        installments: {
          ...v.settings.installments,
          reminderDaysBefore: Number(v.settings.installments.reminderDaysBefore),
        },
        // The rate map is replaced whole: an emptied field removes that currency's reference rate.
        fx: {
          maxDeviationPct: String(v.settings.fx.maxDeviationPct).trim(),
          referenceRates: Object.fromEntries(
            Object.entries(v.settings.fx.referenceRates ?? {})
              .map(([cur, rate]) => [cur, String(rate ?? '').trim()] as const)
              .filter(([cur, rate]) => cur !== q.data?.baseCurrency && rate !== ''),
          ),
        },
      },
    }),
  });

  // validation_failed issues carry the same dotted paths as the form fields.
  const invalid = useMemo(() => {
    const e = save.error;
    if (!(e instanceof ApiError) || e.code !== 'validation_failed') return new Set<string>();
    const issues = (e.details as { issues?: Array<{ path: string }> } | undefined)?.issues ?? [];
    return new Set(issues.map((i) => i.path));
  }, [save.error]);
  const pctError = (path: string) => (invalid.has(path) ? t('settings.errPct100') : undefined);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  const reg = form.register;
  const planName = c.subscription
    ? i18n.language === 'en'
      ? c.subscription.plan.nameEn
      : c.subscription.plan.nameAr
    : '—';
  const limit = (n: number | null) => (n === null ? '∞' : n);

  return (
    <>
      <PageHeader title={t('settings.companyTitle')} subtitle={`${c.slug} · ${t(`markets.${c.market}`)}`} />
      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardBody>
            <form id="company-form" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
              <fieldset disabled={!editable || save.isPending} className="min-w-0">
                <FormSection title={t('nav.company')}>
                  <Field label={t('settings.companyName')} required>
                    {(id) => <Input id={id} {...reg('name', { required: true })} />}
                  </Field>
                  <Field label={t('settings.baseCurrency')} hint={t('settings.baseCurrencyHint')}>
                    {(id, d) => (
                      <Input id={id} aria-describedby={d} value={c.baseCurrency} disabled readOnly />
                    )}
                  </Field>
                  <Field label={t('settings.defaultLanguage')}>
                    {(id) => (
                      <Select id={id} {...reg('settings.locale')}>
                        <option value="ar">العربية</option>
                        <option value="en">English</option>
                      </Select>
                    )}
                  </Field>
                  <Field label={t('settings.timezone')}>
                    {(id) => (
                      <Select id={id} {...reg('settings.timezone')}>
                        {[
                          'Africa/Cairo',
                          'Asia/Riyadh',
                          'Asia/Dubai',
                          'Asia/Kuwait',
                          'Asia/Qatar',
                          'Asia/Bahrain',
                          'Asia/Muscat',
                          'UTC',
                        ].map((z) => (
                          <option key={z} value={z}>
                            {z}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('settings.rounding')} hint={t('settings.lockedAfterPosting')}>
                    {(id, d) => (
                      <Select id={id} aria-describedby={d} {...reg('settings.rounding')}>
                        <option value="half_up">{t('settings.roundingHalfUp')}</option>
                        <option value="half_even">{t('settings.roundingHalfEven')}</option>
                      </Select>
                    )}
                  </Field>
                </FormSection>

                <FormSection title={t('settings.taxSection')} description={t('settings.taxDisclaimer')}>
                  <Field label={t('settings.taxMode')}>
                    {(id) => (
                      <Select id={id} {...reg('settings.tax.mode')}>
                        <option value="none">{t('settings.taxModeNone')}</option>
                        <option value="standard">{t('settings.taxModeStandard')}</option>
                        <option value="margin">{t('settings.taxModeMargin')}</option>
                      </Select>
                    )}
                  </Field>
                  <Field label={t('settings.taxRate')} error={pctError('settings.tax.ratePct')}>
                    {(id) => (
                      <Input
                        id={id}
                        dir="ltr"
                        inputMode="decimal"
                        className="num"
                        {...reg('settings.tax.ratePct')}
                      />
                    )}
                  </Field>
                  <Field label={t('settings.taxNumber')}>
                    {(id) => <Input id={id} dir="ltr" {...reg('settings.tax.taxNumber')} />}
                  </Field>
                  <div className="flex items-end pb-2">
                    <Checkbox
                      label={t('settings.pricesIncludeTax')}
                      {...reg('settings.tax.pricesIncludeTax')}
                    />
                  </div>
                </FormSection>

                <FormSection
                  title={t('settings.revenueSection')}
                  description={t('settings.lockedAfterPosting')}
                >
                  <Field label={t('settings.revenueRecognition')} className="sm:col-span-2">
                    {(id) => (
                      <Select id={id} {...reg('settings.revenueRecognition')}>
                        <option value="on_delivery">{t('settings.onDelivery')}</option>
                        <option value="on_confirmation">{t('settings.onConfirmation')}</option>
                      </Select>
                    )}
                  </Field>
                </FormSection>

                <FormSection title={t('settings.fxSection')} description={t('settings.fxSectionHint')}>
                  {CURRENCY_CODES.filter((cur) => cur !== c.baseCurrency).map((cur) => (
                    <Field
                      key={cur}
                      label={t('settings.fxReferenceRate', { currency: cur, base: c.baseCurrency })}
                      error={invalid.has(`settings.fx.referenceRates.${cur}`) ? t('settings.errRate') : undefined}
                    >
                      {(id) => (
                        <Input
                          id={id}
                          dir="ltr"
                          inputMode="decimal"
                          className="num"
                          placeholder={t('settings.fxNotSet')}
                          {...reg(`settings.fx.referenceRates.${cur}`)}
                        />
                      )}
                    </Field>
                  ))}
                  <Field
                    label={t('settings.fxMaxDeviation')}
                    hint={t('settings.fxMaxDeviationHint')}
                    error={pctError('settings.fx.maxDeviationPct')}
                  >
                    {(id, d) => (
                      <Input
                        id={id}
                        aria-describedby={d}
                        dir="ltr"
                        inputMode="decimal"
                        className="num"
                        {...reg('settings.fx.maxDeviationPct', { required: true })}
                      />
                    )}
                  </Field>
                </FormSection>

                <FormSection title={t('settings.reservationSection')}>
                  <Field label={t('settings.reservationDays')}>
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min={1}
                        max={90}
                        {...reg('settings.reservation.defaultDays')}
                      />
                    )}
                  </Field>
                  <Field label={t('settings.refundPolicy')}>
                    {(id) => (
                      <Select id={id} {...reg('settings.reservation.defaultRefundPolicy')}>
                        <option value="refundable">{t('settings.refundable')}</option>
                        <option value="non_refundable">{t('settings.nonRefundable')}</option>
                        <option value="partial">{t('settings.partial')}</option>
                      </Select>
                    )}
                  </Field>
                  <Field
                    label={t('settings.refundablePct')}
                    error={pctError('settings.reservation.defaultRefundablePct')}
                  >
                    {(id) => (
                      <Input
                        id={id}
                        dir="ltr"
                        inputMode="decimal"
                        className="num"
                        {...reg('settings.reservation.defaultRefundablePct')}
                      />
                    )}
                  </Field>
                </FormSection>

                <FormSection title={t('settings.inventorySection')}>
                  <Field label={t('settings.staleWarning')}>
                    {(id) => (
                      <Input id={id} type="number" min={1} {...reg('settings.inventory.staleDaysWarning')} />
                    )}
                  </Field>
                  <Field label={t('settings.staleCritical')}>
                    {(id) => (
                      <Input id={id} type="number" min={1} {...reg('settings.inventory.staleDaysCritical')} />
                    )}
                  </Field>
                  <Checkbox
                    className="sm:col-span-2"
                    label={t('settings.requireInspection')}
                    {...reg('settings.inventory.requireInspectionBeforeListing')}
                  />
                </FormSection>

                <FormSection title={t('settings.installmentsSection')} description={t('settings.lateFees')}>
                  <Checkbox
                    className="sm:col-span-2"
                    label={t('settings.installmentsEnabled')}
                    {...reg('settings.installments.enabled')}
                  />
                  <Field label={t('settings.defaultMethod')}>
                    {(id) => (
                      <Select id={id} {...reg('settings.installments.defaultMethod')}>
                        <option value="flat">Flat / ثابت</option>
                        <option value="reducing_balance">Reducing balance / متناقص</option>
                        <option value="zero_interest">0% / بدون فوائد</option>
                      </Select>
                    )}
                  </Field>
                </FormSection>

                <FormSection title={t('settings.documentsSection')}>
                  <Field label={t('settings.legalNameAr')}>
                    {(id) => <Input id={id} {...reg('settings.documents.legalNameAr')} />}
                  </Field>
                  <Field label={t('settings.legalNameEn')}>
                    {(id) => <Input id={id} dir="ltr" {...reg('settings.documents.legalNameEn')} />}
                  </Field>
                  <Field label={t('settings.commercialRegistration')}>
                    {(id) => (
                      <Input id={id} dir="ltr" {...reg('settings.documents.commercialRegistration')} />
                    )}
                  </Field>
                  <Field label={t('common.phone')}>
                    {(id) => <Input id={id} dir="ltr" {...reg('settings.documents.phone')} />}
                  </Field>
                  <Field label={t('settings.addressAr')}>
                    {(id) => <Input id={id} {...reg('settings.documents.addressAr')} />}
                  </Field>
                  <Field label={t('settings.addressEn')}>
                    {(id) => <Input id={id} dir="ltr" {...reg('settings.documents.addressEn')} />}
                  </Field>
                  <Field label={t('settings.documentLanguage')}>
                    {(id) => (
                      <Select id={id} {...reg('settings.documents.defaultLocale')}>
                        <option value="ar">العربية</option>
                        <option value="en">English</option>
                      </Select>
                    )}
                  </Field>
                  <span />
                  <Field label={t('settings.contractTermsAr')} className="sm:col-span-2">
                    {(id) => <Textarea id={id} rows={4} {...reg('settings.documents.contractTermsAr')} />}
                  </Field>
                  <Field label={t('settings.contractTermsEn')} className="sm:col-span-2">
                    {(id) => (
                      <Textarea id={id} rows={4} dir="ltr" {...reg('settings.documents.contractTermsEn')} />
                    )}
                  </Field>
                  <Field label={t('settings.invoiceFooterAr')}>
                    {(id) => <Textarea id={id} rows={2} {...reg('settings.documents.invoiceFooterAr')} />}
                  </Field>
                  <Field label={t('settings.invoiceFooterEn')}>
                    {(id) => (
                      <Textarea id={id} rows={2} dir="ltr" {...reg('settings.documents.invoiceFooterEn')} />
                    )}
                  </Field>
                </FormSection>

                <FormSection title={t('settings.showroomSection')}>
                  <Controller
                    control={form.control}
                    name="settings.showroom.enabled"
                    render={({ field }) => (
                      <Checkbox
                        className="sm:col-span-2"
                        label={t('settings.showroomEnabled')}
                        checked={!!field.value}
                        onChange={(e) => field.onChange(e.target.checked)}
                      />
                    )}
                  />
                  <Checkbox
                    label={t('settings.showReserved')}
                    description={t('showroom.settings.showReservedHint')}
                    {...reg('settings.showroom.showReserved')}
                  />
                  <Checkbox
                    label={t('settings.showPrices')}
                    description={t('showroom.settings.showPricesHint')}
                    {...reg('settings.showroom.showPrices')}
                  />
                  <Checkbox
                    className="sm:col-span-2"
                    label={t('showroom.settings.acknowledge')}
                    description={t('showroom.settings.acknowledgeHint')}
                    {...reg('settings.showroom.acknowledgeInquiries')}
                  />
                  <Field label={t('settings.whatsapp')} hint={t('showroom.settings.whatsappHint')}>
                    {(id, d) => (
                      <Input
                        id={id}
                        aria-describedby={d}
                        dir="ltr"
                        inputMode="tel"
                        maxLength={20}
                        placeholder="+9665…"
                        {...reg('settings.showroom.whatsappNumber')}
                      />
                    )}
                  </Field>
                  <span />
                  <Field label={t('showroom.settings.headlineAr')}>
                    {(id) => <Input id={id} dir="rtl" maxLength={200} {...reg('settings.showroom.headlineAr')} />}
                  </Field>
                  <Field label={t('showroom.settings.headlineEn')}>
                    {(id) => <Input id={id} dir="ltr" maxLength={200} {...reg('settings.showroom.headlineEn')} />}
                  </Field>
                  {c.settings.showroom.enabled && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] sm:col-span-2">
                      <span className="text-muted">{t('showroom.settings.publicLink')}:</span>
                      <a
                        href={`/showroom/${encodeURIComponent(c.slug)}`}
                        target="_blank"
                        rel="noreferrer"
                        dir="ltr"
                        className="num font-medium break-all text-brand-strong hover:underline"
                      >
                        {`${window.location.origin}/showroom/${c.slug}`}
                      </a>
                      {can('showroom.manage') && (
                        <Link to="/app/showroom" className="font-medium text-brand-strong hover:underline">
                          {t('showroom.settings.manageListings')}
                        </Link>
                      )}
                    </div>
                  )}
                </FormSection>
              </fieldset>
            </form>
            {editable && (
              <div className="sticky bottom-0 -mx-5 -mb-5 flex justify-end gap-2 border-t border-line bg-surface/95 px-5 py-3 backdrop-blur">
                {form.formState.isDirty && (
                  <span className="me-auto self-center text-xs text-warning">
                    {t('common.unsavedChanges')}
                  </span>
                )}
                <Button variant="secondary" onClick={() => form.reset()} disabled={!form.formState.isDirty}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" form="company-form" loading={save.isPending}>
                  {t('common.save')}
                </Button>
              </div>
            )}
          </CardBody>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title={t('settings.subscription')} />
            <CardBody className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">{t('settings.plan')}</span>
                <Badge tone="brand">{planName}</Badge>
              </div>
              {c.subscription?.trialEndsAt && (
                <Alert tone="info">
                  {t('settings.trialEnds', { date: fmtDate(c.subscription.trialEndsAt) })}
                </Alert>
              )}
              <div className="space-y-3">
                {(
                  [
                    ['nav.users', c.usage.users, c.subscription?.plan.maxUsers ?? null],
                    ['nav.branches', c.usage.branches, c.subscription?.plan.maxBranches ?? null],
                    ['nav.vehicles', c.usage.vehicles, c.subscription?.plan.maxVehicles ?? null],
                  ] as const
                ).map(([k, used, max]) => (
                  <div key={k}>
                    <div className="flex justify-between text-[13px]">
                      <span className="text-muted">{t(k)}</span>
                      <span className="num">
                        {used} / {limit(max)}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{ width: max ? `${Math.min(100, (used / max) * 100)}%` : '8%' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
