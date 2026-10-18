import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Car, CircleCheck, CircleX, GripVertical, Phone, UserRound } from 'lucide-react';
import { DragEvent, ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/format';
import { useApi, useListParams } from '@/lib/hooks';
import { fmtPhone, useCrmMutation } from '@/features/customers/api';
import { Board, BoardColumn, cardVehicleLabel, Lead, LEAD_KEYS, LeadCard, useStageName } from './api';
import { ActionMenu, FollowUpText, LeadDialog, LeadDialogs, useLeadActions, useWonStage } from './components';
import { LeadCommonFilters, LeadViewSwitch, NewLeadButton } from './shared';

const PER_STAGE = 30;

function BudgetText({ min, max }: { min: string | null; max: string | null }) {
  const { currency } = useAuth();
  if (!min && !max) return null;
  return <span className="num">{min && max ? `${fmtMoney(min, currency)} – ${fmtMoney(max, currency)}` : fmtMoney(max ?? min, currency)}</span>;
}

function LeadCardView({ l, draggable, onDragStart, onDragEnd, menu }: { l: LeadCard; draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void; menu: ReactNode }) {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const vehicle = cardVehicleLabel(l, i18n.language);
  return (
    <li
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => navigate(`/app/leads/${l.id}`)}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/app/leads/${l.id}`)}
      tabIndex={0}
      data-lead={l.number}
      className={clsx(
        'group cursor-pointer rounded-xl border border-line bg-surface p-3 text-[13px] shadow-sm transition hover:border-line-strong hover:shadow-pop focus-visible:border-brand',
        draggable && 'active:cursor-grabbing',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{l.customerName}</p>
          <p className="num text-[11.5px] text-muted">{l.number}</p>
        </div>
        <div className="flex shrink-0 items-center">
          {draggable && <GripVertical className="h-4 w-4 text-subtle opacity-0 group-hover:opacity-100" aria-hidden />}
          {menu}
        </div>
      </div>
      <div className="mt-2 space-y-1 text-[12.5px] text-muted">
        {l.customerPhone && (
          <p className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span dir="ltr" className="num truncate">
              {fmtPhone(l.customerPhone)}
            </span>
          </p>
        )}
        {vehicle && (
          <p className="flex items-center gap-1.5">
            <Car className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{vehicle}</span>
          </p>
        )}
        {(l.budgetMin || l.budgetMax) && (
          <p className="text-ink">
            <BudgetText min={l.budgetMin} max={l.budgetMax} />
          </p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[12px]">
        <FollowUpText at={l.nextFollowUpAt} />
        <span className="inline-flex min-w-0 items-center gap-1 text-muted">
          <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{l.assigneeName ?? '—'}</span>
        </span>
      </div>
    </li>
  );
}

export function LeadsBoardPage() {
  const { t } = useTranslation();
  const { can, currency } = useAuth();
  const qc = useQueryClient();
  const name = useStageName();
  const lp = useListParams();
  const actions = useLeadActions();
  const won = useWonStage();
  const [dialog, setDialog] = useState<LeadDialog | null>(null);
  const [dragging, setDragging] = useState<LeadCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const canMove = can('leads.manage');
  const query = {
    perStage: PER_STAGE,
    branchId: lp.get('branchId') || undefined,
    source: lp.get('source') || undefined,
    assignedUserId: lp.get('assignedUserId') || undefined,
    mine: lp.get('mine') || undefined,
  };
  const q = useApi<Board>(['leads-board'], '/leads/board', query, { placeholderData: (p) => p });

  const move = useCrmMutation<{ id: string; stageId: string; version: number }, Lead>({
    path: (v) => `/leads/${v.id}/stage`,
    body: (v) => ({ stageId: v.stageId, version: v.version }),
    invalidate: LEAD_KEYS,
    success: (r) => t('leads.messages.moved', { stage: name(q.data?.columns.find((c) => c.stage.id === r.stageId)?.stage) }),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'version_conflict') void qc.invalidateQueries({ queryKey: ['leads-board'] });
      return false;
    },
  });

  const drop = (target: 'won' | 'lost' | BoardColumn) => {
    const l = dragging;
    setDragging(null);
    setOver(null);
    if (!l) return;
    if (target === 'lost') return setDialog({ kind: 'lost', lead: l });
    if (target === 'won') return won && setDialog({ kind: 'stage', lead: l, toStageId: won.id });
    if (target.stage.id === l.stageId) return;
    move.mutate({ id: l.id, stageId: target.stage.id, version: l.version });
  };
  const dropProps = (key: string, target: 'won' | 'lost' | BoardColumn) =>
    canMove
      ? {
          onDragOver: (e: DragEvent) => {
            if (!dragging) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (over !== key) setOver(key);
          },
          onDragLeave: (e: DragEvent) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((o) => (o === key ? null : o));
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            drop(target);
          },
        }
      : {};

  const totals = q.data?.totals;
  return (
    <>
      <PageHeader
        title={t('leads.board.title')}
        subtitle={totals ? t('leads.board.subtitle', { count: totals.count, total: fmtMoney(totals.budgetMaxTotal, currency) }) : t('leads.board.subtitleEmpty')}
        actions={
          <>
            <LeadViewSwitch />
            <NewLeadButton />
          </>
        }
      />
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <LeadCommonFilters lp={lp} />
          {move.isPending && <span className="text-xs text-muted">{t('leads.board.moving')}</span>}
        </div>
      </Card>

      {q.error ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !q.data ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-72 w-[280px] shrink-0 rounded-2xl" />
          ))}
        </div>
      ) : q.data.columns.length === 0 ? (
        <Card>
          <EmptyState title={t('leads.board.noStages')} />
        </Card>
      ) : (
        <>
          {canMove && <p className="mb-2 hidden text-xs text-muted md:block">{t('leads.board.dragHint')}</p>}
          <div className="scrollbar-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-3" aria-label={t('leads.board.title')}>
            {q.data.columns.map((col) => (
              <section
                key={col.stage.id}
                aria-label={name(col.stage)}
                data-stage={col.stage.code}
                {...dropProps(col.stage.id, col)}
                className={clsx(
                  'flex w-[280px] shrink-0 flex-col rounded-2xl border bg-surface-2/60 transition-colors',
                  over === col.stage.id ? 'border-brand bg-brand-soft/40' : 'border-line',
                )}
              >
                <header className="border-b border-line px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="truncate text-[13.5px] font-semibold text-ink">
                      {name(col.stage)}
                      {!col.stage.isActive && <span className="ms-1 text-xs font-normal text-muted">({t('common.inactive')})</span>}
                    </h2>
                    <span className="num rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-ink">{col.count}</span>
                  </div>
                  <p className="mt-0.5 flex items-center justify-between gap-2 text-[11.5px] text-muted">
                    <span className="num">{fmtMoney(col.budgetMaxTotal, currency)}</span>
                    <span className="num">{col.stage.probabilityPct}%</span>
                  </p>
                </header>
                <ul className="flex max-h-[62vh] min-h-[120px] flex-col gap-2 overflow-y-auto p-2">
                  {col.leads.map((l) => (
                    <LeadCardView
                      key={l.id}
                      l={l}
                      draggable={canMove}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', l.id);
                        setDragging(l);
                      }}
                      onDragEnd={() => (setDragging(null), setOver(null))}
                      menu={<ActionMenu label={t('common.actions')} actions={actions(l, setDialog)} />}
                    />
                  ))}
                  {col.leads.length === 0 && <li className="px-2 py-6 text-center text-xs text-subtle">{t('leads.board.emptyColumn')}</li>}
                </ul>
                {col.count > col.leads.length && (
                  <Link to={`/app/leads/list?status=open&stageId=${col.stage.id}`} className="border-t border-line px-3 py-2 text-center text-xs font-medium text-brand-strong hover:underline">
                    {t('leads.board.more', { count: col.count - col.leads.length })}
                  </Link>
                )}
              </section>
            ))}
            {canMove && dragging && (
              <div className="flex w-[200px] shrink-0 flex-col gap-3">
                {won && (
                  <div
                    {...dropProps('won', 'won')}
                    className={clsx(
                      'flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-4 text-center text-sm font-medium',
                      over === 'won' ? 'border-success bg-success-soft text-success' : 'border-success/40 text-success',
                    )}
                  >
                    <CircleCheck className="h-6 w-6" aria-hidden />
                    {t('leads.board.dropWon')}
                  </div>
                )}
                <div
                  {...dropProps('lost', 'lost')}
                  className={clsx(
                    'flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-4 text-center text-sm font-medium',
                    over === 'lost' ? 'border-danger bg-danger-soft text-danger' : 'border-danger/40 text-danger',
                  )}
                >
                  <CircleX className="h-6 w-6" aria-hidden />
                  {t('leads.board.dropLost')}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      <LeadDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}
