import clsx from 'clsx';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Link2, MapPin, MessageCircle, Phone, Share2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { fmtMoney, fmtNumber } from '@/lib/format';
import { copyText } from '../components';
import { PublicVehicleDetail, usePublicCompany, usePublicVehicle } from './api';
import { InquiryForm } from './InquiryForm';
import { isNotFound, PublicLayout, PublicMessage, useDocumentTitle } from './PublicLayout';
import { VehiclePhoto } from './PublicShowroomPage';

function Gallery({ v, title }: { v: PublicVehicleDetail; title: string }) {
  const { t } = useTranslation();
  const photos = v.photos.length ? v.photos : v.photoUrl ? [{ url: v.photoUrl, caption: null }] : [];
  const [i, setI] = useState(0);
  const total = photos.length;
  const cur = photos[Math.min(i, total - 1)];
  const go = (delta: number) => setI((x) => (x + delta + total) % total);
  return (
    <div className="space-y-2">
      <div className="card relative overflow-hidden">
        <VehiclePhoto src={cur?.url ?? null} alt={cur?.caption ?? (total ? t('showroom.public.photo', { n: i + 1, total }) : t('showroom.public.noPhoto'))} className="aspect-[4/3] w-full" />
        {v.status === 'reserved' && (
          <span className="absolute start-3 top-3">
            <Badge tone="accent" className="bg-surface/95 shadow-card">
              {t('showroom.public.reserved')}
            </Badge>
          </span>
        )}
        {total > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label={t('showroom.public.prevPhoto')}
              className="absolute start-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60"
            >
              <ChevronRight className="h-5 w-5 ltr:rotate-180" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label={t('showroom.public.nextPhoto')}
              className="absolute end-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/60"
            >
              <ChevronLeft className="h-5 w-5 ltr:rotate-180" aria-hidden />
            </button>
            <span className="num absolute end-3 bottom-3 rounded-md bg-black/55 px-2 py-0.5 text-xs text-white" aria-live="polite">
              {t('showroom.public.photo', { n: i + 1, total })}
            </span>
          </>
        )}
      </div>
      {total > 1 && (
        <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-1">
          {photos.map((p, n) => (
            <button
              key={p.url}
              type="button"
              onClick={() => setI(n)}
              aria-label={t('showroom.public.photo', { n: n + 1, total })}
              aria-current={n === i || undefined}
              className={clsx('shrink-0 overflow-hidden rounded-lg border-2', n === i ? 'border-brand' : 'border-transparent opacity-80 hover:opacity-100')}
            >
              <VehiclePhoto src={p.url} alt="" className="h-14 w-20" />
            </button>
          ))}
        </div>
      )}
      {cur?.caption && <p className="text-[13px] text-muted">{cur.caption}</p>}
      <span className="sr-only">{title}</span>
    </div>
  );
}

