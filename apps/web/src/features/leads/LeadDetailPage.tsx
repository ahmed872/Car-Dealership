import clsx from 'clsx';
import { ArrowRight, ArrowRightLeft, CalendarClock, CircleCheck, CircleX, History, MessageSquarePlus, Pencil, RotateCcw, UserCog } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { PageHeader, Tabs } from '@/components/ui/Layout';
import { LOST_REASONS, type VehicleStatus } from '@autohub/shared';
import { useAuth } from '@/lib/auth';
import { VehicleStatusBadge } from '@/features/vehicles/components';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { InteractionModal, InteractionTimeline, PhoneText, useCanLogInteraction } from '@/features/customers/components';
import { LeadDetail, Stage, useLead, useStageName, useStages, vehicleLabel } from './api';
import { FollowUpText, LeadDialog, LeadDialogs, LeadEditModal, LeadStatusBadge, StageBadge, useWonStage } from './components';

type TabKey = 'overview' | 'history' | 'interactions' | 'reservations';

/** Horizontal progress through the open stages (won/lost shown as the final step). */
function PipelineProgress({ lead, stages }: { lead: LeadDetail; stages: Stage[] }) {
  const { t } = useTranslation();
  const name = useStageName();
  const open = stages.filter((s) => s.kind === 'open');
  const idx = open.findIndex((s) => s.id === lead.stageId);
  return (
    <ol className="scrollbar-thin flex items-center gap-1 overflow-x-auto pb-1" aria-label={t('leads.detail.progress')}>
      {open.map((s, i) => {
        const done = lead.status === 'won' || (idx >= 0 && i < idx);
        const current = s.id === lead.stageId;
        return (
          <li key={s.id} className="flex shrink-0 items-center gap-1" aria-current={current ? 'step' : undefined}>
            <span
              className={clsx(
                'rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap',
                current ? 'bg-brand text-brand-ink' : done ? 'bg-brand-soft text-brand-strong' : 'bg-surface-2 text-muted',
              )}
            >
              {name(s)}
            </span>
            <span aria-hidden className="h-px w-3 bg-line-strong" />
          </li>
        );
      })}
      <li className="shrink-0">
        <span
          className={clsx(
            'rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap',
            lead.status === 'won' ? 'bg-success text-white' : lead.status === 'lost' ? 'bg-danger text-white' : 'bg-surface-2 text-muted',
          )}
        >
          {lead.status === 'lost' ? t('leads.enums.status.lost') : t('leads.enums.status.won')}
        </span>
      </li>
    </ol>
  );
}

const LOST_REASON_SET = new Set<string>(LOST_REASONS);

/**
 * The API writes system notes on history rows in a fixed English form ("Assigned to X: note",
 * "<lost reason>: notes", "Sale confirmed", "Stage <code> deactivated"); show them translated,
 * keeping any free text the user typed. Unknown notes are shown as written.
 */
function useHistoryNote() {
  const { t } = useTranslation();
  return (h: LeadDetail['history'][number]): string[] => {
    const note = h.note;
    if (!note) return [];
    if (h.event === 'reassigned') {
      if (note === 'Unassigned') return [t('leads.historyNote.unassigned')];
      const m = /^Assigned to (.+?)(?:: ([\s\S]+))?$/.exec(note);
      if (m) return [t('leads.historyNote.assignedTo', { name: m[1] }), ...(m[2] ? [m[2]] : [])];
    }
    if (h.event === 'lost') {
      const m = /^([a-z_]+)(?:: ([\s\S]+))?$/.exec(note);
      if (m && LOST_REASON_SET.has(m[1]!)) return [t(`leads.enums.lostReason.${m[1]}`), ...(m[2] ? [m[2]] : [])];
    }
    if (note === 'Sale confirmed') return [t('leads.historyNote.saleConfirmed')];
    const st = /^Stage ([a-z0-9_]+) deactivated$/.exec(note);
    if (st) return [t('leads.historyNote.stageDeactivated', { code: st[1] })];
    return [note];
  };
}

