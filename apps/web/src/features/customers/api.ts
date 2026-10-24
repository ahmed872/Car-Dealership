import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CUSTOMER_TYPES,
  CustomerDuplicate,
  INTERACTION_TYPES,
  LEAD_SOURCES,
  AssignablePermission,
} from '@autohub/shared';
import { errorMessage } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useAssignableMembers } from '@/lib/members';

export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export type LeadSource = (typeof LEAD_SOURCES)[number];
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Row of GET /customers. */
export interface CustomerListItem {
  id: string;
  type: CustomerType;
  fullName: string;
  companyName: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  nationalIdMasked: string | null;
  city: string | null;
  source: LeadSource | null;
  tags: string[];
  isActive: boolean;
  preferredLanguage: 'ar' | 'en';
  branchId: string | null;
  branchName: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  openLeads: number;
  lastInteractionAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** The customer record as the API presents it (the national ID only masked). */
export interface Customer {
  id: string;
  type: CustomerType;
  fullName: string;
  companyName: string | null;
  phone: string | null;
  phoneAlt: string | null;
  whatsapp: string | null;
  email: string | null;
  nationality: string | null;
  commercialRegistration: string | null;
  taxNumber: string | null;
  city: string | null;
  address: string | null;
  dateOfBirth: string | null;
  preferredLanguage: 'ar' | 'en';
  source: LeadSource | null;
  assignedUserId: string | null;
  branchId: string | null;
  marketingConsent: boolean;
  tags: string[];
  notes: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  nationalIdMasked: string | null;
  hasNationalId: boolean;
}

export interface Interaction {
  id: string;
  customerId?: string;
  leadId?: string | null;
  leadNumber?: string | null;
  vehicleId: string | null;
  vehicleStockNumber?: string | null;
  type: InteractionType;
  direction: 'inbound' | 'outbound' | null;
  summary: string;
  outcome: string | null;
  occurredAt: string;
  nextFollowUpAt: string | null;
  userId: string | null;
  userName: string | null;
  createdAt?: string;
}

export interface Customer360 {
  customer: Customer & { branchName: string | null; assignedUserName: string | null; createdByName: string | null };
  counts: {
    leads: number | null;
    openLeads: number | null;
    reservations: number | null;
    activeReservations: number | null;
    receipts: number | null;
    appointments: number | null;
    upcomingAppointments: number | null;
    wishes: number;
    activeWishes: number;
    interactions: number;
  };
  lastInteractionAt: string | null;
  advanceBalance: string | null;
  leads: Array<{
    id: string;
    number: string;
    status: 'open' | 'won' | 'lost';
    source: LeadSource;
    branchId: string;
    stageId: string;
    stageCode: string;
    stageNameEn: string;
    stageNameAr: string;
    assignedUserId: string | null;
    assignedUserName: string | null;
    vehicleId: string | null;
    vehicleStockNumber: string | null;
    budgetMin: string | null;
    budgetMax: string | null;
    expectedCloseDate: string | null;
    lastActivityAt: string | null;
    nextFollowUpAt: string | null;
    createdAt: string;
  }> | null;
  reservations: Array<{
    id: string;
    number: string;
    status: 'active' | 'converted' | 'expired' | 'cancelled';
    reservedAt: string;
    expiresAt: string;
    agreedPrice: string | null;
    depositAmount: string;
    receivedBase: string;
    vehicleId: string;
    stockNumber: string;
    modelYear: number;
    makeEn: string;
    makeAr: string;
    modelEn: string;
    modelAr: string;
    salesUserName: string | null;
  }> | null;
  receipts: Array<{
    id: string;
    number: string;
    status: 'posted' | 'voided';
    amount: string;
    amountBase: string;
    currency: string;
    receivedAt: string;
    method: string;
    cashAccountName: string | null;
    reference: string | null;
  }> | null;
  appointments: Array<{
    id: string;
    type: string;
    status: string;
    startsAt: string;
    endsAt: string;
    title: string | null;
    vehicleId: string | null;
    vehicleStockNumber: string | null;
    assignedUserName: string | null;
  }> | null;
  wishes: Array<{
    id: string;
    status: string;
    makeEn: string | null;
    makeAr: string | null;
    modelEn: string | null;
    modelAr: string | null;
    yearFrom: number | null;
    yearTo: number | null;
    maxPrice: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
  interactions: Interaction[];
}

export type DuplicateCandidate = CustomerDuplicate;
export interface DuplicateResult {
  candidates: DuplicateCandidate[];
  blocking: boolean;
  forceAllowed: boolean;
}

export const useCustomer = (id: string | undefined) =>
  useApi<Customer360>(['customer', id], id ? `/customers/${id}` : null);

// ── Members (assignees) ──────────────────────────────────────────────────────────────────

export interface Assignee {
  userId: string;
  fullName: string;
}

/**
 * Staff who can be given CRM work in a branch: active members whose role holds `perm` and who can
 * reach the branch (GET /members/assignable, open to every member; the API re-checks the same rule
 * when the work is assigned). Without a branch: everyone eligible within the caller's branches.
 */
export function useAssignees(opts: { branchId?: string | null; perm?: AssignablePermission; enabled?: boolean } = {}) {
  const q = useAssignableMembers(opts.perm ?? 'leads.read', opts.branchId, opts.enabled ?? true);
  const list = useMemo<Assignee[]>(() => (q.data ?? []).map((m) => ({ userId: m.id, fullName: m.fullName })), [q.data]);
  return { list, loading: q.isLoading };
}

// ── Errors ───────────────────────────────────────────────────────────────────────────────

type T = (key: string, opts?: Record<string, unknown>) => string;

const DETAIL_KEYS = ['openLeads', 'currentVersion', 'kind', 'status', 'vehicleStatus'];

/** Translates CRM domain error codes (customers.errors.*), then errors.*, then the server message. */
export function crmErrorMessage(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    const vars: Record<string, unknown> = { defaultValue: '' };
    for (const k of DETAIL_KEYS) {
      const v = err.details?.[k];
      if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
    }
    const reason = err.details?.reason;
    if (err.code === 'invalid_assignee' && typeof reason === 'string') {
      const r = t(`customers.errors.invalid_assignee_${reason}`, { defaultValue: '' });
      if (r) return r;
    }
    const own = t(`customers.errors.${err.code}`, vars);
    if (own) return own;
  }
  return errorMessage(err, t);
}

export function useCrmError() {
  const { t } = useTranslation();
  return useCallback((err: unknown) => crmErrorMessage(err, t as T), [t]);
}

/**
 * Field-level messages from a server error: zod issues (validation_failed) by path, and domain
 * errors that name a `field` (invalid_phone, invalid_national_id, …).
 */
export function fieldErrorsOf(err: unknown, t: T): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError)) return out;
  if (err.code === 'validation_failed') {
    const issues = (err.details?.issues ?? []) as Array<{ path: string; message: string; code: string }>;
    for (const i of issues) {
      if (!i.path || out[i.path]) continue;
      const known = t(`customers.errors.${i.message}`, { defaultValue: '' });
      out[i.path] = known || t(`customers.validation.${i.code}`, { defaultValue: t('customers.validation.invalid') });
    }
  } else if (typeof err.details?.field === 'string') {
    out[err.details.field] = crmErrorMessage(err, t);
  }
  return out;
}

