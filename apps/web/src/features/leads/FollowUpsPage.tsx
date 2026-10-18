import clsx from 'clsx';
import { AlarmClock, CalendarCheck2, CalendarClock, Car, MessageSquarePlus, PartyPopper } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { InteractionModal, PhoneText, useCanLogInteraction } from '@/features/customers/components';
import { cardVehicleLabel, FollowUps, LeadCard } from './api';
import { LeadDialog, LeadDialogs, StageBadge } from './components';

type Item = FollowUps['items'][number];

function FollowUpRow({ l, onLog, onReschedule }: { l: Item; onLog: () => void; onReschedule: () => void }) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const canLog = useCanLogInteraction();
  const vehicle = cardVehicleLabel(l, i18n.language);
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/app/leads/${l.id}`} className="font-semibold text-ink hover:text-brand-strong hover:underline">
            {l.customerName}
          </Link>
          <span className="num text-xs text-muted">{l.number}</span>
          <StageBadge stage={{ nameEn: l.stageNameEn, nameAr: l.stageNameAr, code: l.stageCode, kind: l.stageKind }} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
          <PhoneText phone={l.customerPhone} />
          {vehicle && (
            <span className="inline-flex items-center gap-1">
              <Car className="h-3.5 w-3.5" aria-hidden /> {vehicle}
            </span>
          )}
          <span className={clsx('inline-flex items-center gap-1 font-medium', l.overdue ? 'text-danger' : 'text-warning')}>
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            <span className="num">{fmtDateTime(l.nextFollowUpAt)}</span>
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {canLog && (
          <Button size="sm" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={onLog}>
            {t('leads.followUp.logAndReschedule')}
          </Button>
        )}
        {can('leads.manage') && (
          <Button size="sm" variant="secondary" icon={<CalendarClock className="h-4 w-4" />} onClick={onReschedule}>
            {t('leads.actions.reschedule')}
          </Button>
        )}
      </div>
    </li>
  );
}

/** The signed-in salesperson's follow-ups: overdue first, then the rest of today. */
export function FollowUpsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const tz = me?.tenant?.settings.timezone;
  const q = useApi<FollowUps>(['follow-ups'], '/leads/follow-ups', { limit: 200 }, { refetchInterval: 60_000 });
  const [dialog, setDialog] = useState<LeadDialog | null>(null);
  const [log, setLog] = useState<LeadCard | null>(null);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const overdue = q.data.items.filter((i) => i.overdue);
  const today = q.data.items.filter((i) => !i.overdue);
  const section = (title: string, items: Item[], tone: 'danger' | 'warning') =>
    items.length > 0 && (
      <Card>
        <CardHeader title={<span className={tone === 'danger' ? 'text-danger' : 'text-warning'}>{title}</span>} subtitle={t('leads.followUp.count', { count: items.length })} />
        <ul className="divide-y divide-line">
          {items.map((l) => (
            <FollowUpRow key={l.id} l={l} onLog={() => setLog(l)} onReschedule={() => setDialog({ kind: 'followUp', lead: l })} />
          ))}
        </ul>
      </Card>
    );

  return (
    <>
      <PageHeader title={t('leads.followUp.title')} subtitle={t('leads.followUp.subtitle')} />
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <StatCard label={t('leads.followUp.overdue')} value={q.data.overdue} icon={<AlarmClock className="h-5 w-5" />} tone="danger" />
        <StatCard label={t('leads.followUp.today')} value={q.data.dueToday} hint={t('leads.followUp.until', { time: fmtDateTime(new Date(new Date(q.data.dueBefore).getTime() - 60_000), tz) })} icon={<CalendarCheck2 className="h-5 w-5" />} tone="warning" />
      </div>
      {q.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={<PartyPopper className="h-5 w-5" />} title={t('leads.followUp.empty')} description={t('leads.followUp.emptyHint')} />
        </Card>
      ) : (
        <div className="space-y-4">
          {section(t('leads.followUp.overdue'), overdue, 'danger')}
          {section(t('leads.followUp.today'), today, 'warning')}
        </div>
      )}
      <LeadDialogs dialog={dialog} onClose={() => setDialog(null)} />
      {log && (
        <InteractionModal
          customerId={log.customerId}
          leads={[{ id: log.id, number: log.number, status: log.status }]}
          defaultLeadId={log.id}
          clearFollowUpDefault
          onClose={() => setLog(null)}
        />
      )}
    </>
  );
}
