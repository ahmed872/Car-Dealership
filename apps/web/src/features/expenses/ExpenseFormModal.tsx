import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CURRENCY_CODES, PAYMENT_METHODS, zExpenseCreate } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtMoney, todayIso } from '@/lib/format';
import { useCashAccountOptions } from '@/features/cash/api';
import {
  AmountInput,
  FieldErrors,
  focusFirstInvalid,
  isMoney,
  issuesToErrors,
  RateInput,
  serverFieldErrors,
  toBase,
  useAccessibleBranches,
  useFinError,
  useFinMutation,
  useTenantMoney,
  useValidationText,
} from '@/features/cash/finance-ui';
import { ApiError } from '@/lib/api';
import { categoryName, EXPENSE_KEYS, ExpenseDetail, PaymentMethod, useExpenseCategories } from './api';
import { SupplierLite, SupplierPicker } from './components';

/** Business errors the API reports for a specific field of this form. */
const CODE_FIELD: Record<string, string> = {
  supplier_inactive: 'supplierId',
  category_inactive: 'categoryId',
  category_not_operating: 'categoryId',
  exchange_rate_required: 'exchangeRate',
  pay_now_base_currency: 'payNow.cashAccountId',
  insufficient_cash: 'payNow.cashAccountId',
  cash_account_inactive: 'payNow.cashAccountId',
  cash_day_closed: 'payNow.cashAccountId',
};

/**
 * Records an operating expense. Users with expenses.approve post it directly (and may pay it at
 * once from a base-currency account); others submit it to the approvals inbox.
 */
