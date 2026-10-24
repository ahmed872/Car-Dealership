import clsx from 'clsx';
import { CalendarCheck, Car, Flag, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { APPOINTMENT_MAX_HOURS, APPOINTMENT_TYPES } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import {
  CustomerPicker,
  isVersionConflict,
  LeadOption,
  LeadPicker,
  serverFieldErrors,
  StaleAlert,
  useDomainError,
  useDomainMutation,
  useFieldMessage,
  useTenantMoney,
  VehicleOption,
  VehiclePicker,
  vehicleLabel,
  vehicleOptionTitle,
} from '@/features/receivables/kit';
import type { VehicleDetail } from '@/features/vehicles/api';
import { useAuth } from '@/lib/auth';
import { fmtNumber } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useAssignableMembers } from '@/lib/members';
import { useBranches } from '@/pages/settings/BranchesPage';
import { APPOINTMENT_KEYS, AppointmentStatus, AppointmentType, FullAppointment } from './api';
import { addMinutes, ISO_DATE, minutesBetween, nextQuarter, zoned, zonedToUtc } from './time';

// ── Badges ───────────────────────────────────────────────────────────────────────────────

export const STATUS_TONE: Record<AppointmentStatus, Tone> = {
  scheduled: 'info',
  confirmed: 'brand',
  in_progress: 'accent',
  completed: 'success',
  no_show: 'danger',
  cancelled: 'neutral',
};

export function AppointmentStatusBadge({ status }: { status: AppointmentStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`appointments.status.${status}`)}</Badge>;
}

export function TypeBadge({ type }: { type: AppointmentType }) {
  const { t } = useTranslation();
  return (
    <Badge tone={type === 'test_drive' ? 'accent' : 'neutral'} dot={false}>
      {type === 'test_drive' && <Car className="h-3 w-3" aria-hidden />}
      {t(`appointments.type.${type}`)}
    </Badge>
  );
}

/** Branches the user can book in (active, within their branch scope). */
export function useBookableBranches() {
  const { me } = useAuth();
  const branches = useBranches();
  const list = useMemo(
    () => (branches.data ?? []).filter((b) => b.isActive && (me?.allBranches || me?.branchIds.includes(b.id))),
    [branches.data, me],
  );
  return { list, isLoading: branches.isLoading };
}

/**
 * Members who can be given appointments in a branch (role with appointments.manage, access to the
 * branch). Offered to users with leads.assign, who may book for someone else; the list comes from
 * GET /members/assignable, so no member-directory permission is needed.
 */
export function useAssignees(branchId: string | null) {
  const { can } = useAuth();
  const enabled = can('leads.assign');
  const q = useAssignableMembers('appointments.manage', branchId, enabled);
  const list = useMemo(() => (q.data ?? []).map((m) => ({ userId: m.id, fullName: m.fullName })), [q.data]);
  return { enabled, list, isLoading: enabled && q.isLoading };
}

// ── Book / reschedule ────────────────────────────────────────────────────────────────────

export interface BookingDefaults {
  date?: string;
  time?: string;
  type?: AppointmentType;
  vehicle?: VehicleOption;
  customer?: { id: string; fullName: string };
}

const DEFAULT_MINUTES: Record<AppointmentType, number> = { visit: 60, test_drive: 30, follow_up: 30, delivery: 60, inspection: 60, other: 60 };

/**
 * Books an appointment or test drive (POST /appointments) or reschedules / edits a booked one
 * (PATCH with version). Type and branch are fixed once booked. Times are entered in the company's
 * time zone.
 */
