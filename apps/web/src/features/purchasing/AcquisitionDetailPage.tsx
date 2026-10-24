import { zodResolver } from '@hookform/resolvers/zod';
import { Ban, CheckCircle2, CreditCard, ExternalLink, Pencil, Send, ShieldAlert, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { z } from 'zod';
import {
  ACQUISITION_SOURCES,
  CURRENCIES,
  CURRENCY_CODES,
  d,
  OWNERSHIP_TRANSFER_STATUSES,
  PAYMENT_METHODS,
  VehicleStatus,
  zAcquisitionApprove,
  zAcquisitionUpdate,
} from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader, Skeleton } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { VehicleStatusBadge } from '@/features/vehicles/components';
import { ApiError, newIdempotencyKey } from '@/lib/api';
import { Can, useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import {
  Acquisition,
  AcquisitionApproved,
  AcquisitionDetail,
  AuditEntry,
  OwnershipTransferStatus,
  Paged,
  PAYABLE_KEYS,
  useAcquisition,
  useApAccess,
  useApprovals,
  useCashAccountOptions,
} from './api';
import { usePurchasingError, usePurchasingMutation } from './mutation';
import {
  AcquisitionStatusBadge,
  acquisitionVehicleTitle,
  applyServerErrors,
  emptyToNull,
  emptyToUndefined,
  Money,
  PaymentStatusBadge,
  Stat,
  SupplierPicker,
  toBase,
  useFieldError,
  useIdempotencyKey,
  useTenantMoney,
} from './components';

type Dialog = 'edit' | 'approve' | 'reject' | 'cancel' | 'submit' | null;

const rateText = (rate: string) => d(rate).toString();

// ── Edit (draft / pending approval) ──────────────────────────────────────────────────────

type EditIn = z.input<typeof zAcquisitionUpdate>;
type EditOut = z.output<typeof zAcquisitionUpdate>;

function EditModal({ a, onClose }: { a: AcquisitionDetail; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { base, rounding } = useTenantMoney();
  const fieldError = useFieldError();
  const schema = useMemo(
    () =>
      zAcquisitionUpdate.superRefine((v, ctx) => {
        if (v.currency && v.currency !== base && !v.exchangeRate) {
          ctx.addIssue({ code: 'custom', path: ['exchangeRate'], message: 'exchange_rate_required' });
        }
      }),
    [base],
  );
  const form = useForm<EditIn, unknown, EditOut>({
    resolver: zodResolver(schema),
    defaultValues: {
      supplierId: a.supplierId,
      sourceType: a.sourceType,
      purchaseDate: a.purchaseDate,
      purchasePrice: a.purchasePrice,
      currency: a.currency as EditIn['currency'],
      exchangeRate: a.currency === base ? undefined : rateText(a.exchangeRate),
      paymentMethod: a.paymentMethod,
      dueDate: a.dueDate,
      notes: a.notes ?? '',
      version: a.version,
    },
  });
  const errors = form.formState.errors;
  const [currency, price, rate] = form.watch(['currency', 'purchasePrice', 'exchangeRate']);
  const cur = currency ?? base;
  const foreign = cur !== base;
  const preview = toBase(price, cur, rate, base, rounding);
  const save = usePurchasingMutation<EditOut, Acquisition>({
    path: `/acquisitions/${a.id}`,
    method: 'PATCH',
    invalidate: [['acquisition', a.id], ['acquisitions'], ['approvals'], ['acquisition-audit', a.id]],
    success: (r) => (r.status === 'draft' && a.status === 'pending_approval' ? t('purchasing.acquisitions.updatedBackToDraft') : t('purchasing.acquisitions.updated')),
    onSuccess: onClose,
  });
  const submit = form.handleSubmit((v) =>
    save.mutate({ ...v, exchangeRate: v.currency === base ? undefined : v.exchangeRate }, { onError: (e) => applyServerErrors(e, form.setError) }),
  );
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('purchasing.acquisitions.editTitle', { number: a.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="acq-edit-form" loading={save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {a.status === 'pending_approval' && (
        <Alert tone="warning" className="mb-4">
          {t('purchasing.acquisitions.editPendingWarning')}
        </Alert>
      )}
      <form id="acq-edit-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label={t('purchasing.acquisitions.supplier')} required className="sm:col-span-2" error={fieldError(errors.supplierId)}>
          {(fid, desc) => (
            <Controller
              control={form.control}
              name="supplierId"
              render={({ field }) => <SupplierPicker id={fid} describedBy={desc} value={field.value ?? ''} onChange={(v) => field.onChange(v || undefined)} />}
            />
          )}
        </Field>
        <Field label={t('purchasing.acquisitions.sourceType')}>
          {(fid) => (
            <Select id={fid} {...form.register('sourceType')}>
              {ACQUISITION_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`purchasing.enums.source.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('purchasing.acquisitions.purchaseDate')} required error={fieldError(errors.purchaseDate)}>
          {(fid) => <Input id={fid} type="date" {...form.register('purchaseDate')} />}
        </Field>
        <Field label={t('purchasing.acquisitions.price')} required error={fieldError(errors.purchasePrice)}>
          {(fid, desc) => <MoneyInput id={fid} aria-describedby={desc} currency={cur} invalid={!!errors.purchasePrice} {...form.register('purchasePrice')} />}
        </Field>
        <Field label={t('common.currency')}>
          {(fid) => (
            <Select
              id={fid}
              {...form.register('currency', {
                onChange: (e) => {
                  if (e.target.value === base) form.setValue('exchangeRate', undefined);
                },
              })}
            >
              {CURRENCY_CODES.map((c) => (
                <option key={c} value={c}>
                  {c} — {i18n.language === 'en' ? CURRENCIES[c].nameEn : CURRENCIES[c].nameAr}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {foreign && (
          <Field label={t('purchasing.fx.rate', { from: cur, to: base })} required error={fieldError(errors.exchangeRate)}>
            {(fid, desc) => (
              <Input id={fid} aria-describedby={desc} dir="ltr" inputMode="decimal" className="num" {...form.register('exchangeRate', { setValueAs: emptyToUndefined })} />
            )}
          </Field>
        )}
        <div className="rounded-xl border border-line bg-surface-2/60 px-4 py-2.5" aria-live="polite">
          <p className="text-xs text-muted">{t('purchasing.fx.baseEquivalent', { currency: base })}</p>
          <p className="num font-semibold">{preview ? fmtMoney(preview, base) : '—'}</p>
        </div>
        <Field label={t('purchasing.acquisitions.paymentMethod')}>
          {(fid) => (
            <Select id={fid} {...form.register('paymentMethod', { setValueAs: emptyToNull })}>
              <option value="">—</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`purchasing.enums.method.${m}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('purchasing.acquisitions.dueDate')} error={fieldError(errors.dueDate)}>
          {(fid) => <Input id={fid} type="date" {...form.register('dueDate', { setValueAs: emptyToNull })} />}
        </Field>
        <Field label={t('common.notes')} className="sm:col-span-2">
          {(fid) => <Textarea id={fid} rows={2} {...form.register('notes')} />}
        </Field>
      </form>
    </Modal>
  );
}

// ── Approve (optionally pay now from a base-currency account) ───────────────────────────

function ApproveModal({ a, onClose, onSelfApproval }: { a: AcquisitionDetail; onClose: () => void; onSelfApproval: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { base } = useTenantMoney();
  const describe = usePurchasingError();
  // One key per approval action: a refused request rolls back with its key, so retrying after
  // fixing the cause reuses it safely, while a lost response is replayed instead of re-posted.
  const [idemKey] = useIdempotencyKey();
  const canPay = can('supplier_payments.create');
  const accounts = useCashAccountOptions();
  const baseAccounts = (accounts.data ?? []).filter((c) => c.currency === base);
  const [note, setNote] = useState('');
  const [payNow, setPayNow] = useState(false);
  const [cashAccountId, setCashAccountId] = useState('');
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('cash');
  const [reference, setReference] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const approve = usePurchasingMutation<z.input<typeof zAcquisitionApprove>, AcquisitionApproved>({
    path: `/acquisitions/${a.id}/approve`,
    idempotent: true,
    invalidate: [...PAYABLE_KEYS, ['vehicle', a.vehicleId], ['vehicles'], ['acquisition-audit', a.id]],
    success: (r) => (r.payment ? t('purchasing.acquisitions.approvedAndPaid', { number: r.payment.number }) : t('purchasing.acquisitions.approved')),
    onSuccess: onClose,
  });
  // The approver decides on the version they reviewed; an edit since then is refused (409).
  const payload = {
    note: note.trim() || null,
    payNow: payNow ? { cashAccountId, method, reference: reference.trim() || null } : null,
    version: a.version,
  };
  const valid = zAcquisitionApprove.safeParse(payload).success;
  const selfApproval = failure instanceof ApiError && failure.code === 'self_approval_forbidden';
  const stale = failure instanceof ApiError && failure.code === 'version_conflict';
  return (
    <Modal
      open
      onClose={onClose}
      title={t('purchasing.acquisitions.approveTitle', { number: a.number })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="success"
            loading={approve.isPending}
            disabled={!valid || selfApproval || stale}
            onClick={() => {
              setFailure(null);
              approve.mutate(
                { ...payload, __idemKey: idemKey },
                {
                  onError: (e) => {
                    setFailure(e);
                    if (e instanceof ApiError && e.code === 'self_approval_forbidden') onSelfApproval();
                  },
                },
              );
            }}
          >
            {payNow ? t('purchasing.acquisitions.approveAndPay') : t('common.approve')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {selfApproval && (
          <Alert tone="danger" title={t('purchasing.acquisitions.makerCheckerTitle')}>
            {t('purchasing.acquisitions.makerCheckerBody')}
          </Alert>
        )}
        {stale && (
          <Alert tone="warning" title={t('purchasing.acquisitions.staleTitle')}>
            {t('purchasing.acquisitions.staleBody')}
          </Alert>
        )}
        {failure !== null && !selfApproval && !stale && <Alert tone="danger">{describe(failure)}</Alert>}
        <div className="grid gap-3 rounded-xl border border-line bg-surface-2/60 p-4 sm:grid-cols-2">
          <Stat label={t('purchasing.acquisitions.price')}>
            <Money value={a.purchasePrice} currency={a.currency} />
          </Stat>
          <Stat label={t('purchasing.acquisitions.baseAmount')}>
            <Money value={a.purchasePriceBase} currency={base} />
          </Stat>
        </div>
        <p className="text-[13px] text-muted">{t('purchasing.acquisitions.approveHint')}</p>
        <Field label={t('purchasing.acquisitions.approvalNote')}>
          {(fid) => <Textarea id={fid} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {canPay ? (
          <div className="space-y-3 rounded-xl border border-line p-4">
            <Checkbox
              label={t('purchasing.acquisitions.payNow')}
              description={t('purchasing.acquisitions.payNowHint', { currency: base })}
              checked={payNow}
              onChange={(e) => setPayNow(e.target.checked)}
            />
            {payNow && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('purchasing.payments.cashAccount')} required className="sm:col-span-2">
                  {(fid) => (
                    <Select id={fid} value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}>
                      <option value="">—</option>
                      {baseAccounts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {t(`purchasing.enums.cashAccountType.${c.type}`)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {accounts.data && baseAccounts.length === 0 && (
                  <Alert tone="warning" className="sm:col-span-2">
                    {t('purchasing.acquisitions.noBaseAccounts', { currency: base })}
                  </Alert>
                )}
                {accounts.error ? (
                  <Alert tone="danger" className="sm:col-span-2">
                    {t('purchasing.payments.accountsFailed')}
                  </Alert>
                ) : null}
                <Field label={t('purchasing.payments.method')}>
                  {(fid) => (
                    <Select id={fid} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {t(`purchasing.enums.method.${m}`)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={t('common.reference')}>
                  {(fid) => <Input id={fid} maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}
                </Field>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted">{t('purchasing.acquisitions.payNowNeedsPermission')}</p>
        )}
      </div>
    </Modal>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────────────────

const TIMELINE_ACTIONS = ['created', 'updated', 'submitted', 'approved', 'rejected', 'cancelled', 'ownership_updated'];

function Timeline({ a }: { a: AcquisitionDetail }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canAudit = can('audit.read');
  const audit = useApi<Paged<AuditEntry>>(['acquisition-audit', a.id, a.version], canAudit ? '/audit-logs' : null, {
    entityType: 'acquisition',
    entityId: a.id,
    pageSize: 100,
  });

  type Item = { key: string; title: string; at: string; actor?: string | null; note?: string | null };
  let items: Item[];
  if (canAudit) {
    if (audit.isLoading) {
      return (
        <div className="space-y-3 p-5">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      );
    }
    if (audit.error) return <ErrorState error={audit.error} onRetry={() => audit.refetch()} />;
    items = [...(audit.data?.items ?? [])]
      .reverse()
      .map((e) => {
        const action = e.action.replace(/^acquisition\./, '');
        const after = e.after ?? {};
        const note = (after.reason as string | undefined) ?? (after.note as string | undefined) ?? null;
        const ownership = action === 'ownership_updated' && typeof after.ownershipTransferStatus === 'string' ? ` — ${t(`purchasing.enums.ownership.${after.ownershipTransferStatus}`)}` : '';
        return {
          key: e.id,
          title: (TIMELINE_ACTIONS.includes(action) ? t(`purchasing.timeline.${action}`) : e.action) + ownership,
          at: e.createdAt,
          actor: e.actorName,
          note,
        };
      });
  } else {
    items = [
      { key: 'created', title: t('purchasing.timeline.created'), at: a.createdAt },
      ...(a.approvedAt ? [{ key: 'approved', title: t('purchasing.timeline.approved'), at: a.approvedAt }] : []),
      ...(a.cancelledAt ? [{ key: 'cancelled', title: t('purchasing.timeline.cancelled'), at: a.cancelledAt, note: a.cancelReason }] : []),
    ];
  }
  return (
    <>
      <ol className="px-5 py-4">
        {items.map((h) => (
          <li key={h.key} className="relative border-s-2 border-line ps-5 pb-5 last:pb-0">
            <span className="absolute -start-[7px] top-1 h-3 w-3 rounded-full border-2 border-surface bg-brand" aria-hidden />
            <p className="text-sm font-medium">{h.title}</p>
            <p className="mt-0.5 text-xs text-muted">
              {fmtDateTime(h.at)}
              {h.actor && ` · ${h.actor}`}
            </p>
            {h.note && <p className="mt-1 text-[13px] text-ink">{h.note}</p>}
          </li>
        ))}
      </ol>
      {!canAudit && <p className="px-5 pb-4 text-xs text-muted">{t('purchasing.timeline.partial')}</p>}
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────────────────

export function AcquisitionDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const ap = useApAccess();
  const { base } = useTenantMoney();
  const q = useAcquisition(id);
  const branches = useBranches();
  const canApprove = can('acquisitions.approve');
  const approvals = useApprovals(canApprove);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [cancelKey, setCancelKey] = useState('');
  // The server's maker-checker rule also counts editors and submitters; remember its verdict.
  const [refusedVersion, setRefusedVersion] = useState<number | null>(null);

  const inv: unknown[][] = [['acquisition', id], ['acquisitions'], ['approvals'], ['acquisition-audit', id]];
  const submitM = usePurchasingMutation<Record<string, never>>({ path: `/acquisitions/${id}/submit`, invalidate: inv, success: t('purchasing.acquisitions.submitted'), onSuccess: () => setDialog(null) });
  const rejectM = usePurchasingMutation<{ reason: string }>({ path: `/acquisitions/${id}/reject`, invalidate: inv, success: t('purchasing.acquisitions.rejected'), onSuccess: () => setDialog(null) });
  const cancelM = usePurchasingMutation<{ reason: string }>({
    path: `/acquisitions/${id}/cancel`,
    idempotent: true,
    invalidate: [...PAYABLE_KEYS, ['vehicles'], ['vehicle'], ['acquisition-audit', id]],
    success: t('purchasing.acquisitions.cancelled'),
    onSuccess: () => setDialog(null),
  });
  const ownershipM = usePurchasingMutation<{ status: OwnershipTransferStatus }>({
    path: `/acquisitions/${id}/ownership`,
    method: 'PUT',
    invalidate: [['acquisition', id], ['acquisitions'], ['acquisition-audit', id]],
    success: t('purchasing.acquisitions.ownershipUpdated'),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  const a = q.data;
  const editable = a.status === 'draft' || a.status === 'pending_approval';
  const approvalItem = approvals.data?.find((x) => x.entityType === 'acquisition' && x.entityId === a.id);
  const isMaker = a.createdBy === me?.user.id || approvalItem?.canDecide === false || refusedVersion === a.version;
  const outstanding = a.status === 'approved' ? a.outstandingBase : null;
  const branchName = branches.data?.find((b) => b.id === a.branchId)?.name;
  const vehicleTitle = a.vehicle ? acquisitionVehicleTitle(a.vehicle, i18n.language) : '—';
  const hasOutstanding = outstanding !== null && d(outstanding).gt(0);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('purchasing.acquisitions.title'), to: '/app/purchasing/acquisitions' }, { label: a.number }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="num">{a.number}</span>
            <AcquisitionStatusBadge status={a.status} />
          </span>
        }
        subtitle={vehicleTitle}
        actions={
          <>
            {editable && (
              <Can perm="acquisitions.create">
                <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setDialog('edit')}>
                  {t('common.edit')}
                </Button>
              </Can>
            )}
            {a.status === 'draft' && (
              <Can perm="acquisitions.create">
                <Button variant="secondary" icon={<Send className="h-4 w-4" />} onClick={() => setDialog('submit')}>
                  {t('purchasing.acquisitions.submit')}
                </Button>
              </Can>
            )}
            {a.status === 'pending_approval' && canApprove && (
              <Button variant="secondary" icon={<Undo2 className="h-4 w-4" />} onClick={() => setDialog('reject')}>
                {t('common.reject')}
              </Button>
            )}
            {editable && canApprove && (
              <Button
                variant="success"
                icon={<CheckCircle2 className="h-4 w-4" />}
                disabled={isMaker}
                title={isMaker ? t('purchasing.acquisitions.makerCheckerShort') : undefined}
                onClick={() => setDialog('approve')}
              >
                {t('common.approve')}
              </Button>
            )}
            {hasOutstanding && (
              <Can perm="supplier_payments.create">
                <Button
                  icon={<CreditCard className="h-4 w-4" />}
                  onClick={() => navigate(`/app/purchasing/payments/new?supplierId=${a.supplierId}&target=acquisition:${a.id}`)}
                >
                  {t('purchasing.payments.add')}
                </Button>
              </Can>
            )}
            {a.status !== 'cancelled' && (
              <Can perm="acquisitions.cancel">
                <Button
                  variant="ghost"
                  className="text-danger"
                  icon={<Ban className="h-4 w-4" />}
                  onClick={() => {
                    setCancelKey(newIdempotencyKey());
                    setDialog('cancel');
                  }}
                >
                  {t('purchasing.acquisitions.cancel')}
                </Button>
              </Can>
            )}
          </>
        }
      />

      {editable && canApprove && isMaker && (
        <Alert tone="info" className="mb-4" title={t('purchasing.acquisitions.makerCheckerTitle')}>
          {t('purchasing.acquisitions.makerCheckerBody')}
        </Alert>
      )}
      {a.status === 'pending_approval' && approvalItem && (
        <Alert tone="warning" className="mb-4">
          {t('purchasing.acquisitions.awaitingApproval', { name: approvalItem.requestedBy ?? '—', date: fmtDateTime(approvalItem.requestedAt) })}
        </Alert>
      )}
      {a.status === 'cancelled' && (
        <Alert tone="danger" className="mb-4" title={t('purchasing.acquisitions.cancelledOn', { date: fmtDateTime(a.cancelledAt) })}>
          {a.cancelReason}
        </Alert>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <Stat label={t('purchasing.acquisitions.price')}>
            <Money value={a.purchasePrice} currency={a.currency} className="text-lg font-semibold" />
          </Stat>
          {a.currency !== base && (
            <p className="num mt-1 text-xs text-muted">
              {t('purchasing.fx.atRate', { rate: rateText(a.exchangeRate) })}
            </p>
          )}
        </Card>
        <Card className="p-4">
          <Stat label={t('purchasing.acquisitions.baseAmount')}>
            <Money value={a.purchasePriceBase} currency={base} className="text-lg font-semibold" />
          </Stat>
        </Card>
        <Card className="p-4">
          <Stat label={t('purchasing.acquisitions.paid')}>
            <Money value={a.status === 'approved' ? a.paidBase : null} currency={base} className="text-lg font-semibold text-success" />
          </Stat>
        </Card>
        <Card className="p-4">
          <Stat label={t('purchasing.acquisitions.outstanding')}>
            <Money value={outstanding} currency={base} className={hasOutstanding ? 'text-lg font-semibold text-warning' : 'text-lg font-semibold'} />
          </Stat>
          {a.status !== 'approved' && a.status !== 'cancelled' && <p className="mt-1 text-xs text-muted">{t('purchasing.acquisitions.payableAfterApproval')}</p>}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title={t('purchasing.acquisitions.sections.purchase')} />
            <CardBody>
              <DescriptionList
                items={[
                  { label: t('purchasing.acquisitions.purchaseDate'), value: fmtDate(a.purchaseDate) },
                  { label: t('purchasing.acquisitions.dueDate'), value: fmtDate(a.dueDate) },
                  { label: t('purchasing.acquisitions.sourceType'), value: t(`purchasing.enums.source.${a.sourceType}`) },
                  { label: t('purchasing.acquisitions.paymentMethod'), value: a.paymentMethod ? t(`purchasing.enums.method.${a.paymentMethod}`) : '—' },
                  { label: t('common.branch'), value: branchName ?? '—' },
                  { label: t('common.currency'), value: a.currency !== base ? `${a.currency} · ${t('purchasing.fx.atRate', { rate: rateText(a.exchangeRate) })}` : a.currency },
                  { label: t('purchasing.acquisitions.approvedAt'), value: a.approvedAt ? fmtDateTime(a.approvedAt) : '—' },
                  { label: t('common.createdAt'), value: fmtDateTime(a.createdAt) },
                  { label: t('common.notes'), value: a.notes || '—', full: true },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('purchasing.acquisitions.payments')} subtitle={t('purchasing.acquisitions.paymentsHint')} />
            {a.payments.length === 0 ? (
              <EmptyState title={t('purchasing.acquisitions.noPayments')} />
            ) : (
              <DataTable
                rows={a.payments}
                rowKey={(p) => `${p.paymentId}-${p.targetId}`}
                dense
                onRowClick={ap.read ? (p) => navigate(`/app/purchasing/payments/${p.paymentId}`) : undefined}
                columns={[
                  { key: 'number', header: t('purchasing.payments.number'), cell: (p) => <span className="num font-medium">{p.number}</span> },
                  { key: 'date', header: t('common.date'), cell: (p) => fmtDate(p.paidAt) },
                  { key: 'method', header: t('purchasing.payments.method'), hideOnMobile: true, cell: (p) => t(`purchasing.enums.method.${p.method}`) },
                  { key: 'amount', header: t('purchasing.payments.settled'), align: 'end', cell: (p) => <Money value={p.amountBase} currency={base} className={p.status === 'voided' ? 'text-subtle line-through' : ''} /> },
                  { key: 'status', header: t('common.status'), cell: (p) => <PaymentStatusBadge status={p.status} /> },
                ]}
              />
            )}
          </Card>

          <Card>
            <CardHeader title={t('purchasing.timeline.title')} />
            <Timeline a={a} />
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title={t('purchasing.acquisitions.vehicle')} />
            <CardBody className="space-y-3">
              {a.vehicle ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{vehicleTitle}</p>
                      <p className="num text-xs text-muted">
                        {a.vehicle.stockNumber}
                        {a.vehicle.vin && ` · ${a.vehicle.vin}`}
                      </p>
                    </div>
                    <VehicleStatusBadge status={a.vehicle.status as VehicleStatus} />
                  </div>
                  <Can perm="vehicles.read">
                    <Link to={`/app/vehicles/${a.vehicle.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-strong hover:underline">
                      {t('purchasing.acquisitions.openVehicle')} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </Can>
                </>
              ) : (
                <p className="text-sm text-muted">—</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('purchasing.acquisitions.supplier')} />
            <CardBody className="space-y-2 text-sm">
              {a.supplier ? (
                <>
                  <p className="font-medium">{a.supplier.name}</p>
                  <p className="text-xs text-muted">
                    {t(`purchasing.enums.supplierType.${a.supplier.type}`)}
                    {a.supplier.phone && (
                      <>
                        {' · '}
                        <bdi dir="ltr" className="num">
                          {a.supplier.phone}
                        </bdi>
                      </>
                    )}
                  </p>
                  <Can perm="suppliers.read">
                    <Link to={`/app/purchasing/suppliers/${a.supplier.id}`} className="inline-flex items-center gap-1 font-medium text-brand-strong hover:underline">
                      {t('purchasing.acquisitions.openSupplier')} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </Can>
                </>
              ) : (
                <p className="text-muted">—</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('purchasing.acquisitions.ownership')} subtitle={t('purchasing.acquisitions.ownershipHint')} />
            <CardBody>
              <Field label={t('common.status')}>
                {(fid) => (
                  <Select
                    id={fid}
                    value={a.ownershipTransferStatus}
                    disabled={a.status === 'cancelled' || !can('acquisitions.create') || ownershipM.isPending}
                    onChange={(e) => ownershipM.mutate({ status: e.target.value as OwnershipTransferStatus })}
                  >
                    {OWNERSHIP_TRANSFER_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`purchasing.enums.ownership.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </CardBody>
          </Card>
        </div>
      </div>

      {dialog === 'edit' && <EditModal a={a} onClose={() => setDialog(null)} />}
      {dialog === 'approve' && <ApproveModal a={a} onClose={() => setDialog(null)} onSelfApproval={() => setRefusedVersion(a.version)} />}
      <ConfirmDialog
        open={dialog === 'submit'}
        onClose={() => setDialog(null)}
        title={t('purchasing.acquisitions.submitTitle')}
        message={t('purchasing.acquisitions.submitHint')}
        confirmLabel={t('purchasing.acquisitions.submit')}
        loading={submitM.isPending}
        onConfirm={() => submitM.mutate({})}
      />
      <ConfirmDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        title={t('purchasing.acquisitions.rejectTitle', { number: a.number })}
        message={t('purchasing.acquisitions.rejectHint')}
        confirmLabel={t('common.reject')}
        tone="danger"
        requireReason
        loading={rejectM.isPending}
        onConfirm={(reason) => rejectM.mutate({ reason })}
      />
      <ConfirmDialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title={t('purchasing.acquisitions.cancelTitle', { number: a.number })}
        message={
          <div className="space-y-2">
            <p>{a.status === 'approved' ? t('purchasing.acquisitions.cancelApprovedHint') : t('purchasing.acquisitions.cancelHint')}</p>
            {a.status === 'approved' && d(a.paidBase).gt(0) && (
              <p className="flex items-start gap-1.5 text-danger">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {t('purchasing.acquisitions.cancelHasPayments')}
              </p>
            )}
          </div>
        }
        confirmLabel={t('purchasing.acquisitions.cancel')}
        tone="danger"
        requireReason
        loading={cancelM.isPending}
        onConfirm={(reason) => cancelM.mutate({ reason, __idemKey: cancelKey })}
      />
    </>
  );
}