export function ExpenseFormModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (e: ExpenseDetail) => void;
}) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { base, rounding, timezone } = useTenantMoney();
  const describe = useFinError();
  const vText = useValidationText();
  const branches = useAccessibleBranches();
  const categories = useExpenseCategories();
  const accounts = useCashAccountOptions();

  const willPost = can('expenses.approve');
  const canPay = can('supplier_payments.create');

  const [branchId, setBranchIdRaw] = useState('');
  const [categoryId, setCategoryIdRaw] = useState('');
  const [description, setDescriptionRaw] = useState('');
  const [amount, setAmountRaw] = useState('');
  const [currency, setCurrency] = useState<string>(base);
  const [rate, setRateRaw] = useState('');
  const [expenseDate, setExpenseDateRaw] = useState(() => todayIso(timezone));
  const [supplier, setSupplier] = useState<SupplierLite | null>(null);
  const [notes, setNotes] = useState('');
  const [payNow, setPayNow] = useState(false);
  const [cashAccountId, setCashAccountIdRaw] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  /** Translated business errors the server attached to a field (e.g. inactive supplier). */
  const [serverMsgs, setServerMsgs] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const clearErr = (k: string) => {
    const drop = (e: FieldErrors) => {
      if (!(k in e)) return e;
      const n = { ...e };
      delete n[k];
      return n;
    };
    setErrors(drop);
    setServerMsgs(drop);
  };
  const setBranchId = (v: string) => {
    clearErr('branchId');
    setBranchIdRaw(v);
  };
  const setCategoryId = (v: string) => {
    clearErr('categoryId');
    setCategoryIdRaw(v);
  };
  const setDescription = (v: string) => {
    clearErr('description');
    setDescriptionRaw(v);
  };
  const setAmount = (v: string) => {
    clearErr('amount');
    setAmountRaw(v);
  };
  const setRate = (v: string) => {
    clearErr('exchangeRate');
    setRateRaw(v);
  };
  const setExpenseDate = (v: string) => {
    clearErr('expenseDate');
    setExpenseDateRaw(v);
  };
  const setCashAccountId = (v: string) => {
    clearErr('payNow.cashAccountId');
    setCashAccountIdRaw(v);
  };

  const branchList = branches.branches.filter((b) => b.isActive);
  const effectiveBranch = branchId || (branchList.length === 1 ? branchList[0]!.id : '');
  const foreign = currency !== base;
  const amountBase = toBase(amount, currency, foreign ? rate : '1', base, rounding);
  const baseAccounts = useMemo(
    () => (accounts.data ?? []).filter((a) => a.currency === base),
    [accounts.data, base],
  );

  const create = useFinMutation<Record<string, unknown>, ExpenseDetail>({
    path: '/expenses',
    idempotent: true,
    invalidate: EXPENSE_KEYS,
    toastError: false,
    success: (e) =>
      e.status === 'posted'
        ? t('expenses.form.created', { number: e.number })
        : t('expenses.form.submitted', { number: e.number }),
    onSuccess: (e) => onDone(e),
  });

  const submit = () => {
    setFailure(null);
    setServerMsgs({});
    const body: Record<string, unknown> = {
      branchId: effectiveBranch,
      categoryId,
      description: description.trim(),
      amount: amount.trim(),
      currency,
      expenseDate,
      supplierId: supplier?.id ?? null,
      notes: notes.trim() || null,
      payNow:
        willPost && canPay && payNow ? { cashAccountId, method, reference: reference.trim() || null } : null,
    };
    if (foreign) body.exchangeRate = rate.trim();
    const parsed = zExpenseCreate.safeParse(body);
    const errs = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (!effectiveBranch) errs.branchId = 'required';
    if (!categoryId) errs.categoryId = 'required';
    if (foreign && !rate.trim()) errs.exchangeRate = 'required';
    if (amount.trim() && !isMoney(amount)) errs.amount = 'invalid_amount';
    if (body.payNow && !cashAccountId) errs['payNow.cashAccountId'] = 'required';
    setErrors(errs);
    if (Object.keys(errs).length) return focusFirstInvalid();
    create.mutate(body, {
      onError: (e) => {
        setErrors(serverFieldErrors(e));
        if (e instanceof ApiError && CODE_FIELD[e.code])
          setServerMsgs({ [CODE_FIELD[e.code]!]: describe(e) });
        setFailure(e);
      },
    });
  };

  const err = (k: string) => serverMsgs[k] ?? vText(errors[k]);
  const invalid = (k: string) => !!(errors[k] || serverMsgs[k]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('expenses.form.title')}
      description={t('expenses.form.hint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={create.isPending}
            disabled={branchList.length === 0 && !branches.isLoading}
            onClick={submit}
          >
            {willPost ? t('expenses.form.submit') : t('expenses.form.submitForApproval')}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {failure !== null && (
          <Alert tone="danger" className="sm:col-span-2">
            {describe(failure)}
          </Alert>
        )}
        <Alert tone={willPost ? 'success' : 'info'} className="sm:col-span-2">
          {willPost ? t('expenses.form.willPost') : t('expenses.form.willQueue')}
        </Alert>
        {!branches.isLoading && branchList.length === 0 && (
          <Alert tone="warning" className="sm:col-span-2">
            {t('expenses.form.noBranches')}
          </Alert>
        )}

        <Field label={t('expenses.form.branch')} required error={err('branchId')}>
          {(id, desc) => (
            <Select
              id={id}
              aria-describedby={desc}
              invalid={invalid('branchId')}
              value={effectiveBranch}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {branchList.length !== 1 && <option value="">{t('expenses.form.chooseBranch')}</option>}
              {branchList.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('expenses.form.category')} required error={err('categoryId')}>
          {(id, desc) => (
            <Select
              id={id}
              aria-describedby={desc}
              invalid={invalid('categoryId')}
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">
                {categories.isLoading ? t('common.loading') : t('expenses.form.chooseCategory')}
              </option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryName(c, i18n.language)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={t('expenses.form.description')}
          required
          error={err('description')}
          className="sm:col-span-2"
        >
          {(id, desc) => (
            <Input
              id={id}
              aria-describedby={desc}
              invalid={invalid('description')}
              value={description}
              maxLength={300}
              placeholder={t('expenses.form.descriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('expenses.form.amount')} required error={err('amount')}>
          {(id, desc) => (
            <AmountInput
              id={id}
              aria-describedby={desc}
              currency={currency}
              invalid={invalid('amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('expenses.form.currency')} required>
          {(id) => (
            <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCY_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                  {c === base ? ` — ${t('cash.baseCurrency')}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {foreign && (
          <Field
            label={t('cash.fx.rateLabel', { currency, base })}
            required
            error={err('exchangeRate')}
            hint={
              amountBase
                ? t('cash.fx.equals', { value: fmtMoney(amountBase, base) })
                : t('cash.fx.rateHint', { currency, base })
            }
            className="sm:col-span-2"
          >
            {(id, desc) => (
              <RateInput
                id={id}
                aria-describedby={desc}
                invalid={invalid('exchangeRate')}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field label={t('expenses.form.expenseDate')} required error={err('expenseDate')}>
          {(id) => (
            <Input id={id} type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          )}
        </Field>
        <div className="hidden sm:block" aria-hidden />
        <div className="sm:col-span-2">
          <SupplierPicker
            value={supplier}
            onChange={(v) => {
              clearErr('supplierId');
              setSupplier(v);
            }}
            error={err('supplierId')}
          />
        </div>
        <Field label={t('expenses.form.notes')} error={err('notes')} className="sm:col-span-2">
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>

        <div className="rounded-xl border border-line bg-surface-2/40 p-4 sm:col-span-2">
          <h3 className="text-sm font-semibold text-ink">{t('expenses.payNow.title')}</h3>
          {!willPost ? (
            <p className="mt-0.5 text-[13px] text-muted">{t('expenses.payNow.needsApproval')}</p>
          ) : !canPay ? (
            <p className="mt-0.5 text-[13px] text-muted">{t('expenses.payNow.noPermission')}</p>
          ) : (
            <>
              <Checkbox
                className="mt-2"
                label={t('expenses.payNow.toggle')}
                description={t('expenses.payNow.toggleHint')}
                checked={payNow}
                onChange={(e) => setPayNow(e.target.checked)}
              />
              {payNow && (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t('expenses.payNow.account')}
                    required
                    error={err('payNow.cashAccountId')}
                    hint={
                      baseAccounts.length
                        ? t('expenses.payNow.accountHint', { base })
                        : t('expenses.payNow.noAccounts', { base })
                    }
                    className="sm:col-span-2"
                  >
                    {(id, desc) => (
                      <Select
                        id={id}
                        aria-describedby={desc}
                        invalid={invalid('payNow.cashAccountId')}
                        value={cashAccountId}
                        onChange={(e) => setCashAccountId(e.target.value)}
                      >
                        <option value="">{t('expenses.payNow.chooseAccount')}</option>
                        {baseAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ({t(`cash.enums.type.${a.type}`)})
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('expenses.payNow.method')} required>
                    {(id) => (
                      <Select
                        id={id}
                        value={method}
                        onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                      >
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {t(`expenses.method.${m}`)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('expenses.payNow.reference')} error={err('payNow.reference')}>
                    {(id) => (
                      <Input
                        id={id}
                        value={reference}
                        maxLength={80}
                        onChange={(e) => setReference(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
              )}
            </>
          )}
        </div>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
