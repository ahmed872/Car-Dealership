import { useQueryClient } from '@tanstack/react-query';
import { MailPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { fmtDateTime } from '@/lib/format';
import { useApi, useApiMutation } from '@/lib/hooks';

export interface Invitation {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  roleName: string;
  invitedAt: string;
}

/** The signed-in user's pending company invitations (only they can accept or decline them). */
export function useInvitations() {
  return useApi<Invitation[]>(['invitations'], '/me/invitations', undefined, { staleTime: 60_000 });
}

/** Pending invitations with Accept / Decline. Renders nothing when there are none. */
export function PendingInvitations({ onAccepted }: { onAccepted?: (tenantId: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useInvitations();
  const respond = useApiMutation<{ id: string; action: 'accept' | 'decline' }, { ok: true; tenantId: string | null }>({
    path: (v) => `/me/invitations/${v.id}/${v.action}`,
    body: () => ({}),
    invalidate: [['invitations'], ['me']],
    success: null,
    onSuccess: (res) => {
      void qc.refetchQueries({ queryKey: ['me'] });
      if (res.tenantId) onAccepted?.(res.tenantId);
    },
  });
  const list = q.data ?? [];
  if (!list.length) return null;
  return (
    <section className="mt-5 rounded-xl border border-line p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <MailPlus className="h-4 w-4 text-muted" /> {t('auth.invitations')}
      </h2>
      <p className="mt-1 text-xs text-muted">{t('auth.invitationsHint')}</p>
      <ul className="mt-3 space-y-2">
        {list.map((inv) => (
          <li key={inv.membershipId} className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{inv.tenantName}</span>
              <span className="block text-xs text-muted">
                {t('auth.invitationRole', { role: inv.roleName })} · <span className="num">{fmtDateTime(inv.invitedAt)}</span>
              </span>
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: inv.membershipId, action: 'accept' })}
              >
                {t('auth.accept')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: inv.membershipId, action: 'decline' })}
              >
                {t('auth.decline')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
