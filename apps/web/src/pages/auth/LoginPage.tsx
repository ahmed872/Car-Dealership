import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Gauge, Languages, Lock, Receipt } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { BrandMark } from '@/app/AppShell';
import { Button } from '@/components/ui/Button';
import { Alert, errorMessage } from '@/components/ui/Feedback';
import { Field, Input } from '@/components/ui/Field';
import { currentLang, setLanguage } from '@/i18n';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const schema = z.object({
  email: z.string().trim().min(3).email(),
  password: z.string().min(1),
});
type Form = z.infer<typeof schema>;

export function LoginPage() {
  const { t } = useTranslation();
  const { me, loading } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Form>({ resolver: zodResolver(schema) });
  const from = (location.state as { from?: string } | null)?.from ?? '/app';

  if (!loading && me?.tenant) return <Navigate to={from} replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api<{
        activeTenantId: string | null;
        requiresTenantSelection: boolean;
        tenants: unknown[];
      }>('/auth/login', {
        method: 'POST',
        body: values,
      });
      await qc.refetchQueries({ queryKey: ['me'] });
      const meNow = qc.getQueryData<{ user: { isPlatformAdmin: boolean } }>(['me']);
      if (res.requiresTenantSelection) navigate('/select-company', { replace: true });
      else if (!res.activeTenantId && meNow?.user.isPlatformAdmin) navigate('/platform', { replace: true });
      else if (!res.activeTenantId) navigate('/select-company', { replace: true });
      else navigate(from, { replace: true });
    } catch (e) {
      setError(errorMessage(e, t));
    }
  });

  const features = [
    {
      icon: Gauge,
      ar: 'مخزون وفحص ودورة حياة كاملة لكل سيارة',
      en: 'Inventory, inspections and full vehicle lifecycle',
    },
    {
      icon: Receipt,
      ar: 'تكلفة وربح حقيقي لكل سيارة بقيود متوازنة',
      en: 'True cost & profit per car with balanced ledger',
    },
    {
      icon: BadgeCheck,
      ar: 'حجز وبيع وتقسيط وتحصيل بلا تكرار',
      en: 'Reservations, sales, installments — no double posting',
    },
  ];
  const lang = currentLang();

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-nav p-10 text-white lg:flex lg:flex-col">
        <BrandMark />
        <div className="relative z-10 mt-auto max-w-lg">
          <h2 className="text-3xl leading-snug font-semibold">
            {lang === 'ar'
              ? 'كل أرقام معرضك، صحيحة ومترابطة.'
              : 'Every number in your dealership, correct and connected.'}
          </h2>
          <ul className="mt-8 space-y-4">
            {features.map((f) => (
              <li key={f.en} className="flex items-center gap-3 text-[15px] text-nav-ink">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-brand">
                  <f.icon className="h-[18px] w-[18px]" />
                </span>
                {lang === 'ar' ? f.ar : f.en}
              </li>
            ))}
          </ul>
        </div>
        {/* Decorative road lines */}
        <svg
          className="pointer-events-none absolute -end-24 top-10 h-[520px] w-[520px] opacity-[0.07]"
          viewBox="0 0 200 200"
          aria-hidden
        >
          <circle cx="100" cy="100" r="96" stroke="white" strokeWidth="2" fill="none" />
          <circle cx="100" cy="100" r="70" stroke="white" strokeWidth="2" fill="none" strokeDasharray="6 8" />
          <circle cx="100" cy="100" r="44" stroke="white" strokeWidth="2" fill="none" />
        </svg>
      </aside>

      <main className="flex flex-col px-5 py-8 sm:px-10">
        <div className="flex items-center justify-between">
          <div className="lg:hidden">
            <div className="rounded-xl bg-nav p-2 pe-4">
              <BrandMark />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLanguage(lang === 'ar' ? 'en' : 'ar')}
            className="ms-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2"
          >
            <Languages className="h-4 w-4" /> {lang === 'ar' ? 'English' : 'العربية'}
          </button>
        </div>
        <div className="mx-auto my-auto w-full max-w-sm py-10">
          <h1 className="text-2xl font-semibold tracking-tight">{t('auth.signInTitle')}</h1>
          <p className="mt-1 text-sm text-muted">{t('auth.signInSubtitle')}</p>
          {(location.state as { expired?: boolean } | null)?.expired && (
            <Alert tone="warning" className="mt-5">
              {t('auth.sessionExpired')}
            </Alert>
          )}
          {error && (
            <Alert tone="danger" className="mt-5">
              {error}
            </Alert>
          )}
          <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
            <Field label={t('auth.email')} error={form.formState.errors.email ? 'required' : null} required>
              {(id, d) => (
                <Input
                  id={id}
                  aria-describedby={d}
                  type="email"
                  autoComplete="username"
                  dir="ltr"
                  {...form.register('email')}
                />
              )}
            </Field>
            <Field
              label={t('auth.password')}
              error={form.formState.errors.password ? 'required' : null}
              required
            >
              {(id, d) => (
                <Input
                  id={id}
                  aria-describedby={d}
                  type="password"
                  autoComplete="current-password"
                  dir="ltr"
                  {...form.register('password')}
                />
              )}
            </Field>
            <Button
              type="submit"
              size="lg"
              className="w-full justify-center"
              loading={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
          </form>
          <p className="mt-6 flex items-center gap-2 text-xs text-subtle">
            <Lock className="h-3.5 w-3.5" /> {t('auth.securityNote')}
          </p>
        </div>
      </main>
    </div>
  );
}
