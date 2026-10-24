import clsx from 'clsx';
import { AlertTriangle, CircleDollarSign, Hourglass, Store } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, StatCard } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState, ErrorState } from '@/components/ui/Feedback';
import { Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { vehicleTitle, VehicleStatusBadge } from '@/features/vehicles/components';
import { Can, useAuth } from '@/lib/auth';
import { fmtMoney, fmtNumber } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import type { AgingActionCode, AgingRecommendations } from './api';

const CODES: AgingActionCode[] = ['critical_age', 'set_price', 'publish_listing', 'add_photos', 'review_price'];
type Item = AgingRecommendations['items'][number];
type Action = Item['actions'][number];

/** /app/inventory/aging — rule-based advice for stale stock (vehicles.read + pricing.update, D-037). */
export function AgingPage() {
  const { t, i18n } = useTranslation();
  const { can, currency } = useAuth();
  const lp = useListParams();
  const allowed = can('vehicles.read', 'pricing.update');
  const q = useApi<AgingRecommendations>(['showroom', 'aging'], allowed ? '/inventory/aging-recommendations' : null);
  const filter = lp.get('action');
  const items = useMemo(() => (q.data?.items ?? []).filter((i) => !filter || i.actions.some((a) => a.code === filter)), [q.data, filter]);
  const count = (code: string) => (q.data?.items ?? []).filter((i) => i.actions.some((a) => a.code === code)).length;

  if (!allowed) return <EmptyState title={t('errors.forbidden')} />;

  const describe = (a: Action): string => {
    const det = a.detail ?? {};
    switch (a.code) {
      case 'critical_age':
        return t('showroom.aging.actions.critical_age', { days: fmtNumber(det.days as number), threshold: fmtNumber(det.threshold as number) });
      case 'add_photos':
        return t('showroom.aging.actions.add_photos', { count: Number(det.publicPhotos ?? 0) });
      case 'review_price':
        return t('showroom.aging.actions.review_price', {
          asking: fmtMoney(String(det.askingPrice), currency),
          median: fmtMoney(String(det.medianAgreedPrice), currency),
          count: Number(det.comparableCount ?? 0),
        });
      case 'set_price':
      case 'publish_listing':
        return t(`showroom.aging.actions.${a.code}`);
      default:
        return t('showroom.aging.actions.unknown', { code: a.code });
    }
  };
  /** Where each recommendation is acted on. The Vehicle 360 page holds pricing, photos and the listing tab. */
  const target = (a: Action, i: Item): { to: string; label: string } | null => {
    if (!CODES.includes(a.code as AgingActionCode)) return null;
    if (a.code === 'publish_listing' || a.code === 'review_price') return { to: `/app/showroom/vehicles/${i.vehicleId}`, label: t(`showroom.aging.go.${a.code}`) };
    return { to: `/app/vehicles/${i.vehicleId}`, label: t(`showroom.aging.go.${a.code}`) };
  };

  return (
    <>
      <PageHeader title={t('showroom.aging.title')} subtitle={t('showroom.aging.subtitle')} />
      {q.error ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <>
          {q.data && (
            <p className="mb-4 text-[13px] text-muted">
              {t('showroom.aging.thresholds', { warning: q.data.staleDaysWarning, critical: q.data.staleDaysCritical })}{' '}
              <Can perm="settings.manage">
                <Link to="/app/settings/company" className="font-medium text-brand-strong hover:underline">
                  {t('showroom.aging.changeThresholds')}
                </Link>
              </Can>
            </p>
          )}
          <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t('showroom.aging.vehicles')} value={fmtNumber(q.data?.items.length ?? 0)} icon={<Hourglass className="h-5 w-5" />} tone="warning" onClick={() => lp.set({ action: null })} />
            <StatCard label={t('showroom.aging.critical')} value={fmtNumber(count('critical_age'))} icon={<AlertTriangle className="h-5 w-5" />} tone="danger" onClick={() => lp.set({ action: 'critical_age' })} />
            <StatCard label={t('showroom.aging.noPrice')} value={fmtNumber(count('set_price'))} icon={<CircleDollarSign className="h-5 w-5" />} tone="info" onClick={() => lp.set({ action: 'set_price' })} />
            <StatCard label={t('showroom.aging.notPublished')} value={fmtNumber(count('publish_listing'))} icon={<Store className="h-5 w-5" />} tone="brand" onClick={() => lp.set({ action: 'publish_listing' })} />
          </div>
          <Card>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              <Select value={filter} onChange={(e) => lp.set({ action: e.target.value })} aria-label={t('showroom.aging.filterAction')} className="w-full sm:w-72">
                <option value="">
                  {t('showroom.aging.filterAction')}: {t('showroom.aging.allActions')}
                </option>
                {CODES.map((c) => (
                  <option key={c} value={c}>
                    {t(`showroom.aging.go.${c}`)} ({count(c)})
                  </option>
                ))}
              </Select>
            </div>
            <DataTable
              rows={q.data ? items : undefined}
              loading={q.isLoading}
              rowKey={(i) => i.vehicleId}
              empty={
                <EmptyState
                  icon={<Hourglass className="h-5 w-5" />}
                  title={filter ? t('common.noResults') : t('showroom.aging.empty')}
                  description={filter ? undefined : t('showroom.aging.emptyHint', { warning: q.data?.staleDaysWarning ?? '' })}
                />
              }
              columns={[
                {
                  key: 'vehicle',
                  header: t('showroom.aging.stock'),
                  cell: (i) => (
                    <div className="max-w-[260px] space-y-1">
                      <Link to={`/app/vehicles/${i.vehicleId}`} className="block font-medium text-brand-strong hover:underline">
                        {vehicleTitle({ modelYear: i.modelYear, makeNameEn: i.makeEn, makeNameAr: i.makeAr, modelNameEn: i.modelEn, modelNameAr: i.modelAr, trim: i.trim }, i18n.language)}
                      </Link>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="num text-xs text-muted">{i.stockNumber}</span>
                        <VehicleStatusBadge status={i.status} />
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'days',
                  header: t('showroom.aging.days'),
                  cell: (i) => (
                    <span className={clsx('num font-semibold whitespace-nowrap', q.data && i.daysInStock >= q.data.staleDaysCritical ? 'text-danger' : 'text-warning')}>
                      {t('showroom.aging.daysValue', { count: i.daysInStock })}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: t('showroom.aging.recommendations'),
                  cell: (i) =>
                    i.actions.length === 0 ? (
                      <span className="text-[13px] text-muted">{t('showroom.aging.none')}</span>
                    ) : (
                      <ul className="space-y-1.5">
                        {i.actions.map((a) => {
                          const go = target(a, i);
                          return (
                            <li key={a.code} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                              <span className={clsx('h-1.5 w-1.5 shrink-0 translate-y-[-2px] rounded-full', a.code === 'critical_age' ? 'bg-danger' : 'bg-warning')} aria-hidden />
                              <span className="min-w-0">{describe(a)}</span>
                              {go && (
                                <Link to={go.to} className="text-xs font-medium whitespace-nowrap text-brand-strong hover:underline">
                                  {go.label}
                                </Link>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}
