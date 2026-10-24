import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import type { CurrencyCode, MarketCode, Permission, TenantSettings } from '@autohub/shared';
import { api, ApiError, onAuthError } from './api';

export interface Me {
  user: { id: string; email: string; fullName: string; isPlatformAdmin: boolean };
  tenant: {
    id: string;
    name: string;
    slug: string;
    market: MarketCode;
    baseCurrency: CurrencyCode;
    settings: TenantSettings;
  } | null;
  role: { id: string; name: string; maxDiscountPct: string } | null;
  permissions: Permission[];
  allBranches: boolean;
  branchIds: string[];
  tenants: Array<{ tenantId: string; name: string; slug: string }>;
}

interface AuthValue {
  me: Me | null;
  loading: boolean;
  can: (...perms: Permission[]) => boolean;
  canAny: (...perms: Permission[]) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  currency: CurrencyCode;
}

const AuthCtx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(
    () =>
      onAuthError(() => {
        qc.setQueryData(['me'], null);
      }),
    [qc],
  );

  const me = meQuery.data ?? null;
  const perms = useMemo(() => new Set(me?.permissions ?? []), [me]);
  const refresh = useCallback(async () => {
    await qc.invalidateQueries();
    await qc.refetchQueries({ queryKey: ['me'] });
  }, [qc]);
  const signOut = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    // Sign the UI out on the live 'me' query first: its mounted observer drives every guard.
    // qc.clear() would remove that query from under the observer (which then keeps the old user,
    // so /login bounced straight back into the app); drop only the rest of the cache.
    qc.setQueryData(['me'], null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  }, [qc]);

  const value = useMemo<AuthValue>(
    () => ({
      me,
      loading: meQuery.isLoading,
      can: (...ps) => ps.every((p) => perms.has(p)),
      canAny: (...ps) => ps.some((p) => perms.has(p)),
      refresh,
      signOut,
      currency: me?.tenant?.baseCurrency ?? 'SAR',
    }),
    [me, meQuery.isLoading, perms, refresh, signOut],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Renders children only when the user holds all listed permissions (UI convenience — the server enforces). */
export function Can({
  perm,
  children,
  fallback = null,
}: {
  perm: Permission | Permission[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useAuth();
  const list = Array.isArray(perm) ? perm : [perm];
  return <>{can(...list) ? children : fallback}</>;
}
