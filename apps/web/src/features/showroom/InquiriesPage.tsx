import { Inbox, Mail, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import type { InquiryRow, Paged } from './api';
import { unlinkedReasonText } from './components';

type Filter = '' | 'true' | 'false';

const useCount = (unlinked: Filter) =>
  useApi<Paged<InquiryRow>>(['showroom', 'inquiries', 'count', unlinked], '/showroom/inquiries', { unlinked: unlinked || undefined, pageSize: 1 });

/**
 * /app/showroom/inquiries — online inquiries and test-drive requests (leads.assign). Inquiries the
 * API could not link to a lead are flagged for triage with the reason in plain language.
 */
export function InquiriesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const lp = useListParams();
  const pageSize = 25;
  const unlinked = lp.get('unlinked') as Filter;
  const q = useApi<Paged<InquiryRow>>(['showroom', 'inquiries', 'list'], '/showroom/inquiries', { page: lp.page, pageSize, unlinked: unlinked || undefined }, { placeholderData: (p) => p });
  const all = useCount('');
  const open = useCount('true');
  const linked = useCount('false');

  return (
    <>
      <PageHeader
        breadcrumbs={can('showroom.manage') ? [{ label: t('showroom.nav.listings'), to: '/app/showroom' }, { label: t('showroom.inquiries.title') }] : undefined}
        title={t('showroom.inquiries.title')}
        subtitle={t('showroom.inquiries.subtitle')}
      />
      <Card>
        <div className="px-4 pt-2">
          <Tabs<Filter>
            value={unlinked}
            onChange={(v) => lp.set({ unlinked: v })}
            tabs={[
              { key: '', label: t('showroom.inquiries.tabAll'), count: all.data?.total },
              { key: 'true', label: t('showroom.inquiries.tabUnlinked'), count: open.data?.total },
              { key: 'false', label: t('showroom.inquiries.tabLinked'), count: linked.data?.total },
            ]}
          />
        </div>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(r) => r.id}
          empty={
            <EmptyState
              icon={<Inbox className="h-5 w-5" />}
              title={unlinked ? t('common.noResults') : t('showroom.inquiries.empty')}
              description={unlinked ? undefined : t('showroom.inquiries.emptyHint')}
            />
          }
          columns={[
            {
              key: 'received',
              header: t('showroom.inquiries.received'),
              cell: (r) => <span className="text-[13px] whitespace-nowrap">{fmtDateTime(r.createdAt)}</span>,
            },
            {
              key: 'kind',
              header: t('showroom.inquiries.kind'),
              cell: (r) => (
                <div>
                  <Badge tone={r.kind === 'test_drive' ? 'accent' : 'info'}>{t(`showroom.inquiries.kinds.${r.kind}`)}</Badge>
                  {r.preferredDate && <p className="mt-1 text-xs whitespace-nowrap text-muted">{t('showroom.inquiries.preferredDate', { date: fmtDate(r.preferredDate) })}</p>}
                </div>
              ),
            },
            {
              key: 'contact',
              header: t('showroom.inquiries.contact'),
              cell: (r) => (
                <div className="min-w-0 space-y-0.5">
                  <p className="max-w-[200px] truncate font-medium">{r.name}</p>
                  <a href={`tel:${r.phone}`} dir="ltr" className="num inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
                    <Phone className="h-3 w-3" aria-hidden />
                    {r.phone}
                  </a>
                  {r.email && (
                    <a href={`mailto:${r.email}`} dir="ltr" className="flex max-w-[200px] items-center gap-1 truncate text-xs text-muted hover:text-ink">
                      <Mail className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">{r.email}</span>
                    </a>
                  )}
                </div>
              ),
            },
            {
              key: 'vehicle',
              header: t('showroom.inquiries.vehicle'),
              cell: (r) =>
                r.vehicleId && r.stockNumber ? (
                  <Link to={`/app/vehicles/${r.vehicleId}`} className="num text-[13px] font-medium whitespace-nowrap text-brand-strong hover:underline">
                    {r.stockNumber}
                  </Link>
                ) : (
                  <span className="text-[13px] text-muted">{t('showroom.inquiries.general')}</span>
                ),
            },
            {
              key: 'message',
              header: t('showroom.inquiries.message'),
              hideOnMobile: true,
              cell: (r) => <p className="line-clamp-3 max-w-[280px] text-[13px] break-words whitespace-pre-line">{r.message ?? '—'}</p>,
            },
            {
              key: 'outcome',
              header: t('showroom.inquiries.outcome'),
              cell: (r) => (
                <div className="max-w-[300px] space-y-1 text-[13px]">
                  {!r.leadId && <Badge tone="warning">{t('showroom.inquiries.needsReview')}</Badge>}
                  {r.leadId && !r.unlinkedReason && <p className="text-xs text-muted">{t('showroom.inquiries.linked')}</p>}
                  {r.unlinkedReason && <p className="text-xs text-muted">{unlinkedReasonText(r.unlinkedReason, t)}</p>}
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {r.leadId && can('leads.read') && (
                      <Link to={`/app/leads/${r.leadId}`} className="font-medium text-brand-strong hover:underline">
                        {t('showroom.inquiries.openLead')}
                      </Link>
                    )}
                    {r.customerId && can('customers.read') && (
                      <Link to={`/app/customers/${r.customerId}`} className="font-medium text-brand-strong hover:underline">
                        {t('showroom.inquiries.openCustomer')}
                      </Link>
                    )}
                    {!r.leadId && !r.customerId && can('customers.read') && (
                      <Link to={`/app/customers?q=${encodeURIComponent(r.phone)}`} className="font-medium text-brand-strong hover:underline">
                        {t('showroom.inquiries.findCustomer')}
                      </Link>
                    )}
                  </div>
                </div>
              ),
            },
          ]}
          footer={q.data && <Pagination page={lp.page} pageSize={pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
    </>
  );
}
