import clsx from 'clsx';
import { CalendarDays, Car, ChevronLeft, ChevronRight, Lock, Plus, Rows3 } from 'lucide-react';
import { MouseEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES, todayInZone } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Checkbox, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { useTenantMoney, vehicleLabel } from '@/features/receivables/kit';
import { useAuth } from '@/lib/auth';
import { useApi, useListParams } from '@/lib/hooks';
import { Appointment, AppointmentList, AppointmentStatus, AppointmentType } from './api';
import { AppointmentFormModal, AppointmentStatusBadge, BookingDefaults, TypeBadge, useBookableBranches } from './components';
import { addDays, dayLabel, firstDayOfWeek, hourLabel, ISO_DATE, startOfWeek, timeLabel, zoned, zonedToUtc } from './time';

type View = 'week' | 'day';

/** Height of one hour in the week grid. */
const HOUR_PX = 52;
/** Showroom hours shown even when nothing is booked earlier or later. */
const DAY_FROM = 8;
const DAY_TO = 21;

/** Status colours of calendar blocks (the badge carries the label, so colour is not the only cue). */
const BLOCK: Record<AppointmentStatus, string> = {
  scheduled: 'border-info/40 bg-info-soft',
  confirmed: 'border-brand/50 bg-brand-soft',
  in_progress: 'border-accent/50 bg-accent-soft',
  completed: 'border-success/40 bg-success-soft',
  no_show: 'border-danger/40 bg-danger-soft',
  cancelled: 'border-line bg-surface-2 opacity-70',
};
const STRIPES = { backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 6px, var(--surface-3) 6px 12px)' };

interface Segment {
  a: Appointment;
  day: string;
  /** Minutes since the zone's midnight. */
  from: number;
  to: number;
  lane: number;
  lanes: number;
}

/** Splits appointments into per-day segments in the company zone and lays overlaps side by side. */
function layout(items: Appointment[], days: string[], tz: string): Map<string, Segment[]> {
  const out = new Map<string, Segment[]>(days.map((d) => [d, []]));
  for (const a of items) {
    const s = new Date(a.startsAt).getTime();
    const e = new Date(a.endsAt).getTime();
    for (const day of days) {
      const dayStart = zonedToUtc(day, '00:00', tz).getTime();
      const dayEnd = zonedToUtc(addDays(day, 1), '00:00', tz).getTime();
      if (e <= dayStart || s >= dayEnd) continue;
      const from = s <= dayStart ? 0 : zoned(new Date(s), tz).minutes;
      const to = e >= dayEnd ? 24 * 60 : zoned(new Date(e), tz).minutes;
      out.get(day)!.push({ a, day, from, to: Math.max(to, from + 15), lane: 0, lanes: 1 });
    }
  }
  for (const segs of out.values()) {
    segs.sort((x, y) => x.from - y.from || y.to - x.to);
    // Clusters of overlapping segments share the column width.
    let cluster: Segment[] = [];
    let clusterEnd = -1;
    const close = () => {
      const lanes = cluster.reduce((m, s) => Math.max(m, s.lane + 1), 1);
      cluster.forEach((s) => (s.lanes = lanes));
      cluster = [];
    };
    for (const seg of segs) {
      if (seg.from >= clusterEnd && cluster.length) close();
      const used = new Set(cluster.filter((c) => c.to > seg.from).map((c) => c.lane));
      let lane = 0;
      while (used.has(lane)) lane++;
      seg.lane = lane;
      cluster.push(seg);
      clusterEnd = Math.max(clusterEnd, seg.to);
    }
    if (cluster.length) close();
  }
  return out;
}

/** One line describing who/what an appointment is about (or that it is someone else's). */
function useHeadline() {
  const { t } = useTranslation();
  return (a: Appointment): string => {
    if (a.restricted) return t('appointments.busy');
    return a.title || a.customerName || t(`appointments.type.${a.type}`);
  };
}

