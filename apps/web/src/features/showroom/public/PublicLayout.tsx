import { Car, Languages, MapPin, MessageCircle, Phone, SearchX } from 'lucide-react';
import { ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { currentLang, setLanguage } from '@/i18n';
import { ApiError } from '@/lib/api';
import type { PublicCompany } from './api';
import { whatsappLink } from './api';

export function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

/** 404, or 400 for a malformed id in the URL: both mean there is nothing to show. */
export const isNotFound = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 400);

/** Public showroom chrome: company header with the language switch, and a contact footer. No app shell. */
export function PublicLayout({ slug, company, children }: { slug: string; company?: PublicCompany; children: ReactNode }) {
  const { t } = useTranslation();
  const lang = currentLang();
  const wa = whatsappLink(company?.whatsappNumber ?? null);
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
          <Link to={`/showroom/${encodeURIComponent(slug)}`} className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-ink">
              <Car className="h-5 w-5" aria-hidden />
            </span>
            <span className="truncate text-[15px] font-semibold text-ink">{company?.name ?? ' '}</span>
          </Link>
          <button
            type="button"
            onClick={() => setLanguage(lang === 'ar' ? 'en' : 'ar')}
            lang={lang === 'ar' ? 'en' : 'ar'}
            className="ms-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-ink"
          >
            <Languages className="h-4 w-4" aria-hidden />
            {t('showroom.public.language')}
          </button>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:py-8">
        {children}
      </main>
      {company && (
        <footer className="border-t border-line bg-surface">
          <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 text-[13px] text-muted sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <p className="font-semibold text-ink">{(lang === 'en' ? company.legalNameEn : company.legalNameAr) ?? company.name}</p>
              {company.branches.map((b, i) => (
                <p key={i} className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{[b.name, b.city].filter(Boolean).join(' · ')}</span>
                </p>
              ))}
            </div>
            <div className="flex flex-wrap items-start gap-2 sm:justify-end">
              {company.phone && (
                <a href={`tel:${company.phone}`} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-ink hover:bg-surface-2">
                  <Phone className="h-4 w-4" aria-hidden />
                  <span dir="ltr" className="num">
                    {company.phone}
                  </span>
                </a>
              )}
              {wa && (
                <a href={wa} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-ink hover:bg-surface-2">
                  <MessageCircle className="h-4 w-4" aria-hidden />
                  {t('showroom.public.whatsapp')}
                </a>
              )}
            </div>
            <p className="text-xs text-subtle sm:col-span-2">{t('showroom.public.poweredBy')}</p>
          </div>
        </footer>
      )}
    </div>
  );
}

/** Friendly 404 / error page for the public showroom. */
export function PublicMessage({ title, text, action }: { title: string; text: string; action?: { label: string; to?: string; onClick?: () => void } }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">
        <SearchX className="h-7 w-7" aria-hidden />
      </span>
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-sm text-muted">{text}</p>
      {action &&
        (action.to ? (
          <Link to={action.to} className="mt-5 inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink hover:bg-brand-strong">
            {action.label}
          </Link>
        ) : (
          <Button className="mt-5" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  );
}
