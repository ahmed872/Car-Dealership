import clsx from 'clsx';
import { CheckCircle2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/Field';
import { ApiError } from '@/lib/api';
import { todayIso } from '@/lib/format';
import { InquiryInput, sendInquiry } from './api';

type Kind = 'inquiry' | 'test_drive';
type Errors = Partial<Record<'name' | 'phone' | 'email' | 'consent' | 'preferredDate' | 'form', string>>;

const PHONE = /^\+?[\d\s()-]{6,25}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public inquiry / test-drive request. Consent is an explicit, unticked checkbox. `website` is a
 * honeypot: an off-screen text field people never see or reach with the keyboard; it is sent as
 * typed (always empty for a person), and the API silently drops requests where it is filled.
 */
export function InquiryForm({ slug, listingId }: { slug: string; listingId?: string }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('inquiry');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [preferredDate, setPreferredDate] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const today = todayIso();

  const validate = (): Errors => {
    const e: Errors = {};
    if (name.trim().length < 2) e.name = t('showroom.public.form.errors.name');
    if (!PHONE.test(phone.trim()) || phone.replace(/\D/g, '').length < 6) e.phone = t('showroom.public.form.errors.phone');
    if (email.trim() && !EMAIL.test(email.trim())) e.email = t('showroom.public.form.errors.email');
    if (kind === 'test_drive' && preferredDate && preferredDate < today) e.preferredDate = t('showroom.public.form.errors.date');
    if (!consent) e.consent = t('showroom.public.form.errors.consent');
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: InquiryInput = {
      kind,
      ...(listingId ? { listingId } : {}),
      name: name.trim(),
      phone: phone.trim(),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
      ...(kind === 'test_drive' && preferredDate ? { preferredDate } : {}),
      consent: true,
      website,
    };
    setBusy(true);
    try {
      await sendInquiry(slug, body);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setErrors({ form: t('showroom.public.form.errors.rate_limited') });
      else if (err instanceof ApiError && err.code === 'validation_failed') {
        const issues = (err.details as { issues?: Array<{ path: string }> } | undefined)?.issues ?? [];
        const fe: Errors = {};
        for (const i of issues) {
          if (i.path === 'name') fe.name = t('showroom.public.form.errors.name');
          else if (i.path === 'phone') fe.phone = t('showroom.public.form.errors.phone');
          else if (i.path === 'email') fe.email = t('showroom.public.form.errors.email');
          else if (i.path === 'preferredDate') fe.preferredDate = t('showroom.public.form.errors.date');
          else if (i.path === 'consent') fe.consent = t('showroom.public.form.errors.consent');
        }
        setErrors(Object.keys(fe).length ? fe : { form: t('showroom.public.form.errors.generic') });
      } else setErrors({ form: t('showroom.public.form.errors.generic') });
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 py-6 text-center">
        <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
        <p className="text-base font-semibold text-ink">{t('showroom.public.form.successTitle')}</p>
        <p className="text-sm text-muted">{t('showroom.public.form.successText')}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => {
            setDone(false);
            setMessage('');
            setPreferredDate('');
            setConsent(false);
          }}
        >
          {t('showroom.public.form.another')}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="relative space-y-4">
      {listingId && (
        <div role="radiogroup" aria-label={t('showroom.public.form.title')} className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1">
          {(['inquiry', 'test_drive'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={clsx(
                'rounded-lg px-2 py-2 text-[13px] font-medium transition-colors',
                kind === k ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
              )}
            >
              {k === 'inquiry' ? t('showroom.public.form.kindInquiry') : t('showroom.public.form.kindTestDrive')}
            </button>
          ))}
        </div>
      )}
      <Field label={t('showroom.public.form.name')} required error={errors.name}>
        {(id, d) => <Input id={id} aria-describedby={d} invalid={!!errors.name} autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label={t('showroom.public.form.phone')} required error={errors.phone}>
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            invalid={!!errors.phone}
            type="tel"
            dir="ltr"
            inputMode="tel"
            autoComplete="tel"
            maxLength={25}
            className="num text-start"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        )}
      </Field>
      <Field label={t('showroom.public.form.email')} error={errors.email}>
        {(id, d) => (
          <Input id={id} aria-describedby={d} invalid={!!errors.email} type="email" dir="ltr" autoComplete="email" maxLength={120} className="text-start" value={email} onChange={(e) => setEmail(e.target.value)} />
        )}
      </Field>
      {kind === 'test_drive' && (
        <Field label={t('showroom.public.form.preferredDate')} error={errors.preferredDate}>
          {(id, d) => <Input id={id} aria-describedby={d} invalid={!!errors.preferredDate} type="date" min={today} value={preferredDate} onChange={(e) => setPreferredDate(e.target.value)} />}
        </Field>
      )}
      <Field label={t('showroom.public.form.message')}>
        {(id) => <Textarea id={id} rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />}
      </Field>
      {/* Honeypot: off-screen (not display:none), out of the tab order and hidden from assistive tech. */}
      <div aria-hidden="true" className="pointer-events-none absolute -start-[10000px] top-0 h-px w-px overflow-hidden opacity-0">
        <label htmlFor={`website-${listingId ?? 'general'}`}>{t('showroom.public.form.website')}</label>
        <input id={`website-${listingId ?? 'general'}`} type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>
      <div>
        <Checkbox label={t('showroom.public.form.consent')} checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-invalid={!!errors.consent || undefined} />
        {errors.consent && (
          <p role="alert" className="mt-1 text-xs font-medium text-danger">
            {errors.consent}
          </p>
        )}
      </div>
      {errors.form && <Alert tone="danger">{errors.form}</Alert>}
      <Button type="submit" size="lg" className="w-full justify-center" loading={busy}>
        {busy ? t('showroom.public.form.submitting') : t('showroom.public.form.submit')}
      </Button>
      <p className="text-center text-xs text-subtle">{t('showroom.public.form.privacy')}</p>
    </form>
  );
}
