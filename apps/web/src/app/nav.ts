import type { LucideIcon } from 'lucide-react';
import { ArrowLeftRight, Building2, CarFront, ClipboardCheck, History, KeyRound, LayoutDashboard, Settings2, ShieldCheck, Users } from 'lucide-react';
import type { Permission } from '@autohub/shared';
import { FEATURE_MODULES } from '@/features/modules';
import type { NavGroupKey } from '@/features/registry';

export interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  /** Shown when the user holds ANY of these permissions. */
  anyOf?: Permission[];
  /** Company-wide pages (the API requires access to all branches): hidden for branch-scoped users. */
  companyWide?: boolean;
  end?: boolean;
}

export interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

/** Only modules that are actually implemented appear here — no dead links. Features add items in their module.tsx. */
const BASE: Record<NavGroupKey, NavItem[]> = {
  operations: [{ to: '/app', labelKey: 'nav.dashboard', icon: LayoutDashboard, end: true }],
  sales: [],
  crm: [],
  inventory: [
    { to: '/app/vehicles', labelKey: 'nav.vehicles', icon: CarFront, anyOf: ['vehicles.read'] },
    { to: '/app/inventory/transfers', labelKey: 'nav.transfers', icon: ArrowLeftRight, anyOf: ['vehicles.read'] },
    { to: '/app/inventory/stock-counts', labelKey: 'nav.stockCounts', icon: ClipboardCheck, anyOf: ['inventory.count'] },
  ],
  purchasing: [],
  finance: [],
  admin: [
    { to: '/app/settings/company', labelKey: 'nav.company', icon: Settings2, anyOf: ['settings.read', 'settings.manage'] },
    { to: '/app/settings/branches', labelKey: 'nav.branches', icon: Building2, anyOf: ['branches.manage', 'settings.read'] },
    { to: '/app/settings/users', labelKey: 'nav.users', icon: Users, anyOf: ['users.read'] },
    { to: '/app/settings/roles', labelKey: 'nav.roles', icon: KeyRound, anyOf: ['users.read', 'roles.manage'] },
    { to: '/app/settings/audit', labelKey: 'nav.audit', icon: History, anyOf: ['audit.read'], companyWide: true },
    { to: '/app/settings/privacy', labelKey: 'privacy.nav', icon: ShieldCheck, anyOf: ['privacy.manage'], companyWide: true },
  ],
};

const ORDER: NavGroupKey[] = ['operations', 'sales', 'crm', 'inventory', 'purchasing', 'finance', 'admin'];

export const NAV: NavGroup[] = ORDER.map((key) => ({
  labelKey: `nav.${key}`,
  items: [...BASE[key], ...FEATURE_MODULES.flatMap((m) => (m.nav ?? []).filter((n) => n.group === key).map((n) => n.item))],
}));
