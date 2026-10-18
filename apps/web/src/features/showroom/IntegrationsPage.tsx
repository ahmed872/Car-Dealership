import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, ScanLine } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { Alert, ErrorState, PageLoader } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { IntegrationSetting, useShowroomError, useShowroomMutation, VinSuggestion } from './api';

const KEY = ['showroom', 'integrations'];

function SecretField({ s, label, value, onChange, remove, onRemove }: { s: IntegrationSetting; label: string; value: string; onChange: (v: string) => void; remove: boolean; onRemove: (v: boolean) => void }) {
  const { t } = useTranslation();
  const short = value.trim().length > 0 && value.trim().length < 8;
  return (
    <div className="space-y-2">
      <Field label={label} hint={t('showroom.integrations.secret.hint')} error={short ? t('showroom.integrations.secret.tooShort') : null}>
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            type="password"
            dir="ltr"
            autoComplete="new-password"
            spellCheck={false}
            invalid={short}
            disabled={remove}
            value={value}
            maxLength={500}
            placeholder={s.hasSecret ? t('showroom.integrations.secret.placeholderReplace') : t('showroom.integrations.secret.placeholderNew')}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <KeyRound className="h-3.5 w-3.5 text-muted" aria-hidden />
        <span className="text-muted">
          {s.hasSecret
            ? s.secretLast4
              ? t('showroom.integrations.secret.storedLast4', { last4: s.secretLast4 })
              : t('showroom.integrations.secret.stored')
            : t('showroom.integrations.secret.none')}
        </span>
        {s.hasSecret &&
          (remove ? (
            <>
              <span className="font-medium text-warning">{t('showroom.integrations.secret.willRemove')}</span>
              <button type="button" className="font-medium text-brand-strong hover:underline" onClick={() => onRemove(false)}>
                {t('showroom.integrations.secret.undoRemove')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="font-medium text-danger hover:underline"
              onClick={() => {
                onChange('');
                onRemove(true);
              }}
            >
              {t('showroom.integrations.secret.remove')}
            </button>
          ))}
      </div>
    </div>
  );
}

function VinTest({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const describe = useShowroomError();
  const [vin, setVin] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VinSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<VinSuggestion>(`/integrations/vin-decode/${encodeURIComponent(vin.trim())}`));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="mb-2 text-[13px] font-medium">{t('showroom.integrations.vinTest.title')}</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Input
          dir="ltr"
          className="num min-w-0 flex-1 uppercase"
          maxLength={17}
          value={vin}
          onChange={(e) => setVin(e.target.value)}
          placeholder={t('showroom.integrations.vinTest.placeholder')}
          aria-label={t('showroom.integrations.vinTest.placeholder')}
        />
        <Button type="submit" variant="secondary" icon={<ScanLine className="h-4 w-4" />} loading={busy} disabled={!enabled || vin.trim().length !== 17}>
          {t('showroom.integrations.vinTest.run')}
        </Button>
      </form>
      {!enabled && <p className="mt-2 text-xs text-muted">{t('showroom.integrations.vinTest.enableFirst')}</p>}
      {error && (
        <Alert tone="warning" className="mt-3">
          {error}
        </Alert>
      )}
      {result && (
        <div className="mt-3">
          <DescriptionList
            items={[
              { label: t('showroom.vin.make'), value: result.make },
              { label: t('showroom.vin.model'), value: result.model },
              { label: t('showroom.vin.modelYear'), value: result.modelYear },
              { label: t('showroom.vin.trim'), value: result.trim },
              { label: t('showroom.vin.bodyClass'), value: result.bodyClass },
              { label: t('showroom.vin.engine'), value: result.engine },
            ]}
          />
          {result.warnings && <p className="mt-2 text-xs text-muted" lang="en" dir="ltr">{result.warnings}</p>}
        </div>
      )}
    </div>
  );
}

