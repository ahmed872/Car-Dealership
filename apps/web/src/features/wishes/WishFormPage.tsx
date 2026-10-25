import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { FormSection, PageHeader } from '@/components/ui/Layout';
import type { CustomerOption, WishDetail } from './api';
import { useCustomerBrief } from './api';
import { buildWishPayload, CustomerPicker, emptyWishForm, WishFields, WishFormState } from './components';
import { serverFieldErrors, useWishError, useWishFieldMessage, useWishMutation } from './kit';

/** New wish: pick the customer (or arrive with ?customerId=), then the criteria. */
export function WishFormPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const presetId = params.get('customerId') ?? '';
  const [customerId, setCustomerId] = useState(presetId);
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const preset = useCustomerBrief(presetId && !customer ? presetId : null);
  const [form, setFormState] = useState<WishFormState>(emptyWishForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const describe = useWishError();
  const msg = useWishFieldMessage();

  useEffect(() => {
    if (preset.data && !customer && customerId === presetId) setCustomer(preset.data.customer);
  }, [preset.data, customer, customerId, presetId]);

  const setForm = (patch: Partial<WishFormState>) => {
    setFormState((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      if (next.makeId === 'needCriterion') delete next.makeId;
      return next;
    });
  };

  const create = useWishMutation<Record<string, unknown>, WishDetail>({
    path: '/wishes',
    invalidate: [['wishes']],
    success: (w) => {
      const n = w.matches.filter((m) => m.onSale && !m.dismissedAt).length;
      return n > 0 ? t('wishes.createdWithMatches', { count: n }) : t('wishes.created');
    },
    onSuccess: (w) => navigate(`/app/wishes/${w.id}`, { replace: true }),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const { payload, errors: errs } = buildWishPayload(form, { kind: 'create', customerId });
    setErrors(errs);
    if (!payload) return;
    try {
      await create.mutateAsync(payload);
    } catch (err) {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (!Object.keys(fields).length) setFormError(describe(err));
    }
  };

  const presetMissing = !!presetId && preset.isError && !customer;

  return (
    <>
      <PageHeader
        title={t('wishes.newTitle')}
        subtitle={t('wishes.newSubtitle')}
        breadcrumbs={[{ label: t('wishes.title'), to: '/app/wishes' }, { label: t('wishes.newTitle') }]}
      />
      <Card>
        <CardBody>
          <form id="wish-form" onSubmit={submit} noValidate>
            <FormSection title={t('wishes.sections.customer')} description={t('wishes.sections.customerHint')}>
              <div className="min-w-0 sm:col-span-2">
                {presetMissing && (
                  <Alert tone="warning" className="mb-3">
                    {describe(preset.error)}
                  </Alert>
                )}
                <CustomerPicker
                  value={presetMissing ? '' : customerId}
                  selected={customer}
                  error={msg(errors.customerId)}
                  onChange={(c) => {
                    setCustomer(c);
                    setCustomerId(c?.id ?? '');
                    setErrors((x) => ({ ...x, customerId: '' }));
                  }}
                />
              </div>
            </FormSection>
            <WishFields form={form} setForm={setForm} errors={errors} />
          </form>
          {formError && (
            <Alert tone="danger" className="mt-4">
              {formError}
            </Alert>
          )}
          <div className="sticky bottom-0 -mx-5 -mb-5 flex justify-end gap-2 border-t border-line bg-surface/95 px-5 py-3 backdrop-blur">
            <Button variant="secondary" onClick={() => navigate(-1)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="wish-form" loading={create.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
