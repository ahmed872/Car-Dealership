import { Check, ExternalLink, Inbox, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Field, Textarea } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { FEATURE_MODULES } from '@/features/modules';
import { newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { useApi, useApiMutation, useListParams } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';

type ApprovalType =
  | 'acquisition'
  | 'vehicle_cost'
  | 'expense'
  | 'work_order'
  | 'sale_discount'
  | 'sale_below_floor'
  | 'refund'
  | 'cash_adjustment';
const TYPES: ApprovalType[] = [
  'acquisition',
  'vehicle_cost',
  'expense',
  'work_order',
  'refund',
  'sale_discount',
  'sale_below_floor',
  'cash_adjustment',
];

interface ApprovalItem {
  id: string;
  type: ApprovalType;
  entityType: string;
  entityId: string;
  summary: string;
  payload: { vehicleId?: string; amountBase?: string; itemCount?: number } | null;
  requestedAt: string;
  requestedBy: string | null;
  requestedById: string | null;
  branchId: string | null;
  canDecide: boolean;
}

interface Summary {
  total: number;
  byType: Record<string, number>;
  truncated: boolean;
}

/** Decision routes the API exposes per document type (approve body: { note }, reject body: { reason }). */
const DECISION_BASE: Partial<Record<ApprovalType, string>> = {
  acquisition: '/acquisitions',
  vehicle_cost: '/vehicle-costs',
  expense: '/expenses',
  work_order: '/work-orders',
  refund: '/refunds',
};

/** Types whose own page can also settle the document on approval (pay now). */
const PAY_ON_PAGE: ReadonlySet<ApprovalType> = new Set(['acquisition', 'work_order']);

const typeTone: Record<ApprovalType, Tone> = {
  acquisition: 'brand',
  vehicle_cost: 'info',
  expense: 'accent',
  work_order: 'warning',
  refund: 'danger',
  sale_discount: 'neutral',
  sale_below_floor: 'neutral',
  cash_adjustment: 'neutral',
};

/** Paths registered by the app (base vehicle routes + every feature module), to link only to pages that exist. */
function registeredPaths(): string[] {
  const paths = ['vehicles/:id'];
  for (const m of FEATURE_MODULES)
    for (const r of m.routes ?? []) if (r.path) paths.push(r.path.replace(/^\//, ''));
  return paths;
}

/**
 * The page of a document, wherever its feature mounted it (e.g. `purchasing/acquisitions/:id`):
 * first a detail route `…/<segment>/:id`, else the feature's list `…/<segment>`.
 */
function routeFor(paths: string[], segment: string, id: string): string | null {
  const detail = paths.find((p) => p === `${segment}/:id` || p.endsWith(`/${segment}/:id`));
  if (detail) return `/app/${detail.replace(':id', id)}`;
  const list = paths.find((p) => p === segment || p.endsWith(`/${segment}`));
  return list ? `/app/${list}` : null;
}

function documentLink(a: ApprovalItem, paths: string[]): string | null {
  switch (a.type) {
    case 'acquisition':
      return routeFor(paths, 'acquisitions', a.entityId);
    case 'vehicle_cost':
      return a.payload?.vehicleId ? `/app/vehicles/${a.payload.vehicleId}` : null;
    case 'work_order':
      return routeFor(paths, 'work-orders', a.entityId);
    case 'expense':
      return routeFor(paths, 'expenses', a.entityId);
    case 'refund':
      return routeFor(paths, 'refunds', a.entityId);
    default:
      return null;
  }
}

export function ApprovalsPage() {
  const { t } = useTranslation();
  const { currency } = useAuth();
  const lp = useListParams();
  const type = (lp.get('type') || 'all') as ApprovalType | 'all';
  const list = useApi<ApprovalItem[]>(['approvals'], '/approvals');
  const summary = useApi<Summary>(['approvals-summary'], '/approvals/summary');
  const branches = useBranches();
  const paths = useMemo(registeredPaths, []);
  const [approving, setApproving] = useState<{ item: ApprovalItem; key: string } | null>(null);
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState<ApprovalItem | null>(null);

  const invalidate = [
    ['approvals'],
    ['approvals-summary'],
    ['vehicle-costs'],
    ['vehicle'],
    ['work-order'],
    ['work-orders'],
    ['vehicle-work-orders'],
    ['acquisitions'],
    ['acquisition'],
    ['expenses'],
    ['expense'],
    ['refunds'],
    ['cash-accounts'],
  ];
  const approve = useApiMutation<{ path: string; note: string | null }>({
    path: (v) => v.path,
    body: (v) => ({ note: v.note }),
    idempotent: true,
    invalidate,
    success: t('approvals.success.approved'),
    onSuccess: () => setApproving(null),
  });
  const reject = useApiMutation<{ path: string; reason: string }>({
    path: (v) => v.path,
    body: (v) => ({ reason: v.reason }),
    invalidate,
    success: t('approvals.success.rejected'),
    onSuccess: () => setRejecting(null),
  });

  const counts = summary.data?.byType ?? {};
  const total = summary.data?.total ?? list.data?.length ?? 0;
  const tabTypes = TYPES.filter((x) => (counts[x] ?? 0) > 0 || x === type);
  const rows = list.data?.filter((a) => type === 'all' || a.type === type);
  const branchName = (id: string | null) =>
    id ? (branches.data?.find((b) => b.id === id)?.name ?? '—') : t('approvals.companyWide');
  const typeLabel = (x: ApprovalType) => t(`approvals.types.${x}`);

  const docLink = (a: ApprovalItem) => {
    const href = documentLink(a, paths);
    return href ? (
      <Link
        to={href}
        className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-brand-strong hover:underline"
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden /> {t('approvals.open')}
      </Link>
    ) : (
      <p className="mt-0.5 text-xs text-subtle">{t('approvals.noLink')}</p>
    );
  };
  const amountOf = (a: ApprovalItem) =>
    a.payload?.amountBase ? fmtMoney(a.payload.amountBase, currency) : '—';

  /** Decision buttons, or why the caller cannot decide (maker-checker / no inbox decision route). */
  const actions = (a: ApprovalItem, mobile = false) => {
    if (!a.canDecide) {
      return (
        <div className={mobile ? '' : 'ms-auto max-w-[220px] text-end'}>
          <Badge tone="info">{t('approvals.awaitingOther')}</Badge>
          <p className="mt-1 text-xs text-muted">{t('approvals.awaitingOtherHint')}</p>
        </div>
      );
    }
    if (!DECISION_BASE[a.type]) {
      const href = documentLink(a, paths);
      return href ? (
        <Link to={href} className="text-[13px] font-medium text-brand-strong hover:underline">
          {t('approvals.open')}
        </Link>
      ) : (
        <span className="text-xs text-muted">{t('approvals.decideOnPage')}</span>
      );
    }
    return (
      <div className={mobile ? 'flex gap-2' : 'flex justify-end gap-1'}>
        <Button
          size="sm"
          variant="success"
          icon={<Check className="h-4 w-4" />}
          onClick={() => {
            setNote('');
            setApproving({ item: a, key: newIdempotencyKey() });
          }}
        >
          {t('approvals.approve')}
        </Button>
        <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => setRejecting(a)}>
          {a.type === 'work_order' ? t('approvals.sendBack') : t('approvals.reject')}
        </Button>
      </div>
    );
  };

  const empty = (
    <EmptyState
      icon={<Inbox className="h-5 w-5" />}
      title={t('approvals.empty')}
      description={t('approvals.emptyHint')}
    />
  );

  return (
    <>
      <PageHeader title={t('approvals.title')} subtitle={t('approvals.subtitle')} />
      <Card>
        <div className="px-4 pt-2">
          <Tabs<string>
            value={type}
            onChange={(k) => lp.set({ type: k === 'all' ? null : k })}
            tabs={[
              { key: 'all', label: t('approvals.all'), count: total },
              ...tabTypes.map((x) => ({ key: x, label: typeLabel(x), count: counts[x] ?? 0 })),
            ]}
          />
        </div>
        {/* Phones: one card per request so the decision buttons stay in view. */}
        <div className="md:hidden">
          {list.error ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : list.isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          ) : !rows?.length ? (
            empty
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((a) => (
                <li key={a.id} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <Badge tone={typeTone[a.type] ?? 'neutral'}>{typeLabel(a.type)}</Badge>
                    <span className="num whitespace-nowrap font-semibold">{amountOf(a)}</span>
                  </div>
                  <div>
                    <p className="break-words font-medium">
                      <bdi>{a.summary}</bdi>
                    </p>
                    <p className="text-xs text-muted">
                      <bdi>{a.requestedBy ?? '—'}</bdi> ·{' '}
                      <span className="num">{fmtDateTime(a.requestedAt)}</span> · {branchName(a.branchId)}
                    </p>
                    {docLink(a)}
                  </div>
                  {actions(a, true)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="hidden md:block">
          <DataTable
            rows={rows}
            loading={list.isLoading}
            error={list.error}
            onRetry={() => list.refetch()}
            rowKey={(a) => a.id}
            empty={empty}
            columns={[
              {
                key: 'type',
                header: t('approvals.columns.type'),
                cell: (a) => <Badge tone={typeTone[a.type] ?? 'neutral'}>{typeLabel(a.type)}</Badge>,
              },
              {
                key: 'summary',
                header: t('approvals.columns.summary'),
                cell: (a) => (
                  <div className="min-w-[200px] max-w-[360px]">
                    <p className="break-words font-medium">
                      <bdi>{a.summary}</bdi>
                    </p>
                    {docLink(a)}
                  </div>
                ),
              },
              {
                key: 'amount',
                header: t('approvals.columns.amount'),
                align: 'end',
                cell: (a) => <span className="num whitespace-nowrap font-semibold">{amountOf(a)}</span>,
              },
              {
                key: 'requested',
                header: t('approvals.columns.requestedBy'),
                cell: (a) => (
                  <div className="whitespace-nowrap">
                    <p>
                      <bdi>{a.requestedBy ?? '—'}</bdi>
                    </p>
                    <p className="num text-xs text-muted">{fmtDateTime(a.requestedAt)}</p>
                  </div>
                ),
              },
              {
                key: 'branch',
                header: t('approvals.columns.branch'),
                cell: (a) => <span className="whitespace-nowrap">{branchName(a.branchId)}</span>,
              },
              {
                key: 'actions',
                header: t('approvals.columns.actions'),
                align: 'end',
                cell: (a) => actions(a),
              },
            ]}
          />
        </div>
      </Card>

      <Modal
        open={!!approving}
        onClose={() => setApproving(null)}
        size="sm"
        title={approving ? t('approvals.approveDialog.title', { type: typeLabel(approving.item.type) }) : ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => setApproving(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="success"
              loading={approve.isPending}
              onClick={() => {
                if (!approving) return;
                approve.mutate({
                  path: `${DECISION_BASE[approving.item.type]}/${approving.item.entityId}/approve`,
                  note: note.trim() || null,
                  __idemKey: approving.key,
                });
              }}
            >
              {t('approvals.approveDialog.confirm')}
            </Button>
          </>
        }
      >
        {approving && (
          <div className="space-y-4">
            <div className="rounded-xl border border-line bg-surface-2/50 p-3 text-sm">
              <p className="font-medium">
                <bdi>{approving.item.summary}</bdi>
              </p>
              {approving.item.payload?.amountBase && (
                <p className="num mt-1 font-semibold">
                  {fmtMoney(approving.item.payload.amountBase, currency)}
                </p>
              )}
              <p className="mt-1 text-xs text-muted">
                {approving.item.requestedBy ?? '—'} · {fmtDateTime(approving.item.requestedAt)}
              </p>
            </div>
            <p className="text-sm text-muted">
              {approving.item.type === 'refund'
                ? t('approvals.approveDialog.refundMessage')
                : t('approvals.approveDialog.message')}
            </p>
            {PAY_ON_PAGE.has(approving.item.type) && (
              <p className="text-[13px] text-muted">{t('approvals.approveDialog.payNowHint')}</p>
            )}
            <Field label={t('approvals.approveDialog.note')}>
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
        title={rejecting ? t('approvals.rejectDialog.title', { type: typeLabel(rejecting.type) }) : ''}
        message={
          rejecting
            ? rejecting.type === 'work_order'
              ? t('approvals.rejectDialog.workOrderMessage')
              : t('approvals.rejectDialog.message')
            : undefined
        }
        confirmLabel={rejecting?.type === 'work_order' ? t('approvals.sendBack') : t('approvals.reject')}
        tone="danger"
        requireReason
        loading={reject.isPending}
        onConfirm={(reason) => {
          if (rejecting)
            reject.mutate({ path: `${DECISION_BASE[rejecting.type]}/${rejecting.entityId}/reject`, reason });
        }}
      />
    </>
  );
}
