import { Heart, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { WISH_STATUSES } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Checkbox } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney, fmtPhone } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { Paged, useCustomerBrief, WishListItem, WishStatus } from './api';
import { CriteriaChips, WishStatusBadge } from './components';

type StatusTab = WishStatus | 'all';

export function WishesListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { currency, can } = useAuth();
  const lp = useListParams({ status: 'active' });
  const status = (lp.get('status') || 'active') as StatusTab;
  const customerId = lp.get('customerId');
  const mine = lp.get('mine') === 'true';
  const customer = useCustomerBrief(customerId || null);
  const q = useApi<Paged<WishListItem>>(
    ['wishes', 'list'],
    '/wishes',
    {
      page: lp.page,
      pageSize: 25,
      status: status === 'all' ? undefined : status,
      mine: mine ? 'true' : undefined,
      customerId: customerId || undefined,
    },
    { placeholderData: (p) => p },
  );
  const en = i18n.language === 'en';
  const newPath = customerId ? `/app/wishes/new?customerId=${customerId}` : '/app/wishes/new';

  return (
    <>
      <PageHeader
        title={t('wishes.title')}
        subtitle={t('wishes.subtitle')}
        actions={
          <Can perm="customers.manage">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate(newPath)}>
              {t('wishes.add')}
            </Button>
          </Can>
        }
      />
      <Card>
        <div className="px-4 pt-2">
          <Tabs<StatusTab>
            value={status}
            onChange={(k) => lp.set({ status: k })}
            tabs={[...WISH_STATUSES, 'all' as const].map((s) => ({ key: s, label: t(`wishes.statuses.${s}`) }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Checkbox label={t('wishes.mine')} checked={mine} onChange={(e) => lp.set({ mine: e.target.checked ? 'true' : null })} />
          {customerId && (
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2 py-1 ps-3 pe-1 text-[13px]">
              <span className="text-muted">{t('wishes.searchCustomerFilter')}:</span>
              <span className="truncate font-medium text-ink">{customer.data?.customer.fullName ?? '…'}</span>
              <button
                type="button"
                onClick={() => lp.set({ customerId: null })}
                aria-label={t('wishes.clearCustomer')}
                title={t('wishes.clearCustomer')}
                className="rounded-full p-1 text-muted hover:bg-surface-3 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
        </div>
        <div className="border-t border-line">
          <DataTable
            rows={q.data?.items}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => q.refetch()}
            rowKey={(w) => w.id}
            onRowClick={(w) => navigate(`/app/wishes/${w.id}`)}
            empty={
              <EmptyState
                icon={<Heart className="h-5 w-5" />}
                title={t('wishes.empty')}
                description={t('wishes.emptyHint')}
                action={
                  can('customers.manage') && (
                    <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate(newPath)}>
                      {t('wishes.add')}
                    </Button>
                  )
                }
              />
            }
            columns={[
              {
                key: 'customer',
                header: t('wishes.columns.customer'),
                cell: (w) => (
                  <div className="min-w-0">
                    <Link to={`/app/wishes/${w.id}`} onClick={(e) => e.stopPropagation()} className="block max-w-[220px] truncate font-medium text-ink hover:text-brand-strong hover:underline">
                      {w.customerName}
                    </Link>
                    {w.customerPhone && (
                      <span dir="ltr" className="num block text-xs text-muted">
                        {fmtPhone(w.customerPhone)}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                key: 'criteria',
                header: t('wishes.columns.criteria'),
                cell: (w) => (
                  <CriteriaChips
                    className="max-w-[360px]"
                    wish={w}
                    names={{ make: en ? w.makeEn : w.makeAr, model: en ? w.modelEn : w.modelAr }}
                  />
                ),
              },
              {
                key: 'maxPrice',
                header: t('wishes.columns.maxPrice'),
                align: 'end',
                hideOnMobile: true,
                cell: (w) => <span className="num whitespace-nowrap">{w.maxPrice ? fmtMoney(w.maxPrice, currency) : '—'}</span>,
              },
              {
                key: 'matches',
                header: t('wishes.columns.matches'),
                align: 'center',
                cell: (w) =>
                  w.openMatches > 0 ? (
                    <Badge tone="success">
                      <span className="num">{w.openMatches}</span>
                    </Badge>
                  ) : (
                    <span className="num text-subtle">0</span>
                  ),
              },
              { key: 'status', header: t('common.status'), cell: (w) => <WishStatusBadge status={w.status} /> },
              { key: 'expires', header: t('wishes.columns.expiresAt'), hideOnMobile: true, cell: (w) => <span className="whitespace-nowrap">{fmtDate(w.expiresAt)}</span> },
              { key: 'created', header: t('wishes.columns.createdAt'), hideOnMobile: true, cell: (w) => <span className="whitespace-nowrap text-muted">{fmtDate(w.createdAt)}</span> },
            ]}
            footer={q.data && <Pagination page={lp.page} pageSize={25} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
          />
        </div>
      </Card>
    </>
  );
}
