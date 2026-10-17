import {
  Ban,
  CheckCircle2,
  ExternalLink,
  FilePlus2,
  FileText,
  Landmark,
  Pencil,
  Plus,
  ReceiptText,
  RotateCcw,
  ShieldCheck,
  Truck,
  Undo2,
  Wallet,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { useMakes, useModels } from '@/features/vehicles/api';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtNumber, fmtPct } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { Paged, Refund, SaleDetail, SaleDocumentType, TradeIn, useSale } from './api';
import {
  AddTradeInModal,
  ApproveSaleModal,
  BlockerList,
  CancelSaleModal,
  ConfirmSaleModal,
  DeliverModal,
  ExternalFinanceModal,
  IssueDocumentModal,
  RefundRequestModal,
  RejectSaleModal,
  RemoveTradeInModal,
  ReturnSaleModal,
  VoidDocumentModal,
  VoidPaymentModal,
} from './SaleDialogs';
import {
  commissionRuleText,
  CommissionStatusBadge,
  Money,
  PaymentTypeBadge,
  PlanStatusBadge,
  ReceivePaymentModal,
  Row,
  SaleStatusBadge,
  Stat,
  vehicleSnapshotTitle,
} from './shared';

type Dialog =
  | { kind: 'approve' | 'reject' | 'confirm' | 'ef' | 'deliver' | 'cancel' | 'return' | 'refund' | 'pay' | 'addTradeIn' }
  | { kind: 'issue'; type?: SaleDocumentType }
  | { kind: 'voidDoc'; id: string; label: string }
  | { kind: 'removeTradeIn'; id: string }
  | { kind: 'voidPayment'; id: string; number: string };

const PRE_CONFIRM = ['draft', 'pending_approval', 'approved'];
const LIVE = ['draft', 'pending_approval', 'approved', 'confirmed', 'delivered'];

interface ApprovalItem {
  entityType: string;
  entityId: string;
  canDecide: boolean;
  requestedBy: string | null;
  requestedAt: string;
}

export function SaleDetailPage() {
  const { id } = useParams();
  const q = useSale(id);
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  return <SaleView sale={q.data} onReload={() => void q.refetch()} />;
}

