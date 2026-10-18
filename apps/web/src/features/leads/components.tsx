import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarClock, Car, Check, MoreVertical, Search, UserRound, X } from 'lucide-react';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { d, LEAD_SOURCES, LOST_REASONS, MONEY_REGEX, PAYMENT_PREFERENCES } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import type { VehicleListItem } from '@/features/vehicles/api';
import { CustomerListItem, fieldErrorsOf, fmtPhone, fromLocalInput, Paged, toLocalInput, useCrmMutation } from '@/features/customers/api';
import { AssigneeDirectoryNotice, AssigneeSelect } from '@/features/customers/components';
import { Lead, LEAD_KEYS, LeadCard, LeadDetail, LeadStatus, LostReason, Stage, useStageName, useStages } from './api';

// ── Badges ───────────────────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<LeadStatus, Tone> = { open: 'info', won: 'success', lost: 'danger' };

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`leads.enums.status.${status}`)}</Badge>;
}

export function StageBadge({ stage }: { stage: { nameEn?: string | null; nameAr?: string | null; code?: string | null; kind?: string | null } }) {
  const name = useStageName();
  const tone: Tone = stage.kind === 'won' ? 'success' : stage.kind === 'lost' ? 'danger' : 'brand';
  return (
    <Badge tone={tone} dot={false}>
      {name(stage)}
    </Badge>
  );
}

/** Follow-up time, highlighted when overdue or due today. */
export function FollowUpText({ at, className }: { at: string | null; className?: string }) {
  const { t } = useTranslation();
  if (!at) return <span className={clsx('text-subtle', className)}>—</span>;
  const due = new Date(at).getTime();
  const now = Date.now();
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);
  const overdue = due < now;
  const today = !overdue && due <= endOfDay.getTime();
  return (
    <span
      className={clsx('relative inline-flex items-center gap-1', overdue ? 'font-medium text-danger' : today ? 'font-medium text-warning' : 'text-muted', className)}
      title={overdue ? t('leads.followUp.overdue') : today ? t('leads.followUp.today') : undefined}
    >
      <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="num whitespace-nowrap">{fmtDateTime(at)}</span>
      {overdue && <span className="sr-only">({t('leads.followUp.overdue')})</span>}
    </span>
  );
}

/**
 * Screen-reader-only text anchored in a positioned box: a bare `sr-only` (position: absolute)
 * inside a table scroller would otherwise escape it and widen the page in RTL.
 */
export function HiddenLabel({ children }: { children: ReactNode }) {
  return (
    <span className="relative inline-block">
      <span className="sr-only">{children}</span>
    </span>
  );
}

// ── Action menu ──────────────────────────────────────────────────────────────────────────

export interface MenuAction {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: 'danger' | 'success';
  hidden?: boolean;
}