/** /showroom/:slug/vehicles/:listingId — public vehicle page with the inquiry / test-drive form. */
export function PublicVehiclePage() {
  const { slug = '', listingId = '' } = useParams();
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const company = usePublicCompany(slug);
  const q = usePublicVehicle(slug, listingId);
  const [copied, setCopied] = useState(false);
  const en = i18n.language === 'en';
  const v = q.data;
  const title = v ? (en ? v.titleEn : v.titleAr) : null;
  useDocumentTitle(v && company.data ? `${title} — ${company.data.name}` : null);
  const back = `/showroom/${encodeURIComponent(slug)}`;

  const error = company.error ?? q.error;
  if (error) {
    const showroomMissing = !!company.error;
    return (
      <PublicLayout slug={slug} company={company.data}>
        {isNotFound(error) ? (
          <PublicMessage
            title={t('showroom.public.notFoundTitle')}
            text={showroomMissing ? t('showroom.public.notFoundShowroom') : t('showroom.public.notFoundVehicle')}
            action={showroomMissing ? undefined : { label: t('showroom.public.backToShowroom'), to: back }}
          />
        ) : (
          <PublicMessage title={t('showroom.public.loadError')} text="" action={{ label: t('showroom.public.retry'), onClick: () => void q.refetch() }} />
        )}
      </PublicLayout>
    );
  }

  if (!v || !company.data) {
    return (
      <PublicLayout slug={slug} company={company.data}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <Skeleton className="aspect-[4/3] w-full" />
          <div className="space-y-3">
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      </PublicLayout>
    );
  }

  const c = company.data;
  const description = en ? (v.descriptionEn ?? v.descriptionAr) : (v.descriptionAr ?? v.descriptionEn);
  const enumLabel = (group: string, value: string | null) => (value ? t(`vehicles.enums.${group}.${value}`, { defaultValue: value }) : null);
  const specs: Array<[string, string | null]> = [
    ['modelYear', String(v.modelYear)],
    ['trim', v.trim],
    ['condition', enumLabel('condition', v.condition)],
    ['odometer', v.odometer ? `${fmtNumber(v.odometer.value)} ${t(`showroom.public.${v.odometer.unit === 'mi' ? 'mi' : 'km'}`)}` : null],
    ['bodyType', enumLabel('bodyType', v.bodyType)],
    ['fuelType', enumLabel('fuelType', v.fuelType)],
    ['transmission', enumLabel('transmission', v.transmission)],
    ['exteriorColor', v.exteriorColor],
    ['interiorColor', v.interiorColor],
    ['specRegion', enumLabel('specRegion', v.specRegion)],
  ];
  const share = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: title ?? '', url: v.share.url });
        return;
      } catch {
        /* cancelled or unsupported: fall back to copying */
      }
    }
    if (await copyText(v.share.url)) {
      setCopied(true);
      toast.success(t('showroom.public.linkCopied'));
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <PublicLayout slug={slug} company={c}>
      <Link to={back} className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink">
        <ArrowRight className="h-4 w-4 ltr:rotate-180" aria-hidden />
        {t('showroom.public.back')}
      </Link>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div className="min-w-0 space-y-6">
          <Gallery v={v} title={title ?? ''} />
          <div className="lg:hidden">
            <Summary v={v} title={title ?? ''} />
          </div>
          <section className="card p-5">
            <h2 className="mb-3 text-base font-semibold">{t('showroom.public.specs')}</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              {specs
                .filter(([, val]) => val)
                .map(([k, val]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs text-muted">{t(`showroom.public.spec.${k}`)}</dt>
                    <dd className="mt-0.5 text-sm font-medium break-words text-ink" dir="auto">
                      {val}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
          {description && (
            <section className="card p-5">
              <h2 className="mb-2 text-base font-semibold">{t('showroom.public.description')}</h2>
              <p className="text-sm leading-relaxed whitespace-pre-line text-ink" dir="auto">
                {description}
              </p>
            </section>
          )}
          {v.features.length > 0 && (
            <section className="card p-5">
              <h2 className="mb-3 text-base font-semibold">{t('showroom.public.features')}</h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {v.features.map((f) => (
                  <li key={f.en} className="flex items-center gap-2 text-sm">
                    <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
                    {en ? f.en : f.ar}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside className="min-w-0 space-y-4 lg:sticky lg:top-20">
          <div className="hidden lg:block">
            <Summary v={v} title={title ?? ''} />
          </div>
          <div className="card space-y-2 p-4">
            {v.share.whatsappUrl && (
              <a
                href={v.share.whatsappUrl}
                target="_blank"
                rel="noreferrer"
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#1f9d55] text-sm font-medium text-white hover:bg-[#188a49]"
              >
                <MessageCircle className="h-4 w-4" aria-hidden />
                {t('showroom.public.whatsapp')}
              </a>
            )}
            <div className="grid grid-cols-2 gap-2">
              {c.phone && (
                <a href={`tel:${c.phone}`} className="flex h-10 items-center justify-center gap-2 rounded-lg border border-line text-sm font-medium text-ink hover:bg-surface-2">
                  <Phone className="h-4 w-4" aria-hidden />
                  {t('showroom.public.call')}
                </a>
              )}
              <Button variant="secondary" className={clsx('justify-center', !c.phone && 'col-span-2')} icon={copied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />} onClick={share}>
                {t('showroom.public.share')}
              </Button>
            </div>
            <button
              type="button"
              onClick={async () => {
                if (await copyText(v.share.url)) toast.success(t('showroom.public.linkCopied'));
              }}
              className="flex w-full items-center justify-center gap-1.5 py-1 text-xs font-medium text-muted hover:text-ink"
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              {t('showroom.public.copyLink')}
            </button>
          </div>
          <section className="card p-5" id="inquiry">
            <h2 className="mb-4 text-base font-semibold">{t('showroom.public.form.title')}</h2>
            <InquiryForm slug={slug} listingId={v.id} />
          </section>
        </aside>
      </div>
    </PublicLayout>
  );
}

function Summary({ v, title }: { v: PublicVehicleDetail; title: string }) {
  const { t } = useTranslation();
  return (
    <div className="card space-y-3 p-5">
      <div className="flex flex-wrap items-start gap-2">
        <h1 className="min-w-0 flex-1 text-xl leading-snug font-bold text-ink">{title}</h1>
        {v.status === 'reserved' && <Badge tone="accent">{t('showroom.public.reserved')}</Badge>}
      </div>
      <div>
        <p className="text-xs text-muted">{t('showroom.public.price')}</p>
        <p className={v.price ? 'num text-2xl font-bold text-ink' : 'text-base font-semibold text-brand-strong'}>
          {v.price ? fmtMoney(v.price.amount, v.price.currency) : t('showroom.public.contactForPrice')}
        </p>
      </div>
      <p className="flex items-center gap-1.5 text-[13px] text-muted">
        <MapPin className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {t('showroom.public.branch')}: {[v.branch.name, v.branch.city].filter(Boolean).join(' · ')}
        </span>
      </p>
    </div>
  );
}