function HistoryList({ lead }: { lead: LeadDetail }) {
  const { t } = useTranslation();
  const name = useStageName();
  const noteOf = useHistoryNote();
  const items = [...lead.history].reverse();
  return (
    <ol className="space-y-0 px-5 py-4">
      {items.map((h) => (
        <li key={h.id} className="relative border-s-2 border-line ps-6 pb-5 last:pb-0">
          <span
            className={clsx(
              'absolute -start-[7px] top-1 h-3 w-3 rounded-full border-2 border-surface',
              h.event === 'won' ? 'bg-success' : h.event === 'lost' ? 'bg-danger' : h.event === 'reassigned' ? 'bg-info' : 'bg-brand',
            )}
          />
          <p className="text-sm font-medium text-ink">{t(`leads.history.${h.event}`)}</p>
          {h.event !== 'reassigned' && (
            <p className="mt-0.5 text-[13px] text-muted">
              {h.fromStageId && h.event !== 'created' && (
                <>
                  {name({ nameEn: h.fromStageNameEn, nameAr: h.fromStageNameAr, code: h.fromStageCode })}
                  <ArrowRight className="mx-1 inline h-3 w-3 rtl:rotate-180" aria-hidden />
                </>
              )}
              <span className="text-ink">{name({ nameEn: h.toStageNameEn, nameAr: h.toStageNameAr, code: h.toStageCode })}</span>
            </p>
          )}
          {noteOf(h).map((line, i) => (
            <p key={i} className="mt-1 text-[13px] whitespace-pre-wrap text-ink">
              {line}
            </p>
          ))}
          <p className="mt-1 text-xs text-subtle">
            {fmtDateTime(h.changedAt)} · {h.changedByName ?? t('customers.system')}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function LeadDetailPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const { can, currency } = useAuth();
  const q = useLead(id);
  const stages = useStages(true);
  const won = useWonStage();
  const canLog = useCanLogInteraction();
  const [tab, setTab] = useState<TabKey>('overview');
  const [dialog, setDialog] = useState<LeadDialog | null>(null);
  const [edit, setEdit] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const l = q.data;
  const manage = can('leads.manage');
  const isOpen = l.status === 'open';
  const ref = { id: l.id, number: l.number, version: l.version, stageId: l.stageId, status: l.status, branchId: l.branchId, assignedUserId: l.assignedUserId };
  const stageForBadge = l.stage ?? { nameEn: null, nameAr: null, code: null, kind: l.status === 'open' ? 'open' : l.status };

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('nav.leads'), to: '/app/leads' }, { label: l.number }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="num">{l.number}</span>
            {l.customer && <span className="text-muted">· {l.customer.fullName}</span>}
          </span>
        }
        subtitle={
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <LeadStatusBadge status={l.status} />
            <StageBadge stage={stageForBadge} />
            <span className="text-muted">{t(`customers.enums.source.${l.source}`)}</span>
          </span>
        }
        actions={
          <>
            {canLog && l.customer && (
              <Button variant="secondary" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={() => setLogOpen(true)}>
                {t('customers.detail.logInteraction')}
              </Button>
            )}
            {manage && isOpen && (
              <>
                <Button variant="secondary" icon={<ArrowRightLeft className="h-4 w-4" />} onClick={() => setDialog({ kind: 'stage', lead: ref })}>
                  {t('leads.actions.moveStage')}
                </Button>
                {won && (
                  <Button variant="success" icon={<CircleCheck className="h-4 w-4" />} onClick={() => setDialog({ kind: 'stage', lead: ref, toStageId: won.id })}>
                    {t('leads.actions.markWon')}
                  </Button>
                )}
                <Button variant="danger" icon={<CircleX className="h-4 w-4" />} onClick={() => setDialog({ kind: 'lost', lead: ref })}>
                  {t('leads.actions.markLost')}
                </Button>
              </>
            )}
            {manage && !isOpen && !l.wonSaleId && (
              <Button icon={<RotateCcw className="h-4 w-4" />} onClick={() => setDialog({ kind: 'reopen', lead: ref })}>
                {t('leads.actions.reopen')}
              </Button>
            )}
          </>
        }
      />

      {stages.data && (
        <Card className="mb-4">
          <CardBody className="py-3">
            <PipelineProgress lead={l} stages={stages.data.filter((s) => s.isActive || s.id === l.stageId)} />
          </CardBody>
        </Card>
      )}

      {l.status === 'lost' && (
        <Alert tone="danger" className="mb-4" title={t('leads.detail.lostTitle', { reason: l.lostReason ? t(`leads.enums.lostReason.${l.lostReason}`) : '—' })}>
          {l.lostNotes}
          {l.closedAt && <span className="block text-xs">{fmtDateTime(l.closedAt)}</span>}
        </Alert>
      )}
      {l.status === 'won' && (
        <Alert tone="success" className="mb-4" title={t('leads.detail.wonTitle')}>
          {l.wonSaleId ? t('leads.detail.wonBySale') : null}
          {l.closedAt && <span className="block text-xs">{fmtDateTime(l.closedAt)}</span>}
        </Alert>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          <Tabs<TabKey>
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'overview', label: t('leads.detail.overview') },
              { key: 'history', label: t('leads.detail.history'), count: l.history.length },
              { key: 'interactions', label: t('leads.detail.interactions'), count: l.interactions.length },
              { key: 'reservations', label: t('leads.detail.reservations'), count: l.reservations.length },
            ]}
          />
          {tab === 'overview' && (
            <Card>
              <CardHeader
                title={t('leads.detail.details')}
                actions={
                  manage && isOpen ? (
                    <Button size="sm" variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>
                      {t('common.edit')}
                    </Button>
                  ) : undefined
                }
              />
              <CardBody>
                <DescriptionList
                  items={[
                    {
                      label: t('leads.fields.vehicle'),
                      value: l.vehicle ? (
                        <Link to={`/app/vehicles/${l.vehicle.id}`} className="text-brand-strong hover:underline">
                          {vehicleLabel(l.vehicle, i18n.language)} <span className="num text-xs text-muted">{l.vehicle.stockNumber}</span>
                        </Link>
                      ) : null,
                    },
                    { label: t('leads.fields.askingPrice'), value: l.vehicle?.askingPrice ? <span className="num">{fmtMoney(l.vehicle.askingPrice, currency)}</span> : null },
                    {
                      label: t('leads.fields.budget'),
                      value:
                        l.budgetMin || l.budgetMax ? (
                          <span className="num">
                            {l.budgetMin ? fmtMoney(l.budgetMin, currency) : '…'} – {l.budgetMax ? fmtMoney(l.budgetMax, currency) : '…'}
                          </span>
                        ) : null,
                    },
                    { label: t('leads.fields.paymentPreference'), value: l.paymentPreference ? t(`leads.enums.payment.${l.paymentPreference}`) : null },
                    { label: t('leads.fields.expectedCloseDate'), value: l.expectedCloseDate ? fmtDate(l.expectedCloseDate) : null },
                    { label: t('leads.fields.probability'), value: l.stage ? <span className="num">{l.stage.probabilityPct}%</span> : null },
                    { label: t('leads.fields.lastActivityAt'), value: l.lastActivityAt ? fmtDateTime(l.lastActivityAt) : null },
                    { label: t('common.createdAt'), value: fmtDateTime(l.createdAt) },
                    { label: t('leads.fields.interestNotes'), value: l.interestNotes ? <span className="whitespace-pre-wrap">{l.interestNotes}</span> : null, full: true },
                  ]}
                />
              </CardBody>
            </Card>
          )}
          {tab === 'history' && (
            <Card>
              <CardHeader title={t('leads.detail.history')} />
              {l.history.length ? <HistoryList lead={l} /> : <EmptyState icon={<History className="h-5 w-5" />} title={t('leads.detail.noHistory')} />}
            </Card>
          )}
          {tab === 'interactions' && (
            <Card>
              <CardHeader
                title={t('leads.detail.interactions')}
                actions={
                  canLog && l.customer ? (
                    <Button size="sm" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={() => setLogOpen(true)}>
                      {t('customers.detail.logInteraction')}
                    </Button>
                  ) : undefined
                }
              />
              {l.interactions.length ? (
                <InteractionTimeline items={l.interactions} showLead={false} />
              ) : (
                <EmptyState icon={<History className="h-5 w-5" />} title={t('customers.detail.noInteractions')} />
              )}
            </Card>
          )}
          {tab === 'reservations' && (
            <Card>
              <CardHeader title={t('leads.detail.reservations')} />
              <DataTable
                rows={l.reservations}
                rowKey={(r) => r.id}
                empty={<EmptyState title={t('customers.detail.noReservations')} />}
                columns={[
                  { key: 'number', header: t('customers.detail.reservationNo'), cell: (r) => <span className="num font-medium">{r.number}</span> },
                  {
                    key: 'vehicle',
                    header: t('leads.fields.vehicle'),
                    cell: (r) => (
                      <Link to={`/app/vehicles/${r.vehicleId}`} className="num text-brand-strong hover:underline">
                        {r.stockNumber}
                      </Link>
                    ),
                  },
                  { key: 'status', header: t('common.status'), cell: (r) => <Badge tone={r.status === 'active' ? 'info' : r.status === 'converted' ? 'success' : 'neutral'}>{t(`customers.enums.reservationStatus.${r.status}`)}</Badge> },
                  { key: 'deposit', header: t('customers.detail.deposit'), align: 'end', cell: (r) => <span className="num">{fmtMoney(r.depositAmount, currency)}</span> },
                  { key: 'expires', header: t('customers.detail.expiresAt'), hideOnMobile: true, cell: (r) => fmtDateTime(r.expiresAt) },
                ]}
              />
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          {l.customer && (
            <Card>
              <CardHeader
                title={t('leads.fields.customer')}
                actions={
                  <Link to={`/app/customers/${l.customer.id}`} className="text-[13px] font-medium text-brand-strong hover:underline">
                    {t('leads.detail.openCustomer')}
                  </Link>
                }
              />
              <CardBody>
                <DescriptionList
                  columns={1}
                  items={[
                    { label: t('common.name'), value: l.customer.companyName ? `${l.customer.fullName} — ${l.customer.companyName}` : l.customer.fullName },
                    { label: t('customers.fields.phone'), value: <PhoneText phone={l.customer.phone} /> },
                    { label: t('customers.fields.whatsapp'), value: <PhoneText phone={l.customer.whatsapp} /> },
                    { label: t('customers.fields.email'), value: l.customer.email ? <span dir="ltr">{l.customer.email}</span> : null },
                    { label: t('customers.fields.preferredLanguage'), value: l.customer.preferredLanguage === 'en' ? 'English' : 'العربية' },
                  ]}
                />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader
              title={t('leads.detail.followUp')}
              actions={
                manage && isOpen ? (
                  <Button size="sm" variant="secondary" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setDialog({ kind: 'followUp', lead: l })}>
                    {l.nextFollowUpAt ? t('leads.actions.reschedule') : t('leads.actions.setFollowUp')}
                  </Button>
                ) : undefined
              }
            />
            <CardBody>{isOpen ? <FollowUpText at={l.nextFollowUpAt} className="text-sm" /> : <span className="text-sm text-muted">{t('leads.detail.closedNoFollowUp')}</span>}</CardBody>
          </Card>
          <Card>
            <CardHeader
              title={t('leads.fields.assignee')}
              actions={
                can('leads.assign') ? (
                  <Button size="sm" variant="secondary" icon={<UserCog className="h-4 w-4" />} onClick={() => setDialog({ kind: 'assign', lead: ref })}>
                    {t('leads.actions.assign')}
                  </Button>
                ) : undefined
              }
            />
            <CardBody>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('leads.fields.assignee'), value: l.assignee?.fullName ?? <span className="text-subtle">{t('customers.unassigned')}</span> },
                  { label: t('leads.fields.source'), value: t(`customers.enums.source.${l.source}`) },
                  ...(l.vehicle ? [{ label: t('leads.detail.vehicleStatus'), value: <VehicleStatusBadge status={l.vehicle.status as VehicleStatus} /> }] : []),
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>

      <LeadDialogs dialog={dialog} onClose={() => setDialog(null)} />
      {edit && <LeadEditModal lead={l} onClose={() => setEdit(false)} />}
      {logOpen && l.customer && (
        <InteractionModal
          customerId={l.customer.id}
          leads={[{ id: l.id, number: l.number, status: l.status }]}
          defaultLeadId={l.id}
          onClose={() => setLogOpen(false)}
          invalidate={[['lead', l.id]]}
        />
      )}
    </>
  );
}
