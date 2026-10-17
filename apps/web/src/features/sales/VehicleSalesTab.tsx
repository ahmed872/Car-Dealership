import { HandCoins, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import type { VehicleDetail } from '@/features/vehicles/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { Paged, SaleListItem } from './api';
import { Money, PaymentTypeBadge, SaleStatusBadge } from './shared';

/** Vehicle 360 → Sales: every sale of this vehicle, and a shortcut to sell it. */
export function VehicleSalesTab({ d }: { d: VehicleDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const v = d.vehicle;
  const q = useApi<Paged<SaleListItem>>(['sales', 'vehicle', v.id], '/sales', { vehicleId: v.id, pageSize: 50 });
  const sellable = (v.status === 'available' || v.status === 'reserved') && can('sales.create');
  const sell = () => navigate(`/app/sales/new?vehicleId=${v.id}`);

  return (
    <Card>
      <CardHeader
        title={t('sales.vehicleTab.title')}
        subtitle={sellable ? t(v.status === 'reserved' ? 'sales.vehicleTab.reservedHint' : 'sales.vehicleTab.availableHint') : undefined}
        actions={
          sellable && (
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={sell}>
              {t('sales.vehicleTab.sell')}
            </Button>
          )
        }
      />
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(s) => s.id}
        onRowClick={(s) => navigate(`/app/sales/${s.id}`)}
        empty={<EmptyState icon={<HandCoins className="h-5 w-5" />} title={t('sales.vehicleTab.empty')} />}
        columns={[
          {
            key: 'number',
            header: t('sales.fields.number'),
            cell: (s) => (
              <Link to={`/app/sales/${s.id}`} onClick={(e) => e.stopPropagation()} className="num font-medium text-brand-strong hover:underline">
                {s.number}
              </Link>
            ),
          },
          { key: 'date', header: t('common.date'), cell: (s) => <span className="whitespace-nowrap">{fmtDate(s.saleDate)}</span> },
          { key: 'customer', header: t('sales.fields.customer'), cell: (s) => <span className="max-w-[200px] truncate">{s.customerName}</span> },
          { key: 'type', header: t('sales.fields.paymentType'), hideOnMobile: true, cell: (s) => <PaymentTypeBadge type={s.paymentType} /> },
          { key: 'gross', header: t('sales.fields.gross'), align: 'end', cell: (s) => <Money value={s.grossAmount} className="font-medium" /> },
          { key: 'status', header: t('common.status'), cell: (s) => <SaleStatusBadge status={s.status} /> },
        ]}
      />
    </Card>
  );
}
