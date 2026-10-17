import { BadgePercent, CheckCircle2, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { COMMISSION_STATUSES } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, StatCard } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtNumber } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import type { CashAccountOption, CommissionList, CommissionListItem, PaymentMethod } from '@/features/sales/api';
import { useCashAccountOptions } from '@/features/sales/api';
import {
  CashAccountSelect,
  commissionRuleText,
  CommissionStatusBadge,
  FailureAlert,
  MethodSelect,
  Money,
  useIdempotencyKey,
  useSalesMutation,
  useTenantMoney,
} from '@/features/sales/shared';

export function CommissionsPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const lp = useListParams();
  const readAll = can('commissions.read');
  const pageSize = 25;
  const saleId = lp.get('saleId');
  const q = useApi<CommissionList>(
    ['commissions'],
    '/commissions',
    {
      page: lp.page,
      pageSize,
      status: lp.get('status') || undefined,
      mine: readAll && lp.get('mine') === 'true' ? 'true' : undefined,
      saleId: saleId || undefined,
    },
    { placeholderData: (p) => p },
  );
  const [approving, setApproving] = useState<CommissionListItem | null>(null);
  const [paying, setPaying] = useState<CommissionListItem | null>(null);
  const filtered = ['status', 'mine', 'saleId'].some((k) => lp.get(k));

  return (
    <>
      <PageHeader title={t('commissions.title')} subtitle={readAll ? t('commissions.subtitleAll') : t('commissions.subtitleOwn')} />

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <StatCard label={t('commissions.totalAmount')} value={q.data ? <Money value={q.data.totalAmount} /> : '—'} icon={<BadgePercent className="h-5 w-5" />} tone="brand" />
        <StatCard label={t('commissions.count')} value={q.data ? fmtNumber(q.data.total) : '—'} hint={t('commissions.totalsHint')} />
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Select className="w-auto min-w-[200px]" value={lp.get('status')} onChange={(e) => lp.set({ status: e.target.value })} aria-label={t('common.status')}>
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            {COMMISSION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`commissions.status.${s}`)}
              </option>
            ))}
          </Select>
          {readAll && <Checkbox label={t('commissions.mine')} checked={lp.get('mine') === 'true'} onChange={(e) => lp.set({ mine: e.target.checked ? 'true' : null })} />}
          {saleId && (
            <span className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs">
              {t('commissions.filteredBySale')}
              <button type="button" className="rounded p-0.5 text-subtle hover:text-ink" aria-label={t('common.clearFilters')} onClick={() => lp.set({ saleId: null })}>
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
        </div>
      </Card>

      <Card>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(c) => c.id}
          empty={
            <EmptyState
              icon={<BadgePercent className="h-5 w-5" />}
              title={filtered ? t('common.noResults') : t('commissions.empty')}
              description={filtered ? undefined : t('commissions.emptyHint')}
            />
          }
          columns={[
            {
              key: 'sale',
              header: t('commissions.fields.sale'),
              cell: (c) => (
                <div>
                  {can('sales.read') ? (
                    <Link to={`/app/sales/${c.saleId}`} className="num font-medium text-brand-strong hover:underline">
                      {c.saleNumber}
                    </Link>
                  ) : (
                    <span className="num font-medium">{c.saleNumber}</span>
                  )}
                  <p className="text-xs text-muted">{fmtDate(c.saleDate)}</p>
                </div>
              ),
            },
            {
              key: 'employee',
              header: t('commissions.fields.employee'),
              cell: (c) => (
                <span className="block max-w-[180px] truncate">
                  {c.employeeName ?? '—'}
                  {c.userId === me?.user.id && <span className="ms-1 text-xs text-muted">({t('sales.form.you')})</span>}
                </span>
              ),
            },
            {
              key: 'base',
              header: t('commissions.fields.base'),
              align: 'end',
              hideOnMobile: true,
              cell: (c) => <Money value={c.baseAmount} className="text-muted" />,
            },
            {
              key: 'amount',
              header: t('commissions.fields.amount'),
              align: 'end',
              cell: (c) => (
                <Money value={c.amount} className="font-semibold" />
              ),
            },
            {
              key: 'rule',
              header: t('commissions.fields.earnOn'),
              hideOnMobile: true,
              cell: (c) => (
                <div className="max-w-[220px] text-[13px]">
                  <p>{t(`commissions.earnOn.${c.earnOn}`)}</p>
                  <p className="line-clamp-1 text-xs text-muted" title={c.explanation ?? undefined}>
                    {commissionRuleText(c.ruleSnapshot, t) ?? c.explanation}
                  </p>
                </div>
              ),
            },
            {
              key: 'status',
              header: t('common.status'),
              cell: (c) => (
                <div>
                  <CommissionStatusBadge status={c.status} />
                  {c.reverseReason && <p className="mt-0.5 line-clamp-1 max-w-[180px] text-xs text-muted">{c.reverseReason}</p>}
                </div>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">{t('common.actions')}</span>,
              className: 'relative',
              align: 'end',
              cell: (c) => (
                <span className="inline-flex gap-1">
                  {c.status === 'earned' && can('commissions.approve') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<CheckCircle2 className="h-4 w-4" />}
                      disabled={c.userId === me?.user.id}
                      title={c.userId === me?.user.id ? t('commissions.ownHint') : undefined}
                      onClick={() => setApproving(c)}
                    >
                      {t('common.approve')}
                    </Button>
                  )}
                  {c.status === 'approved' && can('commissions.pay') && (
                    <Button size="sm" icon={<Wallet className="h-4 w-4" />} onClick={() => setPaying(c)}>
                      {t('commissions.pay')}
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
          footer={q.data && <Pagination page={lp.page} pageSize={pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>

      {approving && <ApproveModal c={approving} onClose={() => setApproving(null)} />}
      {paying && <PayModal c={paying} onClose={() => setPaying(null)} />}
    </>
  );
}

function ApproveModal({ c, onClose }: { c: CommissionListItem; onClose: () => void }) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<unknown>(null);
  const approve = useSalesMutation({
    path: `/commissions/${c.id}/approve`,
    toastError: false,
    invalidate: [['commissions'], ['sale', c.saleId]],
    success: t('commissions.approved'),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('commissions.approveTitle', { number: c.saleNumber })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="success"
            loading={approve.isPending}
            onClick={() => {
              setFailure(null);
              approve.mutate({}, { onError: setFailure });
            }}
          >
            {t('common.approve')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {failure !== null && <FailureAlert error={failure} onReload={onClose} />}
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2/60 px-4 py-3">
          <span className="text-muted">{c.employeeName}</span>
          <Money value={c.amount} className="font-semibold" />
        </div>
        <p className="text-muted">{commissionRuleText(c.ruleSnapshot, t) ?? c.explanation}</p>
        <p className="text-xs text-muted">{t('commissions.approveHint')}</p>
      </div>
    </Modal>
  );
}

function PayModal({ c, onClose }: { c: CommissionListItem; onClose: () => void }) {
  const { t } = useTranslation();
  const { base, today } = useTenantMoney();
  const accounts = useCashAccountOptions();
  const [idemKey] = useIdempotencyKey();
  const [account, setAccount] = useState<CashAccountOption | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(today);
  const [failure, setFailure] = useState<unknown>(null);
  const pay = useSalesMutation<Record<string, unknown>>({
    path: `/commissions/${c.id}/pay`,
    idempotent: true,
    toastError: false,
    invalidate: [['commissions'], ['sale', c.saleId], ['cash-accounts']],
    success: t('commissions.paid'),
    onSuccess: onClose,
  });
  const baseAccounts = (accounts.data ?? []).filter((a) => a.currency === base);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('commissions.payTitle', { number: c.saleNumber })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={pay.isPending}
            disabled={!account}
            onClick={() => {
              setFailure(null);
              pay.mutate({ cashAccountId: account!.id, method, reference: reference.trim() || null, paidAt, __idemKey: idemKey }, { onError: setFailure });
            }}
          >
            {t('commissions.pay')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {failure !== null && (
          <div className="sm:col-span-2">
            <FailureAlert error={failure} onReload={onClose} />
          </div>
        )}
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm sm:col-span-2">
          <span className="text-muted">{c.employeeName}</span>
          <Money value={c.amount} className="text-base font-semibold" />
        </div>
        <Field label={t('sales.payment.account')} required hint={t('commissions.baseOnly', { currency: base })} className="sm:col-span-2">
          {(id, desc) => <CashAccountSelect id={id} describedBy={desc} value={account?.id ?? ''} accounts={accounts.data} baseOnly onChange={setAccount} />}
        </Field>
        {accounts.data && baseAccounts.length === 0 && (
          <Alert tone="warning" className="sm:col-span-2">
            {t('installments.settle.noBaseAccount', { currency: base })}
          </Alert>
        )}
        <Field label={t('sales.payment.method')}>{(id) => <MethodSelect id={id} value={method} onChange={setMethod} />}</Field>
        <Field label={t('commissions.paidAt')}>{(id) => <Input id={id} type="date" value={paidAt} max={today} onChange={(e) => setPaidAt(e.target.value)} />}</Field>
        <Field label={t('common.reference')} className="sm:col-span-2">
          {(id) => <Input id={id} maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
