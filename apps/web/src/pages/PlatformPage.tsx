import { ArrowRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BrandMark } from '@/app/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { fmtDate } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useApi, useApiMutation } from '@/lib/hooks';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  market: string;
  base_currency: string;
  status: string;
  created_at: string;
}

function ProvisionForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const form = useForm({
    defaultValues: {
      name: '',
      slug: '',
      market: 'SA',
      locale: 'ar',
      branchName: '',
      planCode: 'starter',
      ownerEmail: '',
      ownerName: '',
      ownerPassword: '',
    },
  });
  const create = useApiMutation<Record<string, unknown>>({
    path: '/platform/tenants',
    invalidate: [['platform-tenants']],
    success: t('platform.created'),
    onSuccess: onDone,
  });
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      noValidate
      onSubmit={form.handleSubmit((v) =>
        create.mutate({
          name: v.name,
          slug: v.slug,
          market: v.market,
          locale: v.locale,
          branchName: v.branchName,
          planCode: v.planCode,
          owner: { email: v.ownerEmail, fullName: v.ownerName, password: v.ownerPassword },
        }),
      )}
    >
      <Field label={t('settings.companyName')} required>
        {(id) => <Input id={id} {...form.register('name', { required: true })} />}
      </Field>
      <Field label={t('platform.slug')} hint="a-z 0-9 -" required>
        {(id, d) => (
          <Input id={id} aria-describedby={d} dir="ltr" {...form.register('slug', { required: true })} />
        )}
      </Field>
      <Field label={t('settings.market')}>
        {(id) => (
          <Select id={id} {...form.register('market')}>
            <option value="SA">{t('markets.SA')} · SAR</option>
            <option value="EG">{t('markets.EG')} · EGP</option>
            <option value="AE">{t('markets.AE')} · AED</option>
          </Select>
        )}
      </Field>
      <Field label={t('settings.defaultLanguage')}>
        {(id) => (
          <Select id={id} {...form.register('locale')}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </Select>
        )}
      </Field>
      <Field label={t('platform.branchName')} required>
        {(id) => <Input id={id} {...form.register('branchName', { required: true })} />}
      </Field>
      <Field label={t('settings.plan')}>
        {(id) => (
          <Select id={id} {...form.register('planCode')}>
            <option value="starter">Starter</option>
            <option value="professional">Professional</option>
            <option value="enterprise">Enterprise</option>
          </Select>
        )}
      </Field>
      <p className="label sm:col-span-2">{t('platform.owner')}</p>
      <Field label={t('users.fullName')} required>
        {(id) => <Input id={id} {...form.register('ownerName', { required: true })} />}
      </Field>
      <Field label={t('common.email')} required>
        {(id) => (
          <Input id={id} type="email" dir="ltr" {...form.register('ownerEmail', { required: true })} />
        )}
      </Field>
      <Field label={t('users.initialPassword')} hint={t('auth.passwordRules')} required>
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            type="password"
            dir="ltr"
            autoComplete="new-password"
            {...form.register('ownerPassword', { required: true })}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={create.isPending}>
          {t('common.create')}
        </Button>
      </div>
    </form>
  );
}

export function PlatformPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const navigate = useNavigate();
  const q = useApi<TenantRow[]>(['platform-tenants'], '/platform/tenants');
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-bg">
      <header className="flex h-16 items-center justify-between bg-nav px-6">
        <BrandMark />
        {me?.tenant && (
          <Button
            variant="ghost"
            className="text-nav-ink hover:bg-white/10 hover:text-white"
            icon={<ArrowRight className="h-4 w-4 ltr:rotate-180" />}
            onClick={() => navigate('/app')}
          >
            {me.tenant.name}
          </Button>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardHeader
            title={t('platform.tenants')}
            subtitle={t('platform.title')}
            actions={
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
                {t('platform.provision')}
              </Button>
            }
          />
          <DataTable
            rows={q.data}
            loading={q.isLoading}
            error={q.error}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'name',
                header: t('common.name'),
                cell: (r) => <span className="font-medium">{r.name}</span>,
              },
              {
                key: 'slug',
                header: t('platform.slug'),
                cell: (r) => <span className="num text-muted">{r.slug}</span>,
              },
              {
                key: 'market',
                header: t('settings.market'),
                cell: (r) => `${t(`markets.${r.market}`)} · ${r.base_currency}`,
              },
              {
                key: 'status',
                header: t('common.status'),
                cell: (r) => <Badge tone={r.status === 'active' ? 'success' : 'danger'}>{r.status}</Badge>,
              },
              { key: 'created', header: t('common.createdAt'), cell: (r) => fmtDate(r.created_at) },
            ]}
          />
        </Card>
      </main>
      <Modal open={open} onClose={() => setOpen(false)} title={t('platform.provision')} size="lg">
        {open && <ProvisionForm onDone={() => setOpen(false)} />}
      </Modal>
    </div>
  );
}
