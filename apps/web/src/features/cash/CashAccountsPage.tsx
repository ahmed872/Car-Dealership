import { ArrowLeftRight, Banknote, Landmark, Plus, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { sum } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, StatCard } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Checkbox } from '@/components/ui/Field';
import { PageHeader, Tabs, Toolbar } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/format';
import { useListParams } from '@/lib/hooks';
import { CashAccountListItem, useCashAccounts } from './api';
import { CashAccountFormModal } from './CashAccountFormModal';
import { AccountScope, AccountTypeBadge, AccountTypeIcon, ActiveBadge } from './components';
import { Money } from './finance-ui';
import { TransferFormModal } from './TransferFormModal';

type TypeFilter = 'all' | 'cashbox' | 'bank';

export function CashAccountsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currency: base, can } = useAuth();
  const lp = useListParams({ type: 'all' });
  const includeInactive = lp.get('inactive') === '1';
  const type = (lp.get('type') || 'all') as TypeFilter;
  const q = useCashAccounts(includeInactive);
  const [creating, setCreating] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const rows = useMemo(() => (q.data ?? []).filter((a) => type === 'all' || a.type === type), [q.data, type]);
  const activeRows = useMemo(() => (q.data ?? []).filter((a) => a.isActive), [q.data]);
  const totals = useMemo(() => {
    const of = (list: CashAccountListItem[]) => sum(list.map((a) => a.balanceBase)).toFixed(2);
    return {
      all: of(activeRows),
      cash: of(activeRows.filter((a) => a.type === 'cashbox')),
      bank: of(activeRows.filter((a) => a.type === 'bank')),
    };
  }, [activeRows]);
  const counts = {
    all: q.data?.length,
    cashbox: q.data?.filter((a) => a.type === 'cashbox').length,
    bank: q.data?.filter((a) => a.type === 'bank').length,
  };

  return (
    <>
      <PageHeader
        title={t('cash.accounts.title')}
        subtitle={t('cash.accounts.subtitle')}
        actions={
          <>
            <Can perm="cash.transfer">
              <Button
                variant="secondary"
                icon={<ArrowLeftRight className="h-4 w-4" />}
                onClick={() => setTransferring(true)}
              >
                {t('cash.transfers.add')}
              </Button>
            </Can>
            <Can perm="cash.manage_accounts">
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                {t('cash.accounts.add')}
              </Button>
            </Can>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t('cash.accounts.totalBalance')}
          value={q.data ? fmtMoney(totals.all, base) : '…'}
          hint={t('cash.accounts.totalBalanceHint', { n: activeRows.length })}
          icon={<Wallet className="h-5 w-5" />}
          tone="brand"
        />
        <StatCard
          label={t('cash.accounts.totalCash')}
          value={q.data ? fmtMoney(totals.cash, base) : '…'}
          icon={<Banknote className="h-5 w-5" />}
          tone="success"
          onClick={() => lp.set({ type: 'cashbox' })}
        />
        <StatCard
          label={t('cash.accounts.totalBank')}
          value={q.data ? fmtMoney(totals.bank, base) : '…'}
          icon={<Landmark className="h-5 w-5" />}
          tone="info"
          onClick={() => lp.set({ type: 'bank' })}
        />
      </div>

      <Card>
        <div className="px-4 pt-2">
          <Tabs
            value={type}
            onChange={(k) => lp.set({ type: k === 'all' ? null : k })}
            tabs={[
              { key: 'all', label: t('common.all'), count: counts.all },
              { key: 'cashbox', label: t('cash.enums.typePlural.cashbox'), count: counts.cashbox },
              { key: 'bank', label: t('cash.enums.typePlural.bank'), count: counts.bank },
            ]}
          />
        </div>
        <Toolbar className="justify-between">
          <Checkbox
            label={t('cash.accounts.showInactive')}
            checked={includeInactive}
            onChange={(e) => lp.set({ inactive: e.target.checked ? '1' : null })}
          />
          <span className="text-xs text-muted">{t('cash.accounts.baseNote', { base })}</span>
        </Toolbar>
        <DataTable
          rows={q.data ? rows : undefined}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(a) => a.id}
          onRowClick={(a) => navigate(`/app/cash/accounts/${a.id}`)}
          empty={
            <EmptyState
              icon={<Wallet className="h-5 w-5" />}
              title={t('cash.accounts.empty')}
              description={t('cash.accounts.emptyHint')}
              action={
                can('cash.manage_accounts') && (
                  <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                    {t('cash.accounts.add')}
                  </Button>
                )
              }
            />
          }
          columns={[
            {
              key: 'name',
              header: t('cash.accounts.account'),
              cell: (a) => (
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                    <AccountTypeIcon type={a.type} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {a.name}
                      {!a.isActive && (
                        <span className="ms-2 text-xs font-normal text-muted md:hidden">
                          ({t('common.inactive')})
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {a.type === 'bank'
                        ? [a.bankName, a.iban ?? a.accountNumber].filter(Boolean).join(' · ') ||
                          t(`cash.enums.type.${a.type}`)
                        : t(`cash.enums.type.${a.type}`)}
                    </p>
                    {/* Phones: the balance lives here (the table scrolls sideways for the rest). */}
                    <p className="mt-1 text-sm md:hidden">
                      <Money value={a.balance} currency={a.currency} toneNegative className="font-semibold" />
                      {a.currency !== base && (
                        <span className="ms-2 text-xs text-muted">
                          <Money value={a.balanceBase} currency={base} />
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              ),
            },
            {
              key: 'type',
              header: t('cash.accounts.type'),
              hideOnMobile: true,
              cell: (a) => <AccountTypeBadge type={a.type} />,
            },
            {
              key: 'branch',
              header: t('common.branch'),
              hideOnMobile: true,
              cell: (a) => <AccountScope branchId={a.branchId} branchName={a.branchName} />,
            },
            {
              key: 'currency',
              header: t('common.currency'),
              hideOnMobile: true,
              cell: (a) => <span className="num text-[13px]">{a.currency}</span>,
            },
            {
              key: 'balance',
              header: t('cash.accounts.balance'),
              align: 'end',
              cell: (a) => (
                <div>
                  <Money value={a.balance} currency={a.currency} toneNegative className="font-semibold" />
                  {a.currency !== base && (
                    <p className="text-xs text-muted">
                      <Money value={a.balanceBase} currency={base} />
                    </p>
                  )}
                </div>
              ),
            },
            {
              key: 'status',
              header: t('common.status'),
              hideOnMobile: true,
              cell: (a) => <ActiveBadge active={a.isActive} />,
            },
          ]}
        />
      </Card>

      {creating && (
        <CashAccountFormModal
          account={null}
          onClose={() => setCreating(false)}
          onSaved={(a) => {
            setCreating(false);
            navigate(`/app/cash/accounts/${a.id}`);
          }}
        />
      )}
      {transferring && (
        <TransferFormModal
          onClose={() => setTransferring(false)}
          onDone={(tr) => {
            setTransferring(false);
            navigate(`/app/cash/transfers/${tr.transferId}`);
          }}
        />
      )}
    </>
  );
}
