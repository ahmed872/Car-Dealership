import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';

type Issue = { path: ReadonlyArray<PropertyKey> | string; message: string; code: string };

/** A zod issue's machine code: our schemas use snake_case messages; built-in checks use the issue code. */
function issueCode(i: Issue): string {
  const path = Array.isArray(i.path) ? i.path.map(String).join('.') : String(i.path);
  if (i.code === 'custom' && path === 'makeId') return 'needCriterion';
  if (i.code === 'custom' && path === 'yearTo') return 'yearOrder';
  if (i.message && /^[a-z_]+$/.test(i.message)) return i.message;
  if (i.code === 'too_small') return 'tooSmall';
  if (i.code === 'too_big') return 'tooBig';
  return 'invalid';
}

/** Field → message code, from zod issues (client-side safeParse). */
export function issuesToFields(issues: ReadonlyArray<Issue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const path = Array.isArray(i.path) ? i.path.map(String).join('.') : String(i.path);
    if (path && !out[path]) out[path] = issueCode(i);
  }
  return out;
}

/** Field → message code, from a `validation_failed` response or a domain error naming a field. */
export function serverFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  if (err.code !== 'validation_failed') {
    const field = err.details?.field;
    return typeof field === 'string' ? { [field]: err.code } : {};
  }
  const issues = (err.details as { issues?: Issue[] } | undefined)?.issues ?? [];
  return issuesToFields(issues);
}

/** Translates a field message code (validation code or server error code). */
export function useWishFieldMessage() {
  const { t } = useTranslation();
  return useCallback(
    (code: string | undefined | null): string | null => {
      if (!code) return null;
      return (
        t(`wishes.validation.${code}`, { defaultValue: '' }) ||
        t(`wishes.errors.${code}`, { defaultValue: '' }) ||
        t(`errors.${code}`, { defaultValue: '' }) ||
        t('wishes.validation.invalid')
      );
    },
    [t],
  );
}

/** Server error → message: this feature's own codes first, then the app-wide ones. */
export function useWishError() {
  const { t } = useTranslation();
  return useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        const own = t(`wishes.errors.${err.code}`, { defaultValue: '' });
        if (own) return own;
      }
      return errorMessage(err, t);
    },
    [t],
  );
}

interface MutationOpts<TVars, TRes> {
  path: string | ((vars: TVars) => string);
  method?: 'POST' | 'PATCH' | 'PUT';
  invalidate?: unknown[][];
  success?: string | ((res: TRes) => string | null) | null;
  onSuccess?: (res: TRes, vars: TVars) => void;
  body?: (vars: TVars) => unknown;
}

/**
 * Like `useApiMutation`, but errors are translated with this feature's error codes (the server's
 * English message would otherwise reach Arabic users for wish-specific rules).
 */
export function useWishMutation<TVars = unknown, TRes = unknown>(opts: MutationOpts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  const describe = useWishError();
  return useMutation<TRes, unknown, TVars>({
    mutationFn: (vars) => {
      const path = typeof opts.path === 'function' ? opts.path(vars) : opts.path;
      return api<TRes>(path, { method: opts.method ?? 'POST', body: opts.body ? opts.body(vars) : (vars ?? {}) });
    },
    onSuccess: async (res, vars) => {
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg = typeof opts.success === 'function' ? opts.success(res) : opts.success === undefined ? t('common.savedSuccessfully') : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars);
    },
    onError: (err) => toast.error(describe(err)),
  });
}
