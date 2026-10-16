import { KeyRound, Pencil, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert, EmptyState } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { Modal } from '@/components/ui/Modal';
import { fmtDateTime } from '@/lib/format';
import { Can, useAuth } from '@/lib/auth';
import { useApi, useApiMutation } from '@/lib/hooks';
import { useBranches } from './BranchesPage';
import { Role, useRoles } from './RolesPage';

interface Member {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: 'active' | 'suspended';
  allBranches: boolean;
  branchIds: string[];
  lastLoginAt: string | null;
  role: { id: string; name: string; key: string | null };
}

function BranchPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const branches = useBranches();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {branches.data?.map((b) => (
        <Checkbox
          key={b.id}
          label={b.name}
          checked={value.includes(b.id)}
          onChange={(e) => onChange(e.target.checked ? [...value, b.id] : value.filter((x) => x !== b.id))}
        />
      ))}
    </div>
  );
}

function UserForm({ member, roles, onDone }: { member: Member | null; roles: Role[]; onDone: () => void }) {
  const { t } = useTranslation();
  const form = useForm({
    defaultValues: {
      email: member?.email ?? '',
      fullName: member?.fullName ?? '',
      phone: member?.phone ?? '',
      password: '',
      roleId: member?.role.id ?? roles.find((r) => r.key === 'sales_rep')?.id ?? '',
      allBranches: member?.allBranches ?? false,
      branchIds: member?.branchIds ?? [],
      status: member?.status ?? 'active',
    },
  });
  const save = useApiMutation<Record<string, unknown>>({
    path: member ? `/users/${member.membershipId}` : '/users',
    method: member ? 'PATCH' : 'POST',
    invalidate: [['users']],
    onSuccess: onDone,
  });
  const allBranches = form.watch('allBranches');
  const submit = form.handleSubmit((v) => {
    const payload: Record<string, unknown> = member
      ? {
          roleId: v.roleId,
          allBranches: v.allBranches,
          branchIds: v.allBranches ? [] : v.branchIds,
          status: v.status,
        }
      : { ...v, phone: v.phone || null, branchIds: v.allBranches ? [] : v.branchIds };
    if (!member) delete payload.status;
    save.mutate(payload);
  });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
      <Field label={t('users.fullName')} required>
        {(id) => <Input id={id} disabled={!!member} {...form.register('fullName', { required: true })} />}
      </Field>
      <Field label={t('common.email')} required>
        {(id) => (
          <Input
            id={id}
            type="email"
            dir="ltr"
            disabled={!!member}
            {...form.register('email', { required: true })}
          />
        )}
      </Field>
      {!member && (
        <>
          <Field label={t('common.phone')}>
            {(id) => <Input id={id} dir="ltr" {...form.register('phone')} />}
          </Field>
          <Field label={t('users.initialPassword')} hint={t('auth.passwordRules')} required>
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                type="password"
                autoComplete="new-password"
                dir="ltr"
                {...form.register('password', { required: true })}
              />
            )}
          </Field>
          <Alert tone="info" className="sm:col-span-2">
            {t('users.existingAccountNote')}
          </Alert>
        </>
      )}
      <Field label={t('users.role')} required>
        {(id) => (
          <Select id={id} {...form.register('roleId', { required: true })}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {member && (
        <Field label={t('common.status')}>
          {(id) => (
            <Select id={id} {...form.register('status')}>
              <option value="active">{t('common.active')}</option>
              <option value="suspended">{t('common.suspended')}</option>
            </Select>
          )}
        </Field>
      )}
      <div className="space-y-3 sm:col-span-2">
        <Checkbox label={t('users.allBranches')} {...form.register('allBranches')} />
        {!allBranches && (
          <div className="rounded-xl border border-line p-3">
            <p className="label">{t('users.branches')}</p>
            <BranchPicker
              value={form.watch('branchIds')}
              onChange={(v) => form.setValue('branchIds', v, { shouldDirty: true })}
            />
          </div>
        )}
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

function ResetPassword({ member, onDone }: { member: Member; onDone: () => void }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState('');
  const reset = useApiMutation<{ newPassword: string }>({
    path: `/users/${member.membershipId}/reset-password`,
    onSuccess: onDone,
  });
  return (
    <div className="space-y-4">
      <Field label={t('auth.newPassword')} hint={t('auth.passwordRules')}>
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          loading={reset.isPending}
          disabled={pw.length < 10}
          onClick={() => reset.mutate({ newPassword: pw })}
        >
          {t('users.resetPassword')}
        </Button>
      </div>
    </div>
  );
}

export function UsersPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const q = useApi<Member[]>(['users'], '/users');
  const roles = useRoles();
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [resetting, setResetting] = useState<Member | null>(null);
  return (
    <>
      <PageHeader
        title={t('users.title')}
        actions={
          <Can perm="users.manage">
            <Button
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setEditing('new')}
              disabled={!roles.data}
            >
              {t('users.add')}
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
          rowKey={(m) => m.membershipId}
          empty={<EmptyState icon={<Users className="h-5 w-5" />} title={t('common.noData')} />}
          columns={[
            {
              key: 'name',
              header: t('users.fullName'),
              cell: (m) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {m.fullName}{' '}
                    {m.userId === me?.user.id && (
                      <span className="text-xs text-muted">({t('users.you')})</span>
                    )}
                  </p>
                  <p className="num truncate text-xs text-muted">{m.email}</p>
                </div>
              ),
            },
            { key: 'role', header: t('users.role'), cell: (m) => <Badge tone="info">{m.role.name}</Badge> },
            {
              key: 'branches',
              header: t('users.branches'),
              hideOnMobile: true,
              cell: (m) =>
                m.allBranches ? t('common.allBranches') : <span className="num">{m.branchIds.length}</span>,
            },
            {
              key: 'last',
              header: t('users.lastLogin'),
              hideOnMobile: true,
              cell: (m) => <span className="text-muted">{fmtDateTime(m.lastLoginAt)}</span>,
            },
            {
              key: 'status',
              header: t('common.status'),
              cell: (m) => (
                <Badge tone={m.status === 'active' ? 'success' : 'danger'}>
                  {m.status === 'active' ? t('common.active') : t('common.suspended')}
                </Badge>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">{t('common.actions')}</span>,
              align: 'end',
              cell: (m) =>
                m.userId !== me?.user.id && (
                  <Can perm="users.manage">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Pencil className="h-3.5 w-3.5" />}
                        onClick={() => setEditing(m)}
                      >
                        {t('common.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<KeyRound className="h-3.5 w-3.5" />}
                        onClick={() => setResetting(m)}
                        aria-label={t('users.resetPassword')}
                      />
                    </div>
                  </Can>
                ),
            },
          ]}
        />
      </Card>
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('users.add') : t('users.edit')}
        size="lg"
      >
        {editing !== null && roles.data && (
          <UserForm
            member={editing === 'new' ? null : editing}
            roles={roles.data}
            onDone={() => setEditing(null)}
          />
        )}
      </Modal>
      <Modal
        open={!!resetting}
        onClose={() => setResetting(null)}
        title={t('users.resetPassword')}
        description={resetting?.email}
        size="sm"
      >
        {resetting && <ResetPassword member={resetting} onDone={() => setResetting(null)} />}
      </Modal>
    </>
  );
}
