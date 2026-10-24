import { useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Alert, errorMessage, PageLoader } from '@/components/ui/Feedback';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PendingInvitations } from './Invitations';

export function SelectCompanyPage() {
  const { t } = useTranslation();
  const { me, loading, signOut } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace />;

  const choose = async (tenantId: string) => {
    setBusy(tenantId);
    setError(null);
    try {
      await api('/auth/switch-tenant', { method: 'POST', body: { tenantId } });
      // Keep the live 'me' query (AuthProvider observes it) and refetch it for the new company;
      // qc.clear() would remove it, leaving nothing to refetch and the guards on the old company.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      await qc.refetchQueries({ queryKey: ['me'] });
      navigate('/app', { replace: true });
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <Card className="w-full max-w-md p-6">
        <h1 className="text-xl font-semibold">{t('auth.selectCompany')}</h1>
        <p className="mt-1 text-sm text-muted">
          {me.tenants.length ? t('auth.selectCompanyHint') : t('auth.noCompany')}
        </p>
        {error && (
          <Alert tone="danger" className="mt-4">
            {error}
          </Alert>
        )}
        {/* Accepting an invitation adds the company to the list below. */}
        <PendingInvitations />
        <ul className="mt-5 space-y-2">
          {me.tenants.map((ten) => (
            <li key={ten.tenantId}>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => choose(ten.tenantId)}
                className="flex w-full items-center gap-3 rounded-xl border border-line px-4 py-3 text-start hover:border-brand hover:bg-brand-soft/40 disabled:opacity-60"
              >
                <Building2 className="h-5 w-5 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{ten.name}</span>
                  <span className="num block text-xs text-muted">{ten.slug}</span>
                </span>
                {me.tenant?.id === ten.tenantId && <span className="text-xs text-success">●</span>}
                <ChevronLeft className="h-4 w-4 text-muted ltr:rotate-180" />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-between">
          {me.user.isPlatformAdmin && (
            <Button variant="secondary" onClick={() => navigate('/platform')}>
              {t('nav.platform')}
            </Button>
          )}
          <Button variant="ghost" onClick={async () => (await signOut(), navigate('/login'))}>
            {t('auth.signOut')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
