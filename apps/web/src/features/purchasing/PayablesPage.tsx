import clsx from 'clsx';
import { CheckCircle2, CreditCard, ReceiptText, Scale } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { AGING_BUCKETS, AgingBuckets, d, PAYABLE_TARGET_TYPES } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, StatCard } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { fmtDate, fmtNumber, todayIso } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { OpenPayablesResponse, PayablesSummary, useApAccess } from './api';
import { documentHref, Money, SupplierPicker, TargetTypeBadge, useTenantMoney } from './components';

type TabKey = 'open' | 'aging';

/** Whole days between two ISO dates (b − a). Calendar arithmetic, not money. */
function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2!, m2! - 1, d2!) - Date.UTC(y1!, m1! - 1, d1!)) / 86_400_000);
}

function OpenPayablesTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { base, timezone } = useTenantMoney();
  const ap = useApAccess();
  const lp = useListParams();
  const supplierId = lp.get('supplierId');
  const targetType = lp.get('targetType');
  const q = useApi<OpenPayablesResponse>(
    ['payables-open', 'all'],
    '/payables/open',
    { supplierId: supplierId || undefined, targetType: targetType || undefined },
    { placeholderData: (p) => p },
  );
  const today = todayIso(timezone);
  const overdue = (q.data?.items ?? []).filter((r) => daysBetween(r.dueDate ?? r.docDate, today) > 0);
  const overdueTotal = overdue.reduce((acc, r) => acc.plus(r.outstandingBase), d(0)).toFixed(2);

  return (
    <>
      <div className="grid gap-2 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[minmax(240px,1.5fr)_minmax(180px,1fr)_auto]">
        <SupplierPicker value={supplierId} onChange={(v) => lp.set({ supplierId: v })} allowNone clearable activeOnly={false} />
        <Select value={targetType} onChange={(e) => lp.set({ targetType: e.target.value })} aria-label={t('purchasing.payables.documentType')}>
          <option value="">
            {t('purchasing.payables.documentType')}: {t('common.all')}
          </option>
          {PAYABLE_TARGET_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`purchasing.enums.targetType.${x}`)}
            </option>
          ))}
        </Select>
        {(supplierId || targetType) && (
          <Button variant="ghost" onClick={() => lp.set({ supplierId: null, targetType: null })}>
            {t('common.clearFilters')}
          </Button>
        )}
      </div>
      {q.data && q.data.items.length > 0 && (
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-3">
          <StatCard label={t('purchasing.payables.totalOutstanding')} value={<Money value={q.data.totals.outstandingBase} currency={base} />} tone="warning" />
          <StatCard
            label={t('purchasing.payables.overdue')}
            value={<Money value={overdueTotal} currency={base} />}
            hint={t('purchasing.payables.documentsCount', { count: overdue.length })}
            tone={overdue.length ? 'danger' : 'success'}
          />
          <StatCard label={t('purchasing.payables.documents')} value={<span className="num">{fmtNumber(q.data.items.length)}</span>} />
        </div>
      )}
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(r) => `${r.targetType}:${r.targetId}`}
        empty={
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5" />}
            title={supplierId || targetType ? t('common.noResults') : t('purchasing.payables.noOpen')}
            description={supplierId || targetType ? undefined : t('purchasing.payables.noOpenHint')}
          />
        }
        columns={[
          {
            key: 'doc',
            header: t('purchasing.payables.document'),
            cell: (r) => {
              const href = documentHref(r.targetType, r.targetId, r.vehicleId);
              return (
                <div className="min-w-0 space-y-1">
                  <TargetTypeBadge type={r.targetType} />
                  <p className="max-w-[260px] truncate font-medium">
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
          {
            key: 'supplier',
            header: t('purchasing.payables.supplier'),
            cell: (r) =>
              r.supplierId ? (
                <Link to={`/app/purchasing/suppliers/${r.supplierId}`} className="hover:underline">
                  {r.supplierName}
                </Link>
              ) : (
                <span className="text-muted">{t('purchasing.payments.directPurchases')}</span>
              ),
          },
          { key: 'date', header: t('purchasing.payables.docDate'), hideOnMobile: true, cell: (r) => fmtDate(r.docDate) },
          {
            key: 'due',
            header: t('purchasing.payables.dueDate'),
            cell: (r) => {
              const age = daysBetween(r.dueDate ?? r.docDate, today);
              return (
                <div className="space-y-1">
                  <p className="whitespace-nowrap">{fmtDate(r.dueDate)}</p>
                  {age > 0 && <Badge tone="danger">{t('purchasing.payables.overdueDays', { count: age })}</Badge>}
                </div>
              );
            },
          },
          { key: 'total', header: t('common.total'), align: 'end', hideOnMobile: true, cell: (r) => <Money value={r.totalBase} currency={base} /> },
          { key: 'paid', header: t('purchasing.payables.paid'), align: 'end', hideOnMobile: true, cell: (r) => <Money value={r.paidBase} currency={base} /> },
          {
            key: 'outstanding',
            header: t('purchasing.payables.outstanding'),
            align: 'end',
            cell: (r) => <Money value={r.outstandingBase} currency={base} className="font-semibold" />,
          },
          {
            key: 'pay',
            header: <span className="sr-only">{t('purchasing.payments.pay')}</span>,
            // Keeps the absolutely positioned sr-only header inside the table's scroll area on phones.
            className: 'relative',
            align: 'end',
            cell: (r) =>
              ap.pay ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => navigate(`/app/purchasing/payments/new?supplierId=${r.supplierId ?? 'none'}&target=${r.targetType}:${r.targetId}`)}
                >
                  {t('purchasing.payments.pay')}
                </Button>
              ) : null,
          },
        ]}
      />
    </>
  );
}

