import { ArrowLeftRight, BookOpen, Pencil, Power, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList, StatCard } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader, Tabs, Toolbar } from '@/components/ui/Layout';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { CashAccountDetail, CashBookRow, CashTransfer, Paged, useCashAccount, useCashBook } from './api';
import { CashAccountFormModal } from './CashAccountFormModal';
import { AccountScope, AccountTypeBadge, AccountTypeIcon, ActiveBadge, TransfersTable } from './components';
import { DateRange, iso, Money, Stat, useFinMutation, useLedgerText } from './finance-ui';
import { TransferFormModal } from './TransferFormModal';

type TabKey = 'book' | 'transfers';

/** Cash-book kinds fully described by their label and linked document number. */
const SELF_DESCRIBING = new Set(['opening_balance', 'supplier_payment', 'cash_over', 'cash_short']);

/** Links from a cash-book row to the documents behind it (only to pages the user can open). */
function RowLinks({ r }: { r: CashBookRow }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const links: Array<{ to: string; label: string }> = [];
  if (r.sourceType === 'cash_transfer')
    links.push({ to: `/app/cash/transfers/${r.sourceId}`, label: t('cash.book.openTransfer') });
  if (r.sourceType === 'supplier_payment' && can('suppliers.read', 'payments.read'))
    links.push({
      to: `/app/purchasing/payments/${r.sourceId}`,
      label: r.documentNumber ?? t('cash.book.openPayment'),
    });
  if (r.journalEntryId && can('ledger.read') && me?.allBranches)
    links.push({ to: `/app/accounting/entries/${r.journalEntryId}`, label: t('cash.book.journalEntry') });
  if (!links.length)
    return r.documentNumber ? <span className="num text-xs text-muted">{r.documentNumber}</span> : null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {links.map((l) => (
        <Link
          key={l.to}
          to={l.to}
          onClick={(e) => e.stopPropagation()}
          className="text-xs font-medium text-brand-strong hover:underline"
        >
          {l.label}
        </Link>
      ))}
    </span>
  );
}

function KindCell({ r }: { r: CashBookRow }) {
  const { t } = useTranslation();
  const base = r.kind.replace(/_reversal$/, '');
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[13px] font-medium">{t(`cash.enums.kind.${base}`, { defaultValue: base })}</span>
      {r.isReversal && (
        <Badge tone="danger" dot={false}>
          {t('cash.book.reversal')}
        </Badge>
      )}
      {r.reversedById && (
        <Badge tone="warning" dot={false}>
          {t('cash.book.reversed')}
        </Badge>
      )}
    </div>
  );
}

