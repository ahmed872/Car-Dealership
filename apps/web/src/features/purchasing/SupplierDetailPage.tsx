import { useMutation } from '@tanstack/react-query';
import { CircleDollarSign, CreditCard, Eye, EyeOff, FileClock, Pencil, Plus, Power, ReceiptText, Wallet } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { d } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList, StatCard } from '@/components/ui/Card';
import { DataTable, Pagination } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { ConfirmDialog } from '@/components/ui/Modal';
import { api, ApiError } from '@/lib/api';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate, fmtNumber } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import {
  AcquisitionListItem,
  OpenPayablesResponse,
  Paged,
  Supplier,
  SupplierDetail,
  SupplierPaymentListItem,
  SupplierSensitive,
  SupplierStatement,
  useApAccess,
  useSupplier,
} from './api';
import {
  AcquisitionStatusBadge,
  acquisitionVehicleTitle,
  DateRange,
  documentHref,
  Money,
  PaymentStatusBadge,
  SupplierFormModal,
  TargetTypeBadge,
  useTenantMoney,
} from './components';
import { usePurchasingError, usePurchasingMutation } from './mutation';

type TabKey = 'overview' | 'open' | 'acquisitions' | 'payments' | 'statement';

/** Masked national ID with an audited "reveal" for suppliers.view_sensitive holders (D-047). */
function NationalIdValue({ s }: { s: Supplier }) {
  const { t } = useTranslation();
  const describe = usePurchasingError();
  const [shown, setShown] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () => api<SupplierSensitive>(`/suppliers/${s.id}/sensitive`),
    onSuccess: (r) => setShown(r.nationalId),
  });
  if (!s.hasNationalId) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <bdi dir="ltr" className="num font-medium tracking-wide">
        {shown ?? s.nationalIdMasked}
      </bdi>
      <Can perm="suppliers.view_sensitive">
        {shown ? (
          <button type="button" onClick={() => setShown(null)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
            <EyeOff className="h-3.5 w-3.5" aria-hidden /> {t('purchasing.suppliers.hide')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => reveal.mutate()}
            disabled={reveal.isPending}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-strong hover:underline disabled:opacity-50"
            title={t('purchasing.suppliers.revealHint')}
          >
            <Eye className="h-3.5 w-3.5" aria-hidden /> {t('purchasing.suppliers.reveal')}
          </button>
        )}
      </Can>
      {reveal.error ? <span className="text-xs text-danger">{describe(reveal.error)}</span> : null}
    </span>
  );
}

