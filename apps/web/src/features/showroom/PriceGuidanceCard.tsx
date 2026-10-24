import clsx from 'clsx';
import { LineChart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { d } from '@autohub/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney, fmtNumber, fmtPct } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { PriceGuidance } from './api';

/**
 * Price guidance for one vehicle (GET /vehicles/:id/price-guidance, vehicles.read + pricing.update).
 * Always presented as an estimate from the company's own recognised sales (D-037).
 */
export function PriceGuidanceCard({ vehicleId }: { vehicleId: string }) {
  const { t } = useTranslation();
  const { currency, can } = useAuth();
  const q = useApi<PriceGuidance>(['showroom', 'price-guidance', vehicleId], `/vehicles/${vehicleId}/price-guidance`);
  const g = q.data;
  const pct = g?.askingVsMedianPct ? d(g.askingVsMedianPct) : null;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <LineChart className="h-4 w-4 text-muted" aria-hidden />
            {t('showroom.guidance.title')}
          </span>
        }
        subtitle={t('showroom.guidance.subtitle')}
      />
      <CardBody className="space-y-4">
        {q.isLoading && <Skeleton className="h-24 w-full" />}
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null}
        {g && !g.sufficient && (
          <Alert tone="info" title={t('showroom.guidance.insufficient')}>
            {t('showroom.guidance.insufficientDetail', { count: g.comparableCount })}
          </Alert>
        )}
        {g?.sufficient && g.agreedPrice && (
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl bg-surface-2 p-3 sm:col-span-2">
                <dt className="text-xs text-muted">{t('showroom.guidance.median')}</dt>
                <dd className="num mt-0.5 text-xl font-semibold">{fmtMoney(g.agreedPrice.median, currency)}</dd>
                <dd className="mt-0.5 text-xs text-muted">
                  {t('showroom.guidance.range')}:{' '}
                  <span className="num">
                    {t('showroom.guidance.rangeValue', { min: fmtMoney(g.agreedPrice.min, currency), max: fmtMoney(g.agreedPrice.max, currency) })}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">{t('showroom.guidance.asking')}</dt>
                <dd className="num mt-0.5 font-medium">{g.askingPrice ? fmtMoney(g.askingPrice, currency) : t('showroom.guidance.noAsking')}</dd>
                {pct && (
                  <dd className={clsx('mt-0.5 text-xs font-medium', pct.gt(5) ? 'text-warning' : pct.lt(-5) ? 'text-info' : 'text-muted')}>
                    {pct.isZero()
                      ? t('showroom.guidance.vsMedianEqual')
                      : t(pct.gt(0) ? 'showroom.guidance.vsMedianAbove' : 'showroom.guidance.vsMedianBelow', { pct: `\u2066${fmtPct(pct.abs().toFixed(1))}\u2069` })}
                  </dd>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-xs text-muted">{t('showroom.guidance.comparables')}</dt>
                  <dd className="num mt-0.5 font-medium">{fmtNumber(g.comparableCount)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">{t('showroom.guidance.avgDays')}</dt>
                  <dd className="num mt-0.5 font-medium">{g.averageDaysToSell === null ? '—' : t('showroom.guidance.days', { count: g.averageDaysToSell })}</dd>
                </div>
              </div>
            </dl>
            {g.comparables.length > 0 ? (
              <div>
                <h3 className="mb-2 text-[13px] font-semibold">{t('showroom.guidance.salesTitle')}</h3>
                <div className="scrollbar-thin overflow-x-auto rounded-lg border border-line">
                  <table className="w-full text-[13px]">
                    <thead className="bg-surface-2/60 text-xs text-muted">
                      <tr>
                        <th className="px-3 py-2 text-start font-medium">{t('showroom.guidance.saleDate')}</th>
                        <th className="px-3 py-2 text-start font-medium">{t('showroom.guidance.modelYear')}</th>
                        <th className="px-3 py-2 text-start font-medium">{t('showroom.guidance.odometer')}</th>
                        <th className="px-3 py-2 text-end font-medium">{t('showroom.guidance.agreedPrice')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.comparables.map((c, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDate(c.saleDate)}</td>
                          <td className="num px-3 py-2">{c.modelYear}</td>
                          <td className="num px-3 py-2">{c.odometer === null ? '—' : fmtNumber(c.odometer)}</td>
                          <td className="num px-3 py-2 text-end whitespace-nowrap">{fmtMoney(c.agreedPrice, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              !can('sales.read') && <p className="text-xs text-muted">{t('showroom.guidance.salesHidden')}</p>
            )}
          </>
        )}
        {g && (
          <p className="text-xs text-muted">
            {t('showroom.guidance.criteria')} {t('showroom.guidance.disclaimer')}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
