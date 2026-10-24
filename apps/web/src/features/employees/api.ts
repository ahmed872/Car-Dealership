import { useTranslation } from 'react-i18next';
import { SYSTEM_ROLES } from '@autohub/shared';
import type { CommissionEarnOn, CommissionRule } from '@autohub/shared';
import { useApi } from '@/lib/hooks';

export interface EmployeeProfile {
  id: string;
  userId: string;
  employeeCode: string | null;
  jobTitle: string | null;
  phone: string | null;
  hireDate: string | null;
  monthlyTargetUnits: number | null;
  monthlyTargetAmount: string | null;
  commissionPolicyId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /employees item. */
export interface EmployeeRow {
  userId: string;
  fullName: string;
  email: string;
  membershipStatus: 'active' | 'suspended';
  roleName: string;
  roleKey: string | null;
  profile: EmployeeProfile | null;
  policyCode: string | null;
  policyName: string | null;
}

/** A stored commission rule (the API fills `earnOn` with its default). */
export type StoredRule = CommissionRule & { earnOn?: CommissionEarnOn };

/** One version of a commission policy (a commission_policies row). */
export interface PolicyVersion {
  id: string;
  code: string;
  version: number;
  name: string;
  rule: StoredRule;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  supersededById: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** GET /employees/:userId */
export interface EmployeeDetail extends EmployeeRow {
  commissionPolicy: PolicyVersion | null;
}

/** GET /commission-policies item (one per policy code). */
export interface PolicyGroup {
  code: string;
  name: string;
  isActive: boolean;
  current: PolicyVersion | null;
  scheduled: PolicyVersion[];
  latestVersion: number;
  versions?: PolicyVersion[];
}

/** POST /commission-policies/preview */
export interface PreviewResult {
  rule: StoredRule;
  result: { base: string; amount: string; explanation: string };
}

export const useEmployees = () => useApi<EmployeeRow[]>(['employees', 'list'], '/employees');
export const useEmployee = (userId: string | null | undefined) => useApi<EmployeeDetail>(['employees', 'detail', userId], userId ? `/employees/${userId}` : null);
export const usePolicies = (enabled = true) =>
  useApi<PolicyGroup[]>(['commission-policies', 'list'], enabled ? '/commission-policies' : null, { includeHistory: 'true' });

/** The version an assignment should point at: today's version, else the next scheduled one, else the latest. */
export function assignableVersion(p: PolicyGroup): PolicyVersion | null {
  return p.current ?? p.scheduled[0] ?? p.versions?.[0] ?? null;
}

export type VersionState = 'current' | 'scheduled' | 'ended' | 'inactive';

export function versionState(v: PolicyVersion, today: string): VersionState {
  if (!v.isActive) return 'inactive';
  if (v.effectiveFrom > today) return 'scheduled';
  if (v.effectiveTo && v.effectiveTo < today) return 'ended';
  return 'current';
}

/**
 * A role's name in the current language. The API returns the stored name only; a system role whose
 * name was never changed is shown with its Arabic or English template name, a renamed one as stored.
 */
export function useRoleLabel() {
  const { i18n } = useTranslation();
  const en = i18n.language === 'en';
  return (e: { roleKey: string | null; roleName: string }): string => {
    const tpl = e.roleKey ? (SYSTEM_ROLES as Record<string, { nameEn: string; nameAr: string } | undefined>)[e.roleKey] : undefined;
    if (!tpl || (e.roleName !== tpl.nameAr && e.roleName !== tpl.nameEn)) return e.roleName;
    return en ? tpl.nameEn : tpl.nameAr;
  };
}