function CashBookCard({ account }: { account: CashAccountDetail }) {
  const { t } = useTranslation();
  const text = useLedgerText();
  const { currency: base } = useAuth();
  const lp = useListParams();
  const from = lp.get('from');
  const to = lp.get('to');
  const page = lp.page;
  const pageSize = 50;
  const q = useCashBook(account.id, { from: from || undefined, to: to || undefined, page, pageSize });
  const book = q.data;
  const foreign = account.currency !== base;

  return (
    <Card>
      <CardHeader
        title={t('cash.book.title')}
        subtitle={
          book
            ? book.from
              ? t('cash.book.periodRange', { from: fmtDate(book.from), to: fmtDate(book.to) })
              : t('cash.book.periodUntil', { to: fmtDate(book.to) })
            : t('cash.book.subtitle')
        }
      />
      <Toolbar>
        <DateRange from={from} to={to} onChange={(v) => lp.set(v)} />
        {(from || to) && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={() => lp.set({ from: null, to: null })}
          >
            {t('common.clearFilters')}
          </Button>
        )}
      </Toolbar>
      {book && (
        <div className="grid grid-cols-2 gap-4 border-b border-line px-5 py-4 md:grid-cols-4">
          <Stat label={t('cash.book.opening')}>
            <Money value={book.opening.amount} currency={account.currency} toneNegative />
            {foreign && (
              <p className="text-xs font-normal text-muted">
                <Money value={book.opening.amountBase} currency={base} />
              </p>
            )}
          </Stat>
          <Stat label={t('cash.book.totalIn')}>
            <span className="text-success">
              <Money value={book.totals.in} currency={account.currency} />
            </span>
            {foreign && (
              <p className="text-xs font-normal text-muted">
                <Money value={book.totals.inBase} currency={base} />
              </p>
            )}
          </Stat>
          <Stat label={t('cash.book.totalOut')}>
            <span className="text-danger">
              <Money value={book.totals.out} currency={account.currency} />
            </span>
            {foreign && (
              <p className="text-xs font-normal text-muted">
                <Money value={book.totals.outBase} currency={base} />
              </p>
            )}
          </Stat>
          <Stat label={t('cash.book.closing')}>
            <Money
              value={book.closing.amount}
              currency={account.currency}
              toneNegative
              className="font-semibold"
            />
            {foreign && (
              <p className="text-xs font-normal text-muted">
                <Money value={book.closing.amountBase} currency={base} />
              </p>
            )}
          </Stat>
        </div>
      )}
      <DataTable
        rows={book?.rows}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(r) => r.id}
        dense
        empty={
          <EmptyState
            icon={<BookOpen className="h-5 w-5" />}
            title={t('cash.book.empty')}
            description={t('cash.book.emptyHint')}
          />
        }
        footer={
          book && (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={book.total}
              onPage={(p) => lp.set({ page: p }, false)}
            />
          )
        }
        columns={[
          {
            key: 'date',
            header: t('common.date'),
            hideOnMobile: true,
            cell: (r) => <span className="num whitespace-nowrap">{fmtDate(r.businessDate)}</span>,
          },
          {
            key: 'desc',
            header: t('common.description'),
            cell: (r) => (
              <div className="max-w-[420px] min-w-0 space-y-0.5 md:min-w-[200px]">
                {/* Phones: date, movement and running balance live here (the table scrolls sideways). */}
                <div className="space-y-0.5 md:hidden">
                  <p className="num text-xs text-muted">{fmtDate(r.businessDate)}</p>
                  <p className="text-xs">
                    <Money
                      value={r.signedAmount}
                      currency={account.currency}
                      signed
                      className={r.direction === 'in' ? 'text-success' : 'text-danger'}
                    />
                    <span className="mx-1 text-subtle">·</span>
                    <span className="text-muted">{t('cash.book.running')}:</span>{' '}
                    <Money
                      value={r.runningBalance}
                      currency={account.currency}
                      toneNegative
                      className="font-medium"
                    />
                  </p>
                </div>
                <KindCell r={r} />
                {r.counterpartAccountName ? (
                  <p className="text-[13px] break-words text-muted">
                    {t(r.direction === 'in' ? 'cash.book.fromAccount' : 'cash.book.toAccount', {
                      name: iso(r.counterpartAccountName),
                    })}
                  </p>
                ) : (
                  // Kinds whose label (and document number link) already say everything skip the
                  // server-generated text; other movements show what was recorded.
                  !SELF_DESCRIBING.has(r.kind) && (
                    <p className="text-[13px] break-words text-muted">{text(r.description)}</p>
                  )
                )}
                {r.reference && (
                  <p className="text-xs text-subtle">
                    {t('common.reference')}: {r.reference}
                  </p>
                )}
                <RowLinks r={r} />
              </div>
            ),
          },
          {
            key: 'in',
            header: t('cash.book.in'),
            align: 'end',
            hideOnMobile: true,
            cell: (r) =>
              r.direction === 'in' ? (
                <Money value={r.amount} currency={account.currency} className="text-success" />
              ) : (
                <span className="text-subtle">—</span>
              ),
          },
          {
            key: 'out',
            header: t('cash.book.out'),
            align: 'end',
            hideOnMobile: true,
            cell: (r) =>
              r.direction === 'out' ? (
                <Money value={r.amount} currency={account.currency} className="text-danger" />
              ) : (
                <span className="text-subtle">—</span>
              ),
          },
          {
            key: 'running',
            header: t('cash.book.running'),
            align: 'end',
            cell: (r) => (
              <div>
                <Money
                  value={r.runningBalance}
                  currency={account.currency}
                  toneNegative
                  className="font-medium"
                />
                {foreign && (
                  <p className="text-xs text-muted">
                    <Money value={r.runningBalanceBase} currency={base} />
                  </p>
                )}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}

function AccountTransfers({ accountId }: { accountId: string }) {
  const [page, setPage] = useState(1);
  const q = useApi<Paged<CashTransfer>>(
    ['cash-transfers', 'account', accountId],
    '/cash/transfers',
    { cashAccountId: accountId, page, pageSize: 25 },
    { placeholderData: (p) => p },
  );
  return (
    <Card>
      <TransfersTable
        data={q.data}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        page={page}
        onPage={setPage}
      />
    </Card>
  );
}

export function CashAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can, me, currency: base } = useAuth();
  const q = useCashAccount(id);
  const branches = useBranches();
  const [tab, setTab] = useState<TabKey>('book');
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const toggle = useFinMutation<{ isActive: boolean }, CashAccountDetail>({
    path: `/cash-accounts/${id}`,
    method: 'PATCH',
    invalidate: [['cash-accounts'], ['cash-book']],
    success: (a) => (a.isActive ? t('cash.accounts.activated') : t('cash.accounts.deactivated')),
    onSuccess: () => setToggling(false),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  const a = q.data;
  const branchName = a.branchId ? (branches.data?.find((b) => b.id === a.branchId)?.name ?? null) : null;
  const canManage = can('cash.manage_accounts') && (a.branchId !== null || !!me?.allBranches);
  const foreign = a.currency !== base;
  const empty = d(a.balance).isZero();

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('cash.accounts.title'), to: '/app/cash/accounts' }, { label: a.name }]}
        title={
          <span className="inline-flex items-center gap-2">
            <AccountTypeIcon type={a.type} className="h-5 w-5 text-muted" />
            {a.name}
          </span>
        }
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <AccountTypeBadge type={a.type} />
            <ActiveBadge active={a.isActive} />
            <AccountScope branchId={a.branchId} branchName={branchName} />
          </span>
        }
        actions={
          <>
            {can('cash.transfer') && a.isActive && (
              <Button
                variant="secondary"
                icon={<ArrowLeftRight className="h-4 w-4" />}
                onClick={() => setTransferring(true)}
              >
                {t('cash.transfers.add')}
              </Button>
            )}
            {canManage && (
              <Button
                variant="secondary"
                icon={<Pencil className="h-4 w-4" />}
                onClick={() => setEditing(true)}
              >
                {t('common.edit')}
              </Button>
            )}
            {canManage && (
              <Button
                variant={a.isActive ? 'outline' : 'success'}
                icon={<Power className="h-4 w-4" />}
                onClick={() => setToggling(true)}
              >
                {a.isActive ? t('cash.accounts.deactivate') : t('cash.accounts.activate')}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid items-start gap-3 lg:grid-cols-3">
        <StatCard
          label={t('cash.accounts.balance')}
          value={<Money value={a.balance} currency={a.currency} toneNegative />}
          tone="brand"
          icon={<AccountTypeIcon type={a.type} className="h-5 w-5" />}
        />
        {foreign && (
          <StatCard
            label={t('cash.accounts.balanceBase', { base })}
            value={<Money value={a.balanceBase} currency={base} toneNegative />}
            hint={t('cash.accounts.carryingHint')}
          />
        )}
        <Card className={foreign ? '' : 'lg:col-span-2'}>
          <CardBody className="py-4">
            <DescriptionList
              columns={foreign ? 2 : 3}
              items={[
                { label: t('common.currency'), value: <span className="num">{a.currency}</span> },
                ...(a.type === 'bank'
                  ? [
                      { label: t('cash.accounts.bankName'), value: a.bankName },
                      {
                        label: t('cash.accounts.accountNumber'),
                        value: a.accountNumber && (
                          <span className="num" dir="ltr">
                            {a.accountNumber}
                          </span>
                        ),
                      },
                      {
                        label: t('cash.accounts.iban'),
                        value: a.iban && (
                          <span className="num break-all" dir="ltr">
                            {a.iban}
                          </span>
                        ),
                      },
                    ]
                  : []),
                { label: t('common.createdAt'), value: fmtDateTime(a.createdAt) },
              ]}
            />
          </CardBody>
        </Card>
      </div>

      {!a.isActive && (
        <Alert tone="info" className="mb-4">
          {t('cash.accounts.inactiveNote')}
        </Alert>
      )}

      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'book', label: t('cash.book.title') },
            { key: 'transfers', label: t('cash.transfers.title') },
          ]}
        />
      </div>
      {tab === 'book' ? <CashBookCard account={a} /> : <AccountTransfers accountId={a.id} />}

      {editing && (
        <CashAccountFormModal
          account={a}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
      {transferring && (
        <TransferFormModal
          defaultFromId={a.id}
          onClose={() => setTransferring(false)}
          onDone={(tr) => {
            setTransferring(false);
            navigate(`/app/cash/transfers/${tr.transferId}`);
          }}
        />
      )}
      <ConfirmDialog
        open={toggling}
        onClose={() => setToggling(false)}
        loading={toggle.isPending}
        tone={a.isActive ? 'danger' : 'primary'}
        title={
          a.isActive
            ? t('cash.accounts.deactivateTitle', { name: iso(a.name) })
            : t('cash.accounts.activateTitle', { name: iso(a.name) })
        }
        confirmLabel={a.isActive ? t('cash.accounts.deactivate') : t('cash.accounts.activate')}
        message={
          a.isActive ? (
            <div className="space-y-3">
              <p>{t('cash.accounts.deactivateHint')}</p>
              {!empty && (
                <Alert tone="warning">
                  {t('cash.accounts.deactivateNotEmpty')} <Money value={a.balance} currency={a.currency} />
                </Alert>
              )}
            </div>
          ) : (
            t('cash.accounts.activateHint')
          )
        }
        onConfirm={() => toggle.mutate({ isActive: !a.isActive })}
      />
    </>
  );
}
