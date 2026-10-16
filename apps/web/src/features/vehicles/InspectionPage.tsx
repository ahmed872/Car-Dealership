import clsx from 'clsx';
import { CheckCircle2, ImagePlus, Save, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PANEL_CONDITIONS, PanelCode, PanelCondition, SEVERITIES } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, ErrorState, errorMessage, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useApi, useApiMutation } from '@/lib/hooks';
import { fileUrl } from './api';
import { CarDiagram, PanelLegend } from './components';

interface Item {
  sectionKey: string;
  itemKey: string;
  labelEn: string;
  labelAr: string;
  result: 'ok' | 'attention' | 'fail' | 'na' | 'not_checked';
  severity: string;
  measuredValue: string | null;
  measuredUnit: string | null;
  measuredText: string | null;
  isMeasured: boolean;
  notes: string | null;
}
interface Panel {
  panelCode: PanelCode;
  condition: PanelCondition;
  paintThicknessMicrons: number | null;
  notes: string | null;
}
interface Inspection {
  id: string;
  vehicleId: string;
  versionNo: number;
  type: string;
  status: 'draft' | 'completed' | 'cancelled';
  inspectorName: string | null;
  startedAt: string;
  completedAt: string | null;
  odometerValue: number | null;
  odometerUnit: string | null;
  overallResult: string | null;
  summary: string | null;
  recommendations: string | null;
  accidentHistory: string | null;
  templateSnapshot: { name: string; sections: Array<{ key: string; en: string; ar: string; items: Array<{ key: string; required: boolean; unit?: string }> }> };
  items: Item[];
  panels: Panel[];
  media: Array<{ id: string; fileId: string; itemKey: string | null; panelCode: string | null; caption: string | null }>;
}

const RESULT_STYLE: Record<string, string> = {
  ok: 'bg-success text-white border-success',
  attention: 'bg-warning text-white border-warning',
  fail: 'bg-danger text-white border-danger',
  na: 'bg-surface-3 text-ink border-line-strong',
};

