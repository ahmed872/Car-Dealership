import { Check, Hourglass, Layers, Plus, ShoppingCart, Undo2, Wallet, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, StatCard } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Field, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import type { VehicleDetail } from '@/features/vehicles/api';
import { vehicleTitle } from '@/features/vehicles/components';
import { newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney, fmtPct } from '@/lib/format';
import { useApiMutation } from '@/lib/hooks';
import { categoryName, useVehicleCosts, VehicleCostItem } from './api';
import { CostStatusBadge, Row } from './components';
import { CostFormModal } from './CostFormModal';

function pctOf(part: string, total: string): string | null {
  if (d(total).isZero()) return null;
  return d(part).dividedBy(total).times(100).toFixed(1);
}

/** Why a posted cost cannot be reversed from here (server rules in CostsService.reverse). */
function reverseBlock(c: VehicleCostItem, costLocked: boolean): 'acquisition' | 'paid' | 'locked' | null {
  if (c.sourceType === 'acquisition') return 'acquisition';
  if (costLocked && !c.postSale) return 'locked';
  if (c.paidBase && d(c.paidBase).gt(0)) return 'paid';
  return null;
}

function SummarySkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

/** Vehicle 360 → Costs: totals, breakdown, expected profit and the cost items with their actions. */
export function VehicleCostsTab({ d: vd }: { d: VehicleDetail }) {
  const { t, i18n } = useTranslation();
  const { can, me, currency } = useAuth();
  const v = vd.vehicle;
  const q = useVehicleCosts(v.id);
  const [adding, setAdding] = useState(false);
  const [approving, setApproving] = useState<VehicleCostItem | null>(null);
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState<VehicleCostItem | null>(null);
  const [reversing, setReversing] = useState<{ item: VehicleCostItem; key: string } | null>(null);

  const invalidate = [
    ['vehicle-costs', v.id],
    ['vehicle', v.id],
    ['vehicles'],
    ['approvals'],
    ['approvals-summary'],
  ];
  const approve = useApiMutation<{ id: string; note: string | null }>({
    path: (x) => `/vehicle-costs/${x.id}/approve`,
    body: (x) => ({ note: x.note }),
    invalidate,
    success: t('costs.success.approved'),
    onSuccess: () => setApproving(null),
  });
  const reject = useApiMutation<{ id: string; reason: string }>({
    path: (x) => `/vehicle-costs/${x.id}/reject`,
    body: (x) => ({ reason: x.reason }),
    invalidate,
    success: t('costs.success.rejected'),
    onSuccess: () => setRejecting(null),
  });
  const reverse = useApiMutation<{ id: string; reason: string }>({
    path: (x) => `/vehicle-costs/${x.id}/reverse`,
    body: (x) => ({ reason: x.reason }),
    idempotent: true,
    invalidate,
    success: t('costs.success.reversed'),
    onSuccess: () => setReversing(null),
  });

  if (q.isLoading) return <SummarySkeleton />;
  if (q.error || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  const s = q.data;
  const cur = s.currency ?? currency;
  const costLocked = !!s.costLockedAt;
  const removed = v.status === 'removed';
  const title = vehicleTitle(
    {
      modelYear: v.modelYear,
      trim: v.trim,
      makeNameEn: vd.make.nameEn,
      makeNameAr: vd.make.nameAr,
      modelNameEn: vd.model.nameEn,
      modelNameAr: vd.model.nameAr,
    },
    i18n.language,
  );
  const exp = s.expectedAtAskingPrice;
  const userId = me?.user.id;

  const actionsFor = (c: VehicleCostItem) => {
    if (c.status === 'pending_approval') {
      if (!can('costs.approve')) return null;
      const own = !!userId && c.createdBy === userId;
      return (
        <div className="flex items-center justify-end gap-1 whitespace-nowrap">
          {own ? (
            <span title={t('costs.awaitingOtherHint')}>
              <Badge tone="info">{t('costs.awaitingOther')}</Badge>
            </span>
          ) : (
            <Button
              size="sm"
              variant="success"
              icon={<Check className="h-4 w-4" />}
              onClick={() => {
                setNote('');
                setApproving(c);
              }}
            >
              {t('costs.actions.approve')}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('costs.actions.reject')}
            title={t('costs.actions.reject')}
            onClick={() => setRejecting(c)}
          >
            <X className="h-4 w-4 text-danger" />
          </Button>
        </div>
      );
    }
    if (c.status === 'posted' && can('costs.reverse')) {
      const block = reverseBlock(c, costLocked);
      if (block)
        return (
          <span className="block min-w-[120px] max-w-[160px] text-end text-xs text-muted">
            {t(`costs.reverseBlocked.${block}`)}
          </span>
        );
      return (
        <Button
          size="sm"
          variant="ghost"
          icon={<Undo2 className="h-4 w-4" />}
          onClick={() => setReversing({ item: c, key: newIdempotencyKey() })}
        >
          {t('costs.actions.reverse')}
        </Button>
      );
    }
    return null;
  };

  return (
    <div className="space-y-5">
      {removed ? (
        <Alert tone="warning">{t('costs.vehicleRemoved')}</Alert>
      ) : (
        costLocked && <Alert tone="info">{t('costs.costLocked')}</Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('costs.totals.posted')}
          value={fmtMoney(s.totals.posted, cur)}
          hint={t('costs.totals.postedHint')}
          icon={<Wallet className="h-5 w-5" />}
          tone="brand"
        />
        <StatCard
          label={t('costs.totals.pending')}
          value={fmtMoney(s.totals.pending, cur)}
          hint={t('costs.totals.pendingHint')}
          icon={<Hourglass className="h-5 w-5" />}
          tone={d(s.totals.pending).gt(0) ? 'warning' : 'default'}
        />
        <StatCard
          label={t('costs.totals.purchase')}
          value={fmtMoney(s.totals.purchase, cur)}
          icon={<ShoppingCart className="h-5 w-5" />}
        />
        <StatCard
          label={t('costs.totals.additional')}
          value={fmtMoney(s.totals.additional, cur)}
          hint={
            d(s.totals.postSale).gt(0)
              ? `${t('costs.totals.postSale')}: ${fmtMoney(s.totals.postSale, cur)}`
              : undefined
          }
          icon={<Wrench className="h-5 w-5" />}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('costs.byCategory.title')} />
          <CardBody>
            {s.byCategory.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted">{t('costs.byCategory.empty')}</p>
            ) : (
              <ul className="space-y-3">
                {[...s.byCategory]
                  .sort((a, b) => d(b.total).comparedTo(a.total))
                  .map((c) => {
                    const pct = pctOf(c.total, s.totals.posted);
                    return (
                      <li key={c.code}>
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate text-ink">{categoryName(c, i18n.language)}</span>
                          <span className="num shrink-0 font-medium">
                            {fmtMoney(c.total, cur)}
                            {pct && <span className="ms-2 text-xs text-muted">{fmtPct(pct)}</span>}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                          <div className="h-full rounded-full bg-brand" style={{ width: `${pct ?? 0}%` }} />
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={t('costs.expected.title')}
            subtitle={exp ? t('costs.expected.note') : undefined}
          />
          <CardBody>
            {exp ? (
              <div className="divide-y divide-line">
                <Row label={t('costs.expected.askingPrice')} value={fmtMoney(exp.price, cur)} />
                <Row label={t('costs.expected.tax')} value={fmtMoney(exp.tax, cur)} />
                <Row label={t('costs.expected.net')} value={fmtMoney(exp.net, cur)} />
                <Row label={t('costs.expected.cost')} value={fmtMoney(s.totals.posted, cur)} />
                <Row
                  label={t('costs.expected.grossProfit')}
                  strong
                  value={
                    <span className={d(exp.grossProfit).isNegative() ? 'text-danger' : 'text-success'}>
                      {fmtMoney(exp.grossProfit, cur)}
                    </span>
                  }
                />
                <Row
                  label={t('costs.expected.margin')}
                  value={exp.marginPct !== null ? fmtPct(exp.marginPct, 2) : '—'}
                />
              </div>
            ) : (
              <Alert tone="info">{t('costs.expected.noPrice')}</Alert>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={t('costs.items.title')}
          subtitle={t('costs.items.count', { count: s.items.length })}
          actions={
            can('costs.create') && (
              <>
                <Link
                  to="/app/costs/allocate"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium text-ink hover:bg-surface-2"
                >
                  <Layers className="h-4 w-4" /> {t('costs.actions.allocate')}
                </Link>
                {!removed && (
                  <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                    {t('costs.actions.add')}
                  </Button>
                )}
              </>
            )
          }
        />
        <DataTable
          rows={s.items}
          rowKey={(c) => c.id}
          empty={
            <EmptyState
              icon={<Wallet className="h-5 w-5" />}
              title={t('costs.items.empty')}
              description={t('costs.items.emptyHint')}
            />
          }
          columns={[
            {
              key: 'category',
              header: t('costs.items.category'),
              cell: (c) => (
                <div className="min-w-[130px]">
                  <p className="font-medium">{categoryName(c, i18n.language)}</p>
                  <p className="num text-xs text-muted">{fmtDate(c.costDate)}</p>
                  <p className="text-xs text-muted">
                    {t(`costs.source.${c.sourceType}`)}
                    {c.postSale && <span className="ms-1 text-warning">· {t('costs.items.postSale')}</span>}
                  </p>
                </div>
              ),
            },
            {
              key: 'description',
              header: t('costs.items.description'),
              cell: (c) => (
                <div className="min-w-[170px] max-w-[300px]">
                  <p className="break-words">{c.description}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {[
                      c.supplierName ??
                        (c.sourceType === 'acquisition' ? null : t('costs.items.directPurchase')),
                      c.createdByName && t('costs.items.createdBy', { name: c.createdByName }),
                    ]
                      .filter((x): x is string => !!x)
                      .map((x, i) => (
                        <span key={i}>
                          {i > 0 && ' · '}
                          <bdi>{x}</bdi>
                        </span>
                      ))}
                  </p>
                  {c.status === 'reversed' && c.reversalReason && (
                    <p className="mt-0.5 text-xs text-muted">
                      {t('costs.items.reversalReason', { reason: c.reversalReason })}
                    </p>
                  )}
                  {c.status === 'rejected' && c.rejectedReason && (
                    <p className="mt-0.5 text-xs text-danger">
                      {t('costs.items.rejectedReason', { reason: c.rejectedReason })}
                    </p>
                  )}
                </div>
              ),
            },
            {
              key: 'amount',
              header: t('costs.items.amount'),
              align: 'end',
              cell: (c) => (
                <div className="whitespace-nowrap">
                  <p
                    className={
                      c.status === 'reversed' || c.status === 'rejected'
                        ? 'num text-muted line-through'
                        : 'num font-medium'
                    }
                  >
                    {fmtMoney(c.amountBase, cur)}
                  </p>
                  {c.currency !== cur && (
                    <p className="num text-xs text-muted">
                      {fmtMoney(c.amount, c.currency)} ·{' '}
                      {t('costs.items.rate', { rate: d(c.exchangeRate).toString() })}
                    </p>
                  )}
                </div>
              ),
            },
            {
              key: 'paid',
              header: t('costs.items.payment'),
              align: 'end',
              hideOnMobile: true,
              cell: (c) =>
                c.status !== 'posted' ? (
                  <span className="text-subtle">—</span>
                ) : c.paidBase === null ? (
                  <span className="text-xs text-muted">{t('costs.items.paidViaAcquisition')}</span>
                ) : (
                  <div className="num whitespace-nowrap text-xs">
                    <p className="text-success">
                      {t('costs.items.paidValue', { amount: fmtMoney(c.paidBase, cur) })}
                    </p>
                    <p className={d(c.amountBase).minus(c.paidBase).gt(0) ? 'text-warning' : 'text-muted'}>
                      {t('costs.items.outstandingValue', {
                        amount: fmtMoney(d(c.amountBase).minus(c.paidBase).toFixed(2), cur),
                      })}
                    </p>
                  </div>
                ),
            },
            {
              key: 'status',
              header: t('costs.items.status'),
              cell: (c) => <CostStatusBadge status={c.status} />,
            },
            {
              key: 'actions',
              header: t('common.actions'),
              align: 'end',
              cell: (c) => actionsFor(c),
            },
          ]}
        />
      </Card>

      {adding && (
        <CostFormModal
          vehicleId={v.id}
          vehicleLabel={`${title} · ${v.stockNumber}`}
          costLocked={costLocked}
          onClose={() => setAdding(false)}
        />
      )}

      <Modal
        open={!!approving}
        onClose={() => setApproving(null)}
        size="sm"
        title={t('costs.approve.title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setApproving(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="success"
              loading={approve.isPending}
              onClick={() => approving && approve.mutate({ id: approving.id, note: note.trim() || null })}
            >
              {t('costs.approve.confirm')}
            </Button>
          </>
        }
      >
        {approving && (
          <div className="space-y-4">
            <div className="rounded-xl border border-line bg-surface-2/50 p-3 text-sm">
              <p className="font-medium">{categoryName(approving, i18n.language)}</p>
              <p className="text-muted">{approving.description}</p>
              <p className="num mt-1 font-semibold">{fmtMoney(approving.amountBase, cur)}</p>
            </div>
            <p className="text-sm text-muted">
              {t(costLocked ? 'costs.approve.messagePostSale' : 'costs.approve.message', {
                amount: fmtMoney(approving.amountBase, cur),
              })}
            </p>
            <Field label={t('costs.approve.note')}>
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
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title={t('costs.reject.title')}
        message={t('costs.reject.message')}
        confirmLabel={t('costs.actions.reject')}
        tone="danger"
        requireReason
        loading={reject.isPending}
        onConfirm={(reason) => {
          if (rejecting) reject.mutate({ id: rejecting.id, reason });
        }}
      />
      <ConfirmDialog
        open={!!reversing}
        onClose={() => setReversing(null)}
        title={t('costs.reverse.title')}
        message={
          reversing
            ? t('costs.reverse.message', { amount: fmtMoney(reversing.item.amountBase, cur) })
            : undefined
        }
        confirmLabel={t('costs.actions.reverse')}
        tone="danger"
        requireReason
        loading={reverse.isPending}
        onConfirm={(reason) => {
          if (reversing) reverse.mutate({ id: reversing.item.id, reason, __idemKey: reversing.key });
        }}
      />
    </div>
  );
}
