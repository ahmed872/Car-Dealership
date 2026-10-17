import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CURRENCY_CODES, CurrencyCode, todayInZone } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert, errorMessage } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ApiError, newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/format';
import { useApiMutation } from '@/lib/hooks';
import {
  categoryName,
  isPositiveMoney,
  isRate,
  previewBase,
  SupplierLite,
  useCashAccountOptions,
  useServerFieldErrors,
  useTenantDefaults,
  useVehicleCategories,
  VehicleCostRow,
} from './api';
import { initialPayNow, payNowBody, PayNowFields, PayNowState, SupplierPicker, MoneyBox } from './components';

/** Server error codes that belong to a specific field of this form. */
const FIELD_FOR_CODE: Record<string, string> = {
  exchange_rate_required: 'exchangeRate',
  fx_rate_invalid: 'exchangeRate',
  supplier_inactive: 'supplierId',
  category_not_vehicle: 'categoryId',
  purchase_via_acquisition: 'categoryId',
  invalid_amount: 'amount',
  pay_now_base_currency: 'payNow.cashAccountId',
};

/** Records a cost on one vehicle (POST /vehicle-costs), optionally paying it immediately. */
export function CostFormModal({
  vehicleId,
  vehicleLabel,
  costLocked,
  onClose,
}: {
  vehicleId: string;
  vehicleLabel: string;
  costLocked: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { tz, rounding, base } = useTenantDefaults();
  const cats = useVehicleCategories();
  const willPost = can('costs.approve');
  const canPay = can('supplier_payments.create');
  const accounts = useCashAccountOptions(willPost && canPay);
  const sfe = useServerFieldErrors();

  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>(base);
  const [rate, setRate] = useState('');
  const [costDate, setCostDate] = useState(() => todayInZone(tz));
  const [supplier, setSupplier] = useState<SupplierLite | null>(null);
  const [notes, setNotes] = useState('');
  const [payNow, setPayNow] = useState<PayNowState>(initialPayNow);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const clearError = (k: string) => setErrors((e) => (e[k] ? { ...e, [k]: '' } : e));
  const [formError, setFormError] = useState<string | null>(null);
  const [idemKey] = useState(() => newIdempotencyKey());

  const foreign = currency !== base;
  const basePreview = foreign ? previewBase(amount, rate, base, rounding) : null;

  const m = useApiMutation<Record<string, unknown>, VehicleCostRow>({
    path: '/vehicle-costs',
    idempotent: true,
    invalidate: [
      ['vehicle-costs', vehicleId],
      ['vehicle', vehicleId],
      ['vehicles'],
      ['approvals'],
      ['approvals-summary'],
      ['cash-accounts'],
    ],
    success: (r) => (r.status === 'posted' ? t('costs.success.created') : t('costs.success.createdPending')),
    onSuccess: onClose,
  });

  const validate = () => {
    const e: Record<string, string> = {};
    if (!categoryId) e.categoryId = t('costs.validation.required');
    if (description.trim().length < 2) e.description = t('costs.validation.too_short');
    if (!amount.trim()) e.amount = t('costs.validation.required');
    else if (!isPositiveMoney(amount)) e.amount = t('costs.validation.must_be_positive');
    if (foreign && !isRate(rate)) e.exchangeRate = t('costs.validation.exchange_rate_required');
    if (!costDate) e.costDate = t('costs.validation.invalid_date');
    if (payNow.enabled && !payNow.cashAccountId) e['payNow.cashAccountId'] = t('costs.validation.required');
    return e;
  };

  const submit = () => {
    const e = validate();
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    m.mutate(
      {
        vehicleId,
        categoryId,
        description: description.trim(),
        amount: amount.trim(),
        currency,
        ...(foreign ? { exchangeRate: rate.trim() } : {}),
        costDate,
        supplierId: supplier?.id ?? null,
        notes: notes.trim() || null,
        payNow: willPost && canPay ? payNowBody(payNow) : null,
        __idemKey: idemKey,
      },
      {
        onError: (err) => {
          const fe = sfe.fromError(err);
          if (err instanceof ApiError && FIELD_FOR_CODE[err.code])
            fe[FIELD_FOR_CODE[err.code]!] = errorMessage(err, t);
          setErrors(fe);
          if (!Object.keys(fe).length) setFormError(errorMessage(err, t));
        },
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('costs.form.title')}
      description={vehicleLabel}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} onClick={submit}>
            {t('costs.form.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {costLocked && (
          <Alert tone="warning" title={t('costs.form.postSaleWarning')}>
            {!can('costs.post_after_sale') && t('costs.form.postSaleNoPermission')}
          </Alert>
        )}
        <Alert tone={willPost ? 'info' : 'warning'}>
          {willPost ? t('costs.form.willPost') : t('costs.form.willPend')}
        </Alert>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('costs.form.category')} required error={errors.categoryId}>
            {(id, desc) => (
              <Select
                id={id}
                aria-describedby={desc}
                invalid={!!errors.categoryId}
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  clearError('categoryId');
                }}
              >
                <option value="">
                  {cats.isLoading ? t('common.loading') : t('costs.form.categoryPlaceholder')}
                </option>
                {cats.list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryName(c, i18n.language)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('costs.form.date')} required error={errors.costDate}>
            {(id, desc) => (
              <Input
                id={id}
                type="date"
                aria-describedby={desc}
                invalid={!!errors.costDate}
                value={costDate}
                onChange={(e) => {
                  setCostDate(e.target.value);
                  clearError('costDate');
                }}
              />
            )}
          </Field>
          <Field
            label={t('costs.form.description')}
            required
            error={errors.description}
            className="sm:col-span-2"
          >
            {(id, desc) => (
              <Input
                id={id}
                aria-describedby={desc}
                invalid={!!errors.description}
                maxLength={300}
                placeholder={t('costs.form.descriptionPlaceholder')}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  clearError('description');
                }}
              />
            )}
          </Field>
          <Field label={t('costs.form.amount')} required error={errors.amount}>
            {(id, desc) => (
              <MoneyBox
                id={id}
                aria-describedby={desc}
                invalid={!!errors.amount}
                currency={currency}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  clearError('amount');
                }}
              />
            )}
          </Field>
          <Field label={t('costs.form.currency')}>
            {(id) => (
              <Select
                id={id}
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value as CurrencyCode);
                  clearError('exchangeRate');
                }}
              >
                {CURRENCY_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {foreign && (
            <Field
              label={t('costs.form.exchangeRate')}
              required
              error={errors.exchangeRate}
              hint={
                basePreview
                  ? t('costs.form.baseAmount', { amount: fmtMoney(basePreview, base) })
                  : t('costs.form.exchangeRateHint', { currency, base })
              }
              className="sm:col-span-2"
            >
              {(id, desc) => (
                <Input
                  id={id}
                  dir="ltr"
                  inputMode="decimal"
                  className="num"
                  aria-describedby={desc}
                  invalid={!!errors.exchangeRate}
                  value={rate}
                  onChange={(e) => {
                    setRate(e.target.value);
                    clearError('exchangeRate');
                  }}
                />
              )}
            </Field>
          )}
          <div className="sm:col-span-2">
            <SupplierPicker
              label={t('costs.form.supplier')}
              hint={t('costs.form.supplierHint')}
              value={supplier}
              onChange={(x) => {
                setSupplier(x);
                clearError('supplierId');
              }}
              error={errors.supplierId}
            />
          </div>
          <Field label={t('costs.form.notes')} error={errors.notes} className="sm:col-span-2">
            {(id, desc) => (
              <Textarea
                id={id}
                aria-describedby={desc}
                rows={2}
                maxLength={1000}
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  clearError('notes');
                }}
              />
            )}
          </Field>
        </div>
        <PayNowFields
          value={payNow}
          onChange={(x) => {
            setPayNow(x);
            clearError('payNow.cashAccountId');
          }}
          accounts={accounts.data}
          loading={accounts.isLoading}
          error={errors['payNow.cashAccountId']}
          unavailable={
            !willPost ? t('costs.payNow.needsApproval') : !canPay ? t('costs.payNow.noPermission') : null
          }
        />
      </div>
    </Modal>
  );
}