export function AppointmentsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const { timezone } = useTenantMoney();
  const headline = useHeadline();
  const narrow = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches, []);
  const lp = useListParams({ view: narrow ? 'day' : 'week' });
  const view: View = lp.get('view') === 'day' ? 'day' : 'week';
  const today = todayInZone(timezone);
  const anchor = ISO_DATE.test(lp.get('date')) ? lp.get('date') : today;
  const weekStart = startOfWeek(anchor, firstDayOfWeek(me?.tenant?.market));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const branches = useBookableBranches();
  const [booking, setBooking] = useState<BookingDefaults | null>(null);
  const canManage = can('appointments.manage');

  const branchId = lp.get('branchId');
  const type = lp.get('type') as AppointmentType | '';
  const status = lp.get('status') as AppointmentStatus | '';
  const mine = lp.get('mine') === 'true';
  // Cancelled bookings free their slot; they are hidden unless asked for, so live ones get the space.
  const showCancelled = status === 'cancelled' || lp.get('cancelled') === 'true';
  const q = useApi<AppointmentList>(
    ['appointments', 'calendar'],
    '/appointments',
    {
      from: zonedToUtc(weekStart, '00:00', timezone).toISOString(),
      to: zonedToUtc(addDays(weekStart, 7), '00:00', timezone).toISOString(),
      branchId: branchId || undefined,
      type: type || undefined,
      status: status || undefined,
      mine: mine ? 'true' : undefined,
    },
    { placeholderData: (p) => p },
  );
  const segments = useMemo(
    () => layout((q.data?.items ?? []).filter((a) => showCancelled || a.status !== 'cancelled'), days, timezone),
    [q.data, days, timezone, showCancelled],
  );
  const counts = (day: string) => (segments.get(day) ?? []).filter((s) => s.a.status !== 'cancelled').length;

  const move = (n: number) => lp.set({ date: addDays(anchor, view === 'week' ? 7 * n : n) });
  const rangeLabel =
    view === 'week'
      ? `${dayLabel(days[0]!, i18n.language, { day: 'numeric', month: 'short' })} – ${dayLabel(days[6]!, i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : dayLabel(anchor, i18n.language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const open = (a: Appointment) => {
    if (!a.restricted) navigate(`/app/appointments/${a.id}`);
  };
  const filtered = !!(branchId || type || status || mine || lp.get('cancelled'));

  return (
    <>
      <PageHeader
        title={t('appointments.title')}
        subtitle={t('appointments.subtitle', { tz: timezone })}
        actions={
          canManage && (
            <>
              <Button variant="secondary" icon={<Car className="h-4 w-4" />} onClick={() => setBooking({ type: 'test_drive', date: anchor >= today ? anchor : today })}>
                {t('appointments.newTestDrive')}
              </Button>
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => setBooking({ date: anchor >= today ? anchor : today })}>
                {t('appointments.new')}
              </Button>
            </>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label={t('appointments.previous')} onClick={() => move(-1)}>
                <ChevronRight className="h-4 w-4 ltr:rotate-180" />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => lp.set({ date: null })} disabled={anchor === today}>
                {t('appointments.today')}
              </Button>
              <Button variant="ghost" size="icon" aria-label={t('appointments.next')} onClick={() => move(1)}>
                <ChevronLeft className="h-4 w-4 ltr:rotate-180" />
              </Button>
            </div>
            <h2 className="num text-[15px] font-semibold text-ink">{rangeLabel}</h2>
          </div>
          <div className="inline-flex rounded-lg border border-line p-0.5 text-[13px]" role="radiogroup" aria-label={t('appointments.view')}>
            {(['week', 'day'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => lp.set({ view: v })}
                className={clsx('inline-flex items-center gap-1.5 rounded-md px-3 py-1', view === v ? 'bg-surface-2 font-medium text-ink' : 'text-muted hover:text-ink')}
              >
                {v === 'week' ? <CalendarDays className="h-3.5 w-3.5" aria-hidden /> : <Rows3 className="h-3.5 w-3.5" aria-hidden />}
                {t(`appointments.views.${v}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center">
          {branches.list.length > 1 && (
            <Select aria-label={t('common.branch')} className="sm:w-52" value={branchId} onChange={(e) => lp.set({ branchId: e.target.value || null })}>
              <option value="">{t('common.allBranches')}</option>
              {branches.list.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
          <Select aria-label={t('appointments.fields.type')} className="sm:w-48" value={type} onChange={(e) => lp.set({ type: e.target.value || null })}>
            <option value="">{t('appointments.allTypes')}</option>
            {APPOINTMENT_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`appointments.type.${x}`)}
              </option>
            ))}
          </Select>
          <Select aria-label={t('common.status')} className="sm:w-48" value={status} onChange={(e) => lp.set({ status: e.target.value || null })}>
            <option value="">{t('appointments.allStatuses')}</option>
            {APPOINTMENT_STATUSES.map((x) => (
              <option key={x} value={x}>
                {t(`appointments.status.${x}`)}
              </option>
            ))}
          </Select>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:ms-2">
            <Checkbox label={t('appointments.mineOnly')} checked={mine} onChange={(e) => lp.set({ mine: e.target.checked ? 'true' : null })} />
            {!status && <Checkbox label={t('appointments.showCancelled')} checked={showCancelled} onChange={(e) => lp.set({ cancelled: e.target.checked ? 'true' : null })} />}
          </div>
          {filtered && (
            <Button variant="ghost" size="sm" className="self-start sm:self-auto" onClick={() => lp.set({ branchId: null, type: null, status: null, mine: null, cancelled: null })}>
              {t('common.clearFilters')}
            </Button>
          )}
        </div>
        {q.data?.truncated && (
          <Alert tone="warning" className="m-4">
            {t('appointments.truncated')}
          </Alert>
        )}
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : view === 'week' ? (
          <WeekGrid
            days={days}
            today={today}
            timezone={timezone}
            segments={segments}
            loading={q.isLoading}
            headline={headline}
            onOpen={open}
            onSlot={canManage ? (date, time) => setBooking({ date, time }) : undefined}
            onDay={(day) => lp.set({ view: 'day', date: day })}
          />
        ) : (
          <DayList
            days={days}
            day={anchor}
            today={today}
            counts={counts}
            items={(segments.get(anchor) ?? []).map((s) => s.a)}
            loading={q.isLoading}
            timezone={timezone}
            headline={headline}
            onPick={(day) => lp.set({ date: day })}
            onOpen={open}
            onBook={canManage ? () => setBooking({ date: anchor >= today ? anchor : today }) : undefined}
          />
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-5 rounded border border-line" style={STRIPES} aria-hidden />
            {t('appointments.legendBusy')}
          </span>
          {canManage && view === 'week' && <span>{t('appointments.legendClick')}</span>}
        </div>
      </Card>
      {booking && <AppointmentFormModal defaults={booking} onClose={() => setBooking(null)} onDone={(a) => navigate(`/app/appointments/${a.id}`)} />}
    </>
  );
}

