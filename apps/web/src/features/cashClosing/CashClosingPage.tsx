import { CalendarCheck2, LockKeyhole, RotateCcw, Vault } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import type { CashAccountOption, CashAccountRow, CashClosing, ExpectedBalance } from '@/features/sales/api';
import {
  AmountInput,
  FailureAlert,
  isMoney,
  Money,
  ReasonModal,
  Row,
  Stat,
  useFieldMessage,
  useIdempotencyKey,
  useSalesError,
  useSalesMutation,
  useTenantMoney,
} from '@/features/sales/shared';

type Account = Pick<CashAccountRow, 'id' | 'type' | 'name' | 'currency' | 'branchId'> & Partial<Pick<CashAccountRow, 'balance' | 'branchName' | 'isActive'>>;

export function CashClosingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const lp = useListParams();
  const canRead = can('cash.read');
  // cash.read lists accounts with balances; a closer without it can still pick from the payment options.
  const full = useApi<CashAccountRow[]>(['cash-accounts', 'closing'], canRead ? '/cash-accounts' : null);
  const options = useApi<CashAccountOption[]>(['cash-accounts', 'options'], canRead ? null : '/cash-accounts/options');
  const accounts: Account[] | undefined = canRead ? full.data : options.data;
  const loading = canRead ? full.isLoading : options.isLoading;
  const error = canRead ? full.error : options.error;
  const selectedId = lp.get('account') || (accounts?.length === 1 ? accounts[0]!.id : '');
  const account = accounts?.find((a) => a.id === selectedId) ?? null;

  return (
    <>
      <PageHeader title={t('cashClosing.title')} subtitle={t('cashClosing.subtitle')} />
      <Card className="mb-5">
        <CardBody className="flex flex-wrap items-end gap-4">
          <Field label={t('cashClosing.account')} className="w-full max-w-md">
            {(id) =>
              loading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <Select id={id} value={selectedId} onChange={(e) => lp.set({ account: e.target.value })}>
                  <option value="">{t('cashClosing.chooseAccount')}</option>
                  {(accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.currency}
                      {a.branchName ? ` · ${a.branchName}` : ''}
                    </option>
                  ))}
                </Select>
              )
            }
          </Field>
          {account?.balance !== undefined && (
            <Stat label={t('cashClosing.currentBalance')}>
              <Money value={account.balance} currency={account.currency} className="text-lg font-semibold" />
            </Stat>
          )}
        </CardBody>
      </Card>

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => (canRead ? full.refetch() : options.refetch())} />
        </Card>
      ) : !account ? (
        <Card>
          <EmptyState
            icon={<Vault className="h-5 w-5" />}
            title={accounts && accounts.length === 0 ? t('cashClosing.noAccounts') : t('cashClosing.pickAccount')}
            description={t('cashClosing.pickAccountHint')}
          />
        </Card>
      ) : (
        <AccountClosing key={account.id} account={account} canRead={canRead} />
      )}
    </>
  );
}

