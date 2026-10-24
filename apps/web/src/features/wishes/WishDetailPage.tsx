import { Ban, CarFront, CheckCircle2, CircleCheck, CircleX, EyeOff, Pencil, Search, UserRound } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { WISH_CRITERIA } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader, Spinner } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useMakes, useModels, VehicleListItem } from '@/features/vehicles/api';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtPhone } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';
import { Paged, useCustomerBrief, useWish, Wish, WishDetail, WishExplain, WishMatch } from './api';
import { buildWishPayload, CriteriaChips, useCriteriaLabels, WishFields, WishFormState, WishNames, WishStatusBadge, wishToForm } from './components';
import { serverFieldErrors, useWishError, useWishMutation } from './kit';

function matchTitle(m: Pick<WishMatch, 'makeEn' | 'makeAr' | 'modelEn' | 'modelAr' | 'modelYear'>, en: boolean) {
  return `${en ? m.makeEn : m.makeAr} ${en ? m.modelEn : m.modelAr} ${m.modelYear}`;
}

function useWishNames(w: Wish | undefined): WishNames {
  const { i18n } = useTranslation();
  const en = i18n.language === 'en';
  const makes = useMakes();
  const models = useModels(w?.makeId ?? null);
  const make = makes.data?.find((m) => m.id === w?.makeId);
  const model = models.data?.find((m) => m.id === w?.modelId);
  return { make: make ? (en ? make.nameEn : make.nameAr) : null, model: model ? (en ? model.nameEn : model.nameAr) : null };
}

// ── Explain ───────────────────────────────────────────────────────────────────────────────

