import { Heart, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import type { VehicleDetail } from '@/features/vehicles/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney, fmtPhone } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { InterestedCustomer } from './api';

/** Vehicle 360 → Interested customers: active wishes this vehicle satisfies right now. */
export function VehicleInterestedTab({ d }: { d: VehicleDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currency } = useAuth();
  const q = useApi<{ items: InterestedCustomer[] }>(['wishes', 'for-vehicle', d.vehicle.id], `/wishes/for-vehicle/${d.vehicle.id}`);
  return (
    <Card>
      <CardHeader title={t('wishes.vehicleTab.title')} subtitle={t('wishes.vehicleTab.subtitle')} />
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(r) => r.wishId}
        onRowClick={(r) => navigate(`/app/wishes/${r.wishId}`)}
        empty={<EmptyState icon={<Heart className="h-5 w-5" />} title={t('wishes.vehicleTab.empty')} />}
        columns={[
          {
            key: 'customer',
            header: t('wishes.vehicleTab.customer'),
            cell: (r) => (
              <Link to={`/app/customers/${r.customerId}`} onClick={(e) => e.stopPropagation()} className="block max-w-[220px] truncate font-medium text-ink hover:text-brand-strong hover:underline">
                {r.customerName}
              </Link>
            ),
          },
          {
            key: 'phone',
            header: t('wishes.vehicleTab.phone'),
            cell: (r) =>
              r.customerPhone ? (
                <a href={`tel:${fmtPhone(r.customerPhone)}`} onClick={(e) => e.stopPropagation()} dir="ltr" className="num inline-flex items-center gap-1.5 whitespace-nowrap text-brand-strong hover:underline">
                  <Phone className="h-3.5 w-3.5" aria-hidden />
                  {fmtPhone(r.customerPhone)}
                </a>
              ) : (
                '—'
              ),
          },
          { key: 'max', header: t('wishes.vehicleTab.maxPrice'), align: 'end', cell: (r) => <span className="num whitespace-nowrap">{r.maxPrice ? fmtMoney(r.maxPrice, currency) : '—'}</span> },
          { key: 'notes', header: t('wishes.vehicleTab.notes'), hideOnMobile: true, cell: (r) => <span className="line-clamp-2 max-w-[280px] text-muted">{r.notes ?? '—'}</span> },
          {
            key: 'open',
            header: t('common.actions'),
            align: 'end',
            cell: (r) => (
              <Link to={`/app/wishes/${r.wishId}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap text-[13px] font-medium text-brand-strong hover:underline">
                {t('wishes.vehicleTab.openWish')}
              </Link>
            ),
          },
        ]}
      />
    </Card>
  );
}
