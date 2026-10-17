import { Ban, Check, ClipboardList, Pencil, Play, Plus, Send, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { d, sum } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Field, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { categoryName, useCashAccountOptions } from '@/features/costs/api';
import {
  CostStatusBadge,
  initialPayNow,
  payNowBody,
  PayNowFields,
  PayNowState,
  Row,
} from '@/features/costs/components';
import { newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber } from '@/lib/format';
import { useApi, useApiMutation } from '@/lib/hooks';
import {
  EDITABLE_STATUSES,
  priorityTone,
  statusTone,
  useWorkOrder,
  WorkOrderDetail,
  WorkOrderItem,
  woVehicleTitle,
} from './api';
import { WorkOrderFormModal } from './WorkOrderFormModal';
import { WorkOrderItemModal } from './WorkOrderItemModal';

interface InboxItem {
  entityType: string;
  entityId: string;
  canDecide: boolean;
}

/** Items that become supplier-less (direct) costs on approval: these are the only ones pay-now settles. */
function directItems(wo: WorkOrderDetail) {
  return wo.items.filter((i) => d(i.total).gt(0) && !(i.supplierId ?? wo.supplierId));
}

function ApproveModal({ wo, onClose }: { wo: WorkOrderDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canPay = can('supplier_payments.create');
  const direct = directItems(wo);
  const accounts = useCashAccountOptions(canPay && direct.length > 0);
  const [note, setNote] = useState('');
  const [payNow, setPayNow] = useState<PayNowState>(initialPayNow);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => newIdempotencyKey());
  const directTotal = sum(direct.map((i) => i.total)).toFixed(2);
  const m = useApiMutation<Record<string, unknown>>({
    path: `/work-orders/${wo.id}/approve`,
    idempotent: true,
    invalidate: [
      ['work-order', wo.id],
      ['work-orders'],
      ['vehicle-work-orders', wo.vehicleId],
      ['vehicle-costs', wo.vehicleId],
      ['vehicle', wo.vehicleId],
      ['approvals'],
      ['approvals-summary'],
      ['cash-accounts'],
    ],
    success: t('workOrders.success.approved'),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('workOrders.approve.title')}
      description={`${wo.number} · ${wo.title}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="success"
            loading={m.isPending}
            onClick={() => {
              if (payNow.enabled && !payNow.cashAccountId) {
                setErr(t('costs.validation.required'));
                return;
              }
              setErr(null);
              m.mutate({ note: note.trim() || null, payNow: payNowBody(payNow), __idemKey: key });
            }}
          >
            {t('workOrders.approve.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {t('workOrders.approve.message', { amount: fmtMoney(wo.totals.items, wo.currency) })}
        </p>
        <Field label={t('workOrders.approve.note')}>
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
        {direct.length === 0 ? (
          <p className="text-[13px] text-muted">{t('workOrders.approve.nothingDirect')}</p>
        ) : (
          <>
            <p className="text-[13px] text-muted">
              {t('workOrders.approve.directTotal', { amount: fmtMoney(directTotal, wo.currency) })}
            </p>
            <PayNowFields
              value={payNow}
              onChange={setPayNow}
              accounts={accounts.data}
              loading={accounts.isLoading}
              error={err}
              label={t('workOrders.approve.payNow')}
              hint={t('workOrders.approve.payNowHint')}
              unavailable={!canPay ? t('costs.payNow.noPermission') : null}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

export function WorkOrderDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const { can, me } = useAuth();
  const q = useWorkOrder(id);
  const wo = q.data;
  const awaiting = wo?.status === 'awaiting_approval';
  const canApprove = can('work_orders.approve');
  // The inbox applies the full maker-checker rule (creator, submitter and every editor).
  const inbox = useApi<InboxItem[]>(['approvals'], awaiting && canApprove ? '/approvals' : null);
  const [modal, setModal] = useState<null | 'edit' | 'approve' | 'complete' | 'reject' | 'cancel'>(null);
  const [itemModal, setItemModal] = useState<{ item?: WorkOrderItem } | null>(null);
  const [deleting, setDeleting] = useState<WorkOrderItem | null>(null);

  const invalidate = [
    ['work-order', id],
    ['work-orders'],
    ['vehicle-work-orders', wo?.vehicleId],
    ['approvals'],
    ['approvals-summary'],
  ];
  const close = () => setModal(null);
  const start = useApiMutation({
    path: `/work-orders/${id}/start`,
    body: () => ({}),
    invalidate,
    success: t('workOrders.success.started'),
    onSuccess: close,
  });
  const complete = useApiMutation({
    path: `/work-orders/${id}/complete`,
    body: () => ({}),
    invalidate,
    success: t('workOrders.success.completed'),
    onSuccess: close,
  });
  const reject = useApiMutation<{ reason: string }>({
    path: `/work-orders/${id}/reject`,
    invalidate,
    success: t('workOrders.success.rejected'),
    onSuccess: close,
  });
  const cancel = useApiMutation<{ reason: string }>({
    path: `/work-orders/${id}/cancel`,
    invalidate,
    success: t('workOrders.success.cancelled'),
    onSuccess: close,
  });
  const del = useApiMutation<{ itemId: string }>({
    path: (x) => `/work-orders/${id}/items/${x.itemId}`,
    method: 'DELETE',
    invalidate,
    success: t('workOrders.success.itemDeleted'),
    onSuccess: () => setDeleting(null),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !wo) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const manage = can('work_orders.manage');
  const editable = EDITABLE_STATUSES.has(wo.status);
  const cur = wo.currency;
  const entry = inbox.data?.find((x) => x.entityType === 'work_order' && x.entityId === wo.id);
  const canDecide = entry ? entry.canDecide : wo.createdBy !== me?.user.id;
  const variance = wo.estimatedCost ? d(wo.totals.items).minus(wo.estimatedCost) : null;
  const vehicleTitle = woVehicleTitle(wo.vehicle, i18n.language);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('workOrders.title'), to: '/app/work-orders' }, { label: wo.number }]}
        title={wo.title}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="num">{wo.number}</span>
            <Badge tone={statusTone[wo.status]}>{t(`workOrders.statuses.${wo.status}`)}</Badge>
            <Badge tone={priorityTone[wo.priority]}>{t(`workOrders.priorities.${wo.priority}`)}</Badge>
          </span>
        }
        actions={
          <>
            {manage && editable && (
              <Button
                variant="secondary"
                icon={<Pencil className="h-4 w-4" />}
                onClick={() => setModal('edit')}
              >
                {t('common.edit')}
              </Button>
            )}
            {manage && wo.status === 'open' && (
              <Button
                icon={<Play className="h-4 w-4" />}
                loading={start.isPending}
                onClick={() => start.mutate({})}
              >
                {t('workOrders.actions.start')}
              </Button>
            )}
            {manage && wo.status === 'in_progress' && (
              <Button
                icon={<Send className="h-4 w-4" />}
                disabled={wo.items.length === 0}
                title={wo.items.length === 0 ? t('workOrders.noItemsHint') : undefined}
                onClick={() => setModal('complete')}
              >
                {t('workOrders.actions.complete')}
              </Button>
            )}
            {awaiting && canApprove && (
              <>
                {canDecide ? (
                  <Button
                    variant="success"
                    icon={<Check className="h-4 w-4" />}
                    onClick={() => setModal('approve')}
                  >
                    {t('workOrders.actions.approve')}
                  </Button>
                ) : (
                  <span title={t('workOrders.awaitingOtherHint')}>
                    <Badge tone="info">{t('workOrders.awaitingOther')}</Badge>
                  </span>
                )}
                <Button
                  variant="secondary"
                  icon={<Undo2 className="h-4 w-4" />}
                  onClick={() => setModal('reject')}
                >
                  {t('workOrders.actions.reject')}
                </Button>
              </>
            )}
            {manage && wo.status !== 'completed' && wo.status !== 'cancelled' && (
              <Button variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={() => setModal('cancel')}>
                {t('workOrders.actions.cancel')}
              </Button>
            )}
          </>
        }
      />

      {awaiting && canApprove && !canDecide && (
        <Alert tone="info" className="mb-4">
          {t('workOrders.awaitingOtherHint')}
        </Alert>
      )}
      {wo.status === 'cancelled' && wo.cancelReason && (
        <Alert tone="warning" className="mb-4" title={t('workOrders.cancelReason')}>
          {wo.cancelReason}
        </Alert>
      )}
      {manage && wo.status === 'in_progress' && wo.items.length === 0 && (
        <Alert tone="info" className="mb-4">
          {t('workOrders.noItemsHint')}
        </Alert>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader
              title={t('workOrders.items.title')}
              subtitle={
                editable
                  ? t('workOrders.items.currencyNote', { currency: cur })
                  : wo.status === 'awaiting_approval'
                    ? t('workOrders.items.lockedHint')
                    : undefined
              }
              actions={
                manage &&
                editable && (
                  <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setItemModal({})}>
                    {t('workOrders.items.add')}
                  </Button>
                )
              }
            />
            <DataTable
              rows={wo.items}
              rowKey={(i) => i.id}
              empty={
                <EmptyState
                  icon={<ClipboardList className="h-5 w-5" />}
                  title={t('workOrders.items.empty')}
                  description={editable ? t('workOrders.items.emptyHint') : undefined}
                />
              }
              columns={[
                {
                  key: 'desc',
                  header: t('workOrders.items.description'),
                  cell: (i) => (
                    <div className="min-w-[170px] max-w-[320px]">
                      <p className="break-words font-medium">{i.description}</p>
                      <p className="text-xs text-muted">
                        {t(`workOrders.kinds.${i.kind}`)} · {categoryName(i, i18n.language)}
                      </p>
                      <p className="text-xs text-muted">
                        {i.supplierName ? (
                          <bdi className="text-ink">{i.supplierName}</bdi>
                        ) : wo.supplierName ? (
                          <bdi>{wo.supplierName}</bdi>
                        ) : (
                          t('costs.items.directPurchase')
                        )}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'total',
                  header: t('workOrders.items.total'),
                  align: 'end',
                  cell: (i) => (
                    <div className="num whitespace-nowrap">
                      <p className="font-semibold">{fmtMoney(i.total, cur)}</p>
                      <p className="text-xs text-muted">
                        {fmtNumber(i.quantity, d(i.quantity).decimalPlaces())} × {fmtMoney(i.unitCost, cur)}
                      </p>
                      {i.hours && (
                        <p className="text-xs text-muted">
                          {t('workOrders.items.hoursValue', {
                            hours: fmtNumber(i.hours, d(i.hours).decimalPlaces()),
                          })}
                        </p>
                      )}
                    </div>
                  ),
                },
                ...(wo.status === 'completed'
                  ? [
                      {
                        key: 'cost',
                        header: t('workOrders.items.cost'),
                        cell: (i: WorkOrderItem) =>
                          i.cost?.status ? (
                            <div className="space-y-0.5 text-xs">
                              <CostStatusBadge status={i.cost.status} />
                              {i.cost.status === 'posted' && (
                                <div className="num whitespace-nowrap">
                                  <p className="text-success">
                                    {t('workOrders.items.paid', { amount: fmtMoney(i.cost.paidBase, cur) })}
                                  </p>
                                  <p
                                    className={
                                      d(i.cost.outstandingBase).gt(0) ? 'text-warning' : 'text-muted'
                                    }
                                  >
                                    {t('workOrders.items.outstanding', {
                                      amount: fmtMoney(i.cost.outstandingBase, cur),
                                    })}
                                  </p>
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted">
                              {d(i.total).isZero()
                                ? t('workOrders.items.zeroNotPosted')
                                : t('workOrders.items.notPosted')}
                            </span>
                          ),
                      },
                    ]
                  : []),
                ...(manage && editable
                  ? [
                      {
                        key: 'actions',
                        header: t('common.actions'),
                        align: 'end' as const,
                        cell: (i: WorkOrderItem) => (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`${t('common.edit')} ${i.description}`}
                              title={t('common.edit')}
                              onClick={() => setItemModal({ item: i })}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`${t('common.delete')} ${i.description}`}
                              title={t('common.delete')}
                              onClick={() => setDeleting(i)}
                            >
                              <Trash2 className="h-4 w-4 text-danger" />
                            </Button>
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]}
              footer={
                wo.items.length > 0 && (
                  <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm">
                    <span className="font-medium">{t('workOrders.totals.items')}</span>
                    <span className="num font-semibold">{fmtMoney(wo.totals.items, cur)}</span>
                  </div>
                )
              }
            />
          </Card>

          {wo.payments.length > 0 && (
            <Card>
              <CardHeader title={t('workOrders.payments.title')} />
              <DataTable
                rows={wo.payments}
                rowKey={(p) => `${p.paymentId}:${p.targetId}`}
                dense
                columns={[
                  {
                    key: 'no',
                    header: t('workOrders.payments.number'),
                    cell: (p) => <span className="num font-medium">{p.number}</span>,
                  },
                  {
                    key: 'date',
                    header: t('workOrders.payments.date'),
                    cell: (p) => <span className="num">{fmtDate(p.paidAt)}</span>,
                  },
                  {
                    key: 'method',
                    header: t('workOrders.payments.method'),
                    cell: (p) => t(`costs.methods.${p.method}`),
                  },
                  {
                    key: 'amount',
                    header: t('workOrders.payments.amount'),
                    align: 'end',
                    cell: (p) => <span className="num">{fmtMoney(p.amountBase, cur)}</span>,
                  },
                  {
                    key: 'status',
                    header: t('workOrders.payments.status'),
                    cell: (p) => (
                      <Badge tone={p.status === 'posted' ? 'success' : 'neutral'}>
                        {t(`workOrders.payments.${p.status}`)}
                      </Badge>
                    ),
                  },
                ]}
              />
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title={t('workOrders.totals.title')} />
            <CardBody className="divide-y divide-line py-2">
              <Row label={t('workOrders.totals.items')} value={fmtMoney(wo.totals.items, cur)} strong />
              <Row
                label={t('workOrders.totals.estimate')}
                value={
                  wo.estimatedCost ? (
                    <span>
                      {fmtMoney(wo.estimatedCost, cur)}
                      {variance && !variance.isZero() && (
                        <span
                          className={
                            variance.gt(0)
                              ? 'ms-1 block text-xs text-warning'
                              : 'ms-1 block text-xs text-success'
                          }
                        >
                          {t('workOrders.totals.variance', {
                            amount: fmtMoney(variance.toFixed(2), cur, { sign: true }),
                          })}
                        </span>
                      )}
                    </span>
                  ) : (
                    '—'
                  )
                }
              />
              {wo.status === 'completed' && (
                <>
                  <Row label={t('workOrders.totals.posted')} value={fmtMoney(wo.totals.posted, cur)} />
                  <Row label={t('workOrders.totals.paid')} value={fmtMoney(wo.totals.paid, cur)} />
                  <Row
                    label={t('workOrders.totals.outstanding')}
                    value={
                      <span className={d(wo.totals.outstanding).gt(0) ? 'text-warning' : ''}>
                        {fmtMoney(wo.totals.outstanding, cur)}
                      </span>
                    }
                  />
                </>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('common.details')} />
            <CardBody>
              <DescriptionList
                columns={1}
                items={[
                  {
                    label: t('workOrders.vehicle'),
                    value: (
                      <Link
                        to={`/app/vehicles/${wo.vehicle.id}`}
                        className="font-medium text-brand-strong hover:underline"
                      >
                        {vehicleTitle} · <span className="num">{wo.vehicle.stockNumber}</span>
                      </Link>
                    ),
                  },
                  { label: t('workOrders.type'), value: t(`workOrders.types.${wo.type}`) },
                  { label: t('workOrders.assignee'), value: wo.assigneeName ?? t('workOrders.unassigned') },
                  { label: t('workOrders.supplier'), value: wo.supplierName ?? t('workOrders.noSupplier') },
                  {
                    label: t('workOrders.createdAt'),
                    value: <span className="num">{fmtDateTime(wo.createdAt)}</span>,
                  },
                  ...(wo.startedAt
                    ? [
                        {
                          label: t('workOrders.startedAt'),
                          value: <span className="num">{fmtDateTime(wo.startedAt)}</span>,
                        },
                      ]
                    : []),
                  ...(wo.completedAt
                    ? [
                        {
                          label: t('workOrders.completedAt'),
                          value: <span className="num">{fmtDateTime(wo.completedAt)}</span>,
                        },
                      ]
                    : []),
                  ...(wo.approvedAt
                    ? [
                        {
                          label: t('workOrders.approvedBy'),
                          value: (
                            <span>
                              {wo.approvedByName ?? '—'} ·{' '}
                              <span className="num">{fmtDateTime(wo.approvedAt)}</span>
                            </span>
                          ),
                        },
                      ]
                    : []),
                  ...(wo.description
                    ? [
                        {
                          label: t('workOrders.description'),
                          value: <span className="whitespace-pre-wrap">{wo.description}</span>,
                        },
                      ]
                    : []),
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>

      {modal === 'edit' && <WorkOrderFormModal wo={wo} onClose={close} />}
      {modal === 'approve' && <ApproveModal wo={wo} onClose={close} />}
      {itemModal && <WorkOrderItemModal wo={wo} item={itemModal.item} onClose={() => setItemModal(null)} />}
      <ConfirmDialog
        open={modal === 'complete'}
        onClose={close}
        title={t('workOrders.confirm.completeTitle')}
        message={t('workOrders.confirm.completeMessage', { amount: fmtMoney(wo.totals.items, cur) })}
        confirmLabel={t('workOrders.actions.complete')}
        loading={complete.isPending}
        onConfirm={() => complete.mutate({})}
      />
      <ConfirmDialog
        open={modal === 'reject'}
        onClose={close}
        title={t('workOrders.confirm.rejectTitle')}
        message={t('workOrders.confirm.rejectMessage')}
        confirmLabel={t('workOrders.actions.reject')}
        requireReason
        loading={reject.isPending}
        onConfirm={(reason) => reject.mutate({ reason })}
      />
      <ConfirmDialog
        open={modal === 'cancel'}
        onClose={close}
        title={t('workOrders.confirm.cancelTitle')}
        message={t('workOrders.confirm.cancelMessage')}
        confirmLabel={t('workOrders.actions.cancel')}
        tone="danger"
        requireReason
        loading={cancel.isPending}
        onConfirm={(reason) => cancel.mutate({ reason })}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t('workOrders.items.deleteTitle')}
        message={deleting ? t('workOrders.items.deleteMessage', { name: deleting.description }) : undefined}
        confirmLabel={t('common.delete')}
        tone="danger"
        loading={del.isPending}
        onConfirm={() => {
          if (deleting) del.mutate({ itemId: deleting.id });
        }}
      />
    </>
  );
}