/** Small "⋮" menu (closes on outside click / Escape). */
export function ActionMenu({ actions, label, className }: { actions: MenuAction[]; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const visible = actions.filter((a) => !a.hidden);
  if (!visible.length) return null;
  return (
    <div ref={ref} className={clsx('relative', className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="animate-in absolute end-0 z-30 mt-1 w-52 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop">
          {visible.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
              className={clsx(
                'flex w-full items-center gap-2.5 px-3.5 py-2 text-start text-sm hover:bg-surface-2',
                a.tone === 'danger' ? 'text-danger' : a.tone === 'success' ? 'text-success' : 'text-ink',
              )}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared mutation plumbing ─────────────────────────────────────────────────────────────

/** A lead write that refreshes every lead view; a version conflict reloads the data too. */
function useLeadMutation<TVars extends Record<string, unknown>>(path: string, opts: { success?: string; onDone: (res: Lead) => void; method?: 'POST' | 'PATCH'; onFieldErrors?: (e: Record<string, string>) => void }) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  return useCrmMutation<TVars, Lead>({
    path,
    method: opts.method,
    invalidate: LEAD_KEYS,
    success: opts.success,
    onSuccess: (res) => opts.onDone(res),
    onError: (err) => {
      if (err instanceof ApiError && (err.code === 'version_conflict' || err.code === 'lead_closed' || err.code === 'lead_open')) {
        LEAD_KEYS.forEach((k) => void qc.invalidateQueries({ queryKey: k }));
      }
      if (opts.onFieldErrors) {
        const fe = fieldErrorsOf(err, t);
        opts.onFieldErrors(fe);
        return Object.keys(fe).length > 0;
      }
      return false;
    },
  });
}

type LeadRef = Pick<LeadCard, 'id' | 'number' | 'version' | 'stageId' | 'status' | 'branchId' | 'assignedUserId'>;

// ── Stage change / won ───────────────────────────────────────────────────────────────────

/** Moves an open lead to another stage (a won stage closes it as won). Lost goes through LostModal. */
export function StageChangeModal({ lead, toStageId, onClose }: { lead: LeadRef; toStageId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const stages = useStages();
  const name = useStageName();
  const options = (stages.data ?? []).filter((s) => s.kind !== 'lost' && s.id !== lead.stageId);
  const [stageId, setStageId] = useState(toStageId ?? '');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!stageId && options.length) setStageId(options[0]!.id);
  }, [options, stageId]);
  const target = (stages.data ?? []).find((s) => s.id === stageId);
  const won = target?.kind === 'won';
  const m = useLeadMutation<{ stageId: string; note: string | null; version: number }>(`/leads/${lead.id}/stage`, {
    success: won ? t('leads.messages.won', { number: lead.number }) : t('leads.messages.moved', { stage: name(target) }),
    onDone: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={won ? t('leads.actions.markWon') : t('leads.actions.moveStage')}
      description={lead.number}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={won ? 'success' : 'primary'} loading={m.isPending} disabled={!stageId} onClick={() => m.mutate({ stageId, note: note.trim() || null, version: lead.version })}>
            {won ? t('leads.actions.confirmWon') : t('leads.actions.move')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('leads.fields.stage')} required>
          {(id) => (
            <Select id={id} value={stageId} onChange={(e) => setStageId(e.target.value)} disabled={stages.isLoading}>
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {name(s)}
                  {s.kind === 'won' ? ` — ${t('leads.enums.status.won')}` : ` (${s.probabilityPct}%)`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {won && <Alert tone="success">{t('leads.hints.won')}</Alert>}
        <Field label={t('leads.fields.note')}>
          {(id) => <Textarea id={id} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/** First active won stage (for "mark as won" shortcuts). */
export function useWonStage(): Stage | undefined {
  const stages = useStages();
  return (stages.data ?? []).find((s) => s.kind === 'won' && s.isActive);
}

// ── Lost ─────────────────────────────────────────────────────────────────────────────────

export function LostModal({ lead, onClose }: { lead: LeadRef; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<LostReason | ''>('');
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const m = useLeadMutation<{ reason: LostReason; notes: string | null; version: number }>(`/leads/${lead.id}/lost`, {
    success: t('leads.messages.lost', { number: lead.number }),
    onDone: onClose,
  });
  const submit = () => {
    setTouched(true);
    if (!reason) return;
    m.mutate({ reason, notes: notes.trim() || null, version: lead.version });
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('leads.actions.markLost')}
      description={lead.number}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={m.isPending} onClick={submit}>
            {t('leads.actions.confirmLost')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('leads.fields.lostReason')} required error={touched && !reason ? t('leads.validation.lostReason') : null}>
          {(id, dsc) => (
            <Select id={id} aria-describedby={dsc} value={reason} onChange={(e) => setReason(e.target.value as LostReason)} invalid={touched && !reason}>
              <option value="">{t('leads.placeholders.chooseReason')}</option>
              {LOST_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`leads.enums.lostReason.${r}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('leads.fields.lostNotes')}>
          {(id) => <Textarea id={id} rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

// ── Reopen ───────────────────────────────────────────────────────────────────────────────

export function ReopenModal({ lead, onClose }: { lead: LeadRef; onClose: () => void }) {
  const { t } = useTranslation();
  const stages = useStages();
  const name = useStageName();
  const open = (stages.data ?? []).filter((s) => s.kind === 'open');
  const [stageId, setStageId] = useState('');
  const [note, setNote] = useState('');
  const m = useLeadMutation<{ stageId?: string; note: string | null; version: number }>(`/leads/${lead.id}/reopen`, {
    success: t('leads.messages.reopened', { number: lead.number }),
    onDone: onClose,
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('leads.actions.reopen')}
      description={lead.number}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} onClick={() => m.mutate({ ...(stageId ? { stageId } : {}), note: note.trim() || null, version: lead.version })}>
            {t('leads.actions.reopen')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('leads.fields.stage')} hint={t('leads.hints.reopenStage')}>
          {(id, dsc) => (
            <Select id={id} aria-describedby={dsc} value={stageId} onChange={(e) => setStageId(e.target.value)}>
              <option value="">{t('leads.placeholders.defaultStage')}</option>
              {open.map((s) => (
                <option key={s.id} value={s.id}>
                  {name(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('leads.fields.note')}>
          {(id) => <Textarea id={id} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

// ── Assign ───────────────────────────────────────────────────────────────────────────────

export function AssignLeadModal({ lead, onClose }: { lead: LeadRef; onClose: () => void }) {
  const { t } = useTranslation();
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const m = useLeadMutation<{ userId: string; note: string | null; version: number }>(`/leads/${lead.id}/assign`, {
    success: t('leads.messages.assigned'),
    onDone: onClose,
  });
  const submit = () => {
    setTouched(true);
    if (!userId) return;
    m.mutate({ userId, note: note.trim() || null, version: lead.version });
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('leads.actions.assign')}
      description={lead.number}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} onClick={submit}>
            {t('leads.actions.assign')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('leads.fields.assignee')} required error={touched && !userId ? t('leads.validation.assignee') : null}>
          {(id) => (
            <>
              <AssigneeSelect
                id={id}
                value={userId}
                onChange={setUserId}
                branchId={lead.branchId}
                perm="leads.read"
                emptyLabel={t('leads.placeholders.chooseAssignee')}
                invalid={touched && !userId}
              />
              <AssigneeDirectoryNotice />
            </>
          )}
        </Field>
        <Field label={t('leads.fields.note')}>
          {(id) => <Textarea id={id} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

// ── Follow-up ────────────────────────────────────────────────────────────────────────────

/** Sets or clears the next follow-up of an open lead (PATCH, optimistic version). */
export function FollowUpModal({ lead, onClose }: { lead: Pick<LeadCard, 'id' | 'number' | 'version' | 'nextFollowUpAt'>; onClose: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(() => toLocalInput(lead.nextFollowUpAt));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useLeadMutation<{ nextFollowUpAt: string | null; version: number }>(`/leads/${lead.id}`, {
    method: 'PATCH',
    success: t('leads.messages.followUpSaved'),
    onDone: onClose,
    onFieldErrors: setErrors,
  });
  const quick = (days: number) => {
    const dt = new Date();
    dt.setDate(dt.getDate() + days);
    dt.setHours(10, 0, 0, 0);
    setValue(toLocalInput(dt.toISOString()));
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('leads.actions.followUp')}
      description={lead.number}
      footer={
        <>
          {lead.nextFollowUpAt && (
            <Button variant="ghost" className="me-auto" loading={m.isPending} onClick={() => m.mutate({ nextFollowUpAt: null, version: lead.version })}>
              {t('leads.actions.clearFollowUp')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} disabled={!value} onClick={() => m.mutate({ nextFollowUpAt: fromLocalInput(value), version: lead.version })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('leads.fields.nextFollowUpAt')} required error={errors.nextFollowUpAt}>
          {(id) => <Input id={id} type="datetime-local" dir="ltr" className="num" value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap gap-2">
          {(
            [
              [1, 'tomorrow'],
              [2, 'in2Days'],
              [3, 'in3Days'],
              [7, 'nextWeek'],
            ] as const
          ).map(([n, key]) => (
            <Button key={n} size="sm" variant="secondary" onClick={() => quick(n)}>
              {t(`leads.followUp.${key}`)}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ── Pickers ──────────────────────────────────────────────────────────────────────────────

export interface PickedCustomer {
  id: string;
  fullName: string;
  phone: string | null;
  branchId: string | null;
  source: string | null;
}

/** Search-as-you-type customer picker (active customers the caller may see). */
export function CustomerPicker({ value, onChange, invalid, id }: { value: PickedCustomer | null; onChange: (c: PickedCustomer | null) => void; invalid?: boolean; id?: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const res = useApi<Paged<CustomerListItem>>(['customers', 'picker'], value || dq.length < 2 ? null : '/customers', { q: dq, pageSize: 8, active: 'true' });
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <UserRound className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate font-medium">{value.fullName}</span>
          {value.phone && (
            <span dir="ltr" className="num truncate text-xs text-muted">
              {fmtPhone(value.phone)}
            </span>
          )}
        </span>
        <button type="button" className="rounded p-1 text-muted hover:text-ink" onClick={() => onChange(null)} aria-label={t('leads.actions.changeCustomer')}>
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input id={id} type="search" className="ps-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('leads.placeholders.searchCustomer')} invalid={invalid} autoComplete="off" />
      </div>
      {dq.length >= 2 && (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-line">
          {res.isLoading && <li className="px-3 py-2 text-sm text-muted">{t('common.loading')}</li>}
          {res.data?.items.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t('common.noResults')}</li>}
          {res.data?.items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-surface-2"
                onClick={() => onChange({ id: c.id, fullName: c.fullName, phone: c.phone ?? c.whatsapp, branchId: c.branchId, source: c.source })}
              >
                <span className="truncate">{c.fullName}</span>
                <span dir="ltr" className="num shrink-0 text-xs text-muted">
                  {fmtPhone(c.phone ?? c.whatsapp)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface PickedVehicle {
  id: string;
  label: string;
  stockNumber: string;
}

/** Stock vehicle picker (vehicles.read). */
export function VehiclePicker({ value, onChange, id }: { value: PickedVehicle | null; onChange: (v: PickedVehicle | null) => void; id?: string }) {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const res = useApi<Paged<VehicleListItem>>(['vehicles', 'picker'], value || dq.length < 2 ? null : '/vehicles', { q: dq, pageSize: 8, scope: 'stock' });
  const en = i18n.language === 'en';
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <Car className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate">{value.label}</span>
          <span className="num shrink-0 text-xs text-muted">{value.stockNumber}</span>
        </span>
        <button type="button" className="rounded p-1 text-muted hover:text-ink" onClick={() => onChange(null)} aria-label={t('leads.actions.clearVehicle')}>
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input id={id} type="search" className="ps-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('leads.placeholders.searchVehicle')} autoComplete="off" />
      </div>
      {dq.length >= 2 && (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-line">
          {res.isLoading && <li className="px-3 py-2 text-sm text-muted">{t('common.loading')}</li>}
          {res.error ? <li className="px-3 py-2 text-sm text-danger">{t('errors.generic')}</li> : null}
          {res.data?.items.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t('common.noResults')}</li>}
          {res.data?.items.map((v) => {
            const label = [en ? v.makeNameEn : v.makeNameAr, en ? v.modelNameEn : v.modelNameAr, v.modelYear].filter(Boolean).join(' ');
            return (
              <li key={v.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-surface-2"
                  onClick={() => onChange({ id: v.id, label, stockNumber: v.stockNumber })}
                >
                  <span className="truncate">{label}</span>
                  <span className="num shrink-0 text-xs text-muted">{v.stockNumber}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Create / edit ────────────────────────────────────────────────────────────────────────

/**
 * MoneyInput is an LTR field whose currency tag is placed at the container's inline end; under
 * RTL that end is the left edge while the field reserves room on the right, so the tag would sit
 * on the digits. An LTR container keeps the tag and its reserved space on the same side.
 */
function Money(props: Parameters<typeof MoneyInput>[0]) {
  return (
    <div dir="ltr">
      <MoneyInput {...props} />
    </div>
  );
}

const validMoney = (v: string) => !v.trim() || (MONEY_REGEX.test(v.trim()) && !v.trim().startsWith('-'));

function budgetErrors(min: string, max: string, t: (k: string) => string): Record<string, string> {
  const e: Record<string, string> = {};
  if (!validMoney(min)) e.budgetMin = t('errors.invalid_amount');
  if (!validMoney(max)) e.budgetMax = t('errors.invalid_amount');
  if (!e.budgetMin && !e.budgetMax && min.trim() && max.trim() && d(min.trim()).gt(d(max.trim()))) e.budgetMax = t('customers.errors.invalid_budget_range');
  return e;
}

/**
 * New lead for a customer. Opened from the customer 360 (customer fixed) or from the leads
 * pages (customer picked by search). The owner defaults to the creator; giving it to someone
 * else needs leads.assign.
 */
export function LeadCreateModal({ customer, onClose, onCreated }: { customer?: PickedCustomer; onClose: () => void; onCreated?: (l: Lead) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me, can, currency } = useAuth();
  const branches = useBranches();
  const stages = useStages();
  const name = useStageName();
  const [cust, setCust] = useState<PickedCustomer | null>(customer ?? null);
  const allowed = (branches.data ?? []).filter((b) => b.isActive && (me?.allBranches || me?.branchIds.includes(b.id)));
  const [branchId, setBranchId] = useState('');
  const [source, setSource] = useState<string>(customer?.source ?? 'walk_in');
  const [stageId, setStageId] = useState('');
  const [assignee, setAssignee] = useState(me?.user.id ?? '');
  const [vehicle, setVehicle] = useState<PickedVehicle | null>(null);
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [payment, setPayment] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (branchId || !allowed.length) return;
    const pref = cust?.branchId && allowed.find((b) => b.id === cust.branchId);
    setBranchId(pref ? pref.id : allowed[0]!.id);
  }, [allowed, branchId, cust]);

  // Picking a customer brings their source and (when the user can work there) their branch.
  const pickCustomer = (c: PickedCustomer | null) => {
    setCust(c);
    if (c?.source) setSource(c.source);
    if (c?.branchId && allowed.some((b) => b.id === c.branchId)) setBranchId(c.branchId);
  };

  const m = useCrmMutation<Record<string, unknown>, Lead>({
    path: '/leads',
    invalidate: LEAD_KEYS,
    success: (l) => t('leads.messages.created', { number: l.number }),
    onSuccess: (l) => {
      onClose();
      if (onCreated) onCreated(l);
      else navigate(`/app/leads/${l.id}`);
    },
    onError: (err) => {
      const fe = fieldErrorsOf(err, t);
      setErrors(fe);
      return Object.keys(fe).length > 0;
    },
  });

  const submit = () => {
    const e: Record<string, string> = { ...budgetErrors(budgetMin, budgetMax, t) };
    if (!cust) e.customerId = t('leads.validation.customer');
    if (!branchId) e.branchId = t('leads.validation.branch');
    const nfu = fromLocalInput(followUp);
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: Record<string, unknown> = { customerId: cust!.id, branchId, source };
    if (stageId) body.stageId = stageId;
    if (can('leads.assign')) body.assignedUserId = assignee || null;
    if (vehicle) body.vehicleId = vehicle.id;
    if (budgetMin.trim()) body.budgetMin = budgetMin.trim();
    if (budgetMax.trim()) body.budgetMax = budgetMax.trim();
    if (payment) body.paymentPreference = payment;
    if (closeDate) body.expectedCloseDate = closeDate;
    if (nfu) body.nextFollowUpAt = nfu;
    if (notes.trim()) body.interestNotes = notes.trim();
    m.mutate(body);
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('leads.create.title')}
      description={customer ? customer.fullName : t('leads.create.subtitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} onClick={submit}>
            {t('leads.create.submit')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!customer && (
          <Field label={t('leads.fields.customer')} required error={errors.customerId} className="sm:col-span-2">
            {(id) => <CustomerPicker id={id} value={cust} onChange={pickCustomer} invalid={!!errors.customerId} />}
          </Field>
        )}
        <Field label={t('common.branch')} required error={errors.branchId}>
          {(id) => (
            <Select id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)} invalid={!!errors.branchId}>
              {!branchId && <option value="">—</option>}
              {allowed.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('leads.fields.source')} required error={errors.source}>
          {(id) => (
            <Select id={id} value={source} onChange={(e) => setSource(e.target.value)}>
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`customers.enums.source.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('leads.fields.stage')} error={errors.stageId}>
          {(id) => (
            <Select id={id} value={stageId} onChange={(e) => setStageId(e.target.value)}>
              <option value="">{t('leads.placeholders.firstStage')}</option>
              {(stages.data ?? [])
                .filter((s) => s.kind === 'open')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {name(s)}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        {can('leads.assign') ? (
          <Field label={t('leads.fields.assignee')} error={errors.assignedUserId}>
            {(id) => (
              <>
                <AssigneeSelect id={id} value={assignee} onChange={setAssignee} branchId={branchId || null} perm="leads.read" />
                <AssigneeDirectoryNotice />
              </>
            )}
          </Field>
        ) : (
          <Field label={t('leads.fields.assignee')} hint={t('leads.hints.ownLead')}>
            {(id) => <Input id={id} value={me?.user.fullName ?? ''} disabled readOnly />}
          </Field>
        )}
        {can('vehicles.read') && (
          <Field label={t('leads.fields.vehicle')} error={errors.vehicleId} className="sm:col-span-2">
            {(id) => <VehiclePicker id={id} value={vehicle} onChange={setVehicle} />}
          </Field>
        )}
        <Field label={t('leads.fields.budgetMin')} error={errors.budgetMin}>
          {(id) => <Money id={id} currency={currency} value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} invalid={!!errors.budgetMin} />}
        </Field>
        <Field label={t('leads.fields.budgetMax')} error={errors.budgetMax}>
          {(id) => <Money id={id} currency={currency} value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} invalid={!!errors.budgetMax} />}
        </Field>
        <Field label={t('leads.fields.paymentPreference')}>
          {(id) => (
            <Select id={id} value={payment} onChange={(e) => setPayment(e.target.value)}>
              <option value="">—</option>
              {PAYMENT_PREFERENCES.map((p) => (
                <option key={p} value={p}>
                  {t(`leads.enums.payment.${p}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('leads.fields.expectedCloseDate')} error={errors.expectedCloseDate}>
          {(id) => <Input id={id} type="date" dir="ltr" className="num" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />}
        </Field>
        <Field label={t('leads.fields.nextFollowUpAt')} error={errors.nextFollowUpAt}>
          {(id) => <Input id={id} type="datetime-local" dir="ltr" className="num" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />}
        </Field>
        <Field label={t('leads.fields.interestNotes')} error={errors.interestNotes} className="sm:col-span-2">
          {(id) => <Textarea id={id} rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/** Edits the commercial details of an open lead (only changed fields are sent). */
export function LeadEditModal({ lead, onClose }: { lead: LeadDetail; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { can, currency } = useAuth();
  const initialVehicle: PickedVehicle | null = lead.vehicle
    ? {
        id: lead.vehicle.id,
        stockNumber: lead.vehicle.stockNumber,
        label: [i18n.language === 'en' ? lead.vehicle.makeEn : lead.vehicle.makeAr, i18n.language === 'en' ? lead.vehicle.modelEn : lead.vehicle.modelAr, lead.vehicle.modelYear].join(' '),
      }
    : null;
  const [vehicle, setVehicle] = useState<PickedVehicle | null>(initialVehicle);
  const [budgetMin, setBudgetMin] = useState(lead.budgetMin ?? '');
  const [budgetMax, setBudgetMax] = useState(lead.budgetMax ?? '');
  const [payment, setPayment] = useState<string>(lead.paymentPreference ?? '');
  const [closeDate, setCloseDate] = useState(lead.expectedCloseDate ?? '');
  const [followUp, setFollowUp] = useState(() => toLocalInput(lead.nextFollowUpAt));
  const [notes, setNotes] = useState(lead.interestNotes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useLeadMutation<Record<string, unknown>>(`/leads/${lead.id}`, { method: 'PATCH', onDone: onClose, onFieldErrors: setErrors });
  const submit = () => {
    const e = budgetErrors(budgetMin, budgetMax, t);
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: Record<string, unknown> = {};
    if ((vehicle?.id ?? null) !== lead.vehicleId) body.vehicleId = vehicle?.id ?? null;
    const moneyChanged = (a: string, b: string | null) => (a.trim() ? !b || !d(a.trim()).eq(d(b)) : b !== null);
    if (moneyChanged(budgetMin, lead.budgetMin)) body.budgetMin = budgetMin.trim() || null;
    if (moneyChanged(budgetMax, lead.budgetMax)) body.budgetMax = budgetMax.trim() || null;
    if ((payment || null) !== lead.paymentPreference) body.paymentPreference = payment || null;
    if ((closeDate || null) !== lead.expectedCloseDate) body.expectedCloseDate = closeDate || null;
    const nfu = fromLocalInput(followUp);
    if ((nfu ? new Date(nfu).getTime() : null) !== (lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt).getTime() : null)) body.nextFollowUpAt = nfu;
    if ((notes.trim() || null) !== lead.interestNotes) body.interestNotes = notes.trim() || null;
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    m.mutate({ ...body, version: lead.version });
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('leads.edit.title')}
      description={lead.number}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} onClick={submit} icon={<Check className="h-4 w-4" />}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {can('vehicles.read') && (
          <Field label={t('leads.fields.vehicle')} error={errors.vehicleId} className="sm:col-span-2">
            {(id) => <VehiclePicker id={id} value={vehicle} onChange={setVehicle} />}
          </Field>
        )}
        <Field label={t('leads.fields.budgetMin')} error={errors.budgetMin}>
          {(id) => <Money id={id} currency={currency} value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} invalid={!!errors.budgetMin} />}
        </Field>
        <Field label={t('leads.fields.budgetMax')} error={errors.budgetMax}>
          {(id) => <Money id={id} currency={currency} value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} invalid={!!errors.budgetMax} />}
        </Field>
        <Field label={t('leads.fields.paymentPreference')}>
          {(id) => (
            <Select id={id} value={payment} onChange={(e) => setPayment(e.target.value)}>
              <option value="">—</option>
              {PAYMENT_PREFERENCES.map((p) => (
                <option key={p} value={p}>
                  {t(`leads.enums.payment.${p}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('leads.fields.expectedCloseDate')} error={errors.expectedCloseDate}>
          {(id) => <Input id={id} type="date" dir="ltr" className="num" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />}
        </Field>
        <Field label={t('leads.fields.nextFollowUpAt')} error={errors.nextFollowUpAt}>
          {(id) => <Input id={id} type="datetime-local" dir="ltr" className="num" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />}
        </Field>
        <Field label={t('leads.fields.interestNotes')} error={errors.interestNotes} className="sm:col-span-2">
          {(id) => <Textarea id={id} rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

// ── Card-level actions ───────────────────────────────────────────────────────────────────

export type LeadDialog =
  | { kind: 'stage'; lead: LeadRef; toStageId?: string }
  | { kind: 'lost'; lead: LeadRef }
  | { kind: 'reopen'; lead: LeadRef }
  | { kind: 'assign'; lead: LeadRef }
  | { kind: 'followUp'; lead: Pick<LeadCard, 'id' | 'number' | 'version' | 'nextFollowUpAt'> };

/** Renders whichever lead dialog is open. */
export function LeadDialogs({ dialog, onClose }: { dialog: LeadDialog | null; onClose: () => void }) {
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'stage':
      return <StageChangeModal lead={dialog.lead} toStageId={dialog.toStageId} onClose={onClose} />;
    case 'lost':
      return <LostModal lead={dialog.lead} onClose={onClose} />;
    case 'reopen':
      return <ReopenModal lead={dialog.lead} onClose={onClose} />;
    case 'assign':
      return <AssignLeadModal lead={dialog.lead} onClose={onClose} />;
    case 'followUp':
      return <FollowUpModal lead={dialog.lead} onClose={onClose} />;
  }
}

/** The action-menu entries for a lead card or row, filtered by status and permission. */
export function useLeadActions() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const won = useWonStage();
  return (l: LeadCard, open: (d: LeadDialog) => void): MenuAction[] => {
    const manage = can('leads.manage');
    const isOpen = l.status === 'open';
    return [
      { key: 'open', label: t('leads.actions.open'), onSelect: () => navigate(`/app/leads/${l.id}`) },
      { key: 'move', label: t('leads.actions.moveStage'), hidden: !manage || !isOpen, onSelect: () => open({ kind: 'stage', lead: l }) },
      { key: 'followUp', label: t('leads.actions.followUp'), hidden: !manage || !isOpen, onSelect: () => open({ kind: 'followUp', lead: l }) },
      { key: 'won', label: t('leads.actions.markWon'), tone: 'success', hidden: !manage || !isOpen || !won, onSelect: () => open({ kind: 'stage', lead: l, toStageId: won?.id }) },
      { key: 'lost', label: t('leads.actions.markLost'), tone: 'danger', hidden: !manage || !isOpen, onSelect: () => open({ kind: 'lost', lead: l }) },
      { key: 'assign', label: t('leads.actions.assign'), hidden: !can('leads.assign'), onSelect: () => open({ kind: 'assign', lead: l }) },
      { key: 'reopen', label: t('leads.actions.reopen'), hidden: !manage || isOpen, onSelect: () => open({ kind: 'reopen', lead: l }) },
    ];
  };
}
