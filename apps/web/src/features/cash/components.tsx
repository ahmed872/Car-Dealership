import { ArrowLeftRight, Banknote, Building2, Landmark } from 'lucide-react';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { fmtDate } from '@/lib/format';
import type { CashAccountType, CashTransfer, Paged } from './api';
import { Money } from './finance-ui';

export function AccountTypeIcon({
  type,
  className = 'h-4 w-4',
}: {
  type: CashAccountType;
  className?: string;
}) {
  return type === 'bank' ? (
    <Landmark className={className} aria-hidden />
  ) : (
    <Banknote className={className} aria-hidden />
  );
}

export function AccountTypeBadge({ type }: { type: CashAccountType }) {
  const { t } = useTranslation();
  return (
    <Badge tone={type === 'bank' ? 'info' : 'brand'} dot={false}>
      <AccountTypeIcon type={type} className="h-3.5 w-3.5" />
      {t(`cash.enums.type.${type}`)}
    </Badge>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge tone={active ? 'success' : 'neutral'}>{active ? t('common.active') : t('common.inactive')}</Badge>
  );
}

/** "Company-level" when the account has no branch (shared by every branch). */
export function AccountScope({
  branchName,
  branchId,
}: {
  branchName?: string | null;
  branchId: string | null;
}) {
  const { t } = useTranslation();
  if (!branchId)
    return (
      <span className="inline-flex items-center gap-1 text-[13px] text-muted">
        <Building2 className="h-3.5 w-3.5" aria-hidden />
        {t('cash.accounts.companyLevel')}
      </span>
    );
  return <span className="text-[13px]">{branchName ?? '—'}</span>;
}

export function TransferStatusBadge({ status }: { status: CashTransfer['status'] }) {
  const { t } = useTranslation();
  return (
    <Badge tone={status === 'posted' ? 'success' : 'danger'}>
      {t(`cash.enums.transferStatus.${status}`)}
    </Badge>
  );
}

/** FX difference with sign and tone (gain positive, loss negative); nothing when zero. */
export function FxDifference({ value, currency }: { value: string; currency: string }) {
  const { t } = useTranslation();
  if (d(value).isZero()) return <span className="text-xs text-subtle">—</span>;
  const gain = d(value).gt(0);
  return (
    <span
      className={gain ? 'text-success' : 'text-danger'}
      title={gain ? t('cash.transfers.fxGain') : t('cash.transfers.fxLoss')}
    >
      <Money value={value} currency={currency} signed />
    </span>
  );
}

/** Transfers table used by the transfers page and the account detail page. */
export function TransfersTable({
  data,
  loading,
  error,
  onRetry,
  page,
  onPage,
  emptyAction,
}: {
  data: Paged<CashTransfer> | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  page: number;
  onPage: (p: number) => void;
  emptyAction?: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <DataTable
      rows={data?.items}
      loading={loading}
      error={error}
      onRetry={onRetry}
      rowKey={(r) => r.transferId}
      onRowClick={(r) => navigate(`/app/cash/transfers/${r.transferId}`)}
      empty={
        <EmptyState
          icon={<ArrowLeftRight className="h-5 w-5" />}
          title={t('cash.transfers.empty')}
          description={t('cash.transfers.emptyHint')}
          action={emptyAction}
        />
      }
      footer={data && <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={onPage} />}
      columns={[
        {
          key: 'date',
          header: t('common.date'),
          hideOnMobile: true,
          cell: (r) => <span className="num whitespace-nowrap">{fmtDate(r.businessDate)}</span>,
        },
        {
          key: 'route',
          header: t('cash.transfers.route'),
          cell: (r) => (
            <div className="min-w-0">
              <p className="truncate font-medium">{r.from.cashAccountName}</p>
              <p className="truncate text-xs text-muted">
                <span aria-hidden>↓ </span>
                {r.to.cashAccountName}
              </p>
              {/* Phones: date, amount and status live here (their columns are hidden or scrolled away). */}
              <p className="mt-1 flex flex-wrap items-center gap-2 md:hidden">
                <span className="num text-xs text-muted">{fmtDate(r.businessDate)}</span>
                <Money value={r.from.amount} currency={r.from.currency} className="text-xs font-semibold" />
                <TransferStatusBadge status={r.status} />
              </p>
            </div>
          ),
        },
        {
          key: 'sent',
          header: t('cash.transfers.amountSent'),
          align: 'end',
          cell: (r) => <Money value={r.from.amount} currency={r.from.currency} />,
        },
        {
          key: 'received',
          header: t('cash.transfers.amountReceived'),
          align: 'end',
          hideOnMobile: true,
          cell: (r) => <Money value={r.to.amount} currency={r.to.currency} />,
        },
        {
          key: 'base',
          header: t('cash.transfers.valueBase'),
          align: 'end',
          hideOnMobile: true,
          cell: (r) => <Money value={r.amountBase} currency={r.baseCurrency} />,
        },
        {
          key: 'fx',
          header: t('cash.transfers.fxDifference'),
          align: 'end',
          hideOnMobile: true,
          cell: (r) => <FxDifference value={r.fxDifference} currency={r.baseCurrency} />,
        },
        {
          key: 'status',
          header: t('common.status'),
          hideOnMobile: true,
          cell: (r) => <TransferStatusBadge status={r.status} />,
        },
        {
          key: 'ref',
          header: t('common.reference'),
          hideOnMobile: true,
          cell: (r) => <span className="text-[13px] whitespace-nowrap text-muted">{r.reference ?? '—'}</span>,
        },
      ]}
    />
  );
}
