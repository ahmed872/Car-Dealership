import { Plus, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import type { VehicleDetail } from '@/features/vehicles/api';
import { vehicleTitle } from '@/features/vehicles/components';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { priorityTone, statusTone, WorkOrderListItem } from './api';
import { WorkOrderFormModal } from './WorkOrderFormModal';

/** Vehicle 360 → Work orders: every work order of the vehicle (GET /vehicles/:id/work-orders). */
export function VehicleWorkOrdersTab({ d }: { d: VehicleDetail }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can, currency } = useAuth();
  const v = d.vehicle;
  const q = useApi<WorkOrderListItem[]>(['vehicle-work-orders', v.id], `/vehicles/${v.id}/work-orders`);
  const [creating, setCreating] = useState(false);
  const closed = v.status === 'delivered' || v.status === 'removed';
  const canCreate = can('work_orders.manage');
  const title = vehicleTitle(
    {
      modelYear: v.modelYear,
      trim: v.trim,
      makeNameEn: d.make.nameEn,
      makeNameAr: d.make.nameAr,
      modelNameEn: d.model.nameEn,
      modelNameAr: d.model.nameAr,
    },
    i18n.language,
  );

  return (
    <Card>
      <CardHeader
        title={t('workOrders.title')}
        subtitle={canCreate && closed ? t('workOrders.vehicleClosed') : undefined}
        actions={
          canCreate &&
          !closed && (
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              {t('workOrders.new')}
            </Button>
          )
        }
      />
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/app/work-orders/${r.id}`)}
        empty={
          <EmptyState
            icon={<Wrench className="h-5 w-5" />}
            title={t('workOrders.vehicleEmpty')}
            description={canCreate && !closed ? t('workOrders.emptyHint') : undefined}
          />
        }
        columns={[
          {
            key: 'number',
            header: t('workOrders.number'),
            cell: (r) => <span className="num font-medium whitespace-nowrap">{r.number}</span>,
          },
          {
            key: 'title',
            header: t('workOrders.titleField'),
            cell: (r) => (
              <div className="min-w-[160px]">
                <p className="font-medium">{r.title}</p>
                <p className="text-xs text-muted">
                  {t(`workOrders.types.${r.type}`)} · {t('workOrders.itemCount', { count: r.itemCount })}
                </p>
              </div>
            ),
          },
          {
            key: 'priority',
            header: t('workOrders.priority'),
            hideOnMobile: true,
            cell: (r) => (
              <Badge tone={priorityTone[r.priority]}>{t(`workOrders.priorities.${r.priority}`)}</Badge>
            ),
          },
          {
            key: 'status',
            header: t('workOrders.status'),
            cell: (r) => <Badge tone={statusTone[r.status]}>{t(`workOrders.statuses.${r.status}`)}</Badge>,
          },
          {
            key: 'assignee',
            header: t('workOrders.assignee'),
            hideOnMobile: true,
            cell: (r) => (
              <span className="whitespace-nowrap">
                {r.assigneeName ?? <span className="text-subtle">{t('workOrders.unassigned')}</span>}
              </span>
            ),
          },
          {
            key: 'total',
            header: t('workOrders.itemsTotal'),
            align: 'end',
            cell: (r) => (
              <div className="num whitespace-nowrap">
                <p className="font-medium">{fmtMoney(r.itemsTotal, currency)}</p>
                {r.status === 'completed' && (
                  <p className="text-xs text-muted">
                    {t('workOrders.postedTotal')}: {fmtMoney(r.postedTotal, currency)}
                  </p>
                )}
              </div>
            ),
          },
          {
            key: 'created',
            header: t('workOrders.createdAt'),
            hideOnMobile: true,
            cell: (r) => <span className="num whitespace-nowrap text-muted">{fmtDate(r.createdAt)}</span>,
          },
        ]}
      />
      {creating && (
        <WorkOrderFormModal
          vehicle={{
            id: v.id,
            stockNumber: v.stockNumber,
            title,
            status: v.status,
            branchId: v.branchId,
            branchName: d.branch.name,
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </Card>
  );
}
