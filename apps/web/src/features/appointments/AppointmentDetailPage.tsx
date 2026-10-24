import { Ban, CalendarClock, CalendarDays, Car, Check, CheckCheck, Flag, Play, UserX } from 'lucide-react';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Field, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { isVersionConflict, ReasonModal, StaleAlert, useDomainError, useDomainMutation, useTenantMoney, vehicleLabel } from '@/features/receivables/kit';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { APPOINTMENT_KEYS, BOOKED, FullAppointment } from './api';
import { AppointmentFormModal, AppointmentStatusBadge, FinishTestDriveModal, StartTestDriveModal, TypeBadge } from './components';
import { timeLabel, zoned } from './time';

const MINUTE = 60_000;
/** Same windows the API enforces (no-show after the start; complete from 15 min before; test drive from 30 min before). */
const COMPLETE_EARLY_MS = 15 * MINUTE;
const START_EARLY_MS = 30 * MINUTE;

type Dialog = 'edit' | 'confirm' | 'cancel' | 'no_show' | 'complete' | 'start' | 'finish' | null;

export function AppointmentDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { timezone } = useTenantMoney();
  const [dialog, setDialog] = useState<Dialog>(null);
  const q = useApi<FullAppointment>(['appointment', id], id ? `/appointments/${id}` : null);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title={t('appointments.notFound')}
          description={t('appointments.notFoundHint')}
          action={
            <Link to="/app/appointments" className="text-sm text-brand-strong hover:underline">
              {t('appointments.backToCalendar')}
            </Link>
          }
        />
      );
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  }
  const a = q.data;
  const manage = can('appointments.manage');
  const booked = BOOKED.includes(a.status);
  const testDrive = a.type === 'test_drive';
  const startMs = new Date(a.startsAt).getTime();
  const now = Date.now();
  const started = startMs <= now;
  const sameDay = zoned(a.startsAt, timezone).date === zoned(a.endsAt, timezone).date;
  const when = `${fmtDate(a.startsAt, timezone)} · ${timeLabel(a.startsAt, timezone, i18n.language)} – ${sameDay ? '' : `${fmtDate(a.endsAt, timezone)} `}${timeLabel(a.endsAt, timezone, i18n.language)}`;
  const distance = a.odometerIn !== null && a.odometerOut !== null ? a.odometerIn - a.odometerOut : null;

  const actions: ReactNode[] = [];
  if (manage && a.status === 'scheduled')
    actions.push(
      <Button key="confirm" variant="success" icon={<Check className="h-4 w-4" />} onClick={() => setDialog('confirm')}>
        {t('appointments.actions.confirm')}
      </Button>,
    );
  if (manage && testDrive && booked)
    actions.push(
      <Button key="start" icon={<Play className="h-4 w-4" />} disabled={startMs - now > START_EARLY_MS} title={startMs - now > START_EARLY_MS ? t('appointments.startTooEarly') : undefined} onClick={() => setDialog('start')}>
        {t('appointments.actions.start')}
      </Button>,
    );
  if (manage && testDrive && a.status === 'in_progress')
    actions.push(
      <Button key="finish" icon={<Flag className="h-4 w-4" />} onClick={() => setDialog('finish')}>
        {t('appointments.actions.finish')}
      </Button>,
    );
  if (manage && !testDrive && booked)
    actions.push(
      <Button key="complete" variant="success" icon={<CheckCheck className="h-4 w-4" />} disabled={startMs > now + COMPLETE_EARLY_MS} title={startMs > now + COMPLETE_EARLY_MS ? t('appointments.notStartedYet') : undefined} onClick={() => setDialog('complete')}>
        {t('appointments.actions.complete')}
      </Button>,
    );
  if (manage && booked)
    actions.push(
      <Button key="edit" variant="secondary" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setDialog('edit')}>
        {t('appointments.actions.reschedule')}
      </Button>,
      <Button key="noshow" variant="outline" icon={<UserX className="h-4 w-4" />} disabled={!started} title={!started ? t('appointments.noShowTooEarly') : undefined} onClick={() => setDialog('no_show')}>
        {t('appointments.actions.noShow')}
      </Button>,
      <Button key="cancel" variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={() => setDialog('cancel')}>
        {t('appointments.actions.cancel')}
      </Button>,
    );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('appointments.title'), to: '/app/appointments' }, { label: t(`appointments.type.${a.type}`) }]}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{a.title || t(`appointments.type.${a.type}`)}</span>
            <AppointmentStatusBadge status={a.status} />
          </span>
        }
        subtitle={<span className="num">{when}</span>}
        actions={actions.length ? actions : undefined}
      />

      {a.status === 'cancelled' && (
        <Alert tone="info" className="mb-4" title={t('appointments.cancelledTitle')}>
          {a.cancelReason}
        </Alert>
      )}
      {a.status === 'no_show' && (
        <Alert tone="warning" className="mb-4" title={t('appointments.noShowTitle')}>
          {a.outcome ?? undefined}
        </Alert>
      )}
      {a.status === 'in_progress' && (
        <Alert tone="info" className="mb-4" title={t('appointments.onTheRoad', { time: a.startedAt ? timeLabel(a.startedAt, timezone, i18n.language) : '—' })}>
          {t('appointments.onTheRoadHint')}
        </Alert>
      )}
      {a.status === 'scheduled' && startMs > now && <p className="mb-4 text-[13px] text-muted">{t('appointments.scheduledHint')}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader title={t('appointments.details')} actions={<TypeBadge type={a.type} />} />
          <CardBody>
            <DescriptionList
              items={[
                { label: t('appointments.fields.when'), value: <span className="num">{when}</span> },
                { label: t('common.branch'), value: a.branchName },
                {
                  label: t('appointments.fields.customer'),
                  value: a.customerId ? (
                    <span>
                      <Link to={`/app/customers/${a.customerId}`} className="text-brand-strong hover:underline">
                        {a.customerName ?? '—'}
                      </Link>
                      {a.customerPhone && (
                        <a href={`tel:${a.customerPhone}`} className="num ms-2 text-muted hover:text-ink">
                          <bdi dir="ltr">{a.customerPhone}</bdi>
                        </a>
                      )}
                    </span>
                  ) : (
                    t('appointments.noCustomer')
                  ),
                },
                {
                  label: t('appointments.fields.lead'),
                  value: a.leadId ? (
                    <Link to={`/app/leads/${a.leadId}`} className="num text-brand-strong hover:underline">
                      {a.leadNumber ?? t('appointments.openLead')}
                    </Link>
                  ) : (
                    '—'
                  ),
                },
                {
                  label: t('appointments.fields.vehicle'),
                  value: a.vehicle ? (
                    <Link to={`/app/vehicles/${a.vehicle.id}`} className="text-brand-strong hover:underline">
                      {vehicleLabel(a.vehicle, i18n.language)} <span className="num text-muted">· {a.vehicle.stockNumber}</span>
                    </Link>
                  ) : (
                    '—'
                  ),
                },
                { label: t('appointments.fields.assignee'), value: a.assigneeName ?? t('appointments.unassigned') },
                { label: t('common.notes'), value: a.notes ?? '—', full: true },
                ...(a.status === 'completed' && !testDrive ? [{ label: t('appointments.fields.outcome'), value: a.outcome ?? '—', full: true }] : []),
              ]}
            />
          </CardBody>
        </Card>
        <div className="space-y-4">
          {testDrive && (
            <Card>
              <CardHeader title={t('appointments.testDrive')} actions={<Car className="h-4 w-4 text-muted" aria-hidden />} />
              <CardBody>
                <DescriptionList
                  columns={1}
                  items={[
                    { label: t('appointments.fields.licenceNumber'), value: a.driverLicenseNumber ? <bdi className="num" dir="ltr">{a.driverLicenseNumber}</bdi> : t('appointments.licenceMissing') },
                    { label: t('appointments.fields.licenceExpiry'), value: a.driverLicenseExpiry ? fmtDate(a.driverLicenseExpiry) : '—' },
                    { label: t('appointments.fields.startedAt'), value: a.startedAt ? fmtDateTime(a.startedAt, timezone) : '—' },
                    { label: t('appointments.fields.odometerOutShort'), value: a.odometerOut !== null ? <span className="num">{fmtNumber(a.odometerOut)}</span> : '—' },
                    { label: t('appointments.fields.finishedAt'), value: a.finishedAt ? fmtDateTime(a.finishedAt, timezone) : '—' },
                    { label: t('appointments.fields.odometerIn'), value: a.odometerIn !== null ? <span className="num">{fmtNumber(a.odometerIn)}</span> : '—' },
                    ...(distance !== null ? [{ label: t('appointments.distance'), value: <span className="num font-semibold">{fmtNumber(distance)}</span> }] : []),
                    ...(a.status === 'completed' ? [{ label: t('appointments.fields.outcome'), value: a.outcome ?? '—' }] : []),
                  ]}
                />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title={t('appointments.history')} />
            <CardBody>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('common.createdAt'), value: fmtDateTime(a.createdAt, timezone) },
                  { label: t('appointments.fields.updatedAt'), value: fmtDateTime(a.updatedAt, timezone) },
                  ...(!testDrive && a.finishedAt ? [{ label: t('appointments.fields.finishedAt'), value: fmtDateTime(a.finishedAt, timezone) }] : []),
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>

      {dialog === 'edit' && <AppointmentFormModal appointment={a} onClose={() => setDialog(null)} />}
      {dialog === 'start' && <StartTestDriveModal appointment={a} onClose={() => setDialog(null)} />}
      {dialog === 'finish' && <FinishTestDriveModal appointment={a} onClose={() => setDialog(null)} />}
      {dialog === 'confirm' && <ConfirmAppointmentDialog appointment={a} onClose={() => setDialog(null)} onReload={() => q.refetch()} />}
      {dialog === 'cancel' && <CancelAppointmentDialog appointment={a} onClose={() => setDialog(null)} onReload={() => q.refetch()} />}
      {(dialog === 'no_show' || dialog === 'complete') && <OutcomeDialog kind={dialog} appointment={a} onClose={() => setDialog(null)} onReload={() => q.refetch()} />}
    </>
  );
}

