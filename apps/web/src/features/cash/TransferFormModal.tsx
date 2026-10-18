import { ArrowDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CurrencyCode, d, zCashTransfer } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Alert, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { fmtMoney, todayIso } from '@/lib/format';
import { CashAccountListItem, CashTransfer, useCashAccounts } from './api';
import {
  AmountInput,
  FieldErrors,
  focusFirstInvalid,
  isPositiveMoney,
  isRate,
  issuesToErrors,
  Money,
  MONEY_KEYS,
  RateInput,
  serverFieldErrors,
  toBase,
  useFinError,
  useFinMutation,
  useTenantMoney,
  useValidationText,
} from './finance-ui';

function optionLabel(a: CashAccountListItem): string {
  return `${a.name} · ${fmtMoney(a.balance, a.currency)}`;
}

/**
 * Transfer between two of the company's own accounts. Currency rules follow the API:
 * a foreign-currency source states its rate to the base currency; a destination in another
 * currency states the amount it receives (optional when it is the base currency — the value at
 * the stated rate is used). The realized FX difference is shown on the transfer afterwards.
 */
export function TransferFormModal({
  defaultFromId,
  onClose,
  onDone,
}: {
  defaultFromId?: string;
  onClose: () => void;
  onDone: (t: CashTransfer) => void;
}) {
  const { t } = useTranslation();
  const { base, rounding, timezone } = useTenantMoney();
  const describe = useFinError();
  const vText = useValidationText();
  const accounts = useCashAccounts();
  const active = useMemo(() => (accounts.data ?? []).filter((a) => a.isActive), [accounts.data]);

  const [fromId, setFromIdRaw] = useState(defaultFromId ?? '');
  const [toId, setToIdRaw] = useState('');
  const [amount, setAmountRaw] = useState('');
  const [amountTo, setAmountToRaw] = useState('');
  const [rate, setRateRaw] = useState('');
  const [date, setDateRaw] = useState(() => todayIso(timezone));
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const clearErr = (k: string) =>
    setErrors((e) => {
      if (!(k in e)) return e;
      const n = { ...e };
      delete n[k];
      return n;
    });
  const setFromId = (v: string) => {
    clearErr('fromAccountId');
    setFromIdRaw(v);
  };
  const setToId = (v: string) => {
    clearErr('toAccountId');
    setToIdRaw(v);
  };
  const setAmount = (v: string) => {
    clearErr('amount');
    setAmountRaw(v);
  };
  const setAmountTo = (v: string) => {
    clearErr('amountTo');
    setAmountToRaw(v);
  };
  const setRate = (v: string) => {
    clearErr('exchangeRate');
    setRateRaw(v);
  };
  const setDate = (v: string) => {
    clearErr('date');
    setDateRaw(v);
  };

  const from = active.find((a) => a.id === fromId);
  const to = active.find((a) => a.id === toId);
  const fromForeign = !!from && from.currency !== base;
  const crossCurrency = !!from && !!to && from.currency !== to.currency;
  const amountToRequired = crossCurrency && to!.currency !== base;
  const txnBase = from ? toBase(amount, from.currency, fromForeign ? rate : '1', base, rounding) : null;
  const receivedDefault = crossCurrency && to!.currency === base ? txnBase : null;
  const overdraw =
    !!from && from.type === 'cashbox' && isPositiveMoney(amount) && d(amount.trim()).gt(from.balance);

  const m = useFinMutation<Record<string, unknown>, CashTransfer>({
    path: '/cash/transfers',
    idempotent: true,
    invalidate: MONEY_KEYS,
    success: t('cash.transfers.created'),
    toastError: false,
    onSuccess: (res) => onDone(res),
  });

  const submit = () => {
    setFailure(null);
    const body: Record<string, unknown> = {
      fromAccountId: fromId,
      toAccountId: toId,
      amount: amount.trim(),
      date,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
    };
    if (fromForeign) body.exchangeRate = rate.trim();
    // A base-currency destination receives exactly the value at the stated rate (the API rejects any other amountTo).
    if (amountToRequired && amountTo.trim()) body.amountTo = amountTo.trim();
    const parsed = zCashTransfer.safeParse(body);
    const errs = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (!fromId) errs.fromAccountId = 'required';
    if (!toId) errs.toAccountId = 'required';
    if (fromForeign && !isRate(rate)) errs.exchangeRate = body.exchangeRate ? 'invalid_rate' : 'required';
    if (amountToRequired && !amountTo.trim()) errs.amountTo = 'required';
    setErrors(errs);
    if (Object.keys(errs).length) return focusFirstInvalid();
    m.mutate(body, {
      onError: (e) => {
        setErrors(serverFieldErrors(e));
        setFailure(e);
      },
    });
  };
  const err = (k: string) => vText(errors[k]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('cash.transfers.addTitle')}
      description={t('cash.transfers.addHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} disabled={active.length < 2} onClick={submit}>
            {t('cash.transfers.submit')}
          </Button>
        </>
      }
    >
      {accounts.isLoading ? (
        <Spinner />
      ) : accounts.error ? (
        <Alert tone="danger">{describe(accounts.error)}</Alert>
      ) : active.length < 2 ? (
        <Alert tone="info">{t('cash.transfers.needTwoAccounts')}</Alert>
      ) : (
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
          <Field
            label={t('cash.transfers.fromAccount')}
            required
            error={err('fromAccountId')}
            className="sm:col-span-2"
          >
            {(id, desc) => (
              <Select
                id={id}
                aria-describedby={desc}
                invalid={!!errors.fromAccountId}
                value={fromId}
                onChange={(e) => {
                  setFromId(e.target.value);
                  if (e.target.value === toId) setToId('');
                }}
              >
                <option value="">{t('cash.transfers.chooseAccount')}</option>
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {optionLabel(a)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex justify-center sm:col-span-2" aria-hidden>
            <ArrowDown className="h-4 w-4 text-subtle" />
          </div>
          <Field
            label={t('cash.transfers.toAccount')}
            required
            error={err('toAccountId')}
            className="sm:col-span-2"
          >
            {(id, desc) => (
              <Select
                id={id}
                aria-describedby={desc}
                invalid={!!errors.toAccountId}
                value={toId}
                onChange={(e) => setToId(e.target.value)}
              >
                <option value="">{t('cash.transfers.chooseAccount')}</option>
                {active
                  .filter((a) => a.id !== fromId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {optionLabel(a)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>

          <Field
            label={t('cash.transfers.amountSent')}
            required
            error={err('amount')}
            hint={
              from
                ? t('cash.transfers.available', { value: fmtMoney(from.balance, from.currency) })
                : undefined
            }
          >
            {(id, desc) => (
              <AmountInput
                id={id}
                aria-describedby={desc}
                currency={from?.currency}
                invalid={!!errors.amount}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('common.date')} required error={err('date')}>
            {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>

          {fromForeign && (
            <Field
              label={t('cash.fx.rateLabel', { currency: from!.currency, base })}
              required
              error={err('exchangeRate')}
              hint={
                txnBase
                  ? t('cash.fx.equals', { value: fmtMoney(txnBase, base) })
                  : t('cash.fx.rateHint', { currency: from!.currency, base })
              }
            >
              {(id, desc) => (
                <RateInput
                  id={id}
                  aria-describedby={desc}
                  invalid={!!errors.exchangeRate}
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              )}
            </Field>
          )}
          {crossCurrency && !amountToRequired && (
            <div className="min-w-0">
              <p className="label">{t('cash.transfers.amountReceived')}</p>
              <div className="flex min-h-10 items-center rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm font-semibold">
                {receivedDefault ? (
                  <Money value={receivedDefault} currency={base} />
                ) : (
                  <span className="text-subtle">—</span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">{t('cash.transfers.amountReceivedComputed')}</p>
            </div>
          )}
          {amountToRequired && (
            <Field
              label={t('cash.transfers.amountReceived')}
              required
              error={err('amountTo')}
              hint={t('cash.transfers.amountReceivedHint', { currency: to!.currency })}
            >
              {(id, desc) => (
                <AmountInput
                  id={id}
                  aria-describedby={desc}
                  currency={to!.currency as CurrencyCode}
                  invalid={!!errors.amountTo}
                  value={amountTo}
                  onChange={(e) => setAmountTo(e.target.value)}
                />
              )}
            </Field>
          )}

          <Field label={t('common.reference')} error={err('reference')}>
            {(id) => (
              <Input
                id={id}
                value={reference}
                maxLength={80}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('common.notes')} error={err('notes')} className="sm:col-span-2">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={notes}
                maxLength={500}
                onChange={(e) => setNotes(e.target.value)}
              />
            )}
          </Field>

          {overdraw && (
            <Alert tone="warning" className="sm:col-span-2">
              {t('cash.transfers.overdrawWarning', { value: fmtMoney(from!.balance, from!.currency) })}
            </Alert>
          )}
          {crossCurrency && (
            <Alert tone="info" className="sm:col-span-2">
              {t('cash.transfers.fxNote')}
            </Alert>
          )}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      )}
    </Modal>
  );
}
