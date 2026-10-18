import { ArrowDown, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { CashTransfer, useCashTransfer } from './api';
import { AccountTypeIcon, FxDifference, TransferStatusBadge } from './components';
import { iso, MONEY_KEYS, Money, useFinMutation, useLedgerText } from './finance-ui';

/**
 * The API stores a transfer's description as "Transfer <from> → <to>[: notes]" and its reversal as
 * "Reversal: <reason>". Show only what the user typed when the text has that shape (an account
 * renamed since keeps the stored text, which is then shown as is).
 */
function transferNotes(tr: CashTransfer): { notes: string | null } | null {
  const prefix = `Transfer ${tr.from.cashAccountName} → ${tr.to.cashAccountName}`;
  if (!tr.description.startsWith(prefix)) return null;
  const rest = tr.description.slice(prefix.length);
  if (!rest) return { notes: null };
  return rest.startsWith(': ') ? { notes: rest.slice(2) } : null;
}
const reversalReason = (s: string) => s.replace(/^Reversal: /, '');

function Leg({ title, leg, base }: { title: string; leg: CashTransfer['from']; base: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="text-xs text-muted">{title}</p>
      <Link
        to={`/app/cash/accounts/${leg.cashAccountId}`}
        className="mt-1 inline-flex items-center gap-2 font-semibold text-ink hover:text-brand-strong"
      >
        <AccountTypeIcon type={leg.cashAccountType} className="h-4 w-4 text-muted" />
        {leg.cashAccountName}
      </Link>
      <p className="mt-2 text-lg font-semibold">
        <Money value={leg.amount} currency={leg.currency} />
      </p>
      {leg.currency !== base && (
        <p className="num mt-0.5 text-xs text-muted">
          {t('cash.transfers.rate')}:{' '}
          <bdi dir="ltr">
            1 {leg.currency} = {d(leg.exchangeRate).toString()} {base}
          </bdi>
        </p>
      )}
    </div>
  );
}

export function TransferDetailPage() {
  const { transferId } = useParams<{ transferId: string }>();
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const q = useCashTransfer(transferId);
  const text = useLedgerText();
  const [reversing, setReversing] = useState(false);
  const reverse = useFinMutation<{ reason: string }, CashTransfer>({
    path: `/cash/transfers/${transferId}/reverse`,
    idempotent: true,
    invalidate: MONEY_KEYS,
    success: t('cash.transfers.reversedOk'),
    onSuccess: () => setReversing(false),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  const tr = q.data;
  const base = tr.baseCurrency;
  const ledgerLinks = can('ledger.read') && !!me?.allBranches;
  const canReverse = tr.status === 'posted' && can('cash.transfer', 'payments.void');
  const parsed = transferNotes(tr);

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: t('cash.transfers.title'), to: '/app/cash/transfers' },
          { label: fmtDate(tr.businessDate) },
        ]}
        title={t('cash.transfers.detailTitle', {
          from: iso(tr.from.cashAccountName),
          to: iso(tr.to.cashAccountName),
        })}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <TransferStatusBadge status={tr.status} />
            <span className="num">{fmtDate(tr.businessDate)}</span>
          </span>
        }
        actions={
          canReverse && (
            <Button variant="danger" icon={<Undo2 className="h-4 w-4" />} onClick={() => setReversing(true)}>
              {t('cash.transfers.reverse')}
            </Button>
          )
        }
      />

      {tr.reversal && (
        <Alert
          tone="warning"
          className="mb-4"
          title={t('cash.transfers.reversedOn', { date: fmtDate(tr.reversal.businessDate) })}
        >
          <span className="block">
            {t('common.reason')}: {reversalReason(tr.reversal.description)}
          </span>
          {ledgerLinks && tr.reversal.journalEntryId && (
            <Link
              to={`/app/accounting/entries/${tr.reversal.journalEntryId}`}
              className="mt-1 inline-block font-medium text-brand-strong hover:underline"
            >
              {t('cash.transfers.reversalEntry')}
            </Link>
          )}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader title={t('cash.transfers.legs')} />
          <CardBody className="space-y-2">
            <Leg title={t('cash.transfers.fromAccount')} leg={tr.from} base={base} />
            <div className="flex justify-center" aria-hidden>
              <ArrowDown className="h-4 w-4 text-subtle" />
            </div>
            <Leg title={t('cash.transfers.toAccount')} leg={tr.to} base={base} />
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader
              title={t('cash.transfers.valuation', { base })}
              subtitle={t('cash.transfers.valuationHint')}
            />
            <CardBody>
              <dl className="divide-y divide-line text-sm">
                <div className="flex items-center justify-between gap-3 pb-3">
                  <dt className="text-muted">{t('cash.transfers.fromBase')}</dt>
                  <dd>
                    <Money value={tr.fromBase} currency={base} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-3">
                  <dt className="text-muted">{t('cash.transfers.valueBase')}</dt>
                  <dd>
                    <Money value={tr.amountBase} currency={base} />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 pt-3">
                  <dt className="font-medium text-ink">{t('cash.transfers.fxDifference')}</dt>
                  <dd className="font-semibold">
                    <FxDifference value={tr.fxDifference} currency={base} />
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted">{t('cash.transfers.fxExplain')}</p>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <DescriptionList
                items={[
                  { label: t('common.reference'), value: tr.reference },
                  { label: t('cash.transfers.createdBy'), value: tr.createdByName },
                  { label: t('common.createdAt'), value: fmtDateTime(tr.createdAt) },
                  {
                    label: t('cash.transfers.journalEntry'),
                    value:
                      tr.journalEntryId && ledgerLinks ? (
                        <Link
                          to={`/app/accounting/entries/${tr.journalEntryId}`}
                          className="font-medium text-brand-strong hover:underline"
                        >
                          {t('cash.transfers.openEntry')}
                        </Link>
                      ) : tr.journalEntryId ? (
                        t('cash.transfers.posted')
                      ) : null,
                  },
                  parsed
                    ? { label: t('common.notes'), value: parsed.notes, full: true }
                    : { label: t('common.description'), value: text(tr.description), full: true },
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={reversing}
        onClose={() => setReversing(false)}
        requireReason
        tone="danger"
        loading={reverse.isPending}
        title={t('cash.transfers.reverseTitle')}
        message={t('cash.transfers.reverseHint')}
        confirmLabel={t('cash.transfers.reverse')}
        onConfirm={(reason) => reverse.mutate({ reason })}
      />
    </>
  );
}
