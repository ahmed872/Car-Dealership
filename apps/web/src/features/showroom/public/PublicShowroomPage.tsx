import { Car, ChevronLeft, ChevronRight, Gauge, ImageOff, MapPin, Search, X } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Feedback';
import { Input, Select } from '@/components/ui/Field';
import { fmtMoney, fmtNumber } from '@/lib/format';
import { PublicVehicleCard, usePublicCompany, usePublicVehicles } from './api';
import { InquiryForm } from './InquiryForm';
import { isNotFound, PublicLayout, PublicMessage, useDocumentTitle } from './PublicLayout';

const PAGE_SIZE = 24;
const MONEY = /^\d{1,13}(\.\d{1,2})?$/;
const thisYear = new Date().getFullYear();
const YEARS = Array.from({ length: thisYear + 2 - 1990 }, (_, i) => String(thisYear + 1 - i));

export function VehiclePhoto({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`flex items-center justify-center bg-surface-2 text-subtle ${className ?? ''}`} role="img" aria-label={alt}>
        {failed ? <ImageOff className="h-8 w-8" aria-hidden /> : <Car className="h-10 w-10" aria-hidden />}
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={`object-cover ${className ?? ''}`} />;
}

function VehicleCard({ slug, v }: { slug: string; v: PublicVehicleCard }) {
  const { t, i18n } = useTranslation();
  const en = i18n.language === 'en';
  const title = en ? v.titleEn : v.titleAr;
  const facts = [
    v.odometer ? `${fmtNumber(v.odometer.value)} ${t(`showroom.public.${v.odometer.unit === 'mi' ? 'mi' : 'km'}`)}` : null,
    v.transmission ? t(`vehicles.enums.transmission.${v.transmission}`, { defaultValue: v.transmission }) : null,
    v.fuelType ? t(`vehicles.enums.fuelType.${v.fuelType}`, { defaultValue: v.fuelType }) : null,
  ].filter(Boolean);
  return (
    <Link
      to={`/showroom/${encodeURIComponent(slug)}/vehicles/${v.id}`}
      className="group card flex min-w-0 flex-col overflow-hidden transition hover:border-line-strong hover:shadow-pop focus-visible:shadow-pop"
    >
      <div className="relative">
        <VehiclePhoto src={v.photoUrl} alt={title} className="aspect-[4/3] w-full" />
        {v.status === 'reserved' && (
          <span className="absolute start-3 top-3">
            <Badge tone="accent" className="bg-surface/95 shadow-card">
              {t('showroom.public.reserved')}
            </Badge>
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <h2 className="line-clamp-2 text-[15px] leading-snug font-semibold text-ink group-hover:text-brand-strong">{title}</h2>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted">
          <span className="num">{v.modelYear}</span>
          {facts.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-2">
              <span aria-hidden>·</span>
              {i === 0 && v.odometer ? (
                <span className="num inline-flex items-center gap-1">
                  <Gauge className="h-3.5 w-3.5" aria-hidden />
                  {f}
                </span>
              ) : (
                f
              )}
            </span>
          ))}
        </p>
        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <p className={v.price ? 'num text-lg font-bold text-ink' : 'text-[13px] font-medium text-brand-strong'}>
            {v.price ? fmtMoney(v.price.amount, v.price.currency) : t('showroom.public.contactForPrice')}
          </p>
          {v.branch.city && (
            <p className="flex min-w-0 items-center gap-1 text-xs text-muted">
              <MapPin className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{v.branch.city}</span>
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

/** /showroom/:slug — the company's public vehicle list (no session). */
export function PublicShowroomPage() {
  const { slug = '' } = useParams();
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const company = usePublicCompany(slug);
  const q = params.get('q') ?? '';
  const yearFrom = params.get('yearFrom') ?? '';
  const yearTo = params.get('yearTo') ?? '';
  const priceMax = params.get('priceMax') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [search, setSearch] = useState(q);
  const [price, setPrice] = useState(priceMax);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => setPrice(priceMax), [priceMax]);

  const showPrices = !!company.data?.showPrices;
  const list = usePublicVehicles(
    slug,
    {
      q: q || undefined,
      yearFrom: yearFrom || undefined,
      yearTo: yearTo || undefined,
      priceMax: showPrices && MONEY.test(priceMax) ? priceMax : undefined,
      page,
      pageSize: PAGE_SIZE,
    },
    company.isSuccess,
  );
  const en = i18n.language === 'en';
  const c = company.data;
  useDocumentTitle(c ? c.name : null);

  const update = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    if (!('page' in next)) p.delete('page');
    setParams(p, { replace: !('page' in next) });
  };
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    update({ q: search.trim(), priceMax: price.replace(/[,\s]/g, '') });
  };
  const filtered = !!(q || yearFrom || yearTo || priceMax);

  if (company.error) {
    return (
      <PublicLayout slug={slug}>
        {isNotFound(company.error) ? (
          <PublicMessage title={t('showroom.public.notFoundTitle')} text={t('showroom.public.notFoundShowroom')} />
        ) : (
          <PublicMessage title={t('showroom.public.loadError')} text="" action={{ label: t('showroom.public.retry'), onClick: () => void company.refetch() }} />
        )}
      </PublicLayout>
    );
  }

  const headline = c ? (en ? (c.headlineEn ?? c.headlineAr) : (c.headlineAr ?? c.headlineEn)) : null;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PublicLayout slug={slug} company={c}>
      <section className="mb-5">
        {c ? (
          <>
            <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{c.name}</h1>
            {headline && <p className="mt-1 text-[15px] text-muted">{headline}</p>}
          </>
        ) : (
          <Skeleton className="h-9 w-64" />
        )}
      </section>

      <form onSubmit={onSearch} role="search" className="card mb-5 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('showroom.public.searchPlaceholder')} aria-label={t('showroom.public.search')} maxLength={80} className="ps-9" />
        </div>
        <Select value={yearFrom} onChange={(e) => update({ yearFrom: e.target.value })} aria-label={t('showroom.public.yearFrom')}>
          <option value="">
            {t('showroom.public.yearFrom')}: {t('showroom.public.any')}
          </option>
          {YEARS.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        <Select value={yearTo} onChange={(e) => update({ yearTo: e.target.value })} aria-label={t('showroom.public.yearTo')}>
          <option value="">
            {t('showroom.public.yearTo')}: {t('showroom.public.any')}
          </option>
          {YEARS.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        {showPrices ? (
          <Input
            inputMode="decimal"
            dir="ltr"
            className="num text-start"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder={`${t('showroom.public.priceMax')} (${c?.currency ?? ''})`}
            aria-label={t('showroom.public.priceMax')}
          />
        ) : (
          <span className="hidden lg:block" />
        )}
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <Button type="submit" icon={<Search className="h-4 w-4" />} className="flex-1 justify-center">
            {t('showroom.public.search')}
          </Button>
          {filtered && (
            <Button
              variant="ghost"
              icon={<X className="h-4 w-4" />}
              onClick={() => {
                setSearch('');
                setPrice('');
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              {t('showroom.public.clear')}
            </Button>
          )}
        </div>
      </form>

      {list.data && (
        <p className="mb-3 text-[13px] text-muted" aria-live="polite">
          {t('showroom.public.results', { count: total })}
        </p>
      )}
      {list.isLoading || !list.data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card overflow-hidden">
              <Skeleton className="aspect-[4/3] w-full rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : list.data.items.length === 0 ? (
        <div className="card">
          <PublicMessage
            title={filtered ? t('showroom.public.noResults') : t('showroom.public.emptyShowroom')}
            text={filtered ? t('showroom.public.noResultsHint') : t('showroom.public.emptyShowroomHint')}
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.data.items.map((v) => (
            <VehicleCard key={v.id} slug={slug} v={v} />
          ))}
        </div>
      )}

      {pages > 1 && (
        <nav className="mt-6 flex items-center justify-center gap-2" aria-label={t('showroom.public.pageOf', { page, pages })}>
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })} icon={<ChevronRight className="h-4 w-4 ltr:rotate-180" />}>
            {t('showroom.public.previous')}
          </Button>
          <span className="num px-2 text-[13px] text-muted">{t('showroom.public.pageOf', { page, pages })}</span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>
            {t('showroom.public.next')}
            <ChevronLeft className="h-4 w-4 ltr:rotate-180" />
          </Button>
        </nav>
      )}

      {c && (
        <section className="card mx-auto mt-10 max-w-xl p-5">
          <h2 className="mb-4 text-lg font-semibold">{t('showroom.public.form.titleGeneral')}</h2>
          <InquiryForm slug={slug} />
        </section>
      )}
    </PublicLayout>
  );
}
