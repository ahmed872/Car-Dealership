import { BookmarkCheck, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Money, Paged, VehicleOption } from '@/features/receivables/kit';
import type { VehicleDetail } from '@/features/vehicles/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ReservationListItem } from './api';
import { ExpiryHint, ReservationFormModal, ReservationStatusBadge } from './components';

/** Vehicle 360 → Reservation: the active reservation, the history, and a shortcut to reserve. */
export function VehicleReservationTab({ d }: { d: VehicleDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const v = d.vehicle;
  const [creating, setCreating] = useState(false);
  const q = useApi<Paged<ReservationListItem>>(['reservations', 'vehicle', v.id], '/reservations', { vehicleId: v.id, pageSize: 50 });
  const current = q.data?.items.find((r) => r.status === 'active');
  const reservable = v.status === 'available' && can('reservations.create');
  const option: VehicleOption = {
    id: v.id,
    stockNumber: v.stockNumber,
    vin: v.vin,
    status: v.status,
    branchId: v.branchId,
    branchName: d.branch.name,
    makeNameEn: d.make.nameEn,
    makeNameAr: d.make.nameAr,
    modelNameEn: d.model.nameEn,
    modelNameAr: d.model.nameAr,
    trim: v.trim,
    modelYear: v.modelYear,
    odometerValue: v.odometerValue,
    odometerUnit: v.odometerUnit,
    askingPrice: v.askingPrice,
  };

  return (
    <div className="space-y-4">
      {current && (
        <Card>
          <CardHeader
            title={t('reservations.vehicleTab.current')}
            actions={
              <Button size="sm" variant="secondary" onClick={() => navigate(`/app/reservations/${current.id}`)}>
                {t('reservations.vehicleTab.open')}
              </Button>
            }
          />
          <CardBody className="grid gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted">{t('reservations.fields.number')}</p>
              <p className="num mt-0.5 font-medium">{current.number}</p>
            </div>
            <div>
              <p className="text-xs text-muted">{t('reservations.fields.customer')}</p>
              <p className="mt-0.5 truncate font-medium">{current.customerName}</p>
            </div>
            <div>
              <p className="text-xs text-muted">{t('reservations.fields.expiresAt')}</p>
              <p className="mt-0.5 text-sm">{fmtDateTime(current.expiresAt)}</p>
              <ExpiryHint expiresAt={current.expiresAt} status={current.status} />
            </div>
            <div>
              <p className="text-xs text-muted">{t('reservations.money.received')}</p>
              <Money value={current.receivedBase} className="mt-0.5 block font-medium" />
            </div>
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader
          title={t('reservations.vehicleTab.title')}
          subtitle={!current ? (reservable ? t('reservations.vehicleTab.availableHint') : v.status !== 'available' ? t('reservations.vehicleTab.notAvailable') : undefined) : undefined}
          actions={
            reservable && (
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                {t('reservations.vehicleTab.reserve')}
              </Button>
            )
          }
        />
        {q.error ? <Alert tone="danger" className="m-4">{t('reservations.vehicleTab.loadFailed')}</Alert> : null}
        {!q.error && (
          <DataTable
            rows={q.data?.items}
            loading={q.isLoading}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/app/reservations/${r.id}`)}
            empty={<EmptyState icon={<BookmarkCheck className="h-5 w-5" />} title={t('reservations.vehicleTab.empty')} />}
            columns={[
              {
                key: 'number',
                header: t('reservations.fields.number'),
                cell: (r) => (
                  <Link to={`/app/reservations/${r.id}`} onClick={(e) => e.stopPropagation()} className="num whitespace-nowrap font-medium text-brand-strong hover:underline">
                    {r.number}
                  </Link>
                ),
              },
              { key: 'customer', header: t('reservations.fields.customer'), cell: (r) => <span className="block max-w-[200px] truncate">{r.customerName}</span> },
              { key: 'reserved', header: t('reservations.fields.reservedAt'), hideOnMobile: true, cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.reservedAt)}</span> },
              { key: 'expires', header: t('reservations.fields.expiresAt'), cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.expiresAt)}</span> },
              { key: 'deposit', header: t('reservations.money.received'), align: 'end', cell: (r) => <Money value={r.receivedBase} className="font-medium" /> },
              { key: 'status', header: t('common.status'), cell: (r) => <ReservationStatusBadge status={r.status} /> },
            ]}
          />
        )}
      </Card>
      {creating && <ReservationFormModal vehicle={option} onClose={() => setCreating(false)} onDone={(r) => navigate(`/app/reservations/${r.id}`)} />}
    </div>
  );
}
