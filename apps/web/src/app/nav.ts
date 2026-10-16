import type { LucideIcon } from 'lucide-react';
import { Building2, History, KeyRound, LayoutDashboard, Settings2, Users } from 'lucide-react';
import type { Permission } from '@autohub/shared';

export interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  /** Shown when the user holds ANY of these permissions. */
  anyOf?: Permission[];
  end?: boolean;
}

export interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

/** Only modules that are actually implemented appear here — no dead links. */
export const NAV: NavGroup[] = [
  {
    labelKey: 'nav.operations',
    items: [{ to: '/app', labelKey: 'nav.dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    labelKey: 'nav.admin',
    items: [
      {
        to: '/app/settings/company',
        labelKey: 'nav.company',
        icon: Settings2,
        anyOf: ['settings.read', 'settings.manage'],
      },
      {
        to: '/app/settings/branches',
        labelKey: 'nav.branches',
        icon: Building2,
        anyOf: ['branches.manage', 'settings.read'],
      },
      { to: '/app/settings/users', labelKey: 'nav.users', icon: Users, anyOf: ['users.read'] },
      {
        to: '/app/settings/roles',
        labelKey: 'nav.roles',
        icon: KeyRound,
        anyOf: ['users.read', 'roles.manage'],
      },
      { to: '/app/settings/audit', labelKey: 'nav.audit', icon: History, anyOf: ['audit.read'] },
    ],
  },
];
