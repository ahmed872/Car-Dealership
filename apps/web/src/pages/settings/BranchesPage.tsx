import { Building2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Field, Input } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { Can } from '@/lib/auth';
import { useApi, useApiMutation } from '@/lib/hooks';

export interface Branch {
  id: string;
  name: string;
  code: string;
  city: string | null;
  address: string | null;
  phone: string | null;
  timezone: string | null;
  isActive: boolean;
}

export function useBranches() {
  return useApi<Branch[]>(['branches'], '/branches', undefined, { staleTime: 5 * 60_000 });
}

function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => void }) {
  const { t } = useTranslation();
  const form = useForm({
    defaultValues: {
      name: branch?.name ?? '',
      code: branch?.code ?? '',
      city: branch?.city ?? '',
      address: branch?.address ?? '',
      phone: branch?.phone ?? '',
      timezone: branch?.timezone ?? '',
      isActive: branch?.isActive ?? true,
    },
  });
  const save = useApiMutation<Record<string, unknown>>({
    path: branch ? `/branches/${branch.id}` : '/branches',
    method: branch ? 'PUT' : 'POST',
    invalidate: [['branches']],
    onSuccess: onDone,
  });
  return (
    <form
      id="branch-form"
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit((v) => save.mutate(v))}
      noValidate
    >
      <Field label={t('common.name')} required error={form.formState.errors.name ? 'required' : null}>
        {(id, d) => (
          <Input id={id} aria-describedby={d} {...form.register('name', { required: true, minLength: 2 })} />
        )}
      </Field>
      <Field
        label={t('common.code')}
        required
        hint="A-Z 0-9"
        error={form.formState.errors.code ? 'required' : null}
      >
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            dir="ltr"
            className="uppercase"
            {...form.register('code', { required: true, pattern: /^[A-Za-z0-9-]{1,12}$/ })}
          />
        )}
      </Field>
      <Field label={t('common.city')}>{(id) => <Input id={id} {...form.register('city')} />}</Field>
      <Field label={t('common.phone')}>
        {(id) => <Input id={id} dir="ltr" {...form.register('phone')} />}
      </Field>
      <Field label={t('common.address')} className="sm:col-span-2">
        {(id) => <Input id={id} {...form.register('address')} />}
      </Field>
      <Field label={t('settings.timezone')} hint={t('branches.timezoneHint')}>
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            dir="ltr"
            placeholder="Asia/Riyadh"
            {...form.register('timezone')}
          />
        )}
      </Field>
      <div className="flex items-end pb-2">
        <Checkbox label={t('common.active')} {...form.register('isActive')} />
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

export function BranchesPage() {
  const { t } = useTranslation();
  const q = useBranches();
  const [editing, setEditing] = useState<Branch | null | 'new'>(null);
  return (
    <>
      <PageHeader
        title={t('branches.title')}
        actions={
          <Can perm="branches.manage">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>
              {t('branches.add')}
            </Button>
          </Can>
        }
      />
      <Card>
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(b) => b.id}
          empty={<EmptyState icon={<Building2 className="h-5 w-5" />} title={t('common.noData')} />}
          columns={[
            {
              key: 'name',
              header: t('common.name'),
              cell: (b) => <span className="font-medium">{b.name}</span>,
            },
            {
              key: 'code',
              header: t('common.code'),
              cell: (b) => <span className="num text-muted">{b.code}</span>,
            },
            { key: 'city', header: t('common.city'), cell: (b) => b.city ?? '—', hideOnMobile: true },
            {
              key: 'phone',
              header: t('common.phone'),
              cell: (b) => <span className="num">{b.phone ?? '—'}</span>,
              hideOnMobile: true,
            },
            {
              key: 'status',
              header: t('common.status'),
              cell: (b) => (
                <Badge tone={b.isActive ? 'success' : 'neutral'}>
                  {b.isActive ? t('common.active') : t('common.inactive')}
                </Badge>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">{t('common.actions')}</span>,
              align: 'end',
              cell: (b) => (
                <Can perm="branches.manage">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Pencil className="h-3.5 w-3.5" />}
                    onClick={() => setEditing(b)}
                  >
                    {t('common.edit')}
                  </Button>
                </Can>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('branches.add') : t('branches.edit')}
      >
        {editing !== null && (
          <BranchForm branch={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        )}
      </Modal>
    </>
  );
}
