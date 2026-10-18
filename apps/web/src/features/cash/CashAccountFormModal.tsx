import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CASH_ACCOUNT_TYPES,
  CURRENCY_CODES,
  d,
  zCashAccountCreate,
  zCashAccountUpdate,
} from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtMoney, todayIso } from '@/lib/format';
import type { CashAccountDetail, CashAccountType } from './api';
import {
  AmountInput,
  FieldErrors,
  focusFirstInvalid,
  iso,
  isMoney,
  issuesToErrors,
  MONEY_KEYS,
  RateInput,
  serverFieldErrors,
  toBase,
  useAccessibleBranches,
  useFinError,
  useFinMutation,
  useTenantMoney,
  useValidationText,
} from './finance-ui';

/** Company-level accounts are stored with branchId null; the select uses this sentinel. */
const COMPANY = '__company__';

interface Props {
  /** null = create a new account. */
  account: CashAccountDetail | null;
  onClose: () => void;
  onSaved: (a: CashAccountDetail) => void;
}

/**
 * Create or edit a cash box / bank account. An opening balance is posted against owner's equity and
 * needs ledger.post_manual; company-level accounts (no branch) need access to all branches.
 */
export function CashAccountFormModal({ account, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const { base, rounding, timezone } = useTenantMoney();
  const branches = useAccessibleBranches();
  const describe = useFinError();
  const vText = useValidationText();
  const editing = account !== null;
  const allBranches = !!me?.allBranches;

  const [type, setType] = useState<CashAccountType>(account?.type ?? 'cashbox');
  const [name, setNameRaw] = useState(account?.name ?? '');
  const [currency, setCurrency] = useState<string>(account?.currency ?? base);
  const [branch, setBranch] = useState<string>(() => {
    if (account) return account.branchId ?? COMPANY;
    return allBranches ? COMPANY : (me?.branchIds[0] ?? '');
  });
  const [bankName, setBankName] = useState(account?.bankName ?? '');
  const [accountNumber, setAccountNumber] = useState(account?.accountNumber ?? '');
  const [iban, setIban] = useState(account?.iban ?? '');
  const [openingBalance, setOpeningBalanceRaw] = useState('');
  const [exchangeRate, setExchangeRateRaw] = useState('');
  const [openingDate, setOpeningDateRaw] = useState(() => todayIso(timezone));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const clearErr = (k: string) =>
    setErrors((e) => {
      if (!(k in e)) return e;
      const n = { ...e };
      delete n[k];
      return n;
    });
  const setName = (v: string) => {
    clearErr('name');
    setNameRaw(v);
  };
  const setOpeningBalance = (v: string) => {
    clearErr('openingBalance');
    setOpeningBalanceRaw(v);
  };
  const setExchangeRate = (v: string) => {
    clearErr('exchangeRate');
    setExchangeRateRaw(v);
  };
  const setOpeningDate = (v: string) => {
    clearErr('openingDate');
    setOpeningDateRaw(v);
  };

  const canOpening = can('ledger.post_manual');
  const foreign = currency !== base;
  const hasOpening = isMoney(openingBalance) && d(openingBalance.trim()).gt(0);
  const openingBase = hasOpening
    ? toBase(openingBalance, currency, foreign ? exchangeRate : '1', base, rounding)
    : null;

  const create = useFinMutation<Record<string, unknown>, CashAccountDetail>({
    path: '/cash-accounts',
    idempotent: true,
    invalidate: MONEY_KEYS,
    success: (a) => t('cash.accounts.created', { name: iso(a.name) }),
    toastError: false,
    onSuccess: (a) => onSaved(a),
  });
  const update = useFinMutation<Record<string, unknown>, CashAccountDetail>({
    path: `/cash-accounts/${account?.id ?? ''}`,
    method: 'PATCH',
    invalidate: [['cash-accounts'], ['cash-book']],
    success: t('cash.accounts.updated'),
    toastError: false,
    onSuccess: (a) => onSaved(a),
  });
  const pending = create.isPending || update.isPending;
  const onFail = (e: unknown) => {
    setErrors(serverFieldErrors(e));
    setFailure(e);
  };

  const submit = () => {
    setFailure(null);
    const bank = type === 'bank';
    const common = {
      name: name.trim(),
      branchId: branch === COMPANY ? null : branch || undefined,
      bankName: bank ? bankName.trim() : null,
      accountNumber: bank ? accountNumber.trim() : null,
      iban: bank ? iban.trim().replace(/\s+/g, '') : null,
    };
    if (editing) {
      const parsed = zCashAccountUpdate.safeParse(common);
      if (!parsed.success) {
        setErrors(issuesToErrors(parsed.error.issues));
        return focusFirstInvalid();
      }
      setErrors({});
      update.mutate(common, { onError: onFail });
      return;
    }
    const body: Record<string, unknown> = { ...common, type, currency };
    if (canOpening && hasOpening) {
      body.openingBalance = openingBalance.trim();
      body.openingDate = openingDate;
      if (foreign) body.exchangeRate = exchangeRate.trim();
    }
    const parsed = zCashAccountCreate.safeParse(body);
    const errs = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (!branch) errs.branchId = 'required';
    if (canOpening && openingBalance.trim() && !isMoney(openingBalance))
      errs.openingBalance = 'invalid_amount';
    if (canOpening && hasOpening && foreign && !exchangeRate.trim()) errs.exchangeRate = 'required';
    setErrors(errs);
    if (Object.keys(errs).length) return focusFirstInvalid();
    create.mutate(body, { onError: onFail });
  };

  const err = (k: string) => vText(errors[k]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={
        editing ? t('cash.accounts.editTitle', { name: iso(account.name) }) : t('cash.accounts.addTitle')
      }
      description={editing ? undefined : t('cash.accounts.addHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={pending} onClick={submit}>
            {editing ? t('common.save') : t('cash.accounts.create')}
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
        <Field label={t('cash.accounts.type')} required>
          {(id) => (
            <Select
              id={id}
              value={type}
              disabled={editing}
              onChange={(e) => setType(e.target.value as CashAccountType)}
            >
              {CASH_ACCOUNT_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`cash.enums.type.${x}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={t('common.currency')}
          required
          hint={editing ? t('cash.accounts.currencyLocked') : undefined}
        >
          {(id, desc) => (
            <Select
              id={id}
              aria-describedby={desc}
              value={currency}
              disabled={editing}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCY_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                  {c === base ? ` — ${t('cash.baseCurrency')}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('cash.accounts.name')} required error={err('name')} className="sm:col-span-2">
          {(id, desc) => (
            <Input
              id={id}
              aria-describedby={desc}
              invalid={!!errors.name}
              value={name}
              maxLength={120}
              placeholder={
                type === 'bank'
                  ? t('cash.accounts.namePlaceholderBank')
                  : t('cash.accounts.namePlaceholderCash')
              }
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('common.branch')}
          required
          error={err('branchId')}
          hint={branch === COMPANY ? t('cash.accounts.companyLevelHint') : t('cash.accounts.branchHint')}
          className="sm:col-span-2"
        >
          {(id, desc) => (
            <Select
              id={id}
              aria-describedby={desc}
              invalid={!!errors.branchId}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            >
              {!allBranches && !branch && <option value="">{t('cash.accounts.chooseBranch')}</option>}
              {allBranches && <option value={COMPANY}>{t('cash.accounts.companyLevel')}</option>}
              {branches.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {type === 'bank' && (
          <>
            <Field label={t('cash.accounts.bankName')} error={err('bankName')}>
              {(id) => (
                <Input
                  id={id}
                  value={bankName}
                  maxLength={120}
                  onChange={(e) => setBankName(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('cash.accounts.accountNumber')} error={err('accountNumber')}>
              {(id) => (
                <Input
                  id={id}
                  dir="ltr"
                  className="num text-start"
                  value={accountNumber}
                  maxLength={60}
                  onChange={(e) => setAccountNumber(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('cash.accounts.iban')} error={err('iban')} className="sm:col-span-2">
              {(id) => (
                <Input
                  id={id}
                  dir="ltr"
                  className="num text-start"
                  value={iban}
                  maxLength={40}
                  onChange={(e) => setIban(e.target.value.toUpperCase())}
                />
              )}
            </Field>
          </>
        )}

        {!editing && (
          <div className="rounded-xl border border-line bg-surface-2/40 p-4 sm:col-span-2">
            <h3 className="text-sm font-semibold text-ink">{t('cash.accounts.openingTitle')}</h3>
            {canOpening ? (
              <>
                <p className="mt-0.5 text-[13px] text-muted">{t('cash.accounts.openingHint')}</p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label={t('cash.accounts.openingBalance')} error={err('openingBalance')}>
                    {(id, desc) => (
                      <AmountInput
                        id={id}
                        aria-describedby={desc}
                        currency={currency}
                        invalid={!!errors.openingBalance}
                        value={openingBalance}
                        onChange={(e) => setOpeningBalance(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label={t('cash.accounts.openingDate')} error={err('openingDate')}>
                    {(id) => (
                      <Input
                        id={id}
                        type="date"
                        value={openingDate}
                        onChange={(e) => setOpeningDate(e.target.value)}
                      />
                    )}
                  </Field>
                  {foreign && hasOpening && (
                    <Field
                      label={t('cash.fx.rateLabel', { currency, base })}
                      required
                      error={err('exchangeRate')}
                      hint={
                        openingBase
                          ? t('cash.fx.equals', { value: fmtMoney(openingBase, base) })
                          : t('cash.fx.rateHint', { currency, base })
                      }
                      className="sm:col-span-2"
                    >
                      {(id, desc) => (
                        <RateInput
                          id={id}
                          aria-describedby={desc}
                          invalid={!!errors.exchangeRate}
                          value={exchangeRate}
                          onChange={(e) => setExchangeRate(e.target.value)}
                        />
                      )}
                    </Field>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-0.5 text-[13px] text-muted">{t('cash.accounts.openingNoPermission')}</p>
            )}
          </div>
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
