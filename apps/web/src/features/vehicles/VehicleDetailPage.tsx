import { ArrowLeftRight, ClipboardCheck, Gauge, MapPin, Pencil, RefreshCw, Tag, Timer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { checkTransition, VEHICLE_STATUSES, VehicleStatus } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { FEATURE_MODULES } from '@/features/modules';
import { Modal } from '@/components/ui/Modal';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber } from '@/lib/format';
import { Can, useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { useVehicle, VehicleDetail } from './api';
import { useStatusLabel, VehiclePhoto, VehicleStatusBadge, vehicleTitle } from './components';
import { DocumentsTab, MediaTab } from './MediaDocsTabs';
import { InspectionsTab } from './InspectionsTab';

type TabKey = 'overview' | 'media' | 'documents' | 'inspections' | 'pricing' | 'history' | `x:${string}`;

function StatusModal({ d, onClose }: { d: VehicleDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const label = useStatusLabel();
  const { can } = useAuth();
  const from = d.vehicle.status;
  const options = VEHICLE_STATUSES.filter((s) => checkTransition(from, s, false).ok && (s !== 'removed' || can('vehicles.remove')));
  const [to, setTo] = useState<VehicleStatus | ''>(options[0] ?? '');
  const [reason, setReason] = useState('');
  const m = useApiMutation<{ to: string; reason: string | null }>({ path: `/vehicles/${d.vehicle.id}/status`, invalidate: [['vehicle', d.vehicle.id], ['vehicles']], onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('vehicles.statusChange.title')}
      size="sm"
      footer={
        options.length > 0 && (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={to === 'removed' ? 'danger' : 'primary'}
              loading={m.isPending}
              disabled={!to || (to === 'removed' && reason.trim().length < 3)}
              onClick={() => m.mutate({ to, reason: reason.trim() || null })}
            >
              {t('common.confirm')}
            </Button>
          </>
        )
      }
    >
      {options.length === 0 ? (
        <Alert tone="info">{t('vehicles.statusChange.none')}</Alert>
      ) : (
        <div className="space-y-4">
          <Field label={t('vehicles.statusChange.to')}>
            {(id) => (
              <Select id={id} value={to} onChange={(e) => setTo(e.target.value as VehicleStatus)}>
                {options.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('common.reason')} required={to === 'removed'} hint={to === 'removed' ? t('vehicles.statusChange.reasonRequired') : undefined}>
            {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
      )}
    </Modal>
  );
}

function PricingModal({ d, onClose }: { d: VehicleDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const { currency, can } = useAuth();
  const [asking, setAsking] = useState(d.vehicle.askingPrice ?? '');
  const [min, setMin] = useState(d.vehicle.minPrice ?? '');
  const [margin, setMargin] = useState(d.vehicle.targetMarginPct ?? '');
  const [reason, setReason] = useState('');
  const canFloor = can('pricing.set_floor');
  const m = useApiMutation<Record<string, unknown>>({ path: `/vehicles/${d.vehicle.id}/pricing`, method: 'PUT', invalidate: [['vehicle', d.vehicle.id], ['vehicles']], onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('vehicles.pricing.title')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                askingPrice: asking || null,
                minPrice: canFloor ? min || null : d.vehicle.minPrice,
                ...(canFloor ? { targetMarginPct: margin || null } : {}),
                reason: reason || null,
              })
            }
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('vehicles.askingPrice')}>{(id) => <MoneyInput id={id} currency={currency} value={asking} onChange={(e) => setAsking(e.target.value)} />}</Field>
        {canFloor ? (
          <>
            <Field label={t('vehicles.minPrice')}>{(id) => <MoneyInput id={id} currency={currency} value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
            <Field label={t('vehicles.targetMargin')}>{(id) => <Input id={id} dir="ltr" className="num" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />}</Field>
          </>
        ) : (
          <Alert tone="info">{t('vehicles.pricing.floorNeedsPermission')}</Alert>
        )}
        <Field label={t('vehicles.pricing.reason')}>{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

function TransferModal({ d, onClose }: { d: VehicleDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const branches = useBranches();
  const options = branches.data?.filter((b) => b.isActive && b.id !== d.vehicle.branchId) ?? [];
  const [to, setTo] = useState('');
  const [notes, setNotes] = useState('');
  const m = useApiMutation<Record<string, unknown>>({ path: `/vehicles/${d.vehicle.id}/transfers`, invalidate: [['vehicle', d.vehicle.id], ['transfers']], onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('vehicles.transfer.title')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} disabled={!to} onClick={() => m.mutate({ toBranchId: to, notes: notes || null })}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('vehicles.transfer.to')} required>
          {(id) => (
            <Select id={id} value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">—</option>
              {options.map((b) => (
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
  );
}

function OdometerModal({ d, onClose }: { d: VehicleDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(String(d.vehicle.odometerValue));
  const [unit, setUnit] = useState<string>(d.vehicle.odometerUnit);
  const [notes, setNotes] = useState('');
  const lower = Number(value) < d.vehicle.odometerValue && unit === d.vehicle.odometerUnit;
  const m = useApiMutation<Record<string, unknown>>({ path: `/vehicles/${d.vehicle.id}/odometer`, invalidate: [['vehicle', d.vehicle.id]], onSuccess: onClose });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('vehicles.actions.addOdometer')}
      size="sm"
      footer={
        <Button loading={m.isPending} disabled={!value || (lower && notes.trim().length < 3)} onClick={() => m.mutate({ value: Number(value), unit, source: 'manual', notes: notes || null })}>
          {t('common.save')}
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_110px]">
        <Field label={t('vehicles.odometerReading.value')}>{(id) => <Input id={id} type="number" className="num" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        <Field label={t('vehicles.odometerUnit')}>
          {(id) => (
            <Select id={id} value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="km">km</option>
              <option value="mi">mi</option>
            </Select>
          )}
        </Field>
        <Field label={t('common.notes')} required={lower} hint={lower ? t('vehicles.odometerReading.decreaseNote') : undefined} className="sm:col-span-2">
          {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function Overview({ d }: { d: VehicleDetail }) {
  const { t, i18n } = useTranslation();
  const v = d.vehicle;
  const e = (k: string, val: string | null) => (val ? t(`vehicles.enums.${k}.${val}`) : null);
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        <Card>
          <CardHeader title={t('vehicles.sections.specs')} />
          <CardBody>
            <DescriptionList
              columns={3}
              items={[
                { label: t('vehicles.vin'), value: <span className="num">{v.vin ?? '—'}</span> },
                { label: t('vehicles.engineNumber'), value: <span className="num">{v.engineNumber ?? '—'}</span> },
                { label: t('vehicles.plateNumber'), value: [v.plateNumber, v.plateRegion].filter(Boolean).join(' · ') || '—' },
                { label: t('vehicles.condition'), value: e('condition', v.condition) },
                { label: t('vehicles.bodyType'), value: e('bodyType', v.bodyType) },
                { label: t('vehicles.fuelType'), value: e('fuelType', v.fuelType) },
                { label: t('vehicles.transmission'), value: e('transmission', v.transmission) },
                { label: t('vehicles.drivetrain'), value: e('drivetrain', v.drivetrain) },
                { label: t('vehicles.engineCapacity'), value: v.engineCapacityCc ? <span className="num">{fmtNumber(v.engineCapacityCc)} cc</span> : null },
                { label: t('vehicles.cylinders'), value: v.cylinders },
                { label: t('vehicles.horsepower'), value: v.horsepower },
                { label: `${t('vehicles.doors')} / ${t('vehicles.seats')}`, value: [v.doors, v.seats].filter(Boolean).join(' / ') || null },
                { label: t('vehicles.exteriorColor'), value: v.exteriorColor },
                { label: t('vehicles.interiorColor'), value: v.interiorColor },
                { label: t('vehicles.specRegion'), value: e('specRegion', v.specRegion) },
                { label: t('vehicles.originCountry'), value: v.originCountry },
                { label: t('vehicles.registrationYear'), value: v.registrationYear },
                { label: t('vehicles.acquiredAt'), value: fmtDate(v.acquiredAt) },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('vehicles.features')} />
          <CardBody>
            {d.features.length ? (
              <div className="flex flex-wrap gap-2">
                {d.features.map((f) => (
                  <span key={f.id} className="rounded-full border border-line bg-surface-2 px-3 py-1 text-[13px]">
                    {i18n.language === 'en' ? f.nameEn : f.nameAr}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">{t('vehicles.noFeatures')}</p>
            )}
          </CardBody>
        </Card>
      </div>
      <div className="space-y-5">
        <Card>
          <CardHeader title={t('vehicles.sections.ownership')} />
          <CardBody>
            <DescriptionList
              columns={1}
              items={[
                { label: t('vehicles.ownershipStatus'), value: e('ownershipStatus', v.ownershipStatus) },
                { label: t('vehicles.documentsStatus'), value: e('documentsStatus', v.documentsStatus) },
                { label: t('vehicles.warranty'), value: [e('warrantyType', v.warrantyType), v.warrantyUntil && fmtDate(v.warrantyUntil)].filter(Boolean).join(' — ') },
                { label: t('vehicles.location'), value: v.locationLabel },
                ...(v.internalNotes !== null ? [{ label: t('vehicles.internalNotes'), value: <span className="whitespace-pre-wrap">{v.internalNotes || '—'}</span> }] : []),
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('vehicles.odometerReading.title')} />
          <ul className="divide-y divide-line">
            {d.odometer.slice(0, 8).map((o) => (
              <li key={o.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span className="num font-medium">
                  {fmtNumber(o.value)} {o.unit}
                  {o.isCorrection && <span className="ms-2 text-xs text-warning">({t('vehicles.odometerReading.correction')})</span>}
                </span>
                <span className="text-xs text-muted">
                  {t(`vehicles.enums.odometerSource.${o.source}`)} · {fmtDate(o.readAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function PricingTab({ d }: { d: VehicleDetail }) {
  const { t } = useTranslation();
  const { currency, can } = useAuth();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title={t('vehicles.tabs.pricing')} />
        <CardBody>
          <DescriptionList
            columns={1}
            items={[
              { label: t('vehicles.askingPrice'), value: <span className="num text-lg font-semibold">{fmtMoney(d.vehicle.askingPrice, currency)}</span> },
              ...(can('vehicles.view_cost')
                ? [
                    { label: t('vehicles.minPrice'), value: <span className="num">{fmtMoney(d.vehicle.minPrice, currency)}</span> },
                    { label: t('vehicles.targetMargin'), value: d.vehicle.targetMarginPct ? <span className="num">{Number(d.vehicle.targetMarginPct)}%</span> : '—' },
                  ]
                : []),
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('vehicles.pricing.history')} />
        <ul className="divide-y divide-line">
          {d.priceHistory.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted">{t('common.noData')}</li>}
          {d.priceHistory.map((p) => (
            <li key={p.id} className="px-5 py-3 text-sm">
              <div className="flex justify-between gap-2">
                <span className="font-medium">{t(`vehicles.pricing.field.${p.field}`)}</span>
                <span className="num">
                  <span className="text-muted line-through">{p.oldValue ? fmtMoney(p.oldValue, currency) : '—'}</span> → {p.newValue ? fmtMoney(p.newValue, currency) : '—'}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {p.actorName} · {fmtDateTime(p.createdAt)} {p.reason && `· ${p.reason}`}
              </p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function HistoryTab({ d }: { d: VehicleDetail }) {
  const { t } = useTranslation();
  const label = useStatusLabel();
  return (
    <Card>
      <ol className="relative space-y-0 px-5 py-4">
        {d.statusHistory.map((h) => (
          <li key={h.id} className="relative border-s-2 border-line ps-5 pb-5 last:pb-0">
            <span className="absolute -start-[7px] top-1 h-3 w-3 rounded-full border-2 border-surface bg-brand" aria-hidden />
            <p className="text-sm font-medium">
              {h.fromStatus ? `${label(h.fromStatus as VehicleStatus)} → ` : ''}
              {label(h.toStatus as VehicleStatus)}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {fmtDateTime(h.createdAt)} · {h.actorName ?? '—'} · {t(`vehicles.enums.statusSource.${h.source}`)}
            </p>
            {h.reason && h.reason !== 'created' && <p className="mt-1 text-[13px] text-ink">{h.reason}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function VehicleDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can, canAny, currency } = useAuth();
  const q = useVehicle(id);
  const [tab, setTab] = useState<TabKey>('overview');
  // Tabs contributed by other features (costs, work orders, reservations, …), filtered by permission.
  const extraTabs = FEATURE_MODULES.flatMap((m) => m.vehicleTabs ?? []).filter((x) => !x.anyOf || canAny(...x.anyOf));
  const [modal, setModal] = useState<'status' | 'pricing' | 'transfer' | 'odometer' | null>(null);
  const startInspection = useApiMutation<Record<string, unknown>, { id: string }>({
    path: `/vehicles/${id}/inspections`,
    invalidate: [['vehicle', id]],
    success: null,
    onSuccess: (r) => navigate(`/app/inspections/${r.id}`),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const v = d.vehicle;
  const title = vehicleTitle({ modelYear: v.modelYear, trim: v.trim, makeNameEn: d.make.nameEn, makeNameAr: d.make.nameAr, modelNameEn: d.model.nameEn, modelNameAr: d.model.nameAr }, i18n.language);
  const primary = d.media.find((m) => m.isPrimary) ?? d.media.find((m) => m.kind === 'photo');
  const closed = ['delivered', 'removed'].includes(v.status);
  const draft = d.inspections.find((i) => i.status === 'draft');

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('nav.vehicles'), to: '/app/vehicles' }, { label: v.stockNumber }]}
        title={title}
        actions={
          !closed && (
            <>
              <Can perm="vehicles.update">
                <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => navigate(`/app/vehicles/${v.id}/edit`)}>
                  {t('common.edit')}
                </Button>
              </Can>
              <Can perm="vehicles.change_status">
                <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => setModal('status')}>
                  {t('vehicles.actions.changeStatus')}
                </Button>
              </Can>
              <Can perm="pricing.update">
                <Button variant="secondary" icon={<Tag className="h-4 w-4" />} onClick={() => setModal('pricing')}>
                  {t('vehicles.actions.setPricing')}
                </Button>
              </Can>
              <Can perm="inventory.transfer">
                {!d.activeTransfer && (
                  <Button variant="secondary" icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setModal('transfer')}>
                    {t('vehicles.actions.transfer')}
                  </Button>
                )}
              </Can>
              <Can perm="inspections.perform">
                <Button
                  icon={<ClipboardCheck className="h-4 w-4" />}
                  loading={startInspection.isPending}
                  onClick={() => (draft ? navigate(`/app/inspections/${draft.id}`) : startInspection.mutate({ type: d.inspections.length ? 'periodic' : 'acquisition' }))}
                >
                  {draft ? t('vehicles.inspections.continue') : t('vehicles.actions.startInspection')}
                </Button>
              </Can>
            </>
          )
        }
      />
      {d.activeTransfer && (
        <Alert tone="info" className="mb-4" title={`${t('vehicles.transfer.inTransit')} — ${d.activeTransfer.number}`}>
          {fmtDateTime(d.activeTransfer.shippedAt)}
        </Alert>
      )}
      <Card className="mb-5 overflow-hidden">
        <div className="grid md:grid-cols-[320px_1fr]">
          <VehiclePhoto fileId={primary?.fileId ?? null} alt={title} className="aspect-[4/3] h-full w-full md:aspect-auto md:min-h-[210px]" />
          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-muted">{t('common.status')}</p>
              <div className="mt-1">
                <VehicleStatusBadge status={v.status} />
              </div>
            </div>
            <div>
              <p className="text-xs text-muted">{t('vehicles.askingPrice')}</p>
              <p className="num mt-1 text-xl font-semibold">{v.askingPrice ? fmtMoney(v.askingPrice, currency) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted">{t('vehicles.odometer')}</p>
              <p className="num mt-1 flex items-center gap-1.5 font-medium">
                <Gauge className="h-4 w-4 text-muted" /> {fmtNumber(v.odometerValue)} {v.odometerUnit}
                {can('vehicles.update') && !closed && (
                  <button type="button" className="text-xs text-brand-strong underline-offset-2 hover:underline" onClick={() => setModal('odometer')}>
                    {t('common.edit')}
                  </button>
                )}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">{t('vehicles.daysInStock')}</p>
              <p className="num mt-1 flex items-center gap-1.5 font-medium">
                <Timer className="h-4 w-4 text-muted" /> {d.daysInStock ?? '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">{t('vehicles.stockNumber')}</p>
              <p className="num mt-1 font-medium">{v.stockNumber}</p>
            </div>
            <div>
              <p className="text-xs text-muted">{t('vehicles.branch')}</p>
              <p className="mt-1 flex items-center gap-1.5 font-medium">
                <MapPin className="h-4 w-4 text-muted" /> {d.branch.name}
                {v.locationLabel && <span className="text-xs text-muted">· {v.locationLabel}</span>}
              </p>
            </div>
            <div className="sm:col-span-2">
              <p className="text-xs text-muted">{t('vehicles.vin')}</p>
              <p className="num mt-1 font-medium tracking-wide">{v.vin ?? '—'}</p>
            </div>
          </div>
        </div>
      </Card>

      <div className="mb-5">
        <Tabs<TabKey>
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'overview', label: t('vehicles.tabs.overview') },
            { key: 'media', label: t('vehicles.tabs.media'), count: d.media.length },
            { key: 'documents', label: t('vehicles.tabs.documents'), count: d.documents.length },
            { key: 'inspections', label: t('vehicles.tabs.inspections'), count: d.inspections.length },
            { key: 'pricing', label: t('vehicles.tabs.pricing') },
            { key: 'history', label: t('vehicles.tabs.history') },
            ...extraTabs.map((x) => ({ key: `x:${x.key}` as TabKey, label: t(x.labelKey) })),
          ]}
        />
      </div>
      {tab === 'overview' && <Overview d={d} />}
      {tab === 'media' && <MediaTab d={d} />}
      {tab === 'documents' && <DocumentsTab d={d} />}
      {tab === 'inspections' && <InspectionsTab d={d} />}
      {tab === 'pricing' && <PricingTab d={d} />}
      {tab === 'history' && <HistoryTab d={d} />}
      {extraTabs.map((x) => (tab === `x:${x.key}` ? <x.component key={x.key} d={d} /> : null))}

      {modal === 'status' && <StatusModal d={d} onClose={() => setModal(null)} />}
      {modal === 'pricing' && <PricingModal d={d} onClose={() => setModal(null)} />}
      {modal === 'transfer' && <TransferModal d={d} onClose={() => setModal(null)} />}
      {modal === 'odometer' && <OdometerModal d={d} onClose={() => setModal(null)} />}
    </>
  );
}
