import type { LucideIcon } from 'lucide-react';
import { Boxes, HandCoins, Landmark, TrendingUp, Users } from 'lucide-react';
import { REPORT_KEYS, type Permission, type ReportKey, type ReportResult } from '@autohub/shared';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';

export type { ReportCell, ReportColumn, ReportKey, ReportResult, ReportSummaryItem } from '@autohub/shared';

/** GET /dashboard — every block is present only when the caller holds its permission. */
export interface DashboardData {
  period: { from: string; to: string };
  branchId: string | null;
  generatedAt: string;
  inventory?: {
    onHand: number;
    available: number;
    reservedOrPending: number;
    agedWarning: number;
    agedCritical: number;
    staleDaysWarning: number;
    staleDaysCritical: number;
    /** Only with vehicles.view_cost. */
    inventoryValue?: string;
  };
  sales?: {
    scope: 'own' | 'all';
    units: number;
    netRevenue: string;
    /** Only with vehicles.view_cost. */
    grossProfit?: string;
    drafts: number;
    awaitingApproval: number;
    awaitingDelivery: number;
    monthly: Array<{ month: string; units: number; netRevenue: string; grossProfit?: string }>;
  };
  leads?: {
    scope: 'own' | 'all';
    open: number;
    newInPeriod: number;
    wonInPeriod: number;
    followUpsDue: number;
    conversionPct: string | null;
  };
  appointments?: { today: number };
  cash?: { balanceBase: string; accounts: number };
  receivables?: {
    total: string;
    /** null for branch-scoped runs (deposits carry no branch). */
    customerAdvances: string | null;
    overdueInstallments: string;
    plansOverdue: number;
  };
  approvals?: { pending: number; byType: Record<string, number> };
}

export type ReportFilter =
  | 'period'
  | 'asOf'
  | 'branch'
  | 'salesGroupBy'
  | 'leadsGroupBy'
  | 'status'
  | 'bucket'
  | 'source'
  | 'paymentType'
  | 'salesperson'
  | 'cashAccount';

export interface ReportDef {
  key: ReportKey;
  /** i18n key segment under reports.catalog. */
  i18nKey: 'inventory' | 'sales' | 'leads' | 'cashFlow' | 'receivables';
  kind: 'operational' | 'financial';
  /** ALL of these are required (mirrors the API route guards). */
  perms: Permission[];
  icon: LucideIcon;
  /** Filters the report's query schema accepts, in display order. */
  filters: ReportFilter[];
}

/** The five reports of GET /reports/:key, with the permissions the API enforces for each. */
export const REPORTS: ReportDef[] = [
  { key: 'inventory', i18nKey: 'inventory', kind: 'operational', perms: ['reports.view', 'vehicles.read'], icon: Boxes, filters: ['branch', 'status', 'bucket'] },
  {
    key: 'sales',
    i18nKey: 'sales',
    kind: 'operational',
    perms: ['reports.view'],
    icon: HandCoins,
    filters: ['period', 'branch', 'salesGroupBy', 'paymentType', 'salesperson'],
  },
  { key: 'leads', i18nKey: 'leads', kind: 'operational', perms: ['reports.view'], icon: Users, filters: ['period', 'branch', 'leadsGroupBy', 'source'] },
  { key: 'cash-flow', i18nKey: 'cashFlow', kind: 'financial', perms: ['reports.financial', 'cash.read'], icon: Landmark, filters: ['period', 'branch', 'cashAccount'] },
  { key: 'receivables', i18nKey: 'receivables', kind: 'financial', perms: ['reports.financial'], icon: TrendingUp, filters: ['asOf', 'branch'] },
];

export const isReportKey = (k: string | undefined): k is ReportKey => !!k && (REPORT_KEYS as readonly string[]).includes(k);
export const reportDef = (k: ReportKey): ReportDef => REPORTS.find((r) => r.key === k)!;

/** The reports the signed-in user may open (UX only — the API enforces the same rules). */
export function useAllowedReports(): ReportDef[] {
  const { can } = useAuth();
  return REPORTS.filter((r) => can(...r.perms));
}

/** Detail routes registered by other features, used for report drill-down (vehicle, sale, cash account, lead). */
export const DRILL_DOWN: Record<NonNullable<ReportResult['drillDown']>['kind'], { path: (id: string) => string; perm: Permission }> = {
  vehicle: { path: (id) => `/app/vehicles/${id}`, perm: 'vehicles.read' },
  sale: { path: (id) => `/app/sales/${id}`, perm: 'sales.read' },
  cash_account: { path: (id) => `/app/cash/accounts/${id}`, perm: 'cash.read' },
  lead: { path: (id) => `/app/leads/${id}`, perm: 'leads.read' },
};

export interface BranchOption {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
}

/**
 * Branches the user may filter by: every branch for all-branch users, their own branches when
 * they have more than one, and none (no selector) otherwise.
 */
export function useBranchOptions(): { branches: BranchOption[]; show: boolean } {
  const { me } = useAuth();
  const multi = !!me && (me.allBranches || me.branchIds.length > 1);
  const q = useApi<BranchOption[]>(['branches'], multi ? '/branches' : null, undefined, { staleTime: 5 * 60_000 });
  const all = q.data ?? [];
  const branches = me?.allBranches ? all : all.filter((b) => me?.branchIds.includes(b.id));
  return { branches, show: multi && branches.length > 1 };
}

export interface CashAccountOption {
  id: string;
  name: string;
  currency: string;
  isActive: boolean;
  branchId: string | null;
}

export interface MemberOption {
  userId: string;
  fullName: string;
  status: 'active' | 'suspended';
}
