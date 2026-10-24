import clsx from 'clsx';
import { CheckCircle2, ListChecks, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CurrencyCode, d, PAYMENT_METHODS, sum, zSupplierPaymentCreate } from '@autohub/shared';
import type { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { FormSection, PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { OpenPayable, OpenPayablesResponse, PAYABLE_KEYS, PaymentMethod, SupplierPaymentCreated, useApAccess, useCashAccountOptions, useDocInfo } from './api';
import { docEquivalent, isMoney, isPositiveMoney, isRate, Money, SupplierPicker, TargetTypeBadge, toBase, useIdempotencyKey, useTenantMoney } from './components';
import { errorTarget, usePurchasingError, usePurchasingMutation } from './mutation';

type Body = z.input<typeof zSupplierPaymentCreate>;
interface Alloc {
  amountBase: string;
  amountDoc: string;
}
const keyOf = (r: Pick<OpenPayable, 'targetType' | 'targetId'>) => `${r.targetType}:${r.targetId}`;

/** One open document with its allocation inputs. */
function AllocationRow({
  row,
  alloc,
  onChange,
  base,
  error,
}: {
  row: OpenPayable;
  alloc: Alloc | undefined;
  onChange: (next: Alloc | undefined) => void;
  base: string;
  error: string | null;
}) {
  const { t } = useTranslation();
  const included = !!alloc;
  const doc = useDocInfo(row.targetType, row.targetId, included);
  const foreign = doc.info && doc.info.currency !== base ? doc.info : null;
  const neverPaid = d(row.paidBase).isZero();
  const outstandingDoc = foreign ? (neverPaid ? foreign.totalDoc : docEquivalent(row.outstandingBase, foreign.totalDoc, foreign.totalBase)) : null;
  const baseInvalid = included && alloc.amountBase !== '' && !isPositiveMoney(alloc.amountBase);
  const docInvalid = included && alloc.amountDoc !== '' && !isPositiveMoney(alloc.amountDoc);
  const overBase = included && !foreign && isMoney(alloc.amountBase) && d(alloc.amountBase).gt(row.outstandingBase);
  const overDoc = included && foreign && outstandingDoc && isMoney(alloc.amountDoc) && d(alloc.amountDoc).gt(outstandingDoc) && neverPaid;
  // Carrying amount the settlement relieves (as the API computes it) and the resulting FX difference.
  const relief =
    included && foreign && isPositiveMoney(alloc.amountDoc)
      ? outstandingDoc && d(alloc.amountDoc).eq(outstandingDoc) && neverPaid
        ? row.outstandingBase
        : d(foreign.totalBase).times(alloc.amountDoc).dividedBy(foreign.totalDoc).toDecimalPlaces(2).toFixed(2)
      : null;
  const fxDiff = relief && isPositiveMoney(alloc?.amountBase) ? d(alloc!.amountBase).minus(relief).toFixed(2) : null;

  return (
    <li className={clsx('px-4 py-3', included && 'bg-brand-soft/30', error && 'bg-danger-soft/60')}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand-strong)]"
            checked={included}
            aria-label={t('purchasing.paymentForm.include', { label: row.label })}
            onChange={(e) => onChange(e.target.checked ? { amountBase: row.outstandingBase, amountDoc: '' } : undefined)}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <TargetTypeBadge type={row.targetType} />
              <span className="truncate font-medium">{row.label}</span>
            </div>
            <p className="text-xs text-muted">
              {t('purchasing.payables.docDate')}: {fmtDate(row.docDate)}
              {row.dueDate && ` · ${t('purchasing.payables.dueDate')}: ${fmtDate(row.dueDate)}`}
              {row.vehicleStockNumber && row.targetType !== 'vehicle_cost' && ` · ${row.vehicleStockNumber}`}
            </p>
            <p className="text-xs">
              <span className="text-muted">{t('purchasing.payables.outstanding')}: </span>
              <Money value={row.outstandingBase} currency={base} className="font-semibold" />
              {!neverPaid && (
                <span className="text-muted">
                  {' '}
                  ({t('purchasing.payables.of')} <Money value={row.totalBase} currency={base} />)
                </span>
              )}
            </p>
            {included && doc.loading && <Skeleton className="h-3 w-40" />}
            {foreign && (
              <p className="text-xs text-info">
                {t('purchasing.paymentForm.foreignDoc', { currency: foreign.currency })}{' '}
                <Money value={foreign.totalDoc} currency={foreign.currency} />
                {outstandingDoc && (
                  <>
                    {' · '}
                    {neverPaid ? t('purchasing.paymentForm.outstandingDoc') : t('purchasing.paymentForm.outstandingDocApprox')}{' '}
                    <Money value={outstandingDoc} currency={foreign.currency} />
                  </>
                )}
              </p>
            )}
            {included && !doc.allowed && <p className="text-xs text-muted">{t('purchasing.paymentForm.docCurrencyUnknown')}</p>}
          </div>
        </div>
        {included && (
          <div className="grid gap-2 sm:grid-cols-2 md:w-[420px] md:shrink-0">
            <Field
              label={t('purchasing.paymentForm.allocBase', { currency: base })}
              error={baseInvalid ? 'invalid_amount' : overBase ? t('purchasing.paymentForm.overOutstanding') : null}
            >
              {(id, desc) => (
                <MoneyInput
                  id={id}
                  aria-describedby={desc}
                  currency={base}
                  invalid={baseInvalid || overBase}
                  value={alloc.amountBase}
                  onChange={(e) => onChange({ ...alloc, amountBase: e.target.value })}
                />
              )}
            </Field>
            {foreign && (
              <Field
                label={t('purchasing.paymentForm.allocDoc', { currency: foreign.currency })}
                hint={t('purchasing.paymentForm.allocDocHint')}
                error={docInvalid ? 'invalid_amount' : overDoc ? t('purchasing.paymentForm.overOutstanding') : null}
              >
                {(id, desc) => (
                  <MoneyInput
                    id={id}
                    aria-describedby={desc}
                    currency={foreign.currency}
                    invalid={docInvalid || !!overDoc}
                    value={alloc.amountDoc}
                    onChange={(e) => onChange({ ...alloc, amountDoc: e.target.value })}
                  />
                )}
              </Field>
            )}
            {fxDiff && !d(fxDiff).isZero() && (
              <p className="text-xs text-muted sm:col-span-2">
                {t('purchasing.paymentForm.fxDifference')}: <Money value={fxDiff} currency={base} className={d(fxDiff).gt(0) ? 'text-danger' : 'text-success'} />{' '}
                ({d(fxDiff).gt(0) ? t('purchasing.paymentForm.fxLoss') : t('purchasing.paymentForm.fxGain')})
              </p>
            )}
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export function SupplierPaymentFormPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { can } = useAuth();
  const ap = useApAccess();
  const { base, rounding, timezone } = useTenantMoney();
  const describe = usePurchasingError();
  const [idemKey] = useIdempotencyKey();
  const accounts = useCashAccountOptions();

  const [supplierId, setSupplierId] = useState(params.get('supplierId') ?? '');
  const [cashAccountId, setCashAccountId] = useState('');
  const [paidAt, setPaidAt] = useState(() => todayIso(timezone));
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [alloc, setAlloc] = useState<Record<string, Alloc>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [pendingTarget, setPendingTarget] = useState(params.get('target'));
  const [touched, setTouched] = useState(false);

  const open = useApi<OpenPayablesResponse>(['payables-open', supplierId || 'unset'], supplierId ? '/payables/open' : null, { supplierId });
  const rows = useMemo(() => open.data?.items ?? [], [open.data]);
  const account = accounts.data?.find((a) => a.id === cashAccountId);
  const accountDetail = useApi<{ balance: string; currency: string }>(['cash-accounts', 'detail', cashAccountId], cashAccountId && can('cash.read') ? `/cash-accounts/${cashAccountId}` : null);
  const accCur = (account?.currency ?? base) as CurrencyCode;
  const foreign = !!account && account.currency !== base;
  const paymentBase = account ? toBase(amount, accCur, foreign ? rate : '1', base, rounding) : null;
  const allocEntries = Object.entries(alloc);
  const allocatedValid = allocEntries.every(([, a]) => isPositiveMoney(a.amountBase) && (a.amountDoc === '' || isPositiveMoney(a.amountDoc)));
  const allocated = allocatedValid ? sum(allocEntries.map(([, a]) => a.amountBase.trim())).toFixed(2) : null;
  const difference = paymentBase && allocated ? d(paymentBase).minus(allocated).toFixed(2) : null;
  const balanced = difference !== null && d(difference).isZero();

  // Preselect the document the user came from (e.g. "Pay" on an acquisition) once it is loaded.
  useEffect(() => {
    if (!pendingTarget || !open.data) return;
    const row = rows.find((r) => keyOf(r) === pendingTarget);
    if (row) setAlloc({ [keyOf(row)]: { amountBase: row.outstandingBase, amountDoc: '' } });
    setPendingTarget(null);
  }, [pendingTarget, open.data, rows]);

  const body: Body | null =
    cashAccountId && supplierId
      ? {
          supplierId: supplierId === 'none' ? null : supplierId,
          cashAccountId,
          paidAt,
          method,
          reference: reference.trim() || null,
          notes: notes.trim() || null,
          amount: amount.trim(),
          exchangeRate: foreign ? rate.trim() : undefined,
          allocations: allocEntries.map(([k, a]) => {
            const [targetType, targetId] = k.split(':') as [OpenPayable['targetType'], string];
            return { targetType, targetId, amountBase: a.amountBase.trim(), ...(a.amountDoc.trim() ? { amountDoc: a.amountDoc.trim() } : {}) };
          }),
        }
      : null;
  const parsed = body ? zSupplierPaymentCreate.safeParse(body) : null;
  const canSubmit = !!parsed?.success && balanced && (!foreign || isRate(rate));

  const pay = usePurchasingMutation<Body, SupplierPaymentCreated>({
    path: '/supplier-payments',
    idempotent: true,
    invalidate: PAYABLE_KEYS,
    success: (p) => t('purchasing.payments.created', { number: p.number }),
    onSuccess: (p) => navigate(ap.read ? `/app/purchasing/payments/${p.id}` : '/app/purchasing/payables', { replace: true }),
  });

  const targetError = errorTarget(failure);
  const submit = () => {
    setTouched(true);
    if (!canSubmit || !body) return;
    setFailure(null);
    pay.mutate({ ...body, __idemKey: idemKey }, { onError: setFailure });
  };

  /** Oldest documents first (the API's order), each up to its outstanding balance. */
  const autoAllocate = () => {
    if (!paymentBase) return;
    let left = d(paymentBase);
    const next: Record<string, Alloc> = {};
    for (const r of rows) {
      if (left.lte(0)) break;
      const take = left.gt(r.outstandingBase) ? d(r.outstandingBase) : left;
      next[keyOf(r)] = { amountBase: take.toFixed(2), amountDoc: alloc[keyOf(r)]?.amountDoc ?? '' };
      left = left.minus(take);
    }
    setAlloc(next);
  };

  const amountInvalid = touched && !isPositiveMoney(amount);
  const rateInvalid = touched && foreign && !isRate(rate);

  return (
    <>
      <PageHeader
        title={t('purchasing.payments.add')}
        subtitle={t('purchasing.paymentForm.subtitle')}
        breadcrumbs={[
          ...(ap.read ? [{ label: t('purchasing.payments.title'), to: '/app/purchasing/payments' }] : [{ label: t('purchasing.payables.title'), to: '/app/purchasing/payables' }]),
          { label: t('purchasing.payments.add') },
        ]}
      />
      <Card className="mb-5">
        <CardBody>
          <FormSection title={t('purchasing.paymentForm.payee')} description={t('purchasing.paymentForm.payeeHint')}>
            <Field label={t('purchasing.payables.supplier')} required className="sm:col-span-2" error={touched && !supplierId ? 'required' : null}>
              {(id, desc) => (
                <SupplierPicker
                  id={id}
                  describedBy={desc}
                  allowNone
                  activeOnly={false}
                  invalid={touched && !supplierId}
                  value={supplierId}
                  onChange={(v) => {
                    setSupplierId(v);
                    setAlloc({});
                    setFailure(null);
                  }}
                />
              )}
            </Field>
            <Field label={t('purchasing.payments.cashAccount')} required error={touched && !cashAccountId ? 'required' : null} hint={accountDetail.data ? `${t('purchasing.paymentForm.balance')}: ${fmtMoney(accountDetail.data.balance, accountDetail.data.currency)}` : undefined}>
              {(id, desc) => (
                <Select
                  id={id}
                  aria-describedby={desc}
                  invalid={touched && !cashAccountId}
                  value={cashAccountId}
                  onChange={(e) => {
                    setCashAccountId(e.target.value);
                    setRate('');
                  }}
                >
                  <option value="">—</option>
                  {(accounts.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {t(`purchasing.enums.cashAccountType.${a.type}`)} · {a.currency}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('purchasing.paymentForm.paidAt')} required error={touched && !paidAt ? 'required' : null}>
              {(id, desc) => <Input id={id} aria-describedby={desc} type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />}
            </Field>
            {accounts.error ? (
              <Alert tone="danger" className="sm:col-span-2">
                {t('purchasing.payments.accountsFailed')}
              </Alert>
            ) : accounts.data && accounts.data.length === 0 ? (
              <Alert tone="warning" className="sm:col-span-2">
                {t('purchasing.paymentForm.noAccounts')}
              </Alert>
            ) : null}
            <Field label={t('purchasing.payments.method')} required>
              {(id) => (
                <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`purchasing.enums.method.${m}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('common.reference')} hint={t('purchasing.paymentForm.referenceHint')}>
              {(id, desc) => <Input id={id} aria-describedby={desc} maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}
            </Field>
            <Field label={t('common.notes')} className="sm:col-span-2">
              {(id) => <Textarea id={id} rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
          </FormSection>
          <FormSection title={t('purchasing.paymentForm.amountSection')} description={t('purchasing.paymentForm.amountHint', { currency: base })}>
            <Field label={t('purchasing.paymentForm.amount', { currency: accCur })} required error={amountInvalid ? (amount ? 'invalid_amount' : 'required') : null}>
              {(id, desc) => <MoneyInput id={id} aria-describedby={desc} currency={accCur} invalid={amountInvalid} value={amount} onChange={(e) => setAmount(e.target.value)} />}
            </Field>
            {foreign && (
              <Field
                label={t('purchasing.fx.rate', { from: accCur, to: base })}
                required
                hint={t('purchasing.fx.rateHint', { from: accCur, to: base })}
                error={rateInvalid ? (rate ? t('purchasing.validation.invalid_rate') : 'required') : null}
              >
                {(id, desc) => (
                  <Input id={id} aria-describedby={desc} dir="ltr" inputMode="decimal" className="num" invalid={rateInvalid} value={rate} onChange={(e) => setRate(e.target.value)} />
                )}
              </Field>
            )}
            <div className="rounded-xl border border-line bg-surface-2/60 px-4 py-3 sm:col-span-2" aria-live="polite">
              <p className="text-xs text-muted">{t('purchasing.fx.baseEquivalent', { currency: base })}</p>
              <p className="num mt-0.5 text-lg font-semibold">{paymentBase ? fmtMoney(paymentBase, base) : '—'}</p>
            </div>
          </FormSection>
        </CardBody>
      </Card>

      <Card className="mb-24">
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-muted" aria-hidden />
              {t('purchasing.paymentForm.allocations')}
            </span>
          }
          subtitle={t('purchasing.paymentForm.allocationsHint', { currency: base })}
          actions={
            rows.length > 0 && (
              <>
                <Button size="sm" variant="secondary" icon={<Wand2 className="h-4 w-4" />} disabled={!paymentBase} onClick={autoAllocate}>
                  {t('purchasing.paymentForm.autoAllocate')}
                </Button>
                {!foreign && account && allocated && !d(allocated).isZero() && (
                  <Button size="sm" variant="ghost" onClick={() => setAmount(allocated)}>
                    {t('purchasing.paymentForm.amountFromAllocations')}
                  </Button>
                )}
              </>
            )
          }
        />
        {!supplierId ? (
          <EmptyState title={t('purchasing.paymentForm.chooseSupplier')} />
        ) : open.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : open.error ? (
          <ErrorState error={open.error} onRetry={() => open.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title={t('purchasing.paymentForm.nothingOpen')} description={t('purchasing.paymentForm.nothingOpenHint')} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const k = keyOf(r);
              return (
                <AllocationRow
                  key={k}
                  row={r}
                  base={base}
                  alloc={alloc[k]}
                  error={targetError === k ? describe(failure) : null}
                  onChange={(next) =>
                    setAlloc((cur) => {
                      const copy = { ...cur };
                      if (next) copy[k] = next;
                      else delete copy[k];
                      return copy;
                    })
                  }
                />
              );
            })}
          </ul>
        )}
      </Card>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <div className="flex items-center gap-1.5">
              <dt className="text-xs text-muted">{t('purchasing.paymentForm.paymentBase')}</dt>
              <dd className="num font-medium">{paymentBase ? fmtMoney(paymentBase, base) : '—'}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-xs text-muted">{t('purchasing.paymentForm.allocated')}</dt>
              <dd className="num font-medium">{allocated ? fmtMoney(allocated, base) : '—'}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-xs text-muted">{t('purchasing.paymentForm.difference')}</dt>
              <dd className={clsx('num font-semibold', difference === null ? '' : balanced ? 'text-success' : 'text-danger')}>
                {difference === null ? '—' : fmtMoney(difference, base)}
              </dd>
            </div>
          </dl>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate(-1)}>
              {t('common.cancel')}
            </Button>
            <Button loading={pay.isPending} disabled={touched && !canSubmit} onClick={submit}>
              {t('purchasing.paymentForm.post')}
            </Button>
          </div>
        </div>
        {touched && !canSubmit && (
          <p className="mt-2 text-xs text-danger" role="alert">
            {allocEntries.length === 0
              ? t('purchasing.paymentForm.needAllocation')
              : !balanced && difference !== null
                ? t('purchasing.paymentForm.mustBalance')
                : t('purchasing.paymentForm.fixFields')}
          </p>
        )}
        {failure !== null && !targetError && (
          <Alert tone="danger" className="mt-2">
            {describe(failure)}
          </Alert>
        )}
      </div>
    </>
  );
}