export function AppointmentFormModal({
  appointment: existing,
  defaults,
  onClose,
  onDone,
}: {
  appointment?: FullAppointment;
  defaults?: BookingDefaults;
  onClose: () => void;
  onDone?: (a: FullAppointment) => void;
}) {
  const { t, i18n } = useTranslation();
  const { me, can } = useAuth();
  const { timezone } = useTenantMoney();
  const describe = useDomainError('appointments');
  const fm = useFieldMessage('appointments');
  const branches = useBookableBranches();
  const editing = !!existing;
  const start0 = existing ? zoned(existing.startsAt, timezone) : null;
  const end0 = existing ? zoned(existing.endsAt, timezone) : null;
  const slot = nextQuarter(timezone);

  const [type, setType] = useState<AppointmentType>(existing?.type ?? defaults?.type ?? 'visit');
  const [branchId, setBranchId] = useState(existing?.branchId ?? defaults?.vehicle?.branchId ?? '');
  const [party, setParty] = useState<'customer' | 'lead'>(existing?.leadId ? 'lead' : 'customer');
  const [customer, setCustomer] = useState<{ id: string; fullName: string } | null>(
    existing?.customerId ? { id: existing.customerId, fullName: existing.customerName ?? '' } : (defaults?.customer ?? null),
  );
  const [lead, setLead] = useState<{ id: string; label: string; customerId: string } | null>(
    existing?.leadId ? { id: existing.leadId, label: `${existing.leadNumber ?? ''} · ${existing.customerName ?? ''}`, customerId: existing.customerId ?? '' } : null,
  );
  const [vehicle, setVehicle] = useState<{ id: string; label: string; branchId?: string } | null>(
    existing?.vehicle
      ? { id: existing.vehicle.id, label: `${vehicleLabel(existing.vehicle, i18n.language)} · ${existing.vehicle.stockNumber ?? ''}` }
      : defaults?.vehicle
        ? { id: defaults.vehicle.id, label: `${vehicleOptionTitle(defaults.vehicle, i18n.language)} · ${defaults.vehicle.stockNumber}`, branchId: defaults.vehicle.branchId }
        : null,
  );
  const [date, setDate] = useState(start0?.date ?? defaults?.date ?? slot.date);
  const [start, setStart] = useState(start0?.time ?? defaults?.time ?? slot.time);
  const [end, setEnd] = useState(end0?.time ?? addMinutes(defaults?.time ?? slot.time, DEFAULT_MINUTES[existing?.type ?? defaults?.type ?? 'visit']));
  const assignees = useAssignees(branchId || null);
  const [assignee, setAssignee] = useState<string>(existing ? (existing.assignedUserId ?? '') : (me?.user.id ?? ''));
  const [title, setTitle] = useState(existing?.title ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [licence, setLicence] = useState(existing?.driverLicenseNumber ?? '');
  const [licenceExpiry, setLicenceExpiry] = useState(existing?.driverLicenseExpiry ?? '');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // A single bookable branch is preselected.
  useEffect(() => {
    if (!branchId && branches.list.length > 0) setBranchId(branches.list[0]!.id);
  }, [branches.list, branchId]);

  const testDrive = type === 'test_drive';
  const duration = minutesBetween(start, end);
  const serverErrors = serverFieldErrors(failure);
  const errors: Record<string, string | null> = {
    branchId: !branchId ? 'required' : null,
    customerId: testDrive && !customer && !lead ? 'customer_required' : (serverErrors.customerId ?? null),
    leadId: serverErrors.leadId ?? null,
    vehicleId: testDrive && !vehicle ? 'vehicle_required' : (serverErrors.vehicleId ?? null),
    date: !ISO_DATE.test(date) ? 'required' : null,
    startsAt: !/^\d{2}:\d{2}$/.test(start) ? 'required' : (serverErrors.startsAt ?? null),
    endsAt: !/^\d{2}:\d{2}$/.test(end) || duration <= 0 ? 'end_before_start' : duration > APPOINTMENT_MAX_HOURS * 60 ? 'too_long' : (serverErrors.endsAt ?? null),
    driverLicenseExpiry: serverErrors.driverLicenseExpiry ?? null,
  };
  const clientInvalid = ['branchId', 'date', 'startsAt', 'endsAt'].some((k) => errors[k] && !serverErrors[k]) || (testDrive && (!vehicle || (!customer && !lead)));

  const save = useDomainMutation<Record<string, unknown>, FullAppointment>({
    ns: 'appointments',
    path: editing ? `/appointments/${existing!.id}` : '/appointments',
    method: editing ? 'PATCH' : 'POST',
    toastError: false,
    invalidate: APPOINTMENT_KEYS,
    success: editing ? t('appointments.saved') : testDrive ? t('appointments.bookedTestDrive') : t('appointments.booked'),
    onSuccess: (a) => {
      onDone?.(a);
      onClose();
    },
  });

  const submit = () => {
    setTouched(true);
    if (clientInvalid) return;
    setFailure(null);
    const startsAt = zonedToUtc(date, start, timezone).toISOString();
    const endsAt = zonedToUtc(date, end, timezone).toISOString();
    const body: Record<string, unknown> = {
      customerId: party === 'customer' ? (customer?.id ?? null) : (lead?.customerId ?? null),
      leadId: party === 'lead' ? (lead?.id ?? null) : null,
      vehicleId: vehicle?.id ?? null,
      startsAt,
      endsAt,
      title: title.trim() || null,
      notes: notes.trim() || null,
      driverLicenseNumber: testDrive ? licence.trim() || null : null,
      driverLicenseExpiry: testDrive ? licenceExpiry || null : null,
    };
    if (assignees.enabled) body.assignedUserId = assignee || null;
    if (editing) body.version = existing!.version;
    else Object.assign(body, { type, branchId });
    save.mutate(body, { onError: setFailure });
  };

  const changeStart = (v: string) => {
    // Keep the duration when the start moves.
    if (/^\d{2}:\d{2}$/.test(v) && duration > 0) setEnd(addMinutes(v, duration));
    setStart(v);
  };

  const branchName = branches.list.find((b) => b.id === branchId)?.name ?? existing?.branchName ?? '';

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={editing ? t('appointments.editTitle') : t('appointments.newTitle')}
      description={editing ? t('appointments.editHint') : t('appointments.newHint', { tz: timezone })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon={<CalendarCheck className="h-4 w-4" />} onClick={submit} loading={save.isPending}>
            {editing ? t('common.save') : t('appointments.book')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {failure !== null &&
          (isVersionConflict(failure) ? (
            <div className="sm:col-span-2">
              <StaleAlert onReload={onClose} />
            </div>
          ) : (
            <Alert tone="danger" className="sm:col-span-2">
              {describe(failure)}
            </Alert>
          ))}
        <Field label={t('appointments.fields.type')} required>
          {(id) =>
            editing ? (
              <Input id={id} value={t(`appointments.type.${type}`)} disabled />
            ) : (
              <Select
                id={id}
                value={type}
                onChange={(e) => {
                  const next = e.target.value as AppointmentType;
                  setType(next);
                  if (/^\d{2}:\d{2}$/.test(start)) setEnd(addMinutes(start, DEFAULT_MINUTES[next]));
                }}
              >
                {APPOINTMENT_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {t(`appointments.type.${x}`)}
                  </option>
                ))}
              </Select>
            )
          }
        </Field>
        <Field label={t('common.branch')} required error={touched ? fm(errors.branchId) : null}>
          {(id) =>
            editing || branches.list.length <= 1 ? (
              <Input id={id} value={branchName} disabled />
            ) : (
              <Select
                id={id}
                value={branchId}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  if (vehicle?.branchId && vehicle.branchId !== e.target.value) setVehicle(null);
                }}
              >
                {branches.list.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )
          }
        </Field>

        <fieldset className="sm:col-span-2">
          <legend className="label">
            {t('appointments.fields.party')}
            {testDrive && (
              <span className="text-danger ms-0.5" aria-hidden>
                *
              </span>
            )}
          </legend>
          {can('leads.read') && (
            <div className="mb-2 inline-flex rounded-lg border border-line p-0.5 text-[13px]" role="radiogroup">
              {(['customer', 'lead'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={party === p}
                  onClick={() => setParty(p)}
                  className={clsx('rounded-md px-3 py-1', party === p ? 'bg-surface-2 font-medium text-ink' : 'text-muted hover:text-ink')}
                >
                  {t(`appointments.party.${p}`)}
                </button>
              ))}
            </div>
          )}
          {party === 'customer' ? (
            <Field error={touched || serverErrors.customerId ? fm(errors.customerId) : null}>
              {(id, desc) => (
                <CustomerPicker
                  id={id}
                  describedBy={desc}
                  invalid={(touched || !!serverErrors.customerId) && !!errors.customerId}
                  value={customer?.id ?? ''}
                  selectedLabel={customer?.fullName ?? ''}
                  onSelect={(c) => setCustomer({ id: c.id, fullName: c.fullName })}
                  onClear={() => setCustomer(null)}
                />
              )}
            </Field>
          ) : (
            <Field error={touched || serverErrors.leadId || serverErrors.customerId ? fm(errors.leadId ?? errors.customerId) : null} hint={t('appointments.leadHint')}>
              {(id, desc) => (
                <LeadPicker
                  id={id}
                  describedBy={desc}
                  invalid={(touched || !!serverErrors.leadId) && !!(errors.leadId ?? errors.customerId)}
                  value={lead?.id ?? ''}
                  selectedLabel={lead?.label ?? ''}
                  onSelect={(l: LeadOption) => setLead({ id: l.id, label: `${l.number} · ${l.customerName}`, customerId: l.customerId })}
                  onClear={() => setLead(null)}
                />
              )}
            </Field>
          )}
        </fieldset>

        <Field
          label={t('appointments.fields.vehicle')}
          required={testDrive}
          error={touched || serverErrors.vehicleId ? fm(errors.vehicleId) : null}
          hint={testDrive ? t('appointments.testDriveVehicleHint') : t('common.optional')}
          className="sm:col-span-2"
        >
          {(id, desc) => (
            <VehiclePicker
              id={id}
              describedBy={desc}
              status={testDrive ? 'available,reserved' : undefined}
              branchId={branchId || undefined}
              invalid={(touched || !!serverErrors.vehicleId) && !!errors.vehicleId}
              value={vehicle?.id ?? ''}
              selectedLabel={vehicle?.label ?? ''}
              onSelect={(v) => setVehicle({ id: v.id, label: `${vehicleOptionTitle(v, i18n.language)} · ${v.stockNumber}`, branchId: v.branchId })}
              onClear={() => setVehicle(null)}
            />
          )}
        </Field>

        <Field label={t('appointments.fields.date')} required error={touched ? fm(errors.date) : null}>
          {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('appointments.fields.start')} required error={touched || serverErrors.startsAt ? fm(errors.startsAt) : null}>
            {(id, desc) => <Input id={id} aria-describedby={desc} type="time" step={300} dir="ltr" value={start} invalid={!!serverErrors.startsAt} onChange={(e) => changeStart(e.target.value)} />}
          </Field>
          <Field label={t('appointments.fields.end')} required error={touched || serverErrors.endsAt ? fm(errors.endsAt) : null}>
            {(id, desc) => <Input id={id} aria-describedby={desc} type="time" step={300} dir="ltr" value={end} invalid={touched && !!errors.endsAt} onChange={(e) => setEnd(e.target.value)} />}
          </Field>
        </div>

        {assignees.enabled && (
          <Field label={t('appointments.fields.assignee')} hint={t('appointments.assigneeHint')}>
            {(id, desc) => (
              <Select id={id} aria-describedby={desc} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">{t('appointments.unassigned')}</option>
                {/* Keep the current assignee selectable when they are outside the branch list. */}
                {assignee && !assignees.list.some((m) => m.userId === assignee) && (
                  <option value={assignee}>{existing?.assignedUserId === assignee ? (existing.assigneeName ?? '—') : assignee === me?.user.id ? me.user.fullName : '—'}</option>
                )}
                {assignees.list.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.fullName}
                    {m.userId === me?.user.id ? ` (${t('appointments.me')})` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('appointments.fields.title')} className={assignees.enabled ? undefined : 'sm:col-span-2'}>
          {(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={t('appointments.titlePlaceholder')} />}
        </Field>

        {testDrive && (
          <div className="grid gap-4 rounded-xl border border-line bg-surface-2/40 p-4 sm:col-span-2 sm:grid-cols-2">
            <p className="text-[13px] text-muted sm:col-span-2">{t('appointments.licenceHint')}</p>
            <Field label={t('appointments.fields.licenceNumber')}>
              {(id) => <Input id={id} dir="ltr" className="num" value={licence} maxLength={40} onChange={(e) => setLicence(e.target.value)} />}
            </Field>
            <Field label={t('appointments.fields.licenceExpiry')} error={fm(errors.driverLicenseExpiry)}>
              {(id, desc) => <Input id={id} aria-describedby={desc} type="date" value={licenceExpiry} invalid={!!errors.driverLicenseExpiry} onChange={(e) => setLicenceExpiry(e.target.value)} />}
            </Field>
          </div>
        )}

        <Field label={t('common.notes')} className="sm:col-span-2">
          {(id) => <Textarea id={id} rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

// ── Test drive ───────────────────────────────────────────────────────────────────────────

/** Hands the car over: odometer out and the driver's licence (POST start-test-drive). */
export function StartTestDriveModal({ appointment: a, onClose }: { appointment: FullAppointment; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const describe = useDomainError('appointments');
  const fm = useFieldMessage('appointments');
  const vehicle = useApi<VehicleDetail>(['vehicle', a.vehicle?.id], a.vehicle && can('vehicles.read') ? `/vehicles/${a.vehicle.id}` : null);
  const last = vehicle.data?.vehicle.odometerValue;
  const unit = t(`appointments.units.${vehicle.data?.vehicle.odometerUnit ?? 'km'}`);
  const [odometer, setOdometer] = useState('');
  const [licence, setLicence] = useState(a.driverLicenseNumber ?? '');
  const [expiry, setExpiry] = useState(a.driverLicenseExpiry ?? '');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    if (last !== undefined && !odometer) setOdometer(String(last));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last]);
  const server = serverFieldErrors(failure);
  const errors = {
    odometerOut: !/^\d+$/.test(odometer) ? 'required' : last !== undefined && Number(odometer) < last ? 'odometer_below_last' : (server.odometerOut ?? null),
    driverLicenseNumber: licence.trim().length < 3 ? 'licence_required' : null,
    driverLicenseExpiry: !ISO_DATE.test(expiry) ? 'required' : (server.driverLicenseExpiry ?? null),
  };
  const start = useDomainMutation<{ odometerOut: number; driverLicenseNumber: string; driverLicenseExpiry: string }>({
    ns: 'appointments',
    path: `/appointments/${a.id}/start-test-drive`,
    toastError: false,
    invalidate: APPOINTMENT_KEYS,
    success: t('appointments.testDriveStarted'),
    onSuccess: onClose,
  });
  const submit = () => {
    setTouched(true);
    // Client checks only (a server error from the last attempt must not block a retry).
    if (!/^\d+$/.test(odometer) || (last !== undefined && Number(odometer) < last) || errors.driverLicenseNumber || !ISO_DATE.test(expiry)) return;
    setFailure(null);
    start.mutate({ odometerOut: Number(odometer), driverLicenseNumber: licence.trim(), driverLicenseExpiry: expiry }, { onError: setFailure });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('appointments.startTitle')}
      description={t('appointments.startHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon={<Play className="h-4 w-4" />} onClick={submit} loading={start.isPending}>
            {t('appointments.startConfirm')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {failure !== null && (
          <Alert tone="danger" className="sm:col-span-2">
            {describe(failure)}
          </Alert>
        )}
        <Field
          label={t('appointments.fields.odometerOut', { unit })}
          required
          error={
            touched || server.odometerOut
              ? errors.odometerOut === 'odometer_below_last' && last !== undefined
                ? t('appointments.errors.odometer_below_last', { lastReading: `${fmtNumber(last)} ${unit}` })
                : fm(errors.odometerOut)
              : null
          }
          hint={last !== undefined ? t('appointments.lastReading', { value: fmtNumber(last), unit }) : undefined}
          className="sm:col-span-2"
        >
          {(id, desc) => <Input id={id} aria-describedby={desc} inputMode="numeric" dir="ltr" className="num" value={odometer} invalid={touched && !!errors.odometerOut} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ''))} />}
        </Field>
        <Field label={t('appointments.fields.licenceNumber')} required error={touched ? fm(errors.driverLicenseNumber) : null}>
          {(id, desc) => <Input id={id} aria-describedby={desc} dir="ltr" className="num" maxLength={40} value={licence} invalid={touched && !!errors.driverLicenseNumber} onChange={(e) => setLicence(e.target.value)} />}
        </Field>
        <Field label={t('appointments.fields.licenceExpiry')} required error={touched || server.driverLicenseExpiry ? fm(errors.driverLicenseExpiry) : null}>
          {(id, desc) => <Input id={id} aria-describedby={desc} type="date" value={expiry} invalid={touched && !!errors.driverLicenseExpiry} onChange={(e) => setExpiry(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/** Takes the car back: odometer in and the outcome (POST finish-test-drive). */
export function FinishTestDriveModal({ appointment: a, onClose }: { appointment: FullAppointment; onClose: () => void }) {
  const { t } = useTranslation();
  const describe = useDomainError('appointments');
  const fm = useFieldMessage('appointments');
  const out = a.odometerOut ?? 0;
  const [odometer, setOdometer] = useState(String(out));
  const [outcome, setOutcome] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const server = serverFieldErrors(failure);
  const n = Number(odometer);
  const distance = /^\d+$/.test(odometer) ? n - out : null;
  const error = !/^\d+$/.test(odometer) ? 'required' : n < out ? 'invalid_odometer' : (server.odometerIn ?? null);
  const finish = useDomainMutation<{ odometerIn: number; outcome: string | null }>({
    ns: 'appointments',
    path: `/appointments/${a.id}/finish-test-drive`,
    toastError: false,
    invalidate: APPOINTMENT_KEYS,
    success: t('appointments.testDriveFinished'),
    onSuccess: onClose,
  });
  const submit = () => {
    setTouched(true);
    if (!/^\d+$/.test(odometer) || n < out) return;
    setFailure(null);
    finish.mutate({ odometerIn: n, outcome: outcome.trim() || null }, { onError: setFailure });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('appointments.finishTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button icon={<Flag className="h-4 w-4" />} onClick={submit} loading={finish.isPending}>
            {t('appointments.finishConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure !== null && <Alert tone="danger">{describe(failure)}</Alert>}
        <Field
          label={t('appointments.fields.odometerIn')}
          required
          error={touched || server.odometerIn ? fm(error) : null}
          hint={t('appointments.odometerOutWas', { value: fmtNumber(out) })}
        >
          {(id, desc) => <Input id={id} aria-describedby={desc} inputMode="numeric" dir="ltr" className="num" value={odometer} invalid={touched && !!error} onChange={(e) => setOdometer(e.target.value.replace(/\D/g, ''))} />}
        </Field>
        {distance !== null && distance >= 0 && (
          <p className="rounded-lg border border-line px-3 py-2 text-sm">
            {t('appointments.distance')}: <span className="num font-semibold">{fmtNumber(distance)}</span>
          </p>
        )}
        <Field label={t('appointments.fields.outcome')} hint={t('appointments.outcomeHint')}>
          {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={3} maxLength={1000} value={outcome} onChange={(e) => setOutcome(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