function AccountClosing({ account, canRead }: { account: Account; canRead: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [reopening, setReopening] = useState<CashClosing | null>(null);
  const history = useApi<CashClosing[]>(['cash-closings', account.id], canRead ? `/cash-accounts/${account.id}/closings` : null);
  const latestClosed = history.data?.find((c) => c.status === 'closed') ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="min-w-0">
        {can('cash.close') ? (
          <CloseDayForm account={account} canRead={canRead} closedThrough={latestClosed?.businessDate ?? null} />
        ) : (
          <Alert tone="info">{t('cashClosing.closeNeedsPermission')}</Alert>
        )}
      </div>
      <div className="min-w-0">
        <Card>
          <CardHeader title={t('cashClosing.history')} subtitle={latestClosed ? t('cashClosing.closedThrough', { date: fmtDate(latestClosed.businessDate) }) : t('cashClosing.neverClosed')} />
          {!canRead ? (
            <p className="px-5 py-4 text-sm text-muted">{t('cashClosing.historyNeedsRead')}</p>
          ) : (
            <DataTable
              dense
              rows={history.data}
              loading={history.isLoading}
              error={history.error}
              onRetry={() => history.refetch()}
              rowKey={(c) => c.id}
              empty={<EmptyState icon={<CalendarCheck2 className="h-5 w-5" />} title={t('cashClosing.noClosings')} />}
              columns={[
                {
                  key: 'date',
                  header: t('cashClosing.businessDate'),
                  cell: (c) => (
                    <div>
                      <p className="font-medium whitespace-nowrap">{fmtDate(c.businessDate)}</p>
                      <p className="text-xs text-muted">{fmtDateTime(c.closedAt)}</p>
                    </div>
                  ),
                },
                { key: 'expected', header: t('cashClosing.expected'), align: 'end', cell: (c) => <Money value={c.expectedBalance} currency={account.currency} /> },
                { key: 'counted', header: t('cashClosing.counted'), align: 'end', cell: (c) => <Money value={c.countedBalance} currency={account.currency} className="font-medium" /> },
                {
                  key: 'diff',
                  header: t('cashClosing.difference'),
                  align: 'end',
                  cell: (c) => (
                    <Money
                      value={c.difference}
                      currency={account.currency}
                      className={d(c.difference).isZero() ? 'text-muted' : d(c.difference).gt(0) ? 'font-medium text-success' : 'font-medium text-danger'}
                    />
                  ),
                },
                {
                  key: 'status',
                  header: t('common.status'),
                  cell: (c) => (
                    <div className="max-w-[200px]">
                      <Badge tone={c.status === 'closed' ? 'success' : 'warning'}>{t(`cashClosing.status.${c.status}`)}</Badge>
                      {c.status === 'reopened' && c.reopenReason && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{c.reopenReason}</p>}
                      {c.notes && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{c.notes}</p>}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">{t('common.actions')}</span>,
                  className: 'relative',
                  align: 'end',
                  cell: (c) =>
                    c.id === latestClosed?.id && can('cash.reopen') ? (
                      <Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setReopening(c)}>
                        {t('cashClosing.reopen')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          )}
        </Card>
      </div>
      {reopening && <ReopenModal closing={reopening} onClose={() => setReopening(null)} />}
    </div>
  );
}

function CloseDayForm({ account, canRead, closedThrough }: { account: Account; canRead: boolean; closedThrough: string | null }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { base, today } = useTenantMoney();
  const fm = useFieldMessage();
  const describe = useSalesError();
  const [idemKey, renewKey] = useIdempotencyKey();
  const [date, setDate] = useState(today);
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const expected = useApi<ExpectedBalance>(['cash-closings', account.id, 'expected'], canRead && date ? `/cash-accounts/${account.id}/closings/expected` : null, { date });
  const exp = expected.data?.businessDate === date ? expected.data.expectedBalance : null;
  const countedOk = isMoney(counted) && !d(counted.trim()).isNegative();
  const diff = exp !== null && countedOk ? d(counted.trim()).minus(exp).toFixed(2) : null;
  const hasDiff = diff !== null && !d(diff).isZero();
  const canAdjust = can('cash.adjust');
  const foreign = account.currency !== base;
  const alreadyClosed = !!closedThrough && date <= closedThrough;
  const future = date > today;
  const blocked = alreadyClosed || future || (hasDiff && (!canAdjust || foreign));

  const close = useSalesMutation<Record<string, unknown>>({
    path: `/cash-accounts/${account.id}/closings`,
    idempotent: true,
    toastError: false,
    invalidate: [['cash-closings', account.id], ['cash-accounts']],
    success: t('cashClosing.closed', { date: fmtDate(date) }),
    onSuccess: () => {
      setCounted('');
      setNotes('');
      renewKey();
    },
  });

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <LockKeyhole className="h-4 w-4 text-muted" aria-hidden />
            {t('cashClosing.closeDay')}
          </span>
        }
        subtitle={t('cashClosing.closeDayHint')}
      />
      <CardBody className="grid gap-4">
        {failure !== null && <FailureAlert error={failure} onReload={() => setFailure(null)} />}
        <Field
          label={t('cashClosing.businessDate')}
          required
          error={alreadyClosed ? t('cashClosing.dateClosed', { date: fmtDate(closedThrough) }) : future ? t('cashClosing.futureDate') : null}
        >
          {(id) => <Input id={id} type="date" value={date} max={today} invalid={alreadyClosed || future} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <dl className="divide-y divide-line rounded-xl border border-line px-4">
          <Row label={t('cashClosing.expected')}>
            {!canRead ? (
              <span className="text-xs text-muted">{t('cashClosing.expectedNeedsRead')}</span>
            ) : expected.isLoading ? (
              <Skeleton className="h-4 w-24" />
            ) : expected.error ? (
              <span className="text-xs text-danger">{describe(expected.error)}</span>
            ) : (
              <Money value={exp} currency={account.currency} className="font-medium" />
            )}
          </Row>
          <Row label={t('cashClosing.difference')} strong tone={diff === null ? 'muted' : hasDiff ? (d(diff).gt(0) ? 'success' : 'danger') : undefined}>
            {diff === null ? '—' : <Money value={diff} currency={account.currency} />}
          </Row>
        </dl>
        <Field label={t('cashClosing.counted')} required error={counted.trim() && !countedOk ? fm('invalid_amount') : null} hint={t('cashClosing.countedHint')}>
          {(id, desc) => <AmountInput id={id} aria-describedby={desc} currency={account.currency} value={counted} invalid={!!counted.trim() && !countedOk} onChange={(e) => setCounted(e.target.value)} />}
        </Field>
        {hasDiff && diff !== null && (
          <Alert tone={canAdjust && !foreign ? 'warning' : 'danger'} title={d(diff).gt(0) ? t('cashClosing.over') : t('cashClosing.short')}>
            {foreign ? t('cashClosing.foreignDifference') : canAdjust ? t('cashClosing.differencePosted', { date: fmtDate(date) }) : t('cashClosing.needsAdjust')}
          </Alert>
        )}
        {!hasDiff && diff !== null && <Alert tone="success">{t('cashClosing.exact')}</Alert>}
        <Field label={t('common.notes')}>{(id) => <Textarea id={id} rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <p className="text-xs text-muted">{t('cashClosing.lockNote')}</p>
        <Button
          className="justify-center"
          icon={<LockKeyhole className="h-4 w-4" />}
          loading={close.isPending}
          disabled={!countedOk || blocked}
          onClick={() => {
            setFailure(null);
            close.mutate({ businessDate: date, countedBalance: counted.trim(), notes: notes.trim() || null, __idemKey: idemKey }, { onError: setFailure });
          }}
        >
          {t('cashClosing.closeButton', { date: fmtDate(date) })}
        </Button>
      </CardBody>
    </Card>
  );
}

function ReopenModal({ closing, onClose }: { closing: CashClosing; onClose: () => void }) {
  const { t } = useTranslation();
  const describe = useSalesError();
  const [failure, setFailure] = useState<unknown>(null);
  const reopen = useSalesMutation<{ reason: string }>({
    path: `/cash-closings/${closing.id}/reopen`,
    toastError: false,
    invalidate: [['cash-closings', closing.cashAccountId], ['cash-accounts']],
    success: t('cashClosing.reopened', { date: fmtDate(closing.businessDate) }),
    onSuccess: onClose,
  });
  return (
    <ReasonModal
      title={t('cashClosing.reopenTitle', { date: fmtDate(closing.businessDate) })}
      message={t('cashClosing.reopenHint')}
      confirmLabel={t('cashClosing.reopen')}
      tone="primary"
      minLength={5}
      loading={reopen.isPending}
      error={failure !== null ? describe(failure) : undefined}
      onClose={onClose}
      onConfirm={(reason) => {
        setFailure(null);
        reopen.mutate({ reason }, { onError: setFailure });
      }}
    />
  );
}