interface ActionProps {
  appointment: FullAppointment;
  onClose: () => void;
  onReload: () => void;
}

function ErrorBox({ failure, onReload }: { failure: unknown; onReload: () => void }) {
  const describe = useDomainError('appointments');
  if (failure === null) return null;
  if (isVersionConflict(failure)) return <StaleAlert onReload={onReload} />;
  return <Alert tone="danger">{describe(failure)}</Alert>;
}

function ConfirmAppointmentDialog({ appointment: a, onClose, onReload }: ActionProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<unknown>(null);
  const m = useDomainMutation<{ version: number }>({
    ns: 'appointments',
    path: `/appointments/${a.id}/confirm`,
    toastError: false,
    invalidate: APPOINTMENT_KEYS,
    success: t('appointments.done.confirm'),
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={t('appointments.confirmTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="success"
            icon={<Check className="h-4 w-4" />}
            loading={m.isPending}
            onClick={() => {
              setFailure(null);
              m.mutate({ version: a.version }, { onError: setFailure });
            }}
          >
            {t('appointments.actions.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorBox
          failure={failure}
          onReload={() => {
            onReload();
            onClose();
          }}
        />
        <p className="text-sm text-muted">{t('appointments.confirmMessage')}</p>
      </div>
    </Modal>
  );
}

function CancelAppointmentDialog({ appointment: a, onClose, onReload }: ActionProps) {
  const { t } = useTranslation();
  const describe = useDomainError('appointments');
  const [failure, setFailure] = useState<unknown>(null);
  const m = useDomainMutation<{ reason: string; version: number }>({
    ns: 'appointments',
    path: `/appointments/${a.id}/cancel`,
    toastError: false,
    invalidate: APPOINTMENT_KEYS,
    success: t('appointments.done.cancel'),
    onSuccess: onClose,
  });
  return (
    <ReasonModal
      title={t('appointments.cancelTitle')}
      message={t('appointments.cancelMessage')}
      confirmLabel={t('appointments.actions.cancel')}
      loading={m.isPending}
      error={
        failure === null ? null : isVersionConflict(failure) ? (
          <span>
            {describe(failure)}{' '}
            <button
              type="button"
              className="font-medium text-brand-strong hover:underline"
              onClick={() => {
                onReload();
                onClose();
              }}
            >
              {t('receivables.kit.reload')}
            </button>
          </span>
        ) : (
          describe(failure)
        )
      }
      onClose={onClose}
      onConfirm={(reason) => {
        setFailure(null);
        m.mutate({ reason, version: a.version }, { onError: setFailure });
      }}
    />
  );
}

/** Records a no-show (optional note) or completes a non-test-drive appointment (optional outcome). */
function OutcomeDialog({ kind, appointment: a, onClose, onReload }: ActionProps & { kind: 'no_show' | 'complete' }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const m = useDomainMutation<Record<string, unknown>>({
    ns: 'appointments',
    path: `/appointments/${a.id}/${kind === 'no_show' ? 'no-show' : 'complete'}`,
    toastError: false,
    invalidate: APPOINTMENT_KEYS,
    success: t(`appointments.done.${kind}`),
    onSuccess: onClose,
  });
  const submit = () => {
    setFailure(null);
    const value = text.trim() || null;
    m.mutate(kind === 'no_show' ? { note: value, version: a.version } : { outcome: value, version: a.version }, { onError: setFailure });
  };
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={t(`appointments.${kind === 'no_show' ? 'noShowDialogTitle' : 'completeTitle'}`)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={kind === 'no_show' ? 'danger' : 'success'} loading={m.isPending} onClick={submit}>
            {t(`appointments.actions.${kind === 'no_show' ? 'noShow' : 'complete'}`)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorBox
          failure={failure}
          onReload={() => {
            onReload();
            onClose();
          }}
        />
        <p className="text-sm text-muted">{t(`appointments.${kind === 'no_show' ? 'noShowMessage' : 'completeMessage'}`)}</p>
        <Field label={kind === 'no_show' ? t('appointments.fields.note') : t('appointments.fields.outcome')} hint={t('common.optional')}>
          {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={3} maxLength={kind === 'no_show' ? 500 : 1000} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
