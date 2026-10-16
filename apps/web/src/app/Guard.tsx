import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Permission } from '@autohub/shared';
import { EmptyState } from '@/components/ui/Feedback';
import { useAuth } from '@/lib/auth';

/** Client-side gate for better UX; the API enforces the same permissions. */
export function Guard({ anyOf, children }: { anyOf: Permission[]; children: ReactNode }) {
  const { canAny } = useAuth();
  const { t } = useTranslation();
  if (!canAny(...anyOf)) return <EmptyState title={t('errors.forbidden')} />;
  return <>{children}</>;
}
