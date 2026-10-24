import { CarFront, ExternalLink, Inbox, Settings2, Store } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { VehicleStatusBadge } from '@/features/vehicles/components';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import type { ListingRow, Paged } from './api';
import { DescriptionSourceBadge, listingTitle, PublishedBadge, VisibilityBadge } from './components';

type Filter = '' | 'true' | 'false';

/** /app/showroom — every vehicle listing, with the published filter (showroom.manage). */
export function ListingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { me } = useAuth();
  const lp = useListParams();
  const pageSize = 25;
  const published = lp.get('published') as Filter;
  const q = useApi<Paged<ListingRow>>(['showroom', 'listings'], '/showroom/listings', { page: lp.page, pageSize, published: published || undefined }, { placeholderData: (p) => p });
  const enabled = !!me?.tenant?.settings.showroom.enabled;
  const slug = me?.tenant?.slug;
  const open = (r: ListingRow) => navigate(`/app/showroom/vehicles/${r.vehicleId}`);

  return (
    <>
      <PageHeader
        title={t('showroom.listings.title')}
        subtitle={t('showroom.listings.subtitle')}
        actions={
          <>
            {enabled && slug && (
              <a
                href={`/showroom/${encodeURIComponent(slug)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-ink hover:bg-surface-3"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                {t('showroom.listings.openPublic')}
              </a>
            )}
            <Can perm="leads.assign">
              <Button variant="secondary" icon={<Inbox className="h-4 w-4" />} onClick={() => navigate('/app/showroom/inquiries')}>
                {t('showroom.listings.inquiries')}
              </Button>
            </Can>
            <Can perm="settings.manage">
              <Button variant="secondary" icon={<Settings2 className="h-4 w-4" />} onClick={() => navigate('/app/settings/company')}>
                {t('showroom.listings.settings')}
              </Button>
            </Can>
          </>
        }
      />
      {!enabled && (
        <Alert tone="warning" className="mb-4">
          {t('showroom.listings.disabled')}
        </Alert>
      )}
      <Card>
        <div className="px-4 pt-2">
          <Tabs<Filter>
            value={published}
            onChange={(v) => lp.set({ published: v })}
            tabs={[
              { key: '', label: t('showroom.listings.filterAll') },
              { key: 'true', label: t('showroom.listings.filterPublished') },
              { key: 'false', label: t('showroom.listings.filterUnpublished') },
            ]}
          />
        </div>
        <DataTable
          rows={q.data?.items}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(r) => r.id}
          onRowClick={open}
          empty={
            <EmptyState
              icon={<Store className="h-5 w-5" />}
              title={published ? t('common.noResults') : t('showroom.listings.empty')}
              description={published ? undefined : t('showroom.listings.emptyHint')}
              action={
                !published && (
                  <Button variant="secondary" icon={<CarFront className="h-4 w-4" />} onClick={() => navigate('/app/vehicles')}>
                    {t('showroom.listings.goVehicles')}
                  </Button>
                )
              }
            />
          }
          columns={[
            {
              key: 'vehicle',
              header: t('showroom.listings.vehicle'),
              cell: (r) => (
                <div className="min-w-0">
                  <Link
                    to={`/app/showroom/vehicles/${r.vehicleId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="block max-w-[280px] truncate font-medium text-ink hover:text-brand-strong hover:underline"
                  >
                    {listingTitle(r, i18n.language, r.stockNumber)}
                  </Link>
                  <Link to={`/app/vehicles/${r.vehicleId}`} onClick={(e) => e.stopPropagation()} className="num text-xs text-muted hover:underline">
                    {r.stockNumber}
                  </Link>
                </div>
              ),
            },
            { key: 'status', header: t('showroom.listings.status'), cell: (r) => <VehicleStatusBadge status={r.vehicleStatus} /> },
            {
              key: 'listing',
              header: t('showroom.listings.listing'),
              cell: (r) => (
                <div className="flex flex-wrap gap-1.5">
                  <PublishedBadge published={r.isPublished} />
                  {r.isPublished && <VisibilityBadge visible={r.publiclyVisible} />}
                </div>
              ),
            },
            { key: 'source', header: t('showroom.descriptionSource.label'), hideOnMobile: true, cell: (r) => (r.descriptionSource ? <DescriptionSourceBadge source={r.descriptionSource} /> : <span className="text-xs text-muted">{t('showroom.descriptionSource.none')}</span>) },
            {
              key: 'photos',
              header: t('showroom.listings.photos'),
              align: 'end',
              hideOnMobile: true,
              cell: (r) => <span className={r.publicPhotos < 3 ? 'num text-warning' : 'num'}>{r.publicPhotos}</span>,
            },
            {
              key: 'publishedAt',
              header: t('showroom.listings.publishedAt'),
              hideOnMobile: true,
              cell: (r) => <span className="whitespace-nowrap">{r.isPublished && r.publishedAt ? fmtDate(r.publishedAt) : '—'}</span>,
            },
          ]}
          footer={q.data && <Pagination page={lp.page} pageSize={pageSize} total={q.data.total} onPage={(p) => lp.set({ page: p }, false)} />}
        />
      </Card>
    </>
  );
}
