import { Layers, Pencil, Plus, Power, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PIPELINE_STAGE_KINDS, PipelineStageKind } from '@autohub/shared';
import { Badge, Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { crmErrorMessage, fieldErrorsOf, Paged, useCrmMutation } from '@/features/customers/api';
import { LeadCard, Stage, useStageName, useStages } from './api';
import { HiddenLabel } from './components';

const KIND_TONE: Record<PipelineStageKind, Tone> = { open: 'brand', won: 'success', lost: 'danger' };
const STAGE_KEYS: unknown[][] = [['pipeline-stages'], ['leads-board'], ['leads'], ['lead']];

function StageFormModal({ stage, nextOrder, codes, onClose }: { stage: Stage | null; nextOrder: number; codes: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState(stage?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(stage?.nameEn ?? '');
  const [sortOrder, setSortOrder] = useState(String(stage?.sortOrder ?? nextOrder));
  const [kind, setKind] = useState<PipelineStageKind>(stage?.kind ?? 'open');
  const [prob, setProb] = useState(String(stage?.probabilityPct ?? 10));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const onError = (err: unknown) => {
    const fe = fieldErrorsOf(err, t);
    if (err instanceof ApiError && err.code === 'stage_code_taken') fe.code = crmErrorMessage(err, t);
    setErrors(fe);
    return Object.keys(fe).length > 0;
  };
  const create = useCrmMutation<Record<string, unknown>, Stage>({ path: '/pipeline-stages', invalidate: STAGE_KEYS, success: t('leads.stages.created'), onSuccess: onClose, onError });
  const update = useCrmMutation<Record<string, unknown>, Stage>({ path: `/pipeline-stages/${stage?.id}`, method: 'PATCH', invalidate: STAGE_KEYS, success: t('leads.stages.updated'), onSuccess: onClose, onError });
  const submit = () => {
    const e: Record<string, string> = {};
    if (!stage && !/^[a-z][a-z0-9_]{1,39}$/.test(code.trim())) e.code = t('customers.errors.invalid_code');
    else if (!stage && codes.includes(code.trim())) e.code = t('customers.errors.stage_code_taken');
    if (!nameAr.trim()) e.nameAr = t('errors.required');
    if (!nameEn.trim()) e.nameEn = t('errors.required');
    const order = Number(sortOrder);
    if (!/^\d+$/.test(sortOrder.trim()) || order > 10000) e.sortOrder = t('leads.stages.invalidOrder');
    const p = Number(prob);
    if (kind === 'open' && (!/^\d+$/.test(prob.trim()) || p > 100)) e.probabilityPct = t('leads.stages.invalidProbability');
    setErrors(e);
    if (Object.keys(e).length) return;
    if (!stage) {
      create.mutate({ code: code.trim(), nameAr: nameAr.trim(), nameEn: nameEn.trim(), sortOrder: order, kind, ...(kind === 'open' ? { probabilityPct: p } : {}) });
      return;
    }
    const body: Record<string, unknown> = {};
    if (nameAr.trim() !== stage.nameAr) body.nameAr = nameAr.trim();
    if (nameEn.trim() !== stage.nameEn) body.nameEn = nameEn.trim();
    if (order !== stage.sortOrder) body.sortOrder = order;
    if (stage.kind === 'open' && p !== stage.probabilityPct) body.probabilityPct = p;
    if (!Object.keys(body).length) return onClose();
    update.mutate(body);
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={stage ? t('leads.stages.editTitle') : t('leads.stages.addTitle')}
      description={stage?.isDefault ? t('leads.stages.defaultHint') : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={create.isPending || update.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('leads.stages.nameAr')} required error={errors.nameAr}>
          {(id) => <Input id={id} dir="rtl" maxLength={80} value={nameAr} onChange={(e) => setNameAr(e.target.value)} invalid={!!errors.nameAr} />}
        </Field>
        <Field label={t('leads.stages.nameEn')} required error={errors.nameEn}>
          {(id) => <Input id={id} dir="ltr" maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} invalid={!!errors.nameEn} />}
        </Field>
        {stage ? (
          <Field label={t('common.code')} hint={t('leads.stages.codeFixed')}>
            {(id, dsc) => <Input id={id} aria-describedby={dsc} dir="ltr" className="num" value={stage.code} disabled readOnly />}
          </Field>
        ) : (
          <Field label={t('common.code')} required error={errors.code} hint={t('leads.stages.codeHint')}>
            {(id, dsc) => <Input id={id} aria-describedby={dsc} dir="ltr" className="num" maxLength={40} value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} invalid={!!errors.code} />}
          </Field>
        )}
        <Field label={t('leads.stages.kind')} hint={stage ? t('leads.stages.kindFixed') : t('leads.stages.kindHint')}>
          {(id, dsc) => (
            <Select id={id} aria-describedby={dsc} value={kind} onChange={(e) => setKind(e.target.value as PipelineStageKind)} disabled={!!stage}>
              {PIPELINE_STAGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`leads.stages.kinds.${k}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('leads.stages.sortOrder')} required error={errors.sortOrder} hint={t('leads.stages.sortOrderHint')}>
          {(id, dsc) => <Input id={id} aria-describedby={dsc} inputMode="numeric" dir="ltr" className="num" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} invalid={!!errors.sortOrder} />}
        </Field>
        <Field label={t('leads.fields.probability')} required={kind === 'open'} error={errors.probabilityPct} hint={kind !== 'open' ? t('leads.stages.probabilityFixed') : undefined}>
          {(id, dsc) => (
            <Input
              id={id}
              aria-describedby={dsc}
              inputMode="numeric"
              dir="ltr"
              className="num"
              value={kind === 'open' ? prob : kind === 'won' ? '100' : '0'}
              onChange={(e) => setProb(e.target.value)}
              disabled={kind !== 'open'}
              invalid={!!errors.probabilityPct}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

function DeactivateModal({ stage, stages, onClose }: { stage: Stage; stages: Stage[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const name = useStageName();
  const [moveTo, setMoveTo] = useState('');
  const [inUse, setInUse] = useState<number | null>(null);
  // Open leads still in the stage must be moved; count them up front (the API re-checks and
  // answers stage_in_use when the count changed or is outside the caller's lead scope).
  const openQ = useApi<Paged<LeadCard>>(['leads', 'stage-open', stage.id], stage.kind === 'open' && can('leads.read') ? '/leads' : null, {
    stageId: stage.id,
    status: 'open',
    pageSize: 1,
  });
  const openLeads = inUse ?? (openQ.data ? openQ.data.total : null);
  const mustMove = (openLeads ?? 0) > 0;
  const targets = stages.filter((s) => s.kind === 'open' && s.isActive && s.id !== stage.id);
  const m = useCrmMutation<{ moveToStageId?: string }, Stage & { movedLeads: number }>({
    path: `/pipeline-stages/${stage.id}/deactivate`,
    invalidate: STAGE_KEYS,
    success: (r) => (r.movedLeads ? t('leads.stages.deactivatedMoved', { count: r.movedLeads }) : t('leads.stages.deactivated')),
    onSuccess: onClose,
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'stage_in_use') {
        setInUse(Number(err.details?.openLeads ?? 0));
        return true;
      }
      return false;
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('leads.stages.deactivateTitle')}
      description={name(stage)}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={m.isPending} disabled={openQ.isLoading || (mustMove && !moveTo)} onClick={() => m.mutate(moveTo ? { moveToStageId: moveTo } : {})}>
            {t('leads.stages.deactivate')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('leads.stages.deactivateMessage')}</p>
        {mustMove && <Alert tone="warning">{t('customers.errors.stage_in_use', { openLeads })}</Alert>}
        {stage.kind === 'open' && (
          <Field label={t('leads.stages.moveTo')} required={mustMove} hint={t('leads.stages.moveToHint')}>
            {(id, dsc) => (
              <Select id={id} aria-describedby={dsc} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} invalid={mustMove && !moveTo}>
                <option value="">{mustMove ? t('leads.placeholders.chooseStage') : t('leads.stages.noMove')}</option>
                {targets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {name(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** Settings → sales pipeline stages (settings.manage). Defaults are customised copy-on-write by the API. */
export function PipelineStagesPage() {
  const { t } = useTranslation();
  const q = useStages(true);
  const [form, setForm] = useState<{ stage: Stage | null } | null>(null);
  const [deactivate, setDeactivate] = useState<Stage | null>(null);
  const activate = useCrmMutation<{ id: string }, Stage>({
    path: (v) => `/pipeline-stages/${v.id}/activate`,
    body: () => ({}),
    invalidate: STAGE_KEYS,
    success: t('leads.stages.activated'),
  });
  const stages = q.data ?? [];
  const StageActions = ({ s }: { s: Stage }) => (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setForm({ stage: s })} aria-label={t('common.edit')}>
        <span className="hidden sm:inline">{t('common.edit')}</span>
      </Button>
      {s.isActive ? (
        <Button size="sm" variant="ghost" className="text-danger" icon={<Power className="h-4 w-4" />} onClick={() => setDeactivate(s)} aria-label={t('leads.stages.deactivate')}>
          <span className="hidden sm:inline">{t('leads.stages.deactivate')}</span>
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="text-success"
          icon={<RotateCcw className="h-4 w-4" />}
          loading={activate.isPending && activate.variables?.id === s.id}
          onClick={() => activate.mutate({ id: s.id })}
          aria-label={t('leads.stages.activate')}
        >
          <span className="hidden sm:inline">{t('leads.stages.activate')}</span>
        </Button>
      )}
    </span>
  );
  const nextOrder = Math.min(10000, stages.filter((s) => s.kind === 'open').reduce((m, s) => Math.max(m, s.sortOrder), 0) + 10);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('nav.settings') }, { label: t('leads.stages.title') }]}
        title={t('leads.stages.title')}
        subtitle={t('leads.stages.subtitle')}
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ stage: null })}>
            {t('leads.stages.add')}
          </Button>
        }
      />
      <Card>
        <CardHeader title={t('leads.stages.listTitle')} subtitle={t('leads.stages.listHint')} />
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(s) => s.id}
          empty={<EmptyState icon={<Layers className="h-5 w-5" />} title={t('leads.board.noStages')} />}
          columns={[
            { key: 'order', header: t('leads.stages.sortOrder'), hideOnMobile: true, cell: (s) => <span className="num text-muted">{s.sortOrder}</span> },
            {
              key: 'name',
              header: t('common.name'),
              cell: (s) => (
                <div>
                  <p className="font-medium">{s.nameAr}</p>
                  <p className="text-xs text-muted">
                    <bdi>{s.nameEn}</bdi>
                  </p>
                  {/* On phones the kind, status and action columns are hidden; keep the essentials here. */}
                  <div className="mt-1 flex flex-wrap items-center gap-1 md:hidden">
                    <Badge tone={KIND_TONE[s.kind]}>{t(`leads.stages.kinds.${s.kind}`)}</Badge>
                    <span className="num text-xs text-muted">{s.probabilityPct}%</span>
                    {!s.isActive && <Badge tone="neutral">{t('common.inactive')}</Badge>}
                    <StageActions s={s} />
                  </div>
                </div>
              ),
            },
            { key: 'code', header: t('common.code'), hideOnMobile: true, cell: (s) => <span className="num text-xs text-muted">{s.code}</span> },
            { key: 'kind', header: t('leads.stages.kind'), hideOnMobile: true, cell: (s) => <Badge tone={KIND_TONE[s.kind]}>{t(`leads.stages.kinds.${s.kind}`)}</Badge> },
            { key: 'prob', header: t('leads.fields.probability'), align: 'center', hideOnMobile: true, cell: (s) => <span className="num">{s.probabilityPct}%</span> },
            {
              key: 'status',
              header: t('common.status'),
              hideOnMobile: true,
              cell: (s) => (
                <span className="flex flex-wrap gap-1">
                  <Badge tone={s.isActive ? 'success' : 'neutral'}>{s.isActive ? t('common.active') : t('common.inactive')}</Badge>
                  {s.isDefault && (
                    <Badge tone="neutral" dot={false}>
                      {t('leads.stages.default')}
                    </Badge>
                  )}
                </span>
              ),
            },
            {
              key: 'actions',
              header: <HiddenLabel>{t('common.actions')}</HiddenLabel>,
              align: 'end',
              hideOnMobile: true,
              cell: (s) => <StageActions s={s} />,
            },
          ]}
        />
      </Card>
      {form && <StageFormModal stage={form.stage} nextOrder={nextOrder} codes={stages.map((s) => s.code)} onClose={() => setForm(null)} />}
      {deactivate && <DeactivateModal stage={deactivate} stages={stages} onClose={() => setDeactivate(null)} />}
    </>
  );
}
