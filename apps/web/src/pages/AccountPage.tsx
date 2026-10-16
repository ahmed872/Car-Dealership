import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { zPassword } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, DescriptionList } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/Layout';
import { useAuth } from '@/lib/auth';
import { useApiMutation } from '@/lib/hooks';

const schema = z
  .object({ currentPassword: z.string().min(1), newPassword: zPassword, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'passwordMismatch' });

export function AccountPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const change = useApiMutation<{ currentPassword: string; newPassword: string }>({
    path: '/auth/change-password',
    success: t('auth.passwordChanged'),
    onSuccess: () => form.reset(),
  });
  const err = (k: keyof z.infer<typeof schema>) => {
    const e = form.formState.errors[k];
    if (!e) return null;
    return e.message === 'passwordMismatch'
      ? t('auth.passwordMismatch')
      : k === 'newPassword'
        ? t('auth.passwordRules')
        : 'required';
  };
  return (
    <>
      <PageHeader title={t('account.title')} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={me?.user.fullName} subtitle={me?.user.email} />
          <CardBody>
            <DescriptionList
              items={[
                { label: t('nav.company'), value: me?.tenant?.name },
                { label: t('users.role'), value: me?.role?.name },
                {
                  label: t('roles.maxDiscount'),
                  value: <span className="num">{me?.role?.maxDiscountPct}%</span>,
                },
                {
                  label: t('users.branches'),
                  value: me?.allBranches ? t('common.allBranches') : me?.branchIds.length,
                },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('auth.changePassword')} subtitle={t('auth.passwordRules')} />
          <CardBody>
            <form
              className="space-y-4"
              noValidate
              onSubmit={form.handleSubmit((v) =>
                change.mutate({ currentPassword: v.currentPassword, newPassword: v.newPassword }),
              )}
            >
              <Field label={t('auth.currentPassword')} error={err('currentPassword')} required>
                {(id, d) => (
                  <Input
                    id={id}
                    aria-describedby={d}
                    type="password"
                    autoComplete="current-password"
                    dir="ltr"
                    {...form.register('currentPassword')}
                  />
                )}
              </Field>
              <Field label={t('auth.newPassword')} error={err('newPassword')} required>
                {(id, d) => (
                  <Input
                    id={id}
                    aria-describedby={d}
                    type="password"
                    autoComplete="new-password"
                    dir="ltr"
                    {...form.register('newPassword')}
                  />
                )}
              </Field>
              <Field label={t('auth.confirmPassword')} error={err('confirm')} required>
                {(id, d) => (
                  <Input
                    id={id}
                    aria-describedby={d}
                    type="password"
                    autoComplete="new-password"
                    dir="ltr"
                    {...form.register('confirm')}
                  />
                )}
              </Field>
              <Button type="submit" loading={change.isPending}>
                {t('auth.changePassword')}
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
