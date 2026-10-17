import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { fmtDate } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import type { InstallmentPlanListItem, Paged, PlanStatus } from '@/features/sales/api';
import { Money, PlanStatusBadge } from '@/features/sales/shared';

const PLAN_STATUSES: PlanStatus[] = ['scheduled', 'active', 'settled', 'completed', 'cancelled'];

export function InstallmentsListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lp = useListParams();
  const pageSize = 25;
  const q = useApi<Paged<InstallmentPlanListItem>>(
    ['installment-plans'],
    '/installment-plans',
    { page: lp.page, pageSize, status: lp.get('status') || undefined, overdue: lp.get('overdue') === 'true' ? 'true' : undefined },
    { placeholderData: (p) => p },
  );
  const filtered = !!lp.get('status') || !!lp.get('overdue');

  return (
    <>
      <PageHeader title={t('installments.title')} subtitle={t('installments.subtitle')} />
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Select className="w-auto min-w-[200px]" value={lp.get('status')} onChange={(e) => lp.set({ status: e.target.value })} aria-label={t('common.status')}>
            <option value="">
              {t('common.status')}: {t('common.all')}
            </option>
            {PLAN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`installments.planStatus.${s}`)}
              </option>
            ))}
          </Select>
          <Checkbox label={t('installments.list.overdueOnly')} checked={lp.get('overdue') === 'true'} onChange={(e) => lp.set({ overdue: e.target.checked ? 'true' : null })} />
        </div>
      </Card>
      <Card>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/app/installments/${p.id}`)}
          empty={
            <EmptyState
              icon={<CalendarClock className="h-5 w-5" />}
              title={filtered ? t('common.noResults') : t('installments.list.empty')}
              description={filtered ? undefined : t('installments.list.emptyHint')}
            />
          }
          columns={[
            {
              key: 'sale',
              header: t('installments.fields.sale'),
              cell: (p) => (
                <div>
                  <p className="num font-medium">{p.saleNumber}</p>
                  <p className="text-xs text-muted">{fmtDate(p.firstDueDate)}</p>
                </div>
              ),
            },
            { key: 'customer', header: t('installments.fields.customer'), cell: (p) => <span className="block max-w-[200px] truncate">{p.customerName}</span> },
            {
              key: 'terms',
              header: t('installments.fields.terms'),
              hideOnMobile: true,
              cell: (p) => (
                <div className="text-[13px]">
                  <p>{t(`sales.instMethod.${p.method}`)}</p>
                  <p className="text-xs text-muted">
                    {t('installments.fields.countEvery', { n: p.count, every: t(`sales.frequency.m${p.frequencyMonths}`) })}
                  </p>
                </div>
              ),
            },
            { key: 'total', header: t('installments.fields.total'), align: 'end', cell: (p) => <Money value={p.totalAmount} className="font-medium" /> },
            {
              key: 'overdue',
              header: t('installments.fields.overdue'),
              align: 'end',
              cell: (p) => <Money value={p.overdueAmount} className={d(p.overdueAmount).gt(0) ? 'font-medium text-danger' : 'text-muted'} />,
            },
            { key: 'status', header: t('common.status'), cell: (p) => <PlanStatusBadge status={p.status} /> },
            {
              key: 'open',
              header: <span className="sr-only">{t('common.view')}</span>,
              className: 'relative',
              align: 'end',
              cell: (p) => (
                <Link to={`/app/installments/${p.id}`} onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-brand-strong hover:underline">
                  {t('common.view')}
                </Link>
              ),
            },
          ]}
          footer={q.data && <Pagination page={lp.page} pageSize={pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
    </>
  );
}