export function InspectionPage() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useApi<Inspection>(['inspection', id], `/inspections/${id}`);
  const [items, setItems] = useState<Item[]>([]);
  const [panels, setPanels] = useState<Record<string, Panel>>({});
  const [header, setHeader] = useState({ overallResult: '', odometerValue: '', odometerUnit: 'km', summary: '', recommendations: '', accidentHistory: '' });
  const [selected, setSelected] = useState<PanelCode | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<'complete' | 'cancel' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const lang = i18n.language;

  useEffect(() => {
    if (!q.data) return;
    setItems(q.data.items);
    setPanels(Object.fromEntries(q.data.panels.map((p) => [p.panelCode, p])));
    setHeader({
      overallResult: q.data.overallResult ?? '',
      odometerValue: q.data.odometerValue?.toString() ?? '',
      odometerUnit: q.data.odometerUnit ?? 'km',
      summary: q.data.summary ?? '',
      recommendations: q.data.recommendations ?? '',
      accidentHistory: q.data.accidentHistory ?? '',
    });
    setDirty(false);
  }, [q.data]);

  const required = useMemo(() => {
    const set = new Set<string>();
    q.data?.templateSnapshot.sections.forEach((s) => s.items.forEach((i) => i.required && set.add(`${s.key}.${i.key}`)));
    return set;
  }, [q.data]);
  const missing = items.filter((i) => required.has(`${i.sectionKey}.${i.itemKey}`) && i.result === 'not_checked').length;
  const done = items.filter((i) => i.result !== 'not_checked').length;
  const readOnly = !q.data || q.data.status !== 'draft' || !can('inspections.perform');

  const payload = () => ({
    items: items.map((i) => ({
      sectionKey: i.sectionKey,
      itemKey: i.itemKey,
      result: i.result,
      severity: i.severity || 'none',
      measuredValue: i.measuredValue || null,
      measuredUnit: i.measuredUnit,
      measuredText: i.measuredText || null,
      isMeasured: !!i.measuredValue && i.isMeasured,
      notes: i.notes || null,
    })),
    panels: Object.values(panels).map((p) => ({ panelCode: p.panelCode, condition: p.condition, paintThicknessMicrons: p.paintThicknessMicrons, notes: p.notes || null })),
    overallResult: header.overallResult || null,
    odometerValue: header.odometerValue ? Number(header.odometerValue) : null,
    odometerUnit: header.odometerUnit,
    summary: header.summary || null,
    recommendations: header.recommendations || null,
    accidentHistory: header.accidentHistory || null,
  });
  const save = useApiMutation<Record<string, unknown>>({ path: `/inspections/${id}`, method: 'PUT', body: () => payload(), invalidate: [['inspection', id]], onSuccess: () => setDirty(false) });
  const complete = async () => {
    try {
      await api(`/inspections/${id}`, { method: 'PUT', body: payload() });
      await api(`/inspections/${id}/complete`, { method: 'POST' });
      toast.success(t('common.savedSuccessfully'));
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: ['inspection', id] });
      await qc.invalidateQueries({ queryKey: ['vehicle', q.data?.vehicleId] });
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };
  const cancel = useApiMutation<{ reason: string }>({
    path: `/inspections/${id}/cancel`,
    invalidate: [['inspection', id]],
    onSuccess: () => navigate(`/app/vehicles/${q.data?.vehicleId}`),
  });

  const updateItem = (key: string, patch: Partial<Item>) => {
    setItems((xs) => xs.map((x) => (`${x.sectionKey}.${x.itemKey}` === key ? { ...x, ...patch } : x)));
    setDirty(true);
  };
  const updatePanel = (code: PanelCode, patch: Partial<Panel>) => {
    setPanels((ps) => ({ ...ps, [code]: { ...ps[code]!, ...patch } }));
    setDirty(true);
  };
  const uploadEvidence = async (files: FileList) => {
    setUploading(true);
    for (const f of Array.from(files)) {
      const fd = new FormData();
      if (selected) fd.append('panelCode', selected);
      fd.append('file', f);
      try {
        await api(`/inspections/${id}/media`, { method: 'POST', form: fd });
      } catch (e) {
        toast.error(errorMessage(e, t));
      }
    }
    setUploading(false);
    await qc.invalidateQueries({ queryKey: ['inspection', id] });
  };

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const insp = q.data;
  const sel = selected ? panels[selected] : null;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: t('nav.vehicles'), to: '/app/vehicles' },
          { label: t('vehicles.tabs.overview'), to: `/app/vehicles/${insp.vehicleId}` },
          { label: t('vehicles.inspections.version', { n: insp.versionNo }) },
        ]}
        title={`${t('vehicles.inspections.title')} — ${t('vehicles.inspections.version', { n: insp.versionNo })}`}
        subtitle={`${t(`vehicles.enums.inspectionType.${insp.type}`)} · ${insp.templateSnapshot.name} · ${insp.inspectorName ?? ''} · ${fmtDateTime(insp.completedAt ?? insp.startedAt)}`}
        actions={
          !readOnly && (
            <>
              <Button variant="ghost" icon={<XCircle className="h-4 w-4" />} onClick={() => setConfirm('cancel')}>
                {t('vehicles.inspections.cancel')}
              </Button>
              <Button variant="secondary" icon={<Save className="h-4 w-4" />} loading={save.isPending} disabled={!dirty} onClick={() => save.mutate({})}>
                {t('vehicles.inspections.saveDraft')}
              </Button>
              <Button icon={<ShieldCheck className="h-4 w-4" />} disabled={missing > 0 || !header.overallResult} onClick={() => setConfirm('complete')}>
                {t('vehicles.inspections.complete')}
              </Button>
            </>
          )
        }
      />
      <div className="mb-4 space-y-3">
        {insp.status !== 'draft' && (
          <Alert tone={insp.status === 'completed' ? 'success' : 'warning'} title={t(`vehicles.enums.inspectionStatus.${insp.status}`)}>
            {t('vehicles.inspections.readOnly')}
          </Alert>
        )}
        <Alert tone="info">{t('vehicles.inspections.disclaimer')}</Alert>
      </div>

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <div className="space-y-5 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader title={t('vehicles.inspections.bodyDiagram')} subtitle={!readOnly ? t('vehicles.inspections.bodyHint') : undefined} />
            <CardBody className="space-y-4">
              <CarDiagram panels={Object.fromEntries(Object.values(panels).map((p) => [p.panelCode, p.condition]))} selected={selected} onSelect={setSelected} />
              <PanelLegend />
              {sel && (
                <div className="animate-in space-y-3 rounded-xl border border-line bg-surface-2/60 p-3">
                  <p className="text-sm font-semibold">{t(`vehicles.enums.panel.${sel.panelCode}`)}</p>
                  <Select value={sel.condition} disabled={readOnly} onChange={(e) => updatePanel(sel.panelCode, { condition: e.target.value as PanelCondition })} aria-label={t('common.status')}>
                    {PANEL_CONDITIONS.map((c) => (
                      <option key={c} value={c}>
                        {t(`vehicles.enums.panelCondition.${c}`)}
                      </option>
                    ))}
                  </Select>
                  <Field label={t('vehicles.inspections.paintThickness')}>
                    {(fid) => (
                      <Input
                        id={fid}
                        type="number"
                        className="num"
                        disabled={readOnly}
                        value={sel.paintThicknessMicrons ?? ''}
                        onChange={(e) => updatePanel(sel.panelCode, { paintThicknessMicrons: e.target.value ? Number(e.target.value) : null })}
                      />
                    )}
                  </Field>
                  <Textarea rows={2} disabled={readOnly} placeholder={t('common.notes')} value={sel.notes ?? ''} onChange={(e) => updatePanel(sel.panelCode, { notes: e.target.value })} />
                </div>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title={t('vehicles.inspections.evidence')}
              actions={
                !readOnly && (
                  <>
                    <Button size="sm" variant="secondary" loading={uploading} icon={<ImagePlus className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>
                      {t('vehicles.inspections.addEvidence')}
                    </Button>
                    <input ref={fileRef} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,video/mp4" onChange={(e) => e.target.files && void uploadEvidence(e.target.files)} />
                  </>
                )
              }
            />
            <CardBody>
              {insp.media.length === 0 ? (
                <p className="text-sm text-muted">{t('common.noData')}</p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {insp.media.map((m) => (
                    <a key={m.id} href={fileUrl(m.fileId)} target="_blank" rel="noopener noreferrer" className="group relative block aspect-square overflow-hidden rounded-lg bg-surface-2">
                      <img src={fileUrl(m.fileId)} alt={m.caption ?? ''} className="h-full w-full object-cover" loading="lazy" />
                      {m.panelCode && <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[10px] text-white">{t(`vehicles.enums.panel.${m.panelCode}`)}</span>}
                    </a>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <div className="flex flex-wrap items-center gap-4 px-5 py-3 text-sm">
              <span className="num font-medium">{t('vehicles.inspections.progress', { done, total: items.length })}</span>
              <div className="h-2 min-w-[120px] flex-1 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full bg-brand transition-all" style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
              </div>
              {missing > 0 ? <Badge tone="warning">{t('vehicles.inspections.requiredMissing', { count: missing })}</Badge> : <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />}
            </div>
          </Card>
          {insp.templateSnapshot.sections.map((section) => (
            <Card key={section.key}>
              <CardHeader title={lang === 'en' ? section.en : section.ar} />
              <ul className="divide-y divide-line">
                {items
                  .filter((i) => i.sectionKey === section.key)
                  .map((it) => {
                    const key = `${it.sectionKey}.${it.itemKey}`;
                    const isReq = required.has(key);
                    const problem = it.result === 'attention' || it.result === 'fail';
                    return (
                      <li key={key} className="space-y-2 px-5 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm font-medium">
                            {lang === 'en' ? it.labelEn : it.labelAr}
                            {isReq && <span className="ms-1 text-danger" aria-hidden>*</span>}
                          </p>
                          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={lang === 'en' ? it.labelEn : it.labelAr}>
                            {(['ok', 'attention', 'fail', 'na'] as const).map((r) => (
                              <button
                                key={r}
                                type="button"
                                role="radio"
                                aria-checked={it.result === r}
                                disabled={readOnly}
                                onClick={() => updateItem(key, { result: r, severity: r === 'ok' || r === 'na' ? 'none' : it.severity === 'none' ? 'medium' : it.severity })}
                                className={clsx(
                                  'rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:cursor-default',
                                  it.result === r ? RESULT_STYLE[r] : 'border-line text-muted hover:border-line-strong',
                                )}
                              >
                                {t(`vehicles.enums.inspectionResult.${r}`)}
                              </button>
                            ))}
                          </div>
                        </div>
                        {(it.measuredUnit || problem || it.notes) && (
                          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr]">
                            {it.measuredUnit && (
                              <div className="flex items-center gap-2">
                                <Input
                                  aria-label={t('vehicles.inspections.measurement')}
                                  className="num"
                                  inputMode="decimal"
                                  dir="ltr"
                                  disabled={readOnly}
                                  value={it.measuredValue ?? ''}
                                  placeholder={it.measuredUnit}
                                  onChange={(e) => updateItem(key, { measuredValue: e.target.value || null })}
                                />
                                <span className="text-xs text-muted">{it.measuredUnit}</span>
                              </div>
                            )}
                            {it.measuredUnit && (
                              <Checkbox
                                label={it.isMeasured ? t('vehicles.inspections.measured') : t('vehicles.inspections.estimated')}
                                disabled={readOnly || !it.measuredValue}
                                checked={it.isMeasured}
                                onChange={(e) => updateItem(key, { isMeasured: e.target.checked })}
                              />
                            )}
                            {problem && (
                              <Select disabled={readOnly} value={it.severity} onChange={(e) => updateItem(key, { severity: e.target.value })} aria-label="severity">
                                {SEVERITIES.filter((s) => s !== 'none').map((s) => (
                                  <option key={s} value={s}>
                                    {t(`vehicles.enums.severity.${s}`)}
                                  </option>
                                ))}
                              </Select>
                            )}
                            {(problem || it.notes) && (
                              <Input
                                className={clsx(!it.measuredUnit && 'sm:col-span-2')}
                                disabled={readOnly}
                                placeholder={t('common.notes')}
                                value={it.notes ?? ''}
                                onChange={(e) => updateItem(key, { notes: e.target.value })}
                              />
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </Card>
          ))}
          <Card>
            <CardHeader title={t('vehicles.inspections.overall')} />
            <CardBody className="grid gap-4 sm:grid-cols-3">
              <Field label={t('vehicles.inspections.result')} required>
                {(fid) => (
                  <Select id={fid} disabled={readOnly} value={header.overallResult} onChange={(e) => (setHeader({ ...header, overallResult: e.target.value }), setDirty(true))}>
                    <option value="">—</option>
                    {(['pass', 'pass_with_notes', 'fail'] as const).map((r) => (
                      <option key={r} value={r}>
                        {t(`vehicles.enums.overall.${r}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('vehicles.odometer')} required>
                {(fid) => (
                  <Input id={fid} type="number" className="num" disabled={readOnly} value={header.odometerValue} onChange={(e) => (setHeader({ ...header, odometerValue: e.target.value }), setDirty(true))} />
                )}
              </Field>
              <Field label={t('vehicles.odometerUnit')}>
                {(fid) => (
                  <Select id={fid} disabled={readOnly} value={header.odometerUnit} onChange={(e) => (setHeader({ ...header, odometerUnit: e.target.value }), setDirty(true))}>
                    <option value="km">km</option>
                    <option value="mi">mi</option>
                  </Select>
                )}
              </Field>
              {(['summary', 'recommendations', 'accidentHistory'] as const).map((k) => (
                <Field key={k} label={t(`vehicles.inspections.${k}`)} className="sm:col-span-3">
                  {(fid) => <Textarea id={fid} rows={2} disabled={readOnly} value={header[k]} onChange={(e) => (setHeader({ ...header, [k]: e.target.value }), setDirty(true))} />}
                </Field>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={confirm === 'complete'}
        onClose={() => setConfirm(null)}
        onConfirm={complete}
        title={t('vehicles.inspections.complete')}
        message={t('vehicles.inspections.completeConfirm')}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => cancel.mutate({ reason })}
        title={t('vehicles.inspections.cancel')}
        requireReason
        tone="danger"
        loading={cancel.isPending}
      />
    </>
  );
}