function SaleView({ sale: s, onReload }: { sale: SaleDetail; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can, canAny, me } = useAuth();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);

  const pre = PRE_CONFIRM.includes(s.status);
  const closed = s.status === 'cancelled' || s.status === 'returned';
  const outstanding = s.money.outstandingBeforeDelivery;
  const canReceive = LIVE.includes(s.status) && d(outstanding).gt(0) && can('payments.receive');
  const approvalPerm = s.approvalPermission;
  const canDecidePrice = s.status === 'pending_approval' && !!approvalPerm && can(approvalPerm);
  const approvals = useApi<ApprovalItem[]>(['approvals'], canDecidePrice ? '/approvals' : null);
  const approvalItem = approvals.data?.find((x) => x.entityType === 'sale' && x.entityId === s.id);
  const isMaker = approvalItem ? !approvalItem.canDecide : s.createdBy === me?.user.id || s.salespersonId === me?.user.id;
  const rejectedPrice = s.status === 'draft' && !!approvalPerm;
  const canConfirm = (s.status === 'approved' || (s.status === 'draft' && !approvalPerm)) && can('sales.confirm');
  const canDecideEf =
    s.paymentType === 'external_finance' && s.externalFinance?.status === 'pending' && [...PRE_CONFIRM, 'confirmed'].includes(s.status) && can('sales.confirm');
  const canCancel = (pre && can('sales.cancel')) || (s.status === 'confirmed' && can('sales.cancel_confirmed'));
  const canIssue = (s.status === 'confirmed' || s.status === 'delivered') && can('documents.issue');
  const refunds = useApi<Paged<Refund>>(['refunds', 'sale', s.id], closed && can('payments.read') ? '/refunds' : null, { sourceType: 'sale', sourceId: s.id, pageSize: 50 });
  const title = vehicleSnapshotTitle(s.vehicleSnapshot, i18n.language);
  const ef = s.externalFinance;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('sales.title'), to: '/app/sales' }, { label: s.number }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="num">{s.number}</span>
            <SaleStatusBadge status={s.status} />
            <PaymentTypeBadge type={s.paymentType} />
          </span>
        }
        subtitle={`${title} · ${s.customerSnapshot.fullName}`}
        actions={
          <>
            {pre && (
              <Can perm="sales.create">
                <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => navigate(`/app/sales/${s.id}/edit`)}>
                  {t('common.edit')}
                </Button>
              </Can>
            )}
            {canDecidePrice && (
              <>
                <Button variant="secondary" icon={<Undo2 className="h-4 w-4" />} onClick={() => setDialog({ kind: 'reject' })}>
                  {t('common.reject')}
                </Button>
                <Button
                  variant="success"
                  icon={<ShieldCheck className="h-4 w-4" />}
                  disabled={isMaker}
                  title={isMaker ? t('sales.approval.makerCheckerShort') : undefined}
                  onClick={() => setDialog({ kind: 'approve' })}
                >
                  {t('sales.actions.approvePrice')}
                </Button>
              </>
            )}
            {canConfirm && (
              <Button icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setDialog({ kind: 'confirm' })}>
                {t('sales.actions.confirm')}
              </Button>
            )}
            {canReceive && (
              <Button variant={s.status === 'confirmed' ? 'primary' : 'secondary'} icon={<Wallet className="h-4 w-4" />} onClick={() => setDialog({ kind: 'pay' })}>
                {t('sales.actions.recordPayment')}
              </Button>
            )}
            {canIssue && (
              <Button variant="secondary" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => setDialog({ kind: 'issue' })}>
                {t('sales.documents.issue')}
              </Button>
            )}
            {canDecideEf && (
              <Button variant="secondary" icon={<Landmark className="h-4 w-4" />} onClick={() => setDialog({ kind: 'ef' })}>
                {t('sales.ef.decide')}
              </Button>
            )}
            {s.status === 'confirmed' && (
              <Can perm="sales.deliver">
                <Button variant="success" icon={<Truck className="h-4 w-4" />} onClick={() => setDialog({ kind: 'deliver' })}>
                  {t('sales.actions.deliver')}
                </Button>
              </Can>
            )}
            {s.status === 'delivered' && (
              <Can perm="sales.return">
                <Button variant="ghost" className="text-danger" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setDialog({ kind: 'return' })}>
                  {t('sales.actions.return')}
                </Button>
              </Can>
            )}
            {canCancel && (
              <Button variant="ghost" className="text-danger" icon={<Ban className="h-4 w-4" />} onClick={() => setDialog({ kind: 'cancel' })}>
                {t('sales.actions.cancel')}
              </Button>
            )}
            {closed && d(s.money.refundable).gt(0) && (
              <Can perm="refunds.create">
                <Button icon={<ReceiptText className="h-4 w-4" />} onClick={() => setDialog({ kind: 'refund' })}>
                  {t('sales.refund.request')}
                </Button>
              </Can>
            )}
          </>
        }
      />

      {/* Status explanations */}
      {s.status === 'pending_approval' && (
        <Alert tone="warning" className="mb-4" title={t('sales.approval.pendingTitle')}>
          {approvalPerm === 'sales.approve_below_floor' ? t('sales.approval.belowFloorHint') : t('sales.approval.discountHint')}
          {approvalItem && <> {t('sales.approval.requestedBy', { name: approvalItem.requestedBy ?? '—', date: fmtDateTime(approvalItem.requestedAt) })}</>}
        </Alert>
      )}
      {canDecidePrice && isMaker && (
        <Alert tone="info" className="mb-4" title={t('sales.approval.makerCheckerTitle')}>
          {t('sales.approval.makerCheckerBody')}
        </Alert>
      )}
      {rejectedPrice && (
        <Alert tone="warning" className="mb-4" title={t('sales.approval.rejectedTitle')}>
          {t('sales.approval.rejectedBody')}
        </Alert>
      )}
      {s.status === 'confirmed' && s.deliveryBlockers.length > 0 && (
        <Alert tone="info" className="mb-4" title={t('sales.deliver.blockersTitle')}>
          <BlockerList blockers={s.deliveryBlockers} />
        </Alert>
      )}
      {s.status === 'confirmed' && s.deliveryBlockers.length === 0 && (
        <Alert tone="success" className="mb-4">
          {t('sales.deliver.ready')}
        </Alert>
      )}
      {s.status === 'cancelled' && (
        <Alert tone="danger" className="mb-4" title={t('sales.cancel.cancelledOn', { date: fmtDateTime(s.cancelledAt) })}>
          {s.cancelReason}
        </Alert>
      )}
      {s.status === 'returned' && (
        <Alert tone="danger" className="mb-4" title={t('sales.return.returnedOn', { date: fmtDateTime(s.returnedAt) })}>
          {s.returnReason}
        </Alert>
      )}
      {closed && d(s.money.refundable).gt(0) && (
        <Alert tone="warning" className="mb-4" title={t('sales.refund.creditTitle')}>
          {t('sales.refund.creditBody')}
        </Alert>
      )}

      {/* KPI row */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <Stat label={t('sales.fields.gross')}>
            <Money value={s.grossAmount} className="text-lg font-semibold" />
          </Stat>
          <p className="mt-1 text-xs text-muted">{t('sales.fields.saleDateValue', { date: fmtDate(s.saleDate) })}</p>
        </Card>
        <Card className="p-4">
          <Stat label={t('sales.money.held')}>
            <Money value={s.money.held} className="text-lg font-semibold text-success" />
          </Stat>
          <p className="mt-1 text-xs text-muted">{t('sales.money.heldHint')}</p>
        </Card>
        <Card className="p-4">
          <Stat label={t('sales.money.outstanding')}>
            {closed ? (
              <span className="text-lg font-semibold text-muted">—</span>
            ) : (
              <Money value={outstanding} className={d(outstanding).gt(0) ? 'text-lg font-semibold text-warning' : 'text-lg font-semibold'} />
            )}
          </Stat>
          <p className="mt-1 text-xs text-muted">
            {closed ? (
              t('sales.money.closedHint')
            ) : (
              <>
                {t('sales.fields.dueBeforeDelivery')}: <Money value={s.money.dueBeforeDelivery} />
              </>
            )}
          </p>
        </Card>
        <Card className="p-4">
          {closed ? (
            <Stat label={t('sales.money.refundable')}>
              <Money value={s.money.refundable} className="text-lg font-semibold" />
            </Stat>
          ) : (
            <Stat label={t('sales.money.receivable')}>
              {s.money.receivable === null ? <span className="text-sm text-muted">{t('sales.money.notRecognized')}</span> : <Money value={s.money.receivable} className="text-lg font-semibold" />}
            </Stat>
          )}
          {s.recognizedAt && !closed && <p className="mt-1 text-xs text-muted">{t('sales.money.recognizedOn', { date: fmtDate(s.recognitionDate) })}</p>}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0 space-y-5">
          {/* Payments */}
          <Card>
            <CardHeader
              title={t('sales.payments.title')}
              subtitle={t('sales.payments.hint')}
              actions={
                canReceive && (
                  <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ kind: 'pay' })}>
                    {t('sales.actions.recordPayment')}
                  </Button>
                )
              }
            />
            <DataTable
              dense
              rows={s.payments}
              rowKey={(p) => p.receiptId}
              empty={<p className="px-5 py-4 text-sm text-muted">{t('sales.payments.none')}</p>}
              columns={[
                { key: 'number', header: t('sales.payments.number'), cell: (p) => <span className="num font-medium whitespace-nowrap">{p.number}</span> },
                { key: 'date', header: t('common.date'), cell: (p) => <span className="whitespace-nowrap">{fmtDate(p.receivedAt)}</span> },
                { key: 'method', header: t('sales.payment.method'), hideOnMobile: true, cell: (p) => t(`sales.method.${p.method}`) },
                {
                  key: 'amount',
                  header: t('common.amount'),
                  align: 'end',
                  cell: (p) => <Money value={p.amountBase} className={p.status === 'voided' ? 'text-muted line-through' : 'font-medium'} />,
                },
                {
                  key: 'status',
                  header: t('common.status'),
                  cell: (p) => <Badge tone={p.status === 'posted' ? 'success' : 'danger'}>{t(`sales.payments.status.${p.status}`)}</Badge>,
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">{t('common.actions')}</span>,
                  className: 'relative',
                  align: 'end',
                  cell: (p) =>
                    p.status === 'posted' && can('payments.void') ? (
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDialog({ kind: 'voidPayment', id: p.receiptId, number: p.number })}>
                        {t('sales.payments.void')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          </Card>

          {/* Documents */}
          <Card>
            <CardHeader
              title={t('sales.documents.title')}
              subtitle={t('sales.documents.hint')}
              actions={
                canIssue && (
                  <Button size="sm" variant="secondary" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => setDialog({ kind: 'issue' })}>
                    {t('sales.documents.issue')}
                  </Button>
                )
              }
            />
            <DataTable
              dense
              rows={s.documents}
              rowKey={(x) => x.id}
              empty={<p className="px-5 py-4 text-sm text-muted">{t('sales.documents.none')}</p>}
              columns={[
                {
                  key: 'type',
                  header: t('sales.documents.type'),
                  cell: (x) => (
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <FileText className="h-4 w-4 text-muted" aria-hidden />
                      {t(`sales.docType.${x.type}`)}
                    </span>
                  ),
                },
                { key: 'number', header: t('sales.documents.number'), cell: (x) => <span className="num whitespace-nowrap">{x.number}</span> },
                { key: 'date', header: t('common.date'), hideOnMobile: true, cell: (x) => <span className="whitespace-nowrap">{fmtDate(x.issueDate)}</span> },
                {
                  key: 'status',
                  header: t('common.status'),
                  cell: (x) => (
                    <span title={x.voidReason ?? undefined}>
                      <Badge tone={x.status === 'issued' ? 'success' : 'danger'}>{t(`sales.docStatus.${x.status}`)}</Badge>
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">{t('common.actions')}</span>,
                  className: 'relative',
                  align: 'end',
                  cell: (x) => (
                    <span className="inline-flex items-center gap-1">
                      <a
                        href={`/api/v1/sale-documents/${x.id}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-strong hover:bg-surface-2"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        {t('sales.documents.pdf')}
                      </a>
                      {x.status === 'issued' && x.type !== 'credit_note' && s.status === 'confirmed' && can('documents.void') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          onClick={() => setDialog({ kind: 'voidDoc', id: x.id, label: `${t(`sales.docType.${x.type}`)} ${x.number}` })}
                        >
                          {t('sales.documents.void')}
                        </Button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          </Card>

          {/* Trade-ins */}
          {(s.tradeIns.length > 0 || pre) && (
            <Card>
              <CardHeader
                title={t('sales.form.sections.tradeIns')}
                subtitle={t('sales.tradeIn.detailHint')}
                actions={
                  pre &&
                  s.tradeIns.filter((x) => x.status !== 'cancelled').length < 3 && (
                    <Can perm="sales.create">
                      <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog({ kind: 'addTradeIn' })}>
                        {t('sales.tradeIn.add')}
                      </Button>
                    </Can>
                  )
                }
              />
              {s.tradeIns.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">{t('sales.tradeIn.none')}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {s.tradeIns.map((x) => (
                    <TradeInRow
                      key={x.id}
                      x={x}
                      onRemove={pre && x.status === 'pending' && can('sales.create') ? () => setDialog({ kind: 'removeTradeIn', id: x.id }) : undefined}
                    />
                  ))}
                </ul>
              )}
            </Card>
          )}

          {/* Refunds of the customer credit */}
          {closed && can('payments.read') && (
            <Card>
              <CardHeader title={t('sales.refund.listTitle')} />
              <DataTable
                dense
                rows={refunds.data?.items}
                loading={refunds.isLoading}
                error={refunds.error}
                onRetry={() => refunds.refetch()}
                rowKey={(r) => r.id}
                empty={<p className="px-5 py-4 text-sm text-muted">{t('sales.refund.none')}</p>}
                columns={[
                  { key: 'number', header: t('sales.refund.number'), cell: (r) => <span className="num font-medium whitespace-nowrap">{r.number}</span> },
                  { key: 'date', header: t('common.date'), cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.requestedAt)}</span> },
                  { key: 'reason', header: t('common.reason'), cell: (r) => <span className="line-clamp-1 max-w-[220px]">{r.reason}</span> },
                  { key: 'amount', header: t('common.amount'), align: 'end', cell: (r) => <Money value={r.amountBase} className="font-medium" /> },
                  { key: 'status', header: t('common.status'), cell: (r) => <Badge tone={r.status === 'paid' ? 'success' : r.status === 'requested' ? 'warning' : r.status === 'approved' ? 'info' : 'danger'}>{t(`sales.refund.status.${r.status}`)}</Badge> },
                ]}
              />
            </Card>
          )}

          {/* Timeline */}
          <Card>
            <CardHeader title={t('sales.timeline.title')} />
            <CardBody>
              <ol className="space-y-3 border-s border-line ps-4 text-sm">
                <TimelineItem label={t('sales.timeline.created')} at={s.createdAt} />
                {s.approvedAt && <TimelineItem label={t('sales.timeline.approved')} at={s.approvedAt} />}
                {s.confirmedAt && <TimelineItem label={t('sales.timeline.confirmed')} at={s.confirmedAt} />}
                {s.deliveredAt && <TimelineItem label={t('sales.timeline.delivered')} at={s.deliveredAt} note={s.deliveryOverrideReason ? t('sales.timeline.override', { reason: s.deliveryOverrideReason }) : undefined} />}
                {s.cancelledAt && <TimelineItem label={t('sales.timeline.cancelled')} at={s.cancelledAt} note={s.cancelReason ?? undefined} tone="danger" />}
                {s.returnedAt && <TimelineItem label={t('sales.timeline.returned')} at={s.returnedAt} note={s.returnReason ?? undefined} tone="danger" />}
              </ol>
            </CardBody>
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          {/* Pricing */}
          <Card>
            <CardHeader title={t('sales.detail.pricing')} />
            <CardBody className="pt-2">
              <dl className="divide-y divide-line">
                <Row label={t('sales.fields.askingPrice')}>
                  <Money value={s.askingPrice} />
                </Row>
                {s.floorPrice && (
                  <Row label={t('sales.fields.floorPrice')}>
                    <Money value={s.floorPrice} />
                  </Row>
                )}
                <Row label={t('sales.fields.agreedPrice')}>
                  <Money value={s.agreedPrice} />
                </Row>
                <Row label={t('sales.fields.discount')} tone={d(s.discountAmount).gt(0) ? 'warning' : undefined}>
                  <Money value={s.discountAmount} /> <span className="num text-xs">({fmtPct(s.discountPct, 2)})</span>
                </Row>
                <Row label={t('sales.fields.net')}>
                  <Money value={s.netAmount} />
                </Row>
                <Row label={t('sales.fields.taxWithRate', { rate: fmtPct(s.taxRatePct, 2) })}>
                  <Money value={s.taxAmount} />
                </Row>
                <Row label={t('sales.fields.gross')} strong>
                  <Money value={s.grossAmount} />
                </Row>
                {s.paymentType === 'installments' && (
                  <>
                    <Row label={t('sales.fields.downPayment')}>
                      <Money value={s.downPayment} />
                    </Row>
                    <Row label={t('sales.fields.financed')}>
                      <Money value={s.financedAmount} />
                    </Row>
                  </>
                )}
              </dl>
              {approvalPerm && (
                <p className="mt-2 text-xs text-muted">
                  {approvalPerm === 'sales.approve_below_floor' ? t('sales.approval.neededBelowFloor') : t('sales.approval.neededDiscount')}
                  {s.approvedAt && ` · ${t('sales.approval.approvedOn', { date: fmtDateTime(s.approvedAt) })}`}
                </p>
              )}
            </CardBody>
          </Card>

          {/* Money summary */}
          <Card>
            <CardHeader title={t('sales.detail.money')} />
            <CardBody className="pt-2">
              <dl className="divide-y divide-line">
                {d(s.tradeInCredit).gt(0) && (
                  <Row label={t('sales.fields.tradeInCredit')}>
                    <Money value={s.tradeInCredit} />
                  </Row>
                )}
                {d(s.depositTransferred).gt(0) && (
                  <Row label={t('sales.fields.depositTransferred')}>
                    <Money value={s.depositTransferred} />
                  </Row>
                )}
                <Row label={t('sales.money.held')} tone="success">
                  <Money value={s.money.held} />
                </Row>
                {!closed && (
                  <>
                    <Row label={t('sales.fields.dueBeforeDelivery')}>
                      <Money value={s.money.dueBeforeDelivery} />
                    </Row>
                    <Row label={t('sales.money.outstanding')} tone={d(outstanding).gt(0) ? 'warning' : undefined} strong>
                      <Money value={outstanding} />
                    </Row>
                  </>
                )}
                <Row label={t('sales.money.receivable')}>
                  {s.money.receivable === null ? <span className="text-xs text-muted">{t('sales.money.notRecognized')}</span> : <Money value={s.money.receivable} />}
                </Row>
                {closed && (
                  <Row label={t('sales.money.refundable')} strong>
                    <Money value={s.money.refundable} />
                  </Row>
                )}
              </dl>
              {s.paymentType === 'installments' && <p className="mt-2 text-xs text-muted">{t('sales.money.installmentsNote')}</p>}
            </CardBody>
          </Card>

          {/* Profit (only for users who may see cost) */}
          {(s.costAtConfirmation !== null || s.grossProfit !== null) && (
            <Card>
              <CardHeader title={t('sales.detail.profit')} />
              <CardBody className="pt-2">
                <dl className="divide-y divide-line">
                  {s.costAtConfirmation !== null && (
                    <Row label={t('sales.fields.costAtConfirmation')}>
                      <Money value={s.costAtConfirmation} />
                    </Row>
                  )}
                  {s.cogsAmount !== null && (
                    <Row label={t('sales.fields.cogs')}>
                      <Money value={s.cogsAmount} />
                    </Row>
                  )}
                  {s.grossProfit !== null && (
                    <Row label={t('sales.fields.grossProfit')} strong tone={d(s.grossProfit).lt(0) ? 'danger' : 'success'}>
                      <Money value={s.grossProfit} />
                    </Row>
                  )}
                </dl>
              </CardBody>
            </Card>
          )}

          {/* External finance */}
          {ef && (
            <Card>
              <CardHeader
                title={t('sales.ef.panel')}
                actions={<Badge tone={ef.status === 'approved' ? 'success' : ef.status === 'rejected' ? 'danger' : 'warning'}>{t(`sales.efStatus.${ef.status}`)}</Badge>}
              />
              <CardBody>
                <DescriptionList
                  items={[
                    { label: t('sales.fields.efProvider'), value: ef.provider },
                    { label: t('sales.fields.efReference'), value: ef.reference || '—' },
                    { label: t('sales.fields.efAmount'), value: <Money value={ef.amount} /> },
                    { label: t('sales.ef.decidedAt'), value: ef.decidedAt ? fmtDateTime(ef.decidedAt) : '—' },
                    ...(ef.note ? [{ label: t('common.notes'), value: ef.note, full: true }] : []),
                  ]}
                />
              </CardBody>
            </Card>
          )}

          {/* Installment plan */}
          {s.paymentType === 'installments' && (
            <Card>
              <CardHeader title={t('sales.detail.plan')} actions={s.installmentPlan && <PlanStatusBadge status={s.installmentPlan.status} />} />
              <CardBody>
                {s.installmentPlan ? (
                  <>
                    <DescriptionList
                      items={[
                        { label: t('sales.fields.instMethod'), value: t(`sales.instMethod.${s.installmentPlan.method}`) },
                        { label: t('sales.fields.count'), value: <span className="num">{fmtNumber(s.installmentPlan.count)}</span> },
                        { label: t('sales.preview.totalPayable'), value: <Money value={s.installmentPlan.totalAmount} />, full: true },
                      ]}
                    />
                    <Can perm="installments.read">
                      <Link to={`/app/installments/${s.installmentPlan.id}`} className="mt-4 inline-flex text-sm font-medium text-brand-strong hover:underline">
                        {t('sales.detail.openPlan')}
                      </Link>
                    </Can>
                  </>
                ) : (
                  s.installmentTerms && (
                    <>
                      <DescriptionList
                        items={[
                          { label: t('sales.fields.instMethod'), value: t(`sales.instMethod.${s.installmentTerms.method}`) },
                          { label: t('sales.fields.annualRate'), value: fmtPct(s.installmentTerms.annualRatePct, 2) },
                          { label: t('sales.fields.count'), value: <span className="num">{fmtNumber(s.installmentTerms.count)}</span> },
                          { label: t('sales.fields.frequency'), value: t(`sales.frequency.m${s.installmentTerms.frequencyMonths}`) },
                          { label: t('sales.fields.firstDueDate'), value: fmtDate(s.installmentTerms.firstDueDate) },
                        ]}
                      />
                      <p className="mt-3 text-xs text-muted">{t('sales.detail.planAtConfirmation')}</p>
                    </>
                  )
                )}
              </CardBody>
            </Card>
          )}

          {/* Commission */}
          {s.commission && (
            <Card>
              <CardHeader title={t('sales.detail.commission')} actions={<CommissionStatusBadge status={s.commission.status} />} />
              <CardBody>
                <DescriptionList
                  items={[
                    { label: t('commissions.fields.amount'), value: <Money value={s.commission.amount} className="font-semibold" /> },
                    { label: t('commissions.fields.base'), value: <Money value={s.commission.baseAmount} /> },
                    { label: t('commissions.fields.earnOn'), value: t(`commissions.earnOn.${s.commission.earnOn}`) },
                    { label: t('commissions.fields.explanation'), value: commissionRuleText(s.commission.ruleSnapshot, t) ?? s.commission.explanation ?? '—', full: true },
                  ]}
                />
                {canAny('commissions.read', 'commissions.read_own') && (
                  <Link to={`/app/commissions?saleId=${s.id}`} className="mt-4 inline-flex text-sm font-medium text-brand-strong hover:underline">
                    {t('sales.detail.openCommission')}
                  </Link>
                )}
              </CardBody>
            </Card>
          )}

          {/* Parties */}
          <Card>
            <CardHeader title={t('sales.detail.parties')} />
            <CardBody>
              <DescriptionList
                columns={1}
                items={[
                  {
                    label: t('sales.fields.vehicle'),
                    value: (
                      <Link to={`/app/vehicles/${s.vehicleId}`} className="font-medium text-brand-strong hover:underline">
                        {title}
                      </Link>
                    ),
                  },
                  {
                    label: t('sales.detail.vehicleIds'),
                    value: <span className="num">{[s.vehicleSnapshot.stockNumber, s.vehicleSnapshot.vin, s.vehicleSnapshot.plateNumber].filter(Boolean).join(' · ')}</span>,
                  },
                  { label: t('sales.fields.customer'), value: s.customerSnapshot.fullName },
                  { label: t('common.phone'), value: s.customerSnapshot.phone ? <span dir="ltr" className="num">{s.customerSnapshot.phone}</span> : '—' },
                  { label: t('sales.fields.salesperson'), value: s.salespersonName ?? '—' },
                  ...(s.notes ? [{ label: t('common.notes'), value: s.notes }] : []),
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Dialogs */}
      {dialog?.kind === 'approve' && <ApproveSaleModal sale={s} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'reject' && <RejectSaleModal sale={s} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'confirm' && <ConfirmSaleModal sale={s} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'ef' && <ExternalFinanceModal sale={s} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'deliver' && <DeliverModal sale={s} onClose={close} onReload={onReload} onIssueInvoice={() => setDialog({ kind: 'issue', type: 'invoice' })} />}
      {dialog?.kind === 'cancel' && <CancelSaleModal sale={s} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'return' && <ReturnSaleModal sale={s} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'refund' && <RefundRequestModal sale={s} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'addTradeIn' && <AddTradeInModal sale={s} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'issue' && <IssueDocumentModal sale={s} initialType={dialog.type} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'voidDoc' && <VoidDocumentModal sale={s} docId={dialog.id} docLabel={dialog.label} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'removeTradeIn' && <RemoveTradeInModal sale={s} tradeInId={dialog.id} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'voidPayment' && <VoidPaymentModal receiptId={dialog.id} number={dialog.number} onClose={close} onReload={onReload} />}
      {dialog?.kind === 'pay' && (
        <ReceivePaymentModal
          title={t('sales.payment.title', { number: s.number })}
          description={s.recognizedAt ? t('sales.payment.afterRecognition') : t('sales.payment.beforeRecognition')}
          customerId={s.customerId}
          targetType="sale"
          targetId={s.id}
          defaultAmount={outstanding}
          maxBase={outstanding}
          onClose={close}
        />
      )}
    </>
  );
}

function TimelineItem({ label, at, note, tone }: { label: string; at: string; note?: string; tone?: 'danger' }) {
  return (
    <li className="relative">
      <span aria-hidden className={`absolute -start-[21px] top-1.5 h-2.5 w-2.5 rounded-full ${tone === 'danger' ? 'bg-danger' : 'bg-brand'}`} />
      <p className="font-medium text-ink">{label}</p>
      <p className="text-xs text-muted">{fmtDateTime(at)}</p>
      {note && <p className="mt-0.5 text-[13px] text-muted">{note}</p>}
    </li>
  );
}

function TradeInRow({ x, onRemove }: { x: TradeIn; onRemove?: () => void }) {
  const { t, i18n } = useTranslation();
  const makes = useMakes();
  const models = useModels(x.vehicleInput.makeId ?? null);
  const name = (n?: { nameEn: string; nameAr: string }) => (n ? (i18n.language === 'en' ? n.nameEn : n.nameAr) : '');
  const make = makes.data?.find((m) => m.id === x.vehicleInput.makeId);
  const model = models.data?.find((m) => m.id === x.vehicleInput.modelId);
  const label = [name(make), name(model), x.vehicleInput.modelYear].filter(Boolean).join(' ') || t('sales.tradeIn.vehicle');
  const tone = x.status === 'received' ? 'success' : x.status === 'cancelled' ? 'danger' : 'warning';
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <p className="font-medium">
          {x.vehicleId ? (
            <Link to={`/app/vehicles/${x.vehicleId}`} className="text-brand-strong hover:underline">
              {label}
            </Link>
          ) : (
            label
          )}
        </p>
        <p className="num text-xs text-muted">
          {[
            x.vehicleInput.vin,
            x.vehicleInput.odometerValue !== undefined ? `${fmtNumber(x.vehicleInput.odometerValue)} ${t(`sales.tradeIn.${x.vehicleInput.odometerUnit ?? 'km'}`)}` : null,
            x.vehicleInput.exteriorColor,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {x.notes && <p className="mt-0.5 text-xs text-muted">{x.notes}</p>}
      </div>
      <div className="flex items-center gap-3">
        <Money value={x.agreedValue} className="font-semibold" />
        <Badge tone={tone}>{t(`sales.tradeInStatus.${x.status}`)}</Badge>
        {onRemove && (
          <Button size="icon" variant="ghost" aria-label={t('common.delete')} onClick={onRemove}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </li>
  );
}
