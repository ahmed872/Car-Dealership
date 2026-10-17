import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Detail values the API attaches to purchasing errors, usable as {{placeholders}} in messages. */
const DETAIL_KEYS = ['available', 'required', 'date', 'outstanding', 'currency', 'paymentBase', 'allocated', 'paid', 'vehicleStatus', 'maxRows', 'currentVersion'];

/**
 * Translates an API error: purchasing domain codes (self_approval_forbidden, allocation_mismatch,
 * overpayment, …) from the purchasing namespace, then the global errors.* table, then the server's
 * own message.
 */
export function purchasingErrorMessage(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const vars: Record<string, unknown> = { defaultValue: '' };
    for (const k of DETAIL_KEYS) {
      const v = err.details?.[k];
      if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
    }
    const own = t(`purchasing.errors.${err.code}`, vars);
    if (own) return own;
  }
  return errorMessage(err, t);
}

export function usePurchasingError() {
  const { t } = useTranslation();
  return useCallback((err: unknown) => purchasingErrorMessage(err, t as T), [t]);
}

/** The document a payment error refers to ("acquisition:<uuid>"), when the API names one. */
export function errorTarget(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const target = err.details?.target;
  return typeof target === 'string' ? target : null;
}

interface Opts<TVars, TRes> {
  path: string | ((vars: TVars) => string);
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  invalidate?: unknown[][];
  success?: string | ((res: TRes) => string | null) | null;
  onSuccess?: (res: TRes, vars: TVars) => void;
  /** Send an Idempotency-Key (financial operations). One key per user action. */
  idempotent?: boolean;
}

/**
 * Same contract as useApiMutation (@/lib/hooks): toasts, cache invalidation and an Idempotency-Key
 * per user action, but error toasts translate purchasing domain codes (see purchasingErrorMessage).
 */
export function usePurchasingMutation<TVars = unknown, TRes = unknown>(opts: Opts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  return useMutation<TRes, unknown, TVars & { __idemKey?: string }>({
    mutationFn: (vars) => {
      const { __idemKey, ...rest } = vars as TVars & { __idemKey?: string };
      const path = typeof opts.path === 'function' ? opts.path(rest as TVars) : opts.path;
      return api<TRes>(path, {
        method: opts.method ?? 'POST',
        body: opts.method === 'DELETE' ? undefined : rest,
        idempotencyKey: opts.idempotent ? __idemKey : undefined,
      });
    },
    onSuccess: async (res, vars) => {
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg =
        typeof opts.success === 'function' ? opts.success(res) : opts.success === undefined ? t('common.savedSuccessfully') : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars as TVars);
    },
    onError: (err) => toast.error(purchasingErrorMessage(err, t as T)),
  });
}