function ProviderCard({ s }: { s: IntegrationSetting }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(s.enabled);
  const [kind, setKind] = useState(String(s.config.provider ?? 'log'));
  const [url, setUrl] = useState(String(s.config.url ?? ''));
  const [secret, setSecret] = useState('');
  const [removeSecret, setRemoveSecret] = useState(false);
  const save = useShowroomMutation<Record<string, unknown>, IntegrationSetting>({
    path: `/integrations/${s.provider}`,
    method: 'PUT',
    success: t('showroom.integrations.saved'),
    onSuccess: (res) => {
      qc.setQueriesData<IntegrationSetting[]>({ queryKey: KEY }, (list) => list?.map((x) => (x.provider === res.provider ? res : x)));
      setSecret('');
      setRemoveSecret(false);
    },
  });
  const messaging = s.provider === 'messaging';
  const config = messaging ? (kind === 'webhook' ? { provider: kind, url: url.trim() } : { provider: kind }) : s.config;
  const dirty =
    enabled !== s.enabled ||
    secret.trim() !== '' ||
    removeSecret ||
    (messaging && (kind !== String(s.config.provider ?? 'log') || (kind === 'webhook' && url.trim() !== String(s.config.url ?? ''))));
  const secretInvalid = secret.trim().length > 0 && secret.trim().length < 8;
  const showSecret = s.available && (s.needsSecret || messaging);

  return (
    <Card>
      <CardHeader
        title={t(`showroom.integrations.providers.${s.provider}.title`)}
        subtitle={s.updatedAt ? t('showroom.integrations.lastUpdated', { date: fmtDateTime(s.updatedAt) }) : undefined}
        actions={
          <>
            {!s.available && <Badge tone="neutral">{t('showroom.integrations.unavailable')}</Badge>}
            <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? t('showroom.integrations.enabled') : t('showroom.integrations.disabled')}</Badge>
          </>
        }
      />
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const body: Record<string, unknown> = { enabled, config };
            if (removeSecret) body.secret = null;
            else if (secret.trim()) body.secret = secret.trim();
            save.mutate(body);
          }}
          noValidate
        >
          <p className="text-[13px] text-muted">{t(`showroom.integrations.providers.${s.provider}.description`)}</p>
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs">
            <span className="font-medium text-ink">{t('showroom.integrations.providerNote')}: </span>
            <span lang="en" dir="ltr" className="inline-block text-muted">
              {s.note}
            </span>
          </div>
          {!s.available ? (
            <Alert tone="warning">{t('showroom.integrations.ocrUnavailable')}</Alert>
          ) : (
            <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
              <Checkbox label={t('showroom.integrations.enable')} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              {messaging && (
                <>
                  <Field label={t('showroom.integrations.messaging.provider')}>
                    {(id) => (
                      <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                        <option value="log">{t('showroom.integrations.messaging.log')}</option>
                        <option value="webhook">{t('showroom.integrations.messaging.webhook')}</option>
                      </Select>
                    )}
                  </Field>
                  {kind === 'log' ? (
                    <Alert tone="warning">{t('showroom.integrations.messaging.logWarning')}</Alert>
                  ) : (
                    <Field label={t('showroom.integrations.messaging.url')} hint={t('showroom.integrations.messaging.webhookHint')} required>
                      {(id, d) => (
                        <Input id={id} aria-describedby={d} type="url" dir="ltr" inputMode="url" placeholder="https://" maxLength={500} value={url} onChange={(e) => setUrl(e.target.value)} />
                      )}
                    </Field>
                  )}
                </>
              )}
              {showSecret && (
                <SecretField
                  s={s}
                  label={messaging ? t('showroom.integrations.secret.labelSigning') : t('showroom.integrations.secret.label')}
                  value={secret}
                  onChange={setSecret}
                  remove={removeSecret}
                  onRemove={setRemoveSecret}
                />
              )}
              {s.provider === 'ai_text' && <p className="text-xs text-muted">{t('showroom.integrations.aiNoKey')}</p>}
              <div className="flex justify-end">
                <Button type="submit" loading={save.isPending} disabled={!dirty || secretInvalid || (messaging && enabled && kind === 'webhook' && !url.trim())}>
                  {t('showroom.integrations.save')}
                </Button>
              </div>
            </fieldset>
          )}
        </form>
        {s.provider === 'vin_decoder' && can('vehicles.create') && (
          <div className="mt-4">
            <VinTest enabled={s.enabled} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** /app/settings/integrations — per-company integration settings (integrations.manage, D-035). */
export function IntegrationsPage() {
  const { t } = useTranslation();
  const q = useApi<IntegrationSetting[]>(KEY, '/integrations');
  if (q.isLoading) return <PageLoader />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      <PageHeader title={t('showroom.integrations.title')} subtitle={t('showroom.integrations.subtitle')} />
      <div className="grid gap-5 xl:grid-cols-2">
        {q.data.map((s) => (
          <ProviderCard key={`${s.provider}:${s.updatedAt ?? ''}`} s={s} />
        ))}
      </div>
    </>
  );
}
