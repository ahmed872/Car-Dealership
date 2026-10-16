import { useMutation, useQuery, useQueryClient, UseQueryOptions } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { errorMessage } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { api, RequestOptions } from './api';

export function useApi<T>(
  key: unknown[],
  path: string | null,
  query?: RequestOptions['query'],
  opts: Partial<UseQueryOptions<T>> = {},
) {
  return useQuery<T>({
    queryKey: [...key, query ?? null],
    queryFn: ({ signal }) => api<T>(path!, { query, signal }),
    enabled: path !== null && (opts.enabled ?? true),
    ...opts,
  } as UseQueryOptions<T>);
}

interface MutationOpts<TVars, TRes> {
  path: string | ((vars: TVars) => string);
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  invalidate?: unknown[][];
  success?: string | ((res: TRes) => string | null) | null;
  onSuccess?: (res: TRes, vars: TVars) => void;
  /** Send an Idempotency-Key (financial operations). One key per user action. */
  idempotent?: boolean;
  body?: (vars: TVars) => unknown;
}

/** Mutation with consistent toasts, cache invalidation and server error translation. */
export function useApiMutation<TVars = unknown, TRes = unknown>(opts: MutationOpts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  return useMutation<TRes, unknown, TVars & { __idemKey?: string }>({
    mutationFn: (vars) => {
      const { __idemKey, ...rest } = vars as TVars & { __idemKey?: string };
      const path = typeof opts.path === 'function' ? opts.path(rest as TVars) : opts.path;
      const body = opts.body ? opts.body(rest as TVars) : opts.method === 'DELETE' ? undefined : rest;
      return api<TRes>(path, {
        method: opts.method ?? 'POST',
        body,
        idempotencyKey: opts.idempotent ? __idemKey : undefined,
      });
    },
    onSuccess: async (res, vars) => {
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg =
        typeof opts.success === 'function'
          ? opts.success(res)
          : opts.success === undefined
            ? t('common.savedSuccessfully')
            : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars as TVars);
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });
}

/** List state (page, sort, filters) persisted in the URL so views are shareable and back-button friendly. */
export function useListParams(defaults: Record<string, string> = {}) {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? defaults[k] ?? '';
  const set = useCallback(
    (updates: Record<string, string | number | null | undefined>, resetPage = true) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === undefined || v === '') next.delete(k);
            else next.set(k, String(v));
          }
          if (resetPage && !('page' in updates)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const page = Number(get('page') || '1');
  const pageSize = Number(get('pageSize') || '25');
  return { get, set, page, pageSize, params };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
