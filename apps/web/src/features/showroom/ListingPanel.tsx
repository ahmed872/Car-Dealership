import { useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, EyeOff, Send, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { VehicleDetail } from '@/features/vehicles/api';
import { ApiError, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { GeneratedDescription, ListingState, listingKey, useListing, useShowroomError, useShowroomMutation } from './api';
import { CopyButton, DescriptionSourceBadge, fallbackReasonText, PublishedBadge, VisibilityBadge, visibilityReason } from './components';
import { PriceGuidanceCard } from './PriceGuidanceCard';

interface Values {
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
}
const FIELDS: Array<keyof Values> = ['titleAr', 'titleEn', 'descriptionAr', 'descriptionEn'];

const toValues = (l: ListingState['listing']): Values => ({
  titleAr: l?.titleAr ?? '',
  titleEn: l?.titleEn ?? '',
  descriptionAr: l?.descriptionAr ?? '',
  descriptionEn: l?.descriptionEn ?? '',
});
const same = (a: Values, b: Values) => FIELDS.every((k) => a[k] === b[k]);

/** A generated suggestion moved into the form; its source is kept only if saved unchanged. */
interface Applied {
  ar: string;
  en: string;
  source: 'ai' | 'template';
}

function SuggestionModal({
  result,
  onClose,
  onUse,
}: {
  result: GeneratedDescription;
  onClose: () => void;
  onUse: (ar: string, en: string) => void;
}) {
  const { t } = useTranslation();
  const [ar, setAr] = useState(result.suggestion.descriptionAr);
  const [en, setEn] = useState(result.suggestion.descriptionEn);
  const g = result.generation;
  const fallback = fallbackReasonText(g.fallbackReason, t);
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('showroom.generate.title')}
      description={t('showroom.generate.intro')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => onUse(ar, en)} disabled={!ar.trim() && !en.trim()}>
            {t('showroom.generate.use')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={g.source === 'ai' ? 'accent' : 'neutral'}>
            {g.source === 'ai' ? t('showroom.generate.sourceAi', { model: g.model ?? '—' }) : t('showroom.generate.sourceTemplate')}
          </Badge>
        </div>
        {fallback && <Alert tone="info">{fallback}</Alert>}
        {g.source === 'ai' && <Alert tone="warning">{t('showroom.generate.aiReview')}</Alert>}
        <Field label={t('showroom.editor.descriptionAr')}>
          {(id) => <Textarea id={id} dir="rtl" lang="ar" rows={5} maxLength={4000} value={ar} onChange={(e) => setAr(e.target.value)} />}
        </Field>
        <Field label={t('showroom.editor.descriptionEn')}>
          {(id) => <Textarea id={id} dir="ltr" lang="en" rows={5} maxLength={4000} value={en} onChange={(e) => setEn(e.target.value)} />}
        </Field>
        <p className="text-xs text-muted">{t('showroom.generate.replaceWarning')}</p>
      </div>
    </Modal>
  );
}

/** Vehicle 360 → Showroom listing: content, generation, publishing, sharing and price guidance. */
export function ListingPanel({ d }: { d: VehicleDetail }) {
  const { t, i18n } = useTranslation();
  const { can, me, currency } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const describe = useShowroomError();
  const vehicleId = d.vehicle.id;
  const q = useListing(vehicleId);
  const manage = can('showroom.manage');
  const showroom = me?.tenant?.settings.showroom;

  // `values` stays null until the user edits, so the form follows the server until then.
  const base = useMemo(() => toValues(q.data?.listing ?? null), [q.data]);
  const [values, setValues] = useState<Values | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [suggestion, setSuggestion] = useState<GeneratedDescription | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const current = values ?? base;
  const dirty = values !== null && !same(values, base);

  const accept = (res: ListingState) => {
    // useApi appends the query to the key, so match by prefix.
    qc.setQueriesData({ queryKey: listingKey(vehicleId) }, res);
    void qc.invalidateQueries({ queryKey: ['showroom', 'listings'] });
  };

  const save = useShowroomMutation<Record<string, unknown>, ListingState>({
    path: `/vehicles/${vehicleId}/listing`,
    method: 'PUT',
    success: t('showroom.editor.saved'),
    onSuccess: (res) => {
      accept(res);
      setValues(null);
      setApplied(null);
      setConflict(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'version_conflict') {
        setConflict(true);
        void q.refetch();
      }
    },
  });
  const publish = useShowroomMutation<Record<string, never>, ListingState>({
    path: `/vehicles/${vehicleId}/listing/publish`,
    success: t('showroom.actions.published'),
    onSuccess: accept,
  });
  const unpublish = useShowroomMutation<Record<string, never>, ListingState>({
    path: `/vehicles/${vehicleId}/listing/unpublish`,
    success: t('showroom.actions.unpublished'),
    onSuccess: (res) => {
      accept(res);
      setConfirmUnpublish(false);
    },
  });
  const generate = useShowroomMutation<Record<string, never>, GeneratedDescription>({
    path: `/vehicles/${vehicleId}/listing/generate-description`,
    success: null,
    onSuccess: (res) => setSuggestion(res),
  });

  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  const l = s.listing;
  const lang = i18n.language;
  // The WhatsApp chat text follows the viewer's language (the API builds both).
  const whatsappUrl = s.links ? (s.links.whatsappUrls?.[lang === 'en' ? 'en' : 'ar'] ?? s.links.whatsappUrl) : null;
  const v = d.vehicle;
  const fallbackAr = [d.make.nameAr, d.model.nameAr, v.trim, v.modelYear].filter(Boolean).join(' ');
  const fallbackEn = [d.make.nameEn, d.model.nameEn, v.trim, v.modelYear].filter(Boolean).join(' ');

  const set = (k: keyof Values, val: string) => setValues({ ...current, [k]: val });
  const submit = () => {
    const body: Record<string, unknown> = {};
    for (const k of FIELDS) if (current[k] !== base[k]) body[k] = current[k].trim();
    if (body.descriptionAr !== undefined || body.descriptionEn !== undefined) {
      // Both descriptions travel together so the stored source describes the whole text.
      body.descriptionAr = current.descriptionAr.trim();
      body.descriptionEn = current.descriptionEn.trim();
      const unchanged = applied && applied.ar.trim() === current.descriptionAr.trim() && applied.en.trim() === current.descriptionEn.trim();
      body.descriptionSource = applied && unchanged ? applied.source : 'manual';
    }
    if (l) body.version = l.version;
    save.mutate(body);
  };
  const qr = (format: 'svg' | 'png') =>
    download(`/vehicles/${vehicleId}/listing/qr`, { format }, `listing-${s.stockNumber}-qr.${format}`).catch((e) => toast.error(describe(e)));

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader
            title={t('showroom.tab.title')}
            subtitle={t('showroom.tab.subtitle')}
            actions={
              manage && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Sparkles className="h-4 w-4" />}
                  loading={generate.isPending}
                  onClick={() => generate.mutate({})}
                >
                  {generate.isPending ? t('showroom.editor.generating') : t('showroom.editor.generate')}
                </Button>
              )
            }
          />
          <CardBody>
            {!manage && (
              <Alert tone="info" className="mb-4">
                {t('showroom.tab.readOnly')}
              </Alert>
            )}
            {conflict && (
              <Alert tone="warning" className="mb-4">
                {t('showroom.editor.conflict')}
              </Alert>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              noValidate
            >
              <fieldset disabled={!manage || save.isPending} className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Field label={t('showroom.editor.titleAr')}>
                  {(id) => (
                    <Input
                      id={id}
                      dir="rtl"
                      lang="ar"
                      maxLength={160}
                      value={current.titleAr}
                      placeholder={t('showroom.editor.titlePlaceholder', { fallback: fallbackAr })}
                      onChange={(e) => set('titleAr', e.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('showroom.editor.titleEn')}>
                  {(id) => (
                    <Input
                      id={id}
                      dir="ltr"
                      lang="en"
                      maxLength={160}
                      value={current.titleEn}
                      placeholder={t('showroom.editor.titlePlaceholder', { fallback: fallbackEn })}
                      onChange={(e) => set('titleEn', e.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('showroom.editor.descriptionAr')} className="sm:col-span-2">
                  {(id) => <Textarea id={id} dir="rtl" lang="ar" rows={5} maxLength={4000} value={current.descriptionAr} onChange={(e) => set('descriptionAr', e.target.value)} />}
                </Field>
                <Field label={t('showroom.editor.descriptionEn')} className="sm:col-span-2">
                  {(id) => <Textarea id={id} dir="ltr" lang="en" rows={5} maxLength={4000} value={current.descriptionEn} onChange={(e) => set('descriptionEn', e.target.value)} />}
                </Field>
              </fieldset>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <div className="me-auto flex flex-wrap items-center gap-2 text-xs text-muted">
                  {l && <span className="num">{t('showroom.editor.version', { version: l.version })}</span>}
                  {l?.descriptionSource && (l.descriptionAr || l.descriptionEn) && (
                    <span className="inline-flex items-center gap-1.5">
                      {t('showroom.descriptionSource.label')}: <DescriptionSourceBadge source={l.descriptionSource} />
                    </span>
                  )}
                  {dirty && <span className="font-medium text-warning">{t('showroom.editor.unsaved')}</span>}
                  {applied && dirty && <span>{t('showroom.generate.applied')}</span>}
                </div>
                {manage && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!dirty || save.isPending}
                      onClick={() => {
                        setValues(null);
                        setApplied(null);
                        setConflict(false);
                      }}
                    >
                      {t('showroom.editor.discard')}
                    </Button>
                    <Button type="submit" size="sm" loading={save.isPending} disabled={!dirty}>
                      {t('showroom.editor.save')}
                    </Button>
                  </>
                )}
              </div>
            </form>
          </CardBody>
        </Card>
        {can('vehicles.read', 'pricing.update') && <PriceGuidanceCard vehicleId={vehicleId} />}
      </div>

      <div className="min-w-0 space-y-5">
        <Card>
          <CardHeader title={t('common.status')} />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <PublishedBadge published={l ? l.isPublished : null} />
              <VisibilityBadge visible={s.visibility.public} />
            </div>
            {l?.isPublished && l.publishedAt && <p className="text-xs text-muted">{t('showroom.tab.publishedAt', { date: fmtDateTime(l.publishedAt) })}</p>}
            {!s.visibility.public && s.visibility.reasons.length > 0 && (
              <div>
                <p className="text-[13px] font-medium">{t('showroom.visibility.whyHidden')}</p>
                <ul className="mt-1.5 list-disc space-y-1 ps-5 text-[13px] text-muted">
                  {s.visibility.reasons.map((r) => (
                    <li key={r}>
                      {visibilityReason(r, t, lang, s.vehicleStatus)}
                      {r === 'showroom_disabled' && can('settings.manage') && (
                        <>
                          {' '}
                          <Link to="/app/settings/company" className="font-medium text-brand-strong hover:underline">
                            {t('showroom.visibility.openSettings')}
                          </Link>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {showroom && (
              <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
                <span className="text-muted">{t('showroom.public.price')}: </span>
                <span className="num font-medium">
                  {showroom.showPrices && v.askingPrice ? fmtMoney(v.askingPrice, currency) : showroom.showPrices ? '—' : t('showroom.public.contactForPrice')}
                </span>
              </div>
            )}
            {manage && (
              <div className="flex flex-wrap gap-2">
                {l?.isPublished ? (
                  <Button variant="secondary" icon={<EyeOff className="h-4 w-4" />} onClick={() => setConfirmUnpublish(true)}>
                    {t('showroom.actions.unpublish')}
                  </Button>
                ) : (
                  <Button icon={<Send className="h-4 w-4" />} loading={publish.isPending} disabled={dirty} onClick={() => publish.mutate({})}>
                    {t('showroom.actions.publish')}
                  </Button>
                )}
              </div>
            )}
            {manage && dirty && !l?.isPublished && <p className="text-xs text-warning">{t('showroom.editor.saveBeforePublish')}</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t('showroom.share.title')} />
          <CardBody className="space-y-4">
            {!s.links ? (
              <p className="text-[13px] text-muted">{t('showroom.share.notYet')}</p>
            ) : (
              <>
                <div>
                  <p className="label">{t('showroom.share.link')}</p>
                  <p dir="ltr" className="num rounded-lg border border-line bg-surface-2 px-3 py-2 text-start text-xs break-all">
                    {s.links.url}
                  </p>
                  {!s.visibility.public && <p className="mt-1 text-xs text-muted">{t('showroom.share.linkHint')}</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <CopyButton text={s.links.url} label={t('showroom.share.copy')} copiedLabel={t('showroom.share.copied')} />
                    {s.visibility.public && (
                      <a
                        href={s.links.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[13px] font-medium text-ink hover:bg-surface-2"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden />
                        {t('showroom.actions.viewPublic')}
                      </a>
                    )}
                  </div>
                </div>
                <div>
                  <p className="label">{t('showroom.share.whatsapp')}</p>
                  {whatsappUrl ? (
                    <CopyButton text={whatsappUrl} label={t('showroom.share.copy')} copiedLabel={t('showroom.share.copied')} />
                  ) : (
                    <p className="text-xs text-muted">{t('showroom.share.noWhatsapp')}</p>
                  )}
                </div>
                <div>
                  <p className="label">{t('showroom.share.qr')}</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <img
                      src={`/api/v1/vehicles/${vehicleId}/listing/qr?format=svg`}
                      alt={t('showroom.share.qrAlt')}
                      width={112}
                      height={112}
                      className="rounded-lg border border-line bg-white p-1"
                    />
                    <div className="flex flex-col gap-2">
                      <Button variant="secondary" size="sm" icon={<Download className="h-4 w-4" />} onClick={() => qr('svg')}>
                        {t('showroom.share.qrSvg')}
                      </Button>
                      <Button variant="secondary" size="sm" icon={<Download className="h-4 w-4" />} onClick={() => qr('png')}>
                        {t('showroom.share.qrPng')}
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {suggestion && (
        <SuggestionModal
          result={suggestion}
          onClose={() => setSuggestion(null)}
          onUse={(ar, en) => {
            setValues({ ...current, descriptionAr: ar, descriptionEn: en });
            setApplied({ ar: suggestion.suggestion.descriptionAr, en: suggestion.suggestion.descriptionEn, source: suggestion.generation.source });
            setSuggestion(null);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmUnpublish}
        onClose={() => setConfirmUnpublish(false)}
        onConfirm={() => unpublish.mutate({})}
        loading={unpublish.isPending}
        tone="danger"
        title={t('showroom.actions.confirmUnpublish')}
        message={t('showroom.actions.confirmUnpublishText')}
        confirmLabel={t('showroom.actions.unpublish')}
      />
    </div>
  );
}
