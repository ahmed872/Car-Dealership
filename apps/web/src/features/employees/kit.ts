import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';

type Issue = { path: ReadonlyArray<PropertyKey> | string; message: string; code: string };

const pathOf = (i: Issue) => (Array.isArray(i.path) ? i.path.map(String).join('.') : String(i.path));

/**
 * Maps the English messages of `validateCommissionRule` (a superRefine on the rule, without a
 * path) to a field and a message code of this feature.
 */
function ruleMessage(message: string, prefix: string): [string, string] | null {
  const tier = /^tiers\[(\d+)\]\.ratePct must be 0\.\.100$/.exec(message);
  if (tier) return [`${prefix}tiers.${tier[1]}.ratePct`, 'rateRange'];
  if (message === 'ratePct must be 0..100') return [`${prefix}ratePct`, 'rateRange'];
  if (message === 'fixedAmount must be >= 0') return [`${prefix}fixedAmount`, 'fixedRequired'];
  if (message === 'tiers required') return [`${prefix}tiers`, 'tiersRequired'];
  if (message === 'tiers must be strictly ascending') return [`${prefix}tiers`, 'tiersAscending'];
  if (message === 'first tier must start at 0') return [`${prefix}tiers`, 'firstTierZero'];
  if (message === 'minAmount > capAmount') return [`${prefix}minAmount`, 'minAboveCap'];
  return null;
}

function issueCode(i: Issue): string {
  if (i.message && /^[a-z_]+$/.test(i.message)) return i.message;
  if (i.code === 'too_small') return 'tooSmall';
  if (i.code === 'too_big') return 'tooBig';
  return 'invalid';
}

/** Field → message code from zod issues; rule issues are keyed relative to `rulePrefix`. */
export function issuesToFields(issues: ReadonlyArray<Issue>, rulePrefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const path = pathOf(i);
    const mapped = (path === '' || path === rulePrefix.replace(/\.$/, '')) && i.code === 'custom' ? ruleMessage(i.message, rulePrefix) : null;
    const [k, v] = mapped ?? [path, issueCode(i)];
    if (k && !out[k]) out[k] = v;
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
  return issuesToFields(issues, 'rule.');
}

/** Translates a field message code (validation code or server error code). */
export function useEmpFieldMessage() {
  const { t } = useTranslation();
  return useCallback(
    (code: string | undefined | null): string | null => {
      if (!code) return null;
      return (
        t(`employees.validation.${code}`, { defaultValue: '' }) ||
        t(`employees.errors.${code}`, { defaultValue: '' }) ||
        t(`errors.${code}`, { defaultValue: '' }) ||
        t('employees.validation.invalid')
      );
    },
    [t],
  );
}

/** Server error → message: this feature's codes first (with their details), then the app-wide ones. */
export function useEmpError() {
  const { t } = useTranslation();
  return useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        if (err.code === 'version_overlap' && typeof err.details?.latestEffectiveFrom === 'string') {
          return t('employees.policies.mustStartAfter', { date: fmtDate(err.details.latestEffectiveFrom) });
        }
        const own = t(`employees.errors.${err.code}`, { defaultValue: '' });
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
  /** Toast the error (default). Forms that show it inline pass false. */
  toastError?: boolean;
}

/** Like `useApiMutation`, with errors translated through this feature's error codes. */
export function useEmpMutation<TVars = unknown, TRes = unknown>(opts: MutationOpts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  const describe = useEmpError();
  return useMutation<TRes, unknown, TVars>({
    mutationFn: (vars) => {
      const path = typeof opts.path === 'function' ? opts.path(vars) : opts.path;
      return api<TRes>(path, { method: opts.method ?? 'POST', body: vars ?? {} });
    },
    onSuccess: async (res, vars) => {
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg = typeof opts.success === 'function' ? opts.success(res) : opts.success === undefined ? t('common.savedSuccessfully') : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars);
    },
    onError: (err) => {
      if (opts.toastError !== false) toast.error(describe(err));
    },
  });
}