function AgingTab() {
  const { t } = useTranslation();
  const { timezone } = useTenantMoney();
  const lp = useListParams();
  const asOf = lp.get('asOf') || todayIso(timezone);
  const q = useApi<PayablesSummary>(['payables-summary'], '/payables/summary', { asOf }, { placeholderData: (p) => p });
  const s = q.data;
  const cur = s?.currency ?? 'SAR';
  const bucketCols = AGING_BUCKETS.map((b) => ({
    key: b,
    header: t(`purchasing.aging.buckets.${b}`),
    align: 'end' as const,
    cell: (r: { buckets: AgingBuckets }) => (d(r.buckets[b]).isZero() ? <span className="text-subtle">—</span> : <Money value={r.buckets[b]} currency={cur} />),
  }));
  const rec = s?.reconciliation;
  const balanced = rec ? d(rec.difference).isZero() : false;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-4">
        <Field label={t('purchasing.aging.asOf')} className="w-full sm:w-56">
          {(id) => <Input id={id} type="date" value={asOf} onChange={(e) => lp.set({ asOf: e.target.value || null })} />}
        </Field>
        <p className="max-w-xl text-xs text-muted">{t('purchasing.aging.hint')}</p>
      </div>
      <DataTable
        rows={s?.rows}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(r) => r.supplierId ?? 'direct'}
        dense
        empty={<EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title={t('purchasing.aging.empty')} />}
        columns={[
          {
            key: 'supplier',
            header: t('purchasing.payables.supplier'),
            cell: (r) =>
              r.isDirect || !r.supplierId ? (
                <span className="text-muted">{t('purchasing.payments.directPurchases')}</span>
              ) : (
                <Link to={`/app/purchasing/suppliers/${r.supplierId}`} className="font-medium hover:underline">
                  {r.supplierName}
                </Link>
              ),
          },
          { key: 'docs', header: t('purchasing.payables.documents'), align: 'end', cell: (r) => <span className="num">{fmtNumber(r.documents)}</span> },
          ...bucketCols,
          { key: 'total', header: t('common.total'), align: 'end', cell: (r) => <Money value={r.outstandingBase} currency={cur} className="font-semibold" /> },
        ]}
        footer={
          s && s.rows.length > 0 ? (
            <div className="border-t border-line bg-surface-2/60 px-4 py-3">
              <p className="mb-2 text-sm font-semibold">{t('purchasing.aging.totals')}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
                {AGING_BUCKETS.map((b) => (
                  <div key={b} className="min-w-0">
                    <dt className="text-xs text-muted">{t(`purchasing.aging.buckets.${b}`)}</dt>
                    <dd>
                      <Money value={s.totals.buckets[b]} currency={cur} />
                    </dd>
                  </div>
                ))}
                <div className="min-w-0">
                  <dt className="text-xs text-muted">
                    {t('common.total')} · {t('purchasing.payables.documentsCount', { count: s.totals.documents })}
                  </dt>
                  <dd>
                    <Money value={s.totals.outstandingBase} currency={cur} className="font-semibold" />
                  </dd>
                </div>
              </dl>
            </div>
          ) : null
        }
      />
      {s && (
        <CardBody className="border-t border-line">
          {rec ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Scale className="h-4 w-4 text-muted" aria-hidden />
                <h3 className="text-sm font-semibold">{t('purchasing.aging.reconciliation')}</h3>
                <Badge tone={balanced ? 'success' : 'danger'}>{balanced ? t('purchasing.aging.balanced') : t('purchasing.aging.unbalanced')}</Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-line p-3">
                  <p className="text-xs text-muted">{t('purchasing.aging.subledger')}</p>
                  <Money value={rec.subledgerTotal} currency={cur} className="font-semibold" />
                </div>
                <div className="rounded-xl border border-line p-3">
                  <p className="text-xs text-muted">{t('purchasing.aging.gl')}</p>
                  <Money value={rec.glPayablesBalance} currency={cur} className="font-semibold" />
                </div>
                <div className={clsx('rounded-xl border p-3', balanced ? 'border-line' : 'border-danger/40 bg-danger-soft')}>
                  <p className="text-xs text-muted">{t('purchasing.aging.difference')}</p>
                  <Money value={rec.difference} currency={cur} className={clsx('font-semibold', !balanced && 'text-danger')} />
                </div>
              </div>
              {rec.mismatches.length > 0 && (
                <Alert tone="danger" title={t('purchasing.aging.mismatches')}>
                  <ul className="mt-1 space-y-1">
                    {rec.mismatches.map((m) => (
                      <li key={m.supplierId ?? 'direct'} className="flex flex-wrap gap-x-3">
                        <span className="font-medium text-ink">{m.supplierName ?? t('purchasing.payments.directPurchases')}</span>
                        <span>
                          {t('purchasing.aging.subledger')}: <Money value={m.subledgerBase} currency={cur} />
                        </span>
                        <span>
                          {t('purchasing.aging.gl')}: <Money value={m.glBase} currency={cur} />
                        </span>
                        <span>
                          {t('purchasing.aging.difference')}: <Money value={m.difference} currency={cur} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}
            </div>
          ) : (
            <Alert tone="info">{t('purchasing.aging.branchScope')}</Alert>
          )}
        </CardBody>
      )}
    </>
  );
}

export function PayablesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ap = useApAccess();
  const lp = useListParams({ tab: 'open' });
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'open', label: t('purchasing.payables.tabs.open') },
    ...(ap.read ? [{ key: 'aging' as const, label: t('purchasing.payables.tabs.aging') }] : []),
  ];
  const tab: TabKey = lp.get('tab') === 'aging' && ap.read ? 'aging' : 'open';
  return (
    <>
      <PageHeader
        title={t('purchasing.payables.title')}
        subtitle={t('purchasing.payables.subtitle')}
        actions={
          ap.pay && (
            <Button icon={<CreditCard className="h-4 w-4" />} onClick={() => navigate('/app/purchasing/payments/new')}>
              {t('purchasing.payments.add')}
            </Button>
          )
        }
      />
      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-muted" aria-hidden />
              {tab === 'open' ? t('purchasing.payables.tabs.open') : t('purchasing.payables.tabs.aging')}
            </span>
          }
          subtitle={tab === 'open' ? t('purchasing.payables.openHint') : t('purchasing.aging.subtitle')}
        />
        {tabs.length > 1 && (
          <div className="px-2 pt-1">
            <Tabs<TabKey> tabs={tabs} value={tab} onChange={(k) => lp.set({ tab: k, supplierId: null, targetType: null, asOf: null })} />
          </div>
        )}
        {tab === 'open' ? <OpenPayablesTab /> : <AgingTab />}
      </Card>
    </>
  );
}
