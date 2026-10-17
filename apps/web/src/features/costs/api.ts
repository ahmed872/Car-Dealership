import { useTranslation } from 'react-i18next';
import {
  convert,
  CurrencyCode,
  d,
  money,
  MONEY_REGEX,
  PAYMENT_METHODS,
  RATE_REGEX,
  RoundingMode,
} from '@autohub/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

export type CostStatus = 'pending_approval' | 'posted' | 'reversed' | 'rejected';
export type CostSource = 'acquisition' | 'manual' | 'work_order_item' | 'allocation' | 'trade_in';
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface CostCategory {
  id: string;
  tenantId: string | null;
  code: string;
  nameEn: string;
  nameAr: string;
  kind: 'vehicle' | 'operating';
  isSystem: boolean;
  isActive: boolean;
}

/** A row of `vehicle_costs` as returned by POST /vehicle-costs and friends. */
export interface VehicleCostRow {
  id: string;
  vehicleId: string;
  categoryId: string;
  description: string;
  amount: string;
  currency: CurrencyCode;
  exchangeRate: string;
  amountBase: string;
  costDate: string;
  supplierId: string | null;
  status: CostStatus;
  sourceType: CostSource;
  sourceId: string | null;
  batchId: string | null;
  allocationMethod: string | null;
  postSale: boolean;
  reversedAt: string | null;
  reversalReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** GET /vehicles/:id/costs item: the cost row plus category, supplier, maker and amount paid. */
export interface VehicleCostItem extends VehicleCostRow {
  categoryCode: string;
  categoryEn: string;
  categoryAr: string;
  supplierName: string | null;
  createdByName: string | null;
  /** Paid in base currency; null for the purchase price (settled through the acquisition). */
  paidBase: string | null;
}

export interface VehicleCostSummary {
  vehicleId: string;
  currency: CurrencyCode;
  totals: { posted: string; pending: string; purchase: string; additional: string; postSale: string };
  costLockedAt: string | null;
  byCategory: Array<{ code: string; nameEn: string; nameAr: string; total: string }>;
  expectedAtAskingPrice: {
    price: string;
    net: string;
    tax: string;
    grossProfit: string;
    marginPct: string | null;
  } | null;
  items: VehicleCostItem[];
}

export interface CashAccountOption {
  id: string;
  type: 'cashbox' | 'bank';
  name: string;
  currency: CurrencyCode;
  branchId: string | null;
}

export interface SupplierLite {
  id: string;
  name: string;
  phone?: string | null;
  type?: string;
  isActive?: boolean;
}

export const useCostCategories = () =>
  useApi<CostCategory[]>(['cost-categories'], '/cost-categories', undefined, { staleTime: 10 * 60_000 });

/** Vehicle cost categories that can be recorded manually (the purchase price comes from the acquisition). */
export function useVehicleCategories() {
  const q = useCostCategories();
  const list = q.data?.filter((c) => c.kind === 'vehicle' && c.code !== 'purchase') ?? [];
  return { ...q, list };
}

export const useCashAccountOptions = (enabled = true) =>
  useApi<CashAccountOption[]>(
    ['cash-accounts', 'options'],
    enabled ? '/cash-accounts/options' : null,
    undefined,
    { staleTime: 60_000 },
  );

export const useVehicleCosts = (vehicleId: string | null | undefined, enabled = true) =>
  useApi<VehicleCostSummary>(
    ['vehicle-costs', vehicleId],
    vehicleId && enabled ? `/vehicles/${vehicleId}/costs` : null,
  );

export function categoryName(
  c: { nameEn: string; nameAr: string } | { categoryEn: string; categoryAr: string },
  lang: string,
): string {
  if ('nameEn' in c) return lang === 'en' ? c.nameEn : c.nameAr;
  return lang === 'en' ? c.categoryEn : c.categoryAr;
}

/** Tenant "today" (ISO date) and rounding mode, as the server uses them. */
export function useTenantDefaults() {
  const { me, currency } = useAuth();
  const tz = me?.tenant?.settings.timezone ?? 'UTC';
  const rounding: RoundingMode = me?.tenant?.settings.rounding ?? 'half_up';
  return { tz, rounding, base: currency };
}

export const isMoney = (v: string) => MONEY_REGEX.test(v.trim());
export const isPositiveMoney = (v: string) => isMoney(v) && d(v.trim()).gt(0);
export const isRate = (v: string) => RATE_REGEX.test(v.trim()) && d(v.trim()).gt(0);

/** Base-currency equivalent for preview (the server converts again on save). */
export function previewBase(
  amount: string,
  rate: string,
  base: CurrencyCode,
  mode: RoundingMode,
): string | null {
  if (!isMoney(amount) || !isRate(rate)) return null;
  try {
    return convert(amount.trim(), rate.trim(), base, mode);
  } catch {
    return null;
  }
}

export function safeMoney(v: string, currency: CurrencyCode): string | null {
  if (!isMoney(v)) return null;
  return money(v.trim(), currency);
}

// ── Server validation errors ───────────────────────────────────────────────────────────────

interface Issue {
  path: string;
  message: string;
  code: string;
}

/** Maps zod issue codes (when the message is zod's English default) to our validation keys. */
const CODE_KEYS: Record<string, string> = {
  too_small: 'too_short',
  too_big: 'too_long',
  invalid_type: 'required',
  invalid_format: 'invalid_value',
  invalid_value: 'invalid_value',
};

/** Field → translated message, from a 422 validation_failed response. */
export function useServerFieldErrors() {
  const { t } = useTranslation();
  const text = (msg: string, code?: string) => {
    if (/^[a-z_]+$/.test(msg)) {
      const tr = t(`costs.validation.${msg}`, { defaultValue: '' });
      if (tr) return tr;
    }
    const key = code ? CODE_KEYS[code] : undefined;
    return key ? t(`costs.validation.${key}`) : msg;
  };
  return {
    text,
    fromError(err: unknown): Record<string, string> {
      if (!(err instanceof ApiError) || err.code !== 'validation_failed') return {};
      const issues = ((err.details?.issues as Issue[] | undefined) ?? []).filter(
        (i) => typeof i.path === 'string',
      );
      const out: Record<string, string> = {};
      for (const i of issues) if (!(i.path in out)) out[i.path] = text(i.message, i.code);
      return out;
    },
  };
}

/** True when a decision was refused because the caller is a maker of the document (maker-checker). */
export const isSelfApproval = (e: unknown) => e instanceof ApiError && e.code === 'self_approval_forbidden';