function OpenDocuments({ supplierId }: { supplierId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { base } = useTenantMoney();
  const ap = useApAccess();
  const q = useApi<OpenPayablesResponse>(['payables-open', supplierId], '/payables/open', { supplierId });
  return (
    <DataTable
      rows={q.data?.items}
      loading={q.isLoading}
      error={q.error}
      onRetry={() => q.refetch()}
      rowKey={(r) => `${r.targetType}:${r.targetId}`}
      empty={<EmptyState icon={<ReceiptText className="h-5 w-5" />} title={t('purchasing.payables.noOpen')} />}
      columns={[
        {
          key: 'doc',
          header: t('purchasing.payables.document'),
          cell: (r) => {
            const href = documentHref(r.targetType, r.targetId, r.vehicleId);
            return (
              <div className="min-w-0 space-y-1">
                <TargetTypeBadge type={r.targetType} />
                <p className="truncate font-medium">
                  {href ? (
                    <Link to={href} className="hover:underline">
                      {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                </p>
              </div>
            );
          },
        },
        { key: 'date', header: t('purchasing.payables.docDate'), cell: (r) => fmtDate(r.docDate) },
        { key: 'due', header: t('purchasing.payables.dueDate'), hideOnMobile: true, cell: (r) => fmtDate(r.dueDate) },
        { key: 'total', header: t('common.total'), align: 'end', hideOnMobile: true, cell: (r) => <Money value={r.totalBase} currency={base} /> },
        { key: 'paid', header: t('purchasing.payables.paid'), align: 'end', hideOnMobile: true, cell: (r) => <Money value={r.paidBase} currency={base} /> },
        {
          key: 'outstanding',
          header: t('purchasing.payables.outstanding'),
          align: 'end',
          cell: (r) => <Money value={r.outstandingBase} currency={base} className="font-semibold text-warning" />,
        },
        {
          key: 'pay',
          header: <span className="sr-only">{t('purchasing.payments.add')}</span>,
          // Keeps the absolutely positioned sr-only header inside the table's scroll area on phones.
          className: 'relative',
          align: 'end',
          cell: (r) =>
            ap.pay ? (
              <Button size="sm" variant="secondary" onClick={() => navigate(`/app/purchasing/payments/new?supplierId=${supplierId}&target=${r.targetType}:${r.targetId}`)}>
                {t('purchasing.payments.pay')}
              </Button>
            ) : null,
        },
      ]}
      footer={
        q.data && q.data.items.length > 0 ? (
          <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t border-line px-4 py-3 text-sm">
            <span className="text-muted">{t('purchasing.payables.totalOutstanding')}</span>
            <Money value={q.data.totals.outstandingBase} currency={base} className="font-semibold" />
          </div>
        ) : null
      }
    />
  );
}

function SupplierAcquisitions({ supplierId }: { supplierId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { base } = useTenantMoney();
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const q = useApi<Paged<AcquisitionListItem>>(['supplier-acquisitions', supplierId], '/acquisitions', { supplierId, page, pageSize }, { placeholderData: (p) => p });
  return (
    <DataTable
      rows={q.data?.items}
      loading={q.isLoading}
      error={q.error}
      onRetry={() => q.refetch()}
      rowKey={(a) => a.id}
      onRowClick={(a) => navigate(`/app/purchasing/acquisitions/${a.id}`)}
      empty={<EmptyState title={t('purchasing.suppliers.noAcquisitions')} />}
      columns={[
        {
          key: 'number',
          header: t('purchasing.acquisitions.number'),
          cell: (a) => (
            <div>
              <p className="num font-medium">{a.number}</p>
              <p className="text-xs text-muted">{fmtDate(a.purchaseDate)}</p>
            </div>
          ),
        },
        {
          key: 'vehicle',
          header: t('purchasing.acquisitions.vehicle'),
          cell: (a) => (
            <div className="min-w-0">
              <p className="truncate">{acquisitionVehicleTitle(a, i18n.language)}</p>
              <p className="num truncate text-xs text-muted">{a.stockNumber}</p>
            </div>
          ),
        },
        {
          key: 'price',
          header: t('purchasing.acquisitions.price'),
          align: 'end',
          cell: (a) => (
            <div>
              <Money value={a.purchasePrice} currency={a.currency} />
              {a.currency !== base && (
                <p className="text-xs text-muted">
                  <Money value={a.purchasePriceBase} currency={base} />
                </p>
              )}
            </div>
          ),
        },
        {
          key: 'outstanding',
          header: t('purchasing.acquisitions.outstanding'),
          align: 'end',
          hideOnMobile: true,
          cell: (a) => (a.outstandingBase === null ? <span className="text-subtle">—</span> : <Money value={a.outstandingBase} currency={base} />),
        },
        { key: 'status', header: t('common.status'), cell: (a) => <AcquisitionStatusBadge status={a.status} /> },
      ]}
      footer={q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
    />
  );
}

function SupplierPayments({ supplierId }: { supplierId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { base } = useTenantMoney();
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const q = useApi<Paged<SupplierPaymentListItem>>(['supplier-payments', 'supplier', supplierId], '/supplier-payments', { supplierId, page, pageSize }, { placeholderData: (p) => p });
  return (
    <DataTable
      rows={q.data?.items}
      loading={q.isLoading}
      error={q.error}
      onRetry={() => q.refetch()}
      rowKey={(p) => p.id}
      onRowClick={(p) => navigate(`/app/purchasing/payments/${p.id}`)}
      empty={<EmptyState title={t('purchasing.payments.empty')} />}
      columns={[
        {
          key: 'number',
          header: t('purchasing.payments.number'),
          cell: (p) => (
            <div>
              <p className="num font-medium">{p.number}</p>
              <p className="text-xs text-muted">{fmtDate(p.paidAt)}</p>
            </div>
          ),
        },
        { key: 'account', header: t('purchasing.payments.cashAccount'), hideOnMobile: true, cell: (p) => p.cashAccountName },
        { key: 'method', header: t('purchasing.payments.method'), hideOnMobile: true, cell: (p) => t(`purchasing.enums.method.${p.method}`) },
        {
          key: 'amount',
          header: t('common.amount'),
          align: 'end',
          cell: (p) => (
            <div className={p.status === 'voided' ? 'text-subtle line-through' : ''}>
              <Money value={p.amount} currency={p.currency} />
              {p.currency !== base && (
                <p className="text-xs text-muted">
                  <Money value={p.amountBase} currency={base} />
                </p>
              )}
            </div>
          ),
        },
        { key: 'status', header: t('common.status'), cell: (p) => <PaymentStatusBadge status={p.status} /> },
      ]}
      footer={q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
    />
  );
}

const STATEMENT_KINDS = ['acquisition', 'vehicle_cost', 'expense', 'supplier_payment'] as const;

function Statement({ supplierId }: { supplierId: string }) {
  const { t } = useTranslation();
  const describe = usePurchasingError();
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const invalidRange = !!range.from && !!range.to && range.from > range.to;
  const q = useApi<SupplierStatement>(
    ['supplier-statement', supplierId],
    invalidRange ? null : `/suppliers/${supplierId}/statement`,
    { from: range.from || undefined, to: range.to || undefined },
    { placeholderData: (p) => p, retry: false },
  );
  const s = q.data;
  const cur = s?.currency ?? 'SAR';
  const kind = (r: SupplierStatement['rows'][number]) => {
    const k = r.documentType && (STATEMENT_KINDS as readonly string[]).includes(r.documentType) ? r.documentType : null;
    const base = k ? t(`purchasing.statement.kind.${k}`) : r.description;
    return r.isReversal ? t('purchasing.statement.reversalOf', { kind: base }) : base;
  };
  const allBranchesRequired = q.error instanceof ApiError && q.error.code === 'all_branches_required';

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <DateRange from={range.from} to={range.to} onChange={(v) => setRange((r) => ({ ...r, ...v }))} />
        <p className="text-xs text-muted">{t('purchasing.statement.hint')}</p>
      </div>
      {invalidRange && (
        <Alert tone="warning" className="m-4">
          {t('purchasing.validation.to_before_from')}
        </Alert>
      )}
      {q.error ? (
        allBranchesRequired ? (
          <Alert tone="info" className="m-4" title={t('purchasing.statement.allBranchesTitle')}>
            {t('purchasing.errors.all_branches_required')}
          </Alert>
        ) : (
          <div className="p-4">
            <Alert tone="danger">{describe(q.error)}</Alert>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => q.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        )
      ) : (
        <>
          {s && (
            <div className="grid gap-3 border-b border-line px-4 py-3 sm:grid-cols-4">
              <Stat2 label={t('purchasing.statement.opening')} value={<Money value={s.openingBalance} currency={cur} />} />
              <Stat2 label={t('purchasing.statement.debit')} value={<Money value={s.totalDebit} currency={cur} />} />
              <Stat2 label={t('purchasing.statement.credit')} value={<Money value={s.totalCredit} currency={cur} />} />
              <Stat2 label={t('purchasing.statement.closing')} value={<Money value={s.closingBalance} currency={cur} className="font-semibold" />} />
            </div>
          )}
          <DataTable
            rows={s?.rows}
            loading={q.isLoading}
            rowKey={(r) => `${r.entryId}-${r.debit}-${r.credit}`}
            dense
            empty={<EmptyState icon={<FileClock className="h-5 w-5" />} title={t('purchasing.statement.empty')} />}
            columns={[
              { key: 'date', header: t('common.date'), cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.date)}</span> },
              {
                key: 'doc',
                header: t('purchasing.statement.document'),
                cell: (r) => {
                  const href =
                    r.documentType === 'acquisition' && r.documentId
                      ? `/app/purchasing/acquisitions/${r.documentId}`
                      : r.documentType === 'supplier_payment' && r.documentId
                        ? `/app/purchasing/payments/${r.documentId}`
                        : null;
                  return (
                    <div className="min-w-0">
                      <p className="text-xs text-muted">{kind(r)}</p>
                      <p className="truncate font-medium">
                        {href ? (
                          <Link to={href} className="hover:underline">
                            {r.label}
                          </Link>
                        ) : (
                          r.label
                        )}
                      </p>
                    </div>
                  );
                },
              },
              { key: 'entry', header: t('purchasing.statement.entryNo'), hideOnMobile: true, cell: (r) => <span className="num">#{r.entryNo}</span> },
              { key: 'debit', header: t('purchasing.statement.debit'), align: 'end', cell: (r) => (d(r.debit).isZero() ? '' : <Money value={r.debit} currency={cur} />) },
              { key: 'credit', header: t('purchasing.statement.credit'), align: 'end', cell: (r) => (d(r.credit).isZero() ? '' : <Money value={r.credit} currency={cur} />) },
              { key: 'balance', header: t('purchasing.statement.balance'), align: 'end', cell: (r) => <Money value={r.runningBalance} currency={cur} className="font-medium" /> },
            ]}
          />
        </>
      )}
    </div>
  );
}

function Stat2({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-sm">{value}</p>
    </div>
  );
}

export function SupplierDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const ap = useApAccess();
  const lp = useListParams({ tab: 'overview' });
  const q = useSupplier(id);
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const toggle = usePurchasingMutation<{ isActive: boolean }, Supplier>({
    path: `/suppliers/${id}`,
    method: 'PATCH',
    invalidate: [['suppliers'], ['supplier', id]],
    success: (s) => (s.isActive ? t('purchasing.suppliers.reactivated') : t('purchasing.suppliers.deactivated')),
    onSuccess: () => setToggling(false),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  const s: SupplierDetail = q.data;
  const sum = s.summary;
  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'overview', label: t('purchasing.suppliers.tabs.overview') },
    ...(ap.open ? [{ key: 'open' as const, label: t('purchasing.suppliers.tabs.open'), count: sum?.openDocuments }] : []),
    ...(can('acquisitions.read') ? [{ key: 'acquisitions' as const, label: t('purchasing.suppliers.tabs.acquisitions') }] : []),
    ...(ap.read ? [{ key: 'payments' as const, label: t('purchasing.suppliers.tabs.payments') }] : []),
    ...(ap.read ? [{ key: 'statement' as const, label: t('purchasing.suppliers.tabs.statement') }] : []),
  ];
  const requested = lp.get('tab') as TabKey;
  const tab: TabKey = tabs.some((x) => x.key === requested) ? requested : 'overview';

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('purchasing.suppliers.title'), to: '/app/purchasing/suppliers' }, { label: s.name }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="truncate">{s.name}</span>
            <Badge tone={s.isActive ? 'success' : 'neutral'}>{s.isActive ? t('common.active') : t('common.inactive')}</Badge>
          </span>
        }
        subtitle={t(`purchasing.enums.supplierType.${s.type}`)}
        actions={
          <>
            <Can perm="suppliers.manage">
              <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
              <Button variant="ghost" icon={<Power className="h-4 w-4" />} onClick={() => setToggling(true)}>
                {s.isActive ? t('purchasing.suppliers.deactivate') : t('purchasing.suppliers.reactivate')}
              </Button>
            </Can>
            {s.isActive && (
              <Can perm={['acquisitions.create', 'vehicles.create']}>
                <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate(`/app/purchasing/acquisitions/new?supplierId=${s.id}`)}>
                  {t('purchasing.acquisitions.add')}
                </Button>
              </Can>
            )}
            {ap.pay && sum && d(sum.outstandingBase).gt(0) && (
              <Button icon={<CreditCard className="h-4 w-4" />} onClick={() => navigate(`/app/purchasing/payments/new?supplierId=${s.id}`)}>
                {t('purchasing.payments.add')}
              </Button>
            )}
          </>
        }
      />

      {sum ? (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={t('purchasing.suppliers.summary.outstanding')}
            value={<Money value={sum.outstandingBase} currency={sum.currency} />}
            hint={t('purchasing.suppliers.summary.openDocuments', { count: sum.openDocuments })}
            icon={<Wallet className="h-5 w-5" />}
            tone={d(sum.outstandingBase).gt(0) ? 'warning' : 'success'}
            onClick={ap.open ? () => lp.set({ tab: 'open' }) : undefined}
          />
          <StatCard
            label={t('purchasing.suppliers.summary.purchased')}
            value={<Money value={sum.totalPurchasedBase} currency={sum.currency} />}
            icon={<ReceiptText className="h-5 w-5" />}
            tone="brand"
          />
          <StatCard
            label={t('purchasing.suppliers.summary.paid')}
            value={<Money value={sum.totalPaidBase} currency={sum.currency} />}
            icon={<CircleDollarSign className="h-5 w-5" />}
            tone="success"
          />
          <StatCard
            label={t('purchasing.suppliers.summary.lastPayment')}
            value={sum.lastPaymentDate ? fmtDate(sum.lastPaymentDate) : t('purchasing.suppliers.summary.never')}
            icon={<FileClock className="h-5 w-5" />}
          />
        </div>
      ) : (
        <Alert tone="info" className="mb-5">
          {t('purchasing.suppliers.summaryHidden')}
        </Alert>
      )}

      <Card>
        <div className="px-2 pt-1">
          <Tabs<TabKey> tabs={tabs} value={tab} onChange={(k) => lp.set({ tab: k })} />
        </div>
        {tab === 'overview' && (
          <CardBody>
            <DescriptionList
              items={[
                { label: t('purchasing.suppliers.fields.type'), value: t(`purchasing.enums.supplierType.${s.type}`) },
                {
                  label: t('common.phone'),
                  value: s.phone ? (
                    <bdi dir="ltr" className="num">
                      {s.phone}
                    </bdi>
                  ) : null,
                },
                {
                  label: t('common.email'),
                  value: s.email ? (
                    <bdi dir="ltr" className="break-all">
                      {s.email}
                    </bdi>
                  ) : null,
                },
                { label: t('purchasing.suppliers.fields.taxNumber'), value: s.taxNumber ? <span className="num">{s.taxNumber}</span> : null },
                { label: t('purchasing.suppliers.fields.nationalId'), value: s.hasNationalId ? <NationalIdValue key={`${s.id}:${s.updatedAt}`} s={s} /> : null },
                { label: t('common.city'), value: s.city },
                { label: t('common.address'), value: s.address, full: true },
                { label: t('common.notes'), value: s.notes, full: true },
                { label: t('common.createdAt'), value: fmtDate(s.createdAt) },
                ...(sum ? [{ label: t('purchasing.suppliers.summary.openDocumentsLabel'), value: <span className="num">{fmtNumber(sum.openDocuments)}</span> }] : []),
              ]}
            />
          </CardBody>
        )}
        {tab === 'open' && <OpenDocuments supplierId={s.id} />}
        {tab === 'acquisitions' && <SupplierAcquisitions supplierId={s.id} />}
        {tab === 'payments' && <SupplierPayments supplierId={s.id} />}
        {tab === 'statement' && (
          <>
            <CardHeader title={t('purchasing.statement.title')} subtitle={t('purchasing.statement.subtitle')} className="border-t" />
            <Statement supplierId={s.id} />
          </>
        )}
      </Card>

      {editing && <SupplierFormModal supplier={s} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={toggling}
        onClose={() => setToggling(false)}
        title={s.isActive ? t('purchasing.suppliers.deactivateTitle', { name: s.name }) : t('purchasing.suppliers.reactivateTitle', { name: s.name })}
        message={s.isActive ? t('purchasing.suppliers.deactivateHint') : t('purchasing.suppliers.reactivateHint')}
        confirmLabel={s.isActive ? t('purchasing.suppliers.deactivate') : t('purchasing.suppliers.reactivate')}
        tone={s.isActive ? 'danger' : 'primary'}
        loading={toggle.isPending}
        onConfirm={() => toggle.mutate({ isActive: !s.isActive })}
      />
    </>
  );
}
