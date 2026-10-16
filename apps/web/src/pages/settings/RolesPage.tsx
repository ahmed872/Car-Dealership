import { Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PERMISSIONS, Permission } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Alert } from '@/components/ui/Feedback';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { Can, useAuth } from '@/lib/auth';
import { useApi, useApiMutation } from '@/lib/hooks';

export interface Role {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  permissions: Permission[];
  maxDiscountPct: string;
  isSystem: boolean;
  memberCount: number;
}

export function useRoles() {
  return useApi<Role[]>(['roles'], '/roles');
}

const groups = Object.entries(PERMISSIONS).reduce<Record<string, Permission[]>>((acc, [k, v]) => {
  (acc[v.group] ??= []).push(k as Permission);
  return acc;
}, {});

function RoleEditor({ role, onDone }: { role: Role | null; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [discount, setDiscount] = useState(role?.maxDiscountPct ?? '0');
  const [perms, setPerms] = useState<Set<Permission>>(new Set(role?.permissions ?? []));
  const save = useApiMutation<Record<string, unknown>>({
    path: role ? `/roles/${role.id}` : '/roles',
    method: role ? 'PUT' : 'POST',
    invalidate: [['roles']],
    onSuccess: onDone,
  });
  const toggle = (p: Permission, on: boolean) =>
    setPerms((prev) => {
      const next = new Set(prev);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
        <Field label={t('common.name')} required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={t('roles.maxDiscount')}>
          {(id) => (
            <Input
              id={id}
              dir="ltr"
              className="num"
              inputMode="decimal"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('common.description')} className="sm:col-span-2">
          {(id) => (
            <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          )}
        </Field>
      </div>
      <Alert tone="info">{t('roles.escalationNote')}</Alert>
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(groups).map(([group, list]) => (
          <fieldset key={group} className="rounded-xl border border-line p-3">
            <legend className="px-1 text-[13px] font-semibold">{t(`roles.groups.${group}`)}</legend>
            <div className="mt-1 space-y-2">
              {list.map((p) => (
                <Checkbox
                  key={p}
                  label={i18n.language === 'en' ? PERMISSIONS[p].en : PERMISSIONS[p].ar}
                  description={<span className="num">{p}</span>}
                  checked={perms.has(p)}
                  disabled={!can(p)}
                  onChange={(e) => toggle(p, e.target.checked)}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          loading={save.isPending}
          disabled={name.trim().length < 2}
          onClick={() =>
            save.mutate({
              name,
              description: description || null,
              permissions: [...perms],
              maxDiscountPct: discount || '0',
            })
          }
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

export function RolesPage() {
  const { t } = useTranslation();
  const q = useRoles();
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const del = useApiMutation<{ id: string }>({
    path: (v) => `/roles/${v.id}`,
    method: 'DELETE',
    invalidate: [['roles']],
    success: t('common.deletedSuccessfully'),
    onSuccess: () => setDeleting(null),
  });
  const rows = useMemo(() => q.data, [q.data]);
  return (
    <>
      <PageHeader
        title={t('roles.title')}
        actions={
          <Can perm="roles.manage">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>
              {t('roles.add')}
            </Button>
          </Can>
        }
      />
      <Card>
        <DataTable
          rows={rows}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'name',
              header: t('common.name'),
              cell: (r) => (
                <div>
                  <p className="font-medium">{r.name}</p>
                  {r.description && <p className="text-xs text-muted">{r.description}</p>}
                </div>
              ),
            },
            {
              key: 'type',
              header: t('common.type'),
              cell: (r) =>
                r.isSystem ? (
                  <Badge tone="neutral">{t('roles.system')}</Badge>
                ) : (
                  <Badge tone="accent">custom</Badge>
                ),
            },
            {
              key: 'perms',
              header: t('roles.permissions'),
              cell: (r) => <span className="num">{r.permissions.length}</span>,
            },
            {
              key: 'discount',
              header: t('roles.maxDiscount'),
              hideOnMobile: true,
              cell: (r) => <span className="num">{Number(r.maxDiscountPct)}%</span>,
            },
            {
              key: 'members',
              header: t('roles.members'),
              cell: (r) => <span className="num">{r.memberCount}</span>,
            },
            {
              key: 'actions',
              header: <span className="sr-only">{t('common.actions')}</span>,
              align: 'end',
              cell: (r) =>
                r.key === 'owner' ? (
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted"
                    title={t('roles.ownerLocked')}
                  >
                    <Lock className="h-3.5 w-3.5" />
                  </span>
                ) : (
                  <Can perm="roles.manage">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Pencil className="h-3.5 w-3.5" />}
                        onClick={() => setEditing(r)}
                      >
                        {t('common.edit')}
                      </Button>
                      {!r.isSystem && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Trash2 className="h-3.5 w-3.5 text-danger" />}
                          onClick={() => setDeleting(r)}
                          aria-label={t('common.delete')}
                        />
                      )}
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
        title={editing === 'new' ? t('roles.add') : t('roles.edit')}
        size="xl"
      >
        {editing !== null && (
          <RoleEditor role={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        )}
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) del.mutate({ id: deleting.id });
        }}
        title={t('common.delete')}
        message={deleting?.name}
        tone="danger"
        loading={del.isPending}
      />
    </>
  );
}