// ── Week grid ────────────────────────────────────────────────────────────────────────────

function WeekGrid({
  days,
  today,
  timezone,
  segments,
  loading,
  headline,
  onOpen,
  onSlot,
  onDay,
}: {
  days: string[];
  today: string;
  timezone: string;
  segments: Map<string, Segment[]>;
  loading: boolean;
  headline: (a: Appointment) => string;
  onOpen: (a: Appointment) => void;
  onSlot?: (date: string, time: string) => void;
  onDay: (day: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const all = [...segments.values()].flat();
  const fromH = Math.min(DAY_FROM, ...all.map((s) => Math.floor(s.from / 60)));
  const toH = Math.max(DAY_TO, ...all.map((s) => Math.ceil(s.to / 60)));
  const hours = Array.from({ length: toH - fromH }, (_, i) => fromH + i);
  const height = hours.length * HOUR_PX;
  const now = zoned(new Date(), timezone);
  const pxPerMin = HOUR_PX / 60;

  const slotClick = (day: string) => (e: MouseEvent<HTMLDivElement>) => {
    if (!onSlot || e.target !== e.currentTarget) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const minutes = fromH * 60 + Math.floor(y / pxPerMin / 30) * 30;
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    if (day < today) return;
    onSlot(day, `${hh}:${mm}`);
  };

  return (
    <div className="scrollbar-thin overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] border-b border-line bg-surface-2/60">
          <div />
          {days.map((day) => (
            <button
              key={day}
              type="button"
              onClick={() => onDay(day)}
              className={clsx('border-s border-line px-2 py-2 text-center text-[13px] hover:bg-surface-2', day === today ? 'font-semibold text-brand-strong' : 'text-muted')}
            >
              <span className="num block">{dayLabel(day, i18n.language)}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))]">
          <div className="relative" style={{ height }}>
            {hours.map((h, i) => (
              <span key={h} className="num absolute end-2 -translate-y-1/2 text-[11px] text-subtle" style={{ top: i * HOUR_PX }}>
                {i === 0 ? '' : hourLabel(h, i18n.language)}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <div
              key={day}
              className={clsx('relative border-s border-line', onSlot && day >= today && 'cursor-copy', day === today && 'bg-brand-soft/20')}
              style={{
                height,
                backgroundImage: 'linear-gradient(to bottom, var(--line) 1px, transparent 1px)',
                backgroundSize: `100% ${HOUR_PX}px`,
              }}
              onClick={slotClick(day)}
            >
              {loading && !segments.get(day)?.length && <Skeleton className="absolute inset-x-2 top-10 h-12" />}
              {day === today && now.minutes >= fromH * 60 && now.minutes <= toH * 60 && (
                <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger" style={{ top: (now.minutes - fromH * 60) * pxPerMin }} aria-hidden />
              )}
              {(segments.get(day) ?? []).map((s) => {
                const top = (s.from - fromH * 60) * pxPerMin;
                const h = Math.max((s.to - s.from) * pxPerMin - 2, 18);
                const a = s.a;
                return (
                  <button
                    key={`${a.id}-${day}`}
                    type="button"
                    onClick={() => onOpen(a)}
                    disabled={a.restricted}
                    title={`${timeLabel(a.startsAt, timezone, i18n.language)}–${timeLabel(a.endsAt, timezone, i18n.language)} · ${headline(a)}${a.assigneeName ? ` · ${a.assigneeName}` : ''}`}
                    className={clsx(
                      'absolute overflow-hidden rounded-md border px-1.5 py-1 text-start text-[11.5px] leading-tight shadow-sm',
                      a.restricted ? 'cursor-default border-line bg-surface text-muted' : clsx(BLOCK[a.status], 'text-ink hover:shadow-pop'),
                    )}
                    style={{ top, height: h, insetInlineStart: `calc(${(s.lane / s.lanes) * 100}% + 2px)`, width: `calc(${100 / s.lanes}% - 4px)`, ...(a.restricted ? STRIPES : {}) }}
                  >
                    {h < 36 ? (
                      // Short slots (e.g. a 30-minute test drive): time and headline on one line.
                      <span className="block truncate">
                        {a.restricted ? <Lock className="me-1 inline h-3 w-3" aria-hidden /> : a.type === 'test_drive' ? <Car className="me-1 inline h-3 w-3" aria-hidden /> : null}
                        <span className="num font-medium">{timeLabel(a.startsAt, timezone, i18n.language)}</span>{' '}
                        <span dir="auto" className={clsx(a.status === 'cancelled' && 'line-through')}>
                          {headline(a)}
                        </span>
                      </span>
                    ) : (
                      <>
                        <span className="num block truncate font-medium">
                          {a.restricted ? <Lock className="me-1 inline h-3 w-3" aria-hidden /> : a.type === 'test_drive' ? <Car className="me-1 inline h-3 w-3" aria-hidden /> : null}
                          {timeLabel(a.startsAt, timezone, i18n.language)}
                        </span>
                        <span dir="auto" className={clsx('block truncate text-start', a.status === 'cancelled' && 'line-through')}>
                          {headline(a)}
                        </span>
                      </>
                    )}
                    {h > 44 && a.assigneeName && <span className="block truncate text-[11px] text-muted">{a.assigneeName}</span>}
                    {h > 58 && a.vehicle?.stockNumber && <span className="num block truncate text-[11px] text-muted">{a.vehicle.stockNumber}</span>}
                    <span className="sr-only">{t(`appointments.status.${a.status}`)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Day list ─────────────────────────────────────────────────────────────────────────────

function DayList({
  days,
  day,
  today,
  counts,
  items,
  loading,
  timezone,
  headline,
  onPick,
  onOpen,
  onBook,
}: {
  days: string[];
  day: string;
  today: string;
  counts: (day: string) => number;
  items: Appointment[];
  loading: boolean;
  timezone: string;
  headline: (a: Appointment) => string;
  onPick: (day: string) => void;
  onOpen: (a: Appointment) => void;
  onBook?: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div>
      <div className="scrollbar-thin flex gap-1.5 overflow-x-auto border-b border-line px-4 py-3">
        {days.map((x) => (
          <button
            key={x}
            type="button"
            aria-pressed={x === day}
            onClick={() => onPick(x)}
            className={clsx(
              'flex min-w-[64px] flex-col items-center rounded-xl border px-2 py-1.5 text-[12px]',
              x === day ? 'border-brand bg-brand-soft text-ink' : 'border-line text-muted hover:bg-surface-2',
              x === today && x !== day && 'border-brand/50',
            )}
          >
            <span>{dayLabel(x, i18n.language, { weekday: 'short' })}</span>
            <span className="num text-[15px] font-semibold text-ink">{dayLabel(x, i18n.language, { day: 'numeric' })}</span>
            <span className="num text-[11px]">{counts(x) || '·'}</span>
          </button>
        ))}
      </div>
      {loading && items.length === 0 ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title={t('appointments.emptyDay')}
          action={
            onBook && day >= today ? (
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={onBook}>
                {t('appointments.new')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-line">
          {[...items]
            .sort((x, y) => x.startsAt.localeCompare(y.startsAt))
            .map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  disabled={a.restricted}
                  onClick={() => onOpen(a)}
                  className={clsx('flex w-full items-start gap-3 px-4 py-3 text-start', a.restricted ? 'cursor-default' : 'hover:bg-surface-2/70')}
                  style={a.restricted ? STRIPES : undefined}
                >
                  <span className="num w-16 shrink-0 text-[13px] font-semibold text-ink">
                    {timeLabel(a.startsAt, timezone, i18n.language)}
                    <span className="block text-xs font-normal text-muted">{timeLabel(a.endsAt, timezone, i18n.language)}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {a.restricted ? (
                        <span className="inline-flex items-center gap-1 text-sm font-medium text-muted">
                          <Lock className="h-3.5 w-3.5" aria-hidden />
                          {t('appointments.busy')}
                        </span>
                      ) : (
                        <span dir="auto" className={clsx('truncate text-sm font-medium text-ink', a.status === 'cancelled' && 'line-through')}>
                          {headline(a)}
                        </span>
                      )}
                      <TypeBadge type={a.type} />
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted">
                      {[
                        a.assigneeName ? t('appointments.with', { name: a.assigneeName }) : t('appointments.unassigned'),
                        a.vehicle ? `${vehicleLabel(a.vehicle, i18n.language)} · ${a.vehicle.stockNumber ?? ''}` : null,
                        a.branchName,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {!a.restricted && <AppointmentStatusBadge status={a.status} />}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