/** Why a vehicle does or does not fit: one row per criterion the wish sets. */
function ExplainModal({ wish, names, vehicle, onClose }: { wish: Wish; names: WishNames; vehicle: { id: string; title: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { currency } = useAuth();
  const q = useApi<WishExplain>(['wishes', 'explain', wish.id, vehicle?.id], vehicle ? `/wishes/${wish.id}/explain/${vehicle.id}` : null);
  const wanted: Record<string, string> = {};
  for (const k of WISH_CRITERIA) {
    const v = wish[k];
    if (v === null || v === undefined || v === '') continue;
    if (k === 'makeId') wanted[k] = names.make ?? '—';
    else if (k === 'modelId') wanted[k] = names.model ?? '—';
    else if (k === 'maxPrice') wanted[k] = t('wishes.criteria.upToPrice', { amount: fmtMoney(String(v), currency) });
    else if (k === 'maxOdometerKm') wanted[k] = t('wishes.criteria.upToKm', { km: fmtNumber(Number(v)) });
    else if (k === 'yearFrom') wanted[k] = t('wishes.criteria.yearFromOnly', { year: v });
    else if (k === 'yearTo') wanted[k] = t('wishes.criteria.yearToOnly', { year: v });
    else if (k === 'bodyType' || k === 'fuelType' || k === 'transmission') wanted[k] = t(`wishes.enums.${k}.${v}`, { defaultValue: String(v) });
    else wanted[k] = String(v);
  }
  return (
    <Modal open={!!vehicle} onClose={onClose} title={t('wishes.explain.title')} description={vehicle?.title} size="md">
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data ? (
        <div className="space-y-4">
          <Alert tone={q.data.matches ? 'success' : 'warning'} title={q.data.matches ? t('wishes.explain.matches') : t('wishes.explain.mismatches', { count: q.data.mismatches.length })}>
            {!q.data.matches && t('wishes.explain.missingData')}
          </Alert>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {Object.entries(wanted).map(([k, v]) => {
              const fail = q.data!.mismatches.includes(k as (typeof WISH_CRITERIA)[number]);
              return (
                <li key={k} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block text-xs text-muted">{t(`wishes.criteria.${k}`)}</span>
                    <span className="block truncate text-ink">{v}</span>
                  </span>
                  {fail ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-danger">
                      <CircleX className="h-4 w-4" aria-hidden /> {t('wishes.explain.fail')}
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-success">
                      <CircleCheck className="h-4 w-4" aria-hidden /> {t('wishes.explain.ok')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </Modal>
  );
}

/** Search the stock and check any vehicle against the wish (vehicles.read). */
function CheckVehicleCard({ onCheck }: { onCheck: (v: { id: string; title: string }) => void }) {
  const { t, i18n } = useTranslation();
  const { currency } = useAuth();
  const en = i18n.language === 'en';
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 350);
  const res = useApi<Paged<VehicleListItem>>(['vehicles', 'wish-check'], debounced.length >= 2 ? '/vehicles' : null, { q: debounced, scope: 'all', pageSize: 6 });
  return (
    <Card>
      <CardHeader title={t('wishes.explain.checkVehicle')} subtitle={t('wishes.explain.checkVehicleHint')} />
      <CardBody className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input type="search" className="ps-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('wishes.explain.searchVehicle')} aria-label={t('wishes.explain.checkVehicle')} />
        </div>
        {debounced.length >= 2 &&
          (res.isLoading ? (
            <Spinner />
          ) : res.error ? (
            <ErrorState error={res.error} onRetry={() => res.refetch()} />
          ) : res.data?.items.length ? (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {res.data.items.map((v) => {
                const title = `${en ? v.makeNameEn : v.makeNameAr} ${en ? v.modelNameEn : v.modelNameAr} ${v.modelYear}`;
                return (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{title}</span>
                      <span className="num block truncate text-xs text-muted">
                        {v.stockNumber}
                        {v.askingPrice && ` · ${fmtMoney(v.askingPrice, currency)}`}
                      </span>
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => onCheck({ id: v.id, title })}>
                      {t('wishes.explain.check')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t('wishes.explain.noVehicles')}</p>
          ))}
      </CardBody>
    </Card>
  );
}

// ── Close (fulfil / cancel) ───────────────────────────────────────────────────────────────

function CloseModal({ wish, kind, onClose }: { wish: WishDetail; kind: 'fulfil' | 'cancel' | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const en = i18n.language === 'en';
  const [note, setNote] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const close = useWishMutation<{ note: string | null; vehicleId?: string | null }, Wish>({
    path: `/wishes/${wish.id}/${kind === 'fulfil' ? 'fulfil' : 'cancel'}`,
    invalidate: [['wishes']],
    success: kind === 'fulfil' ? t('wishes.close.fulfilled') : t('wishes.close.cancelled'),
    onSuccess: () => {
      setNote('');
      setVehicleId('');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    close.mutate(kind === 'fulfil' ? { note: note.trim() || null, vehicleId: vehicleId || null } : { note: note.trim() || null });
  };
  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      size="sm"
      title={kind === 'fulfil' ? t('wishes.close.fulfilTitle') : t('wishes.close.cancelTitle')}
      description={kind === 'fulfil' ? t('wishes.close.fulfilHint') : t('wishes.close.cancelHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="wish-close-form" variant={kind === 'cancel' ? 'danger' : 'success'} loading={close.isPending}>
            {kind === 'fulfil' ? t('wishes.close.confirmFulfil') : t('wishes.close.confirmCancel')}
          </Button>
        </>
      }
    >
      <form id="wish-close-form" onSubmit={submit} className="space-y-4">
        {kind === 'fulfil' && (
          <Field label={t('wishes.close.vehicle')}>
            {(id) => (
              <Select id={id} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">{t('wishes.close.noVehicle')}</option>
                {wish.matches.map((m) => (
                  <option key={m.vehicleId} value={m.vehicleId}>
                    {m.stockNumber} — {matchTitle(m, en)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('wishes.close.note')}>
          {(id) => <Textarea id={id} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  );
}

// ── Edit ──────────────────────────────────────────────────────────────────────────────────

function EditModal({ wish, open, onClose }: { wish: WishDetail; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const describe = useWishError();
  const [form, setFormState] = useState<WishFormState>(() => wishToForm(wish));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const update = useWishMutation<Record<string, unknown>, WishDetail>({
    path: `/wishes/${wish.id}`,
    method: 'PATCH',
    invalidate: [['wishes']],
    success: t('wishes.updated'),
    onSuccess: onClose,
  });
  const setForm = (patch: Partial<WishFormState>) => {
    setFormState((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      if (next.makeId === 'needCriterion') delete next.makeId;
      return next;
    });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const { payload, errors: errs } = buildWishPayload(form, { kind: 'edit' });
    setErrors(errs);
    if (!payload) return;
    // Send only what changed: an untouched (possibly past) expiry must not be re-validated.
    const original = buildWishPayload(wishToForm(wish), { kind: 'edit' }).payload ?? {};
    const changed = Object.fromEntries(Object.entries(payload).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(original[k])));
    if (!Object.keys(changed).length) return onClose();
    try {
      await update.mutateAsync(changed);
    } catch (err) {
      const fields = serverFieldErrors(err);
      setErrors(fields);
      if (!Object.keys(fields).length) setFormError(describe(err));
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('wishes.editTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="wish-edit-form" loading={update.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="wish-edit-form" onSubmit={submit} noValidate>
        <WishFields compact form={form} setForm={setForm} errors={errors} />
        {formError && (
          <Alert tone="danger" className="mt-4">
            {formError}
          </Alert>
        )}
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────────────────

export function WishDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const en = i18n.language === 'en';
  const { currency, can } = useAuth();
  const q = useWish(id);
  const w = q.data;
  const customer = useCustomerBrief(w?.customerId);
  const names = useWishNames(w);
  const criteria = useCriteriaLabels();
  const [explain, setExplain] = useState<{ id: string; title: string } | null>(null);
  const [dismiss, setDismiss] = useState<WishMatch | null>(null);
  const [closing, setClosing] = useState<'fulfil' | 'cancel' | null>(null);
  const [editing, setEditing] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const dismissM = useWishMutation<{ vehicleId: string }, { ok: boolean }>({
    path: (v) => `/wishes/${id}/matches/${v.vehicleId}/dismiss`,
    body: () => ({}),
    invalidate: [['wishes']],
    success: t('wishes.matches.dismissed_ok'),
    onSuccess: () => setDismiss(null),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !w) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const active = w.status === 'active';
  const canManage = can('customers.manage');
  const dismissedCount = w.matches.filter((m) => m.dismissedAt).length;
  const visible = showDismissed ? w.matches : w.matches.filter((m) => !m.dismissedAt);
  const customerName = customer.data?.customer.fullName;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('wishes.title'), to: '/app/wishes' }, { label: customerName ?? t('wishes.wish') }]}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="truncate">{customerName ?? t('wishes.wish')}</span>
            <WishStatusBadge status={w.status} />
          </span>
        }
        subtitle={<CriteriaChips wish={w} names={names} className="mt-1" />}
        actions={
          <>
            <Can perm="customers.read">
              <Link to={`/app/customers/${w.customerId}`} className="inline-flex h-10 items-center gap-2 rounded-lg border border-line-strong px-4 text-sm font-medium text-ink hover:bg-surface-2">
                <UserRound className="h-4 w-4" aria-hidden />
                {t('wishes.detail.openCustomer')}
              </Link>
            </Can>
            {active && canManage && (
              <>
                <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
                  {t('common.edit')}
                </Button>
                <Button variant="success" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setClosing('fulfil')}>
                  {t('wishes.detail.fulfil')}
                </Button>
                <Button variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={() => setClosing('cancel')}>
                  {t('wishes.detail.cancel')}
                </Button>
              </>
            )}
          </>
        }
      />

      {!active && (
        <Alert tone="info" className="mb-4">
          {t('wishes.detail.closedNotice', { status: t(`wishes.statuses.${w.status}`) })}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader
              title={t('wishes.matches.title')}
              subtitle={t('wishes.matches.subtitle')}
              actions={
                dismissedCount > 0 && (
                  <Button variant="ghost" size="sm" icon={<EyeOff className="h-4 w-4" />} onClick={() => setShowDismissed((s) => !s)}>
                    {showDismissed ? t('wishes.matches.hideDismissed') : t('wishes.matches.showDismissed', { count: dismissedCount })}
                  </Button>
                )
              }
            />
            <DataTable
              rows={visible}
              rowKey={(m) => m.vehicleId}
              empty={<EmptyState icon={<CarFront className="h-5 w-5" />} title={t('wishes.matches.empty')} description={active ? t('wishes.matches.emptyHint') : undefined} />}
              columns={[
                {
                  key: 'vehicle',
                  header: t('wishes.matches.vehicle'),
                  cell: (m) => (
                    <div className="min-w-0">
                      {can('vehicles.read') ? (
                        <Link to={`/app/vehicles/${m.vehicleId}`} className="block max-w-[240px] truncate font-medium text-ink hover:text-brand-strong hover:underline">
                          {matchTitle(m, en)}
                        </Link>
                      ) : (
                        <span className="block max-w-[240px] truncate font-medium">{matchTitle(m, en)}</span>
                      )}
                      <span className="num block text-xs text-muted">
                        {m.stockNumber}
                        {m.exteriorColor && ` · ${m.exteriorColor}`}
                      </span>
                    </div>
                  ),
                },
                { key: 'price', header: t('wishes.matches.price'), align: 'end', cell: (m) => <span className="num whitespace-nowrap">{m.askingPrice ? fmtMoney(m.askingPrice, currency) : '—'}</span> },
                {
                  key: 'odo',
                  header: t('wishes.matches.odometer'),
                  align: 'end',
                  hideOnMobile: true,
                  cell: (m) => (
                    <span dir="ltr" className="num whitespace-nowrap">
                      {fmtNumber(m.odometerValue)} {m.odometerUnit}
                    </span>
                  ),
                },
                {
                  key: 'state',
                  header: t('wishes.matches.state'),
                  cell: (m) =>
                    m.dismissedAt ? (
                      <Badge tone="neutral">{t('wishes.matches.dismissed')}</Badge>
                    ) : m.onSale ? (
                      <Badge tone="success">{t('wishes.matches.onSale')}</Badge>
                    ) : (
                      <Badge tone="warning">{t('wishes.matches.notOnSale')}</Badge>
                    ),
                },
                { key: 'at', header: t('wishes.matches.matchedAt'), hideOnMobile: true, cell: (m) => <span className="whitespace-nowrap text-muted">{fmtDateTime(m.matchedAt)}</span> },
                {
                  key: 'actions',
                  header: t('common.actions'),
                  align: 'end',
                  cell: (m) => (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setExplain({ id: m.vehicleId, title: `${m.stockNumber} — ${matchTitle(m, en)}` })}>
                        {t('wishes.matches.explain')}
                      </Button>
                      {canManage && !m.dismissedAt && (
                        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDismiss(m)}>
                          {t('wishes.matches.dismiss')}
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>
          <Can perm="vehicles.read">
            <CheckVehicleCard onCheck={setExplain} />
          </Can>
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title={t('wishes.detail.criteria')} />
            <CardBody>
              <DescriptionList columns={1} items={criteria(w, names).map((c) => ({ label: c.label, value: c.value }))} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('wishes.detail.info')} />
            <CardBody>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('wishes.fields.customer'), value: customerName ?? '—' },
                  {
                    label: t('common.phone'),
                    value: customer.data?.customer.phone ? (
                      <a dir="ltr" className="num text-brand-strong hover:underline" href={`tel:${fmtPhone(customer.data.customer.phone)}`}>
                        {fmtPhone(customer.data.customer.phone)}
                      </a>
                    ) : (
                      '—'
                    ),
                  },
                  { label: t('wishes.detail.createdAt'), value: fmtDateTime(w.createdAt) },
                  { label: t('wishes.detail.updatedAt'), value: fmtDateTime(w.updatedAt) },
                  { label: t('wishes.detail.expiresAt'), value: w.expiresAt ? fmtDate(w.expiresAt) : t('wishes.detail.noExpiry') },
                  { label: t('wishes.detail.notes'), value: w.notes ? <span className="whitespace-pre-line">{w.notes}</span> : '—' },
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>

      <ExplainModal wish={w} names={names} vehicle={explain} onClose={() => setExplain(null)} />
      <ConfirmDialog
        open={!!dismiss}
        onClose={() => setDismiss(null)}
        onConfirm={() => {
          if (dismiss) dismissM.mutate({ vehicleId: dismiss.vehicleId });
        }}
        title={t('wishes.matches.dismissTitle')}
        message={
          dismiss && (
            <>
              <p className="font-medium text-ink">
                {dismiss.stockNumber} — {matchTitle(dismiss, en)}
              </p>
              <p className="mt-1">{t('wishes.matches.dismissMessage')}</p>
            </>
          )
        }
        confirmLabel={t('wishes.matches.dismiss')}
        tone="danger"
        loading={dismissM.isPending}
      />
      {active && <CloseModal wish={w} kind={closing} onClose={() => setClosing(null)} />}
      {editing && <EditModal wish={w} open={editing} onClose={() => setEditing(false)} />}
    </>
  );
}
