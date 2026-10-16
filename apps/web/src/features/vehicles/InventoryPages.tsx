import { ArrowLeftRight, ClipboardCheck, Plus, ScanLine } from 'lucide-react';
import { FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { fmtDateTime } from '@/lib/format';
import { Can, useAuth } from '@/lib/auth';
import { useApi, useApiMutation, useListParams } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { vehicleTitle } from './components';

interface Transfer {
  id: string;
  number: string;
  status: 'in_transit' | 'received' | 'cancelled';
  shippedAt: string;
  receivedAt: string | null;
  notes: string | null;
  cancelReason: string | null;
  vehicleId: string;
  stockNumber: string;
  makeNameEn: string;
  makeNameAr: string;
  modelNameEn: string;
  modelNameAr: string;
  modelYear: number;
  fromBranchId: string;
  fromBranch: string;
  toBranchId: string;
  toBranch: string;
  requestedBy: string | null;
}

const transferTone: Record<Transfer['status'], Tone> = { in_transit: 'info', received: 'success', cancelled: 'neutral' };

export function TransfersPage() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const lp = useListParams({ status: 'in_transit' });
  const q = useApi<Transfer[]>(['transfers'], '/inventory/transfers', { status: lp.get('status') || undefined });
  const [cancelling, setCancelling] = useState<Transfer | null>(null);
  const receive = useApiMutation<{ id: string }>({ path: (v) => `/inventory/transfers/${v.id}/receive`, body: () => ({}), invalidate: [['transfers'], ['vehicles']] });
  const cancel = useApiMutation<{ id: string; reason: string }>({
    path: (v) => `/inventory/transfers/${v.id}/cancel`,
    body: (v) => ({ reason: v.reason }),
    invalidate: [['transfers']],
    onSuccess: () => setCancelling(null),
  });
  const canReceive = (tr: Transfer) => me?.allBranches || me?.branchIds.includes(tr.toBranchId);
  return (
    <>
      <PageHeader title={t('vehicles.transfer.list')} />
      <Card>
        <div className="px-4 pt-2">
          <Tabs
            value={lp.get('status') || 'all'}
            onChange={(k) => lp.set({ status: k === 'all' ? null : k })}
            tabs={[
              { key: 'in_transit', label: t('vehicles.transfer.inTransit') },
              { key: 'received', label: t('vehicles.transfer.received') },
              { key: 'cancelled', label: t('vehicles.transfer.cancelled') },
              { key: 'all', label: t('common.all') },
            ]}
          />
        </div>
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(r) => r.id}
          empty={<EmptyState icon={<ArrowLeftRight className="h-5 w-5" />} title={t('vehicles.transfer.empty')} />}
          columns={[
            { key: 'no', header: '#', cell: (r) => <span className="num font-medium">{r.number}</span> },
            {
              key: 'vehicle',
              header: t('nav.vehicles'),
              cell: (r) => (
                <Link to={`/app/vehicles/${r.vehicleId}`} className="hover:underline">
                  <span className="block font-medium">{vehicleTitle(r, i18n.language)}</span>
                  <span className="num text-xs text-muted">{r.stockNumber}</span>
                </Link>
              ),
            },
            { key: 'route', header: `${t('vehicles.transfer.from')} → ${t('vehicles.transfer.to')}`, cell: (r) => `${r.fromBranch} → ${r.toBranch}` },
            { key: 'date', header: t('common.date'), hideOnMobile: true, cell: (r) => fmtDateTime(r.receivedAt ?? r.shippedAt) },
            {
              key: 'status',
              header: t('common.status'),
              cell: (r) => (
                <Badge tone={transferTone[r.status]}>
                  {t(`vehicles.transfer.${r.status === 'in_transit' ? 'inTransit' : r.status}`)}
                </Badge>
              ),
            },
            {
              key: 'act',
              header: <span className="sr-only">{t('common.actions')}</span>,
              align: 'end',
              cell: (r) =>
                r.status === 'in_transit' && (
                  <Can perm="inventory.transfer">
                    <div className="flex justify-end gap-1">
                      {canReceive(r) && (
                        <Button size="sm" loading={receive.isPending} onClick={() => receive.mutate({ id: r.id })}>
                          {t('vehicles.transfer.receive')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setCancelling(r)}>
                        {t('vehicles.transfer.cancel')}
                      </Button>
                    </div>
                  </Can>
                ),
            },
          ]}
        />
      </Card>
      <ConfirmDialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        title={t('vehicles.transfer.cancel')}
        requireReason
        tone="danger"
        loading={cancel.isPending}
        onConfirm={(reason) => {
          if (cancelling) cancel.mutate({ id: cancelling.id, reason });
        }}
      />
    </>
  );
}

interface CountRow {
  id: string;
  number: string;
  status: 'open' | 'submitted' | 'reconciled' | 'cancelled';
  branchName: string;
  startedAt: string;
  startedBy: string | null;
  reconciledAt: string | null;
}
const countTone: Record<CountRow['status'], Tone> = { open: 'info', submitted: 'warning', reconciled: 'success', cancelled: 'neutral' };

export function StockCountsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const branches = useBranches();
  const q = useApi<CountRow[]>(['stock-counts'], '/inventory/stock-counts');
  const [opening, setOpening] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [notes, setNotes] = useState('');
  const open = useApiMutation<Record<string, unknown>, { id: string }>({
    path: '/inventory/stock-counts',
    invalidate: [['stock-counts']],
    success: null,
    onSuccess: (r) => navigate(`/app/inventory/stock-counts/${r.id}`),
  });
  return (
    <>
      <PageHeader
        title={t('vehicles.stockCount.title')}
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpening(true)}>
            {t('vehicles.stockCount.open')}
          </Button>
        }
      />
      <Card>
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          error={q.error}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/app/inventory/stock-counts/${r.id}`)}
          empty={<EmptyState icon={<ClipboardCheck className="h-5 w-5" />} title={t('vehicles.stockCount.empty')} />}
          columns={[
            { key: 'no', header: '#', cell: (r) => <span className="num font-medium">{r.number}</span> },
            { key: 'branch', header: t('common.branch'), cell: (r) => r.branchName },
            { key: 'by', header: t('audit.actor'), hideOnMobile: true, cell: (r) => r.startedBy ?? '—' },
            { key: 'date', header: t('common.date'), cell: (r) => fmtDateTime(r.startedAt) },
            { key: 'status', header: t('common.status'), cell: (r) => <Badge tone={countTone[r.status]}>{t(`vehicles.stockCount.status.${r.status}`)}</Badge> },
          ]}
        />
      </Card>
      <Modal
        open={opening}
        onClose={() => setOpening(false)}
        title={t('vehicles.stockCount.open')}
        size="sm"
        footer={
          <Button loading={open.isPending} disabled={!branchId} onClick={() => open.mutate({ branchId, notes: notes || null })}>
            {t('common.create')}
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label={t('common.branch')} required>
            {(id) => (
              <Select id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">—</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('common.notes')}>{(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        </div>
      </Modal>
    </>
  );
}

interface CountDetail {
  id: string;
  number: string;
  status: CountRow['status'];
  summary: { expected: number; found: number; missing: number; unexpected: number; pending: number };
  lines: Array<{
    id: string;
    vehicleId: string | null;
    expected: boolean;
    found: boolean | null;
    scannedCode: string | null;
    locationFound: string | null;
    notes: string | null;
    resolution: string;
    stockNumber: string | null;
    vin: string | null;
    plateNumber: string | null;
    makeNameEn: string | null;
    makeNameAr: string | null;
    modelNameEn: string | null;
    modelNameAr: string | null;
    modelYear: number | null;
  }>;
}

export function StockCountDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const q = useApi<CountDetail>(['stock-count', id], `/inventory/stock-counts/${id}`);
  const [code, setCode] = useState('');
  const [location, setLocation] = useState('');
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, { resolution: string; notes: string }>>({});
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scan = useApiMutation<{ code: string; location: string | null }, { result: string }>({
    path: `/inventory/stock-counts/${id}/scan`,
    invalidate: [['stock-count', id]],
    success: null,
    onSuccess: (r) => {
      setLastResult(r.result);
      setCode('');
      inputRef.current?.focus();
    },
  });
  const submit = useApiMutation<object>({ path: `/inventory/stock-counts/${id}/submit`, invalidate: [['stock-count', id], ['stock-counts']], onSuccess: () => setConfirmSubmit(false) });
  const reconcile = useApiMutation<{ lines: Array<{ lineId: string; resolution: string; notes: string | null }> }>({
    path: `/inventory/stock-counts/${id}/reconcile`,
    invalidate: [['stock-count', id], ['stock-counts'], ['vehicles']],
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  const onScan = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim().length >= 3) scan.mutate({ code: code.trim(), location: location || null });
  };
  const needsDecision = c.lines.filter((l) => (l.found === false || !l.expected) && l.resolution === 'none');
  const resultMsg: Record<string, { tone: 'success' | 'warning' | 'danger'; key: string }> = {
    matched: { tone: 'success', key: 'matched' },
    other_branch: { tone: 'warning', key: 'otherBranch' },
    unknown: { tone: 'danger', key: 'unknown' },
  };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('vehicles.stockCount.title'), to: '/app/inventory/stock-counts' }, { label: c.number }]}
        title={`${t('vehicles.stockCount.title')} ${c.number}`}
        subtitle={t(`vehicles.stockCount.status.${c.status}`)}
        actions={
          c.status === 'open' && (
            <Button variant="secondary" onClick={() => setConfirmSubmit(true)}>
              {t('vehicles.stockCount.submit')}
            </Button>
          )
        }
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={t('vehicles.stockCount.expected')} value={c.summary.expected} />
        <StatCard label={t('vehicles.stockCount.found')} value={c.summary.found} tone="success" />
        <StatCard label={t('vehicles.stockCount.missing')} value={c.summary.missing} tone="danger" />
        <StatCard label={t('vehicles.stockCount.unexpected')} value={c.summary.unexpected} tone="warning" />
        <StatCard label={t('vehicles.stockCount.pending')} value={c.summary.pending} tone="info" />
      </div>
      {c.status === 'open' && (
        <Card className="mb-5 p-4">
          <form onSubmit={onScan} className="flex flex-wrap items-end gap-2">
            <Field label={t('vehicles.stockCount.scan')} className="min-w-[240px] flex-1">
              {(fid) => <Input id={fid} ref={inputRef} autoFocus dir="ltr" className="num uppercase" value={code} onChange={(e) => setCode(e.target.value)} />}
            </Field>
            <Field label={t('vehicles.location')} className="w-48">
              {(fid) => <Input id={fid} value={location} onChange={(e) => setLocation(e.target.value)} />}
            </Field>
            <Button type="submit" icon={<ScanLine className="h-4 w-4" />} loading={scan.isPending}>
              {t('vehicles.stockCount.scanButton')}
            </Button>
          </form>
          {lastResult && resultMsg[lastResult] && (
            <Alert tone={resultMsg[lastResult]!.tone} className="mt-3">
              {t(`vehicles.stockCount.${resultMsg[lastResult]!.key}`)}
            </Alert>
          )}
        </Card>
      )}
      <Card>
        <CardHeader
          title={t('nav.vehicles')}
          actions={
            c.status === 'submitted' &&
            can('inventory.reconcile') && (
              <Button
                loading={reconcile.isPending}
                disabled={Object.keys(resolutions).length === 0}
                onClick={() => reconcile.mutate({ lines: Object.entries(resolutions).map(([lineId, r]) => ({ lineId, resolution: r.resolution, notes: r.notes || null })) })}
              >
                {t('vehicles.stockCount.reconcile')} ({needsDecision.length})
              </Button>
            )
          }
        />
        <DataTable
          dense
          rows={c.lines}
          rowKey={(l) => l.id}
          columns={[
            {
              key: 'v',
              header: t('nav.vehicles'),
              cell: (l) =>
                l.vehicleId ? (
                  <Link to={`/app/vehicles/${l.vehicleId}`} className="hover:underline">
                    <span className="block font-medium">{vehicleTitle({ ...l, modelYear: l.modelYear ?? 0, makeNameEn: l.makeNameEn ?? '', makeNameAr: l.makeNameAr ?? '', modelNameEn: l.modelNameEn ?? '', modelNameAr: l.modelNameAr ?? '' }, i18n.language)}</span>
                    <span className="num text-xs text-muted">{l.stockNumber} {l.vin && `· ${l.vin}`}</span>
                  </Link>
                ) : (
                  <span className="num text-muted">{l.scannedCode}</span>
                ),
            },
            {
              key: 'state',
              header: t('common.status'),
              cell: (l) =>
                !l.expected ? (
                  <Badge tone="warning">{t('vehicles.stockCount.unexpected')}</Badge>
                ) : l.found ? (
                  <Badge tone="success">{t('vehicles.stockCount.found')}</Badge>
                ) : l.found === false ? (
                  <Badge tone="danger">{t('vehicles.stockCount.missing')}</Badge>
                ) : (
                  <Badge tone="neutral">{t('vehicles.stockCount.pending')}</Badge>
                ),
            },
            { key: 'loc', header: t('vehicles.location'), hideOnMobile: true, cell: (l) => l.locationFound ?? '—' },
            {
              key: 'res',
              header: t('vehicles.stockCount.resolution'),
              cell: (l) => {
                const needs = (l.found === false || !l.expected) && l.resolution === 'none';
                if (c.status !== 'submitted' || !needs || !can('inventory.reconcile')) {
                  return <span className="text-sm">{t(`vehicles.stockCount.resolutions.${l.resolution}`)}</span>;
                }
                const options = l.found === false ? ['investigate', 'written_off', 'confirmed'] : ['unexpected_noted', 'location_updated'];
                const cur = resolutions[l.id];
                return (
                  <div className="flex min-w-[260px] gap-2">
                    <Select
                      value={cur?.resolution ?? ''}
                      onChange={(e) => setResolutions((r) => ({ ...r, [l.id]: { resolution: e.target.value, notes: r[l.id]?.notes ?? '' } }))}
                      aria-label={t('vehicles.stockCount.resolution')}
                    >
                      <option value="">—</option>
                      {options
                        .filter((o) => o !== 'written_off' || can('vehicles.remove'))
                        .map((o) => (
                          <option key={o} value={o}>
                            {t(`vehicles.stockCount.resolutions.${o}`)}
                          </option>
                        ))}
                    </Select>
                    {cur?.resolution && (
                      <Input
                        placeholder={t('common.reason')}
                        value={cur.notes}
                        onChange={(e) => setResolutions((r) => ({ ...r, [l.id]: { ...r[l.id]!, notes: e.target.value } }))}
                      />
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      </Card>
      <ConfirmDialog open={confirmSubmit} onClose={() => setConfirmSubmit(false)} onConfirm={() => submit.mutate({})} title={t('vehicles.stockCount.submit')} loading={submit.isPending} />
    </>
  );
}