interface MutationOpts<TVars, TRes> {
  path: string | ((vars: TVars) => string);
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  invalidate?: unknown[][];
  success?: string | ((res: TRes) => string | null) | null;
  onSuccess?: (res: TRes, vars: TVars) => void;
  /** Called instead of the error toast; return true when the error was shown in place. */
  onError?: (err: unknown, vars: TVars) => boolean | void;
  body?: (vars: TVars) => unknown;
}

/** Like useApiMutation, but error toasts translate CRM codes and callers can show errors inline. */
export function useCrmMutation<TVars = unknown, TRes = unknown>(opts: MutationOpts<TVars, TRes>) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();
  return useMutation<TRes, unknown, TVars>({
    mutationFn: (vars) => {
      const path = typeof opts.path === 'function' ? opts.path(vars) : opts.path;
      return api<TRes>(path, {
        method: opts.method ?? 'POST',
        body: opts.body ? opts.body(vars) : opts.method === 'DELETE' ? undefined : vars,
      });
    },
    onSuccess: async (res, vars) => {
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      const msg =
        typeof opts.success === 'function' ? opts.success(res) : opts.success === undefined ? t('common.savedSuccessfully') : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, vars);
    },
    onError: (err, vars) => {
      if (opts.onError?.(err, vars) === true) return;
      toast.error(crmErrorMessage(err, t as T));
    },
  });
}

// ── Formatting helpers ───────────────────────────────────────────────────────────────────

/** Stored phones are canonical digits with the country code ("966501234567"). */
export { fmtPhone } from '@/lib/format';

/** ISO instant → value for <input type="datetime-local"> (browser time). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const dt = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/** <input type="datetime-local"> value → ISO instant (null when empty). */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}
