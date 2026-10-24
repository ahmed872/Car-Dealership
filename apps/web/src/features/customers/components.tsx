import clsx from 'clsx';
import {
  Building2,
  CalendarClock,
  Car,
  FileText,
  Mail,
  MessageCircle,
  MessageSquareText,
  NotebookPen,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Receipt,
  Store,
  UserRound,
  Users,
} from 'lucide-react';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { INTERACTION_TYPES } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { fmtDateTime } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import {
  CustomerType,
  fieldErrorsOf,
  fmtPhone,
  fromLocalInput,
  Interaction,
  InteractionType,
  toLocalInput,
  useAssignees,
  useCrmMutation,
} from './api';

const INTERACTION_ICONS: Record<InteractionType, typeof Phone> = {
  call: Phone,
  whatsapp: MessageCircle,
  sms: MessageSquareText,
  email: Mail,
  visit: Store,
  meeting: Users,
  note: NotebookPen,
  test_drive: Car,
  quote: Receipt,
};

export function InteractionIcon({ type, className }: { type: InteractionType; className?: string }) {
  const Icon = INTERACTION_ICONS[type] ?? FileText;
  return <Icon className={className} aria-hidden />;
}

export function CustomerTypeBadge({ type }: { type: CustomerType }) {
  const { t } = useTranslation();
  return (
    <Badge tone={type === 'company' ? 'info' : 'neutral'} dot={false}>
      {type === 'company' ? <Building2 className="h-3 w-3" aria-hidden /> : <UserRound className="h-3 w-3" aria-hidden />}
      {t(`customers.enums.type.${type}`)}
    </Badge>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation();
  return <Badge tone={active ? 'success' : 'neutral'}>{active ? t('common.active') : t('common.inactive')}</Badge>;
}

/** Canonical phone as a tap-to-call link, isolated LTR inside Arabic text. */
export function PhoneText({ phone, className }: { phone: string | null | undefined; className?: string }) {
  if (!phone) return <span className="text-subtle">—</span>;
  return (
    <a href={`tel:+${phone}`} dir="ltr" className={clsx('num hover:text-brand-strong hover:underline', className)} onClick={(e) => e.stopPropagation()}>
      {fmtPhone(phone)}
    </a>
  );
}

/** Vertical timeline of calls, visits, messages… newest first. */
export function InteractionTimeline({ items, showLead = true }: { items: Interaction[]; showLead?: boolean }) {
  const { t } = useTranslation();
  return (
    <ol className="space-y-0 px-5 py-4">
      {items.map((i) => (
        <li key={i.id} className="relative border-s-2 border-line ps-6 pb-5 last:pb-0">
          <span className="absolute -start-[13px] top-0 flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-brand-soft text-brand-strong">
            <InteractionIcon type={i.type} className="h-3 w-3" />
          </span>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-ink">{t(`customers.enums.interactionType.${i.type}`)}</span>
            {i.direction && (
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                {i.direction === 'inbound' ? <PhoneIncoming className="h-3 w-3" aria-hidden /> : <PhoneOutgoing className="h-3 w-3" aria-hidden />}
                {t(`customers.enums.direction.${i.direction}`)}
              </span>
            )}
            {showLead && i.leadId && i.leadNumber && (
              <Link to={`/app/leads/${i.leadId}`} className="num text-xs text-brand-strong hover:underline">
                {i.leadNumber}
              </Link>
            )}
            {i.vehicleId && i.vehicleStockNumber && (
              <Link to={`/app/vehicles/${i.vehicleId}`} className="num inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
                <Car className="h-3 w-3" aria-hidden />
                {i.vehicleStockNumber}
              </Link>
            )}
          </div>
          <p className="mt-1 text-[13px] whitespace-pre-wrap text-ink">{i.summary}</p>
          {i.outcome && (
            <p className="mt-1 text-xs text-muted">
              <span className="font-medium">{t('customers.interaction.outcome')}:</span> {i.outcome}
            </p>
          )}
          <p className="mt-1 text-xs text-subtle">
            {fmtDateTime(i.occurredAt)} · {i.userName ?? t('customers.system')}
            {i.nextFollowUpAt && (
              <span className="ms-1 inline-flex items-center gap-1 text-info">
                · <CalendarClock className="h-3 w-3" aria-hidden /> {t('customers.interaction.nextFollowUp')}: {fmtDateTime(i.nextFollowUpAt)}
              </span>
            )}
          </p>
        </li>
      ))}
    </ol>
  );
}

/** Whether the user may log interactions (the API accepts customers.manage or leads.manage). */
export function useCanLogInteraction() {
  const { canAny } = useAuth();
  return canAny('customers.manage', 'leads.manage');
}

export interface LeadOption {
  id: string;
  number: string;
  status: string;
}

/**
 * Logs a call, WhatsApp message, visit… on the customer's timeline. With a lead, the lead's last
 * activity moves forward and (for open leads) its next follow-up takes the value entered here.
 */
export function InteractionModal({
  customerId,
  leads,
  defaultLeadId,
  defaultType = 'call',
  onClose,
  invalidate = [],
  clearFollowUpDefault = false,
}: {
  customerId: string;
  leads?: LeadOption[];
  defaultLeadId?: string | null;
  defaultType?: InteractionType;
  onClose: () => void;
  invalidate?: unknown[][];
  /** Pre-tick "follow-up done" (clears the lead's pending follow-up when no new one is set). */
  clearFollowUpDefault?: boolean;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<InteractionType>(defaultType);
  const [direction, setDirection] = useState<'' | 'inbound' | 'outbound'>(defaultType === 'note' ? '' : 'outbound');
  const [summary, setSummary] = useState('');
  const [outcome, setOutcome] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => toLocalInput(new Date().toISOString()));
  const [nextFollowUp, setNextFollowUp] = useState('');
  const [leadId, setLeadId] = useState(defaultLeadId ?? '');
  const [clearFollowUp, setClearFollowUp] = useState(clearFollowUpDefault);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const openLeads = (leads ?? []).filter((l) => l.status === 'open' || l.id === defaultLeadId);
  const m = useCrmMutation<Record<string, unknown>>({
    path: '/interactions',
    invalidate: [['customer', customerId], ['customer-interactions', customerId], ['lead'], ['leads'], ['follow-ups'], ...invalidate],
    success: t('customers.interaction.logged'),
    onSuccess: onClose,
    onError: (err) => {
      const fe = fieldErrorsOf(err, t);
      setErrors(fe);
      return Object.keys(fe).length > 0;
    },
  });
  const submit = () => {
    const next: Record<string, string> = {};
    if (summary.trim().length < 2) next.summary = t('customers.validation.summaryRequired');
    const occ = fromLocalInput(occurredAt);
    if (!occ) next.occurredAt = t('customers.validation.invalid');
    const nfu = fromLocalInput(nextFollowUp);
    if (nfu && occ && nfu <= occ) next.nextFollowUpAt = t('customers.errors.invalid_follow_up');
    setErrors(next);
    if (Object.keys(next).length) return;
    // With a lead, the API copies nextFollowUpAt onto it (null clears it), so the field is sent
    // only when a date is entered or the user ticked "follow-up done"; otherwise it is left as is.
    const body: Record<string, unknown> = {
      customerId,
      leadId: leadId || null,
      type,
      direction: direction || null,
      summary: summary.trim(),
      outcome: outcome.trim() || null,
      occurredAt: occ!,
    };
    if (nfu) body.nextFollowUpAt = nfu;
    else if (leadId && clearFollowUp) body.nextFollowUpAt = null;
    m.mutate(body);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('customers.interaction.title')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={m.isPending} onClick={submit}>
            {t('customers.interaction.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div role="radiogroup" aria-label={t('customers.interaction.type')} className="flex flex-wrap gap-2">
          {INTERACTION_TYPES.map((it) => (
            <button
              key={it}
              type="button"
              role="radio"
              aria-checked={type === it}
              onClick={() => setType(it)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors',
                type === it ? 'border-brand bg-brand-soft font-medium text-brand-strong' : 'border-line text-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              <InteractionIcon type={it} className="h-3.5 w-3.5" />
              {t(`customers.enums.interactionType.${it}`)}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('customers.interaction.direction')}>
            {(id) => (
              <Select id={id} value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)}>
                <option value="">—</option>
                <option value="outbound">{t('customers.enums.direction.outbound')}</option>
                <option value="inbound">{t('customers.enums.direction.inbound')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('customers.interaction.occurredAt')} error={errors.occurredAt} required>
            {(id, d) => <Input id={id} aria-describedby={d} type="datetime-local" dir="ltr" className="num" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} invalid={!!errors.occurredAt} />}
          </Field>
        </div>
        <Field label={t('customers.interaction.summary')} error={errors.summary} required>
          {(id, d) => <Textarea id={id} aria-describedby={d} rows={3} maxLength={2000} value={summary} onChange={(e) => setSummary(e.target.value)} invalid={!!errors.summary} />}
        </Field>
        <Field label={t('customers.interaction.outcome')} error={errors.outcome}>
          {(id, d) => <Input id={id} aria-describedby={d} maxLength={500} value={outcome} onChange={(e) => setOutcome(e.target.value)} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {openLeads.length > 0 && (
            <Field label={t('customers.interaction.lead')} error={errors.leadId}>
              {(id) => (
                <Select id={id} value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                  <option value="">{t('customers.interaction.noLead')}</option>
                  {openLeads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.number}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label={t('customers.interaction.nextFollowUp')} error={errors.nextFollowUpAt} hint={leadId ? t('customers.interaction.nextFollowUpHint') : undefined}>
            {(id, d) => <Input id={id} aria-describedby={d} type="datetime-local" dir="ltr" className="num" value={nextFollowUp} onChange={(e) => setNextFollowUp(e.target.value)} invalid={!!errors.nextFollowUpAt} />}
          </Field>
        </div>
        {leadId && !nextFollowUp && (
          <Checkbox
            checked={clearFollowUp}
            onChange={(e) => setClearFollowUp(e.target.checked)}
            label={t('customers.interaction.clearFollowUp')}
            description={t('customers.interaction.clearFollowUpHint')}
          />
        )}
      </div>
    </Modal>
  );
}

/**
 * Salesperson picker: the staff who can be given this work in the branch (GET /members/assignable).
 * The current value stays selectable even when it is outside the list (e.g. a former owner).
 */
export function AssigneeSelect({
  id,
  value,
  onChange,
  branchId,
  perm = 'leads.read',
  allowEmpty = true,
  emptyLabel,
  invalid,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  branchId?: string | null;
  perm?: 'leads.read' | 'customers.read';
  allowEmpty?: boolean;
  emptyLabel?: ReactNode;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const a = useAssignees({ branchId, perm });
  const missing = value && !a.list.some((o) => o.userId === value);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={a.loading} invalid={invalid}>
      {allowEmpty && <option value="">{emptyLabel ?? t('customers.unassigned')}</option>}
      {missing && <option value={value}>{t('customers.currentAssignee')}</option>}
      {a.list.map((o) => (
        <option key={o.userId} value={o.userId}>
          {/* Unicode isolates keep a Latin name and an Arabic suffix (or the reverse) in order. */}
          {`\u2068${o.fullName}\u2069`}
          {o.userId === me?.user.id ? ` · \u2068${t('customers.me')}\u2069` : ''}
        </option>
      ))}
    </Select>
  );
}
