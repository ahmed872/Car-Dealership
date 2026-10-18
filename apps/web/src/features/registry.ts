import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router-dom';
import type { Permission } from '@autohub/shared';
import type { NavItem } from '@/app/nav';
import type { VehicleDetail } from '@/features/vehicles/api';

/** Sidebar groups, in display order (see app/nav.ts). */
export type NavGroupKey = 'operations' | 'sales' | 'crm' | 'inventory' | 'purchasing' | 'finance' | 'admin';

/** An extra tab on the Vehicle 360 page, owned by another feature (costs, reservations, …). */
export interface VehicleTab {
  key: string;
  /** i18n key of the tab label. */
  labelKey: string;
  /** Shown when the user holds ANY of these permissions. */
  anyOf?: Permission[];
  component: ComponentType<{ d: VehicleDetail }>;
}

/**
 * What a feature contributes to the app shell. Each feature owns `features/<name>/module.tsx`
 * and lists its routes, nav items, vehicle tabs and header widgets there, so features can be
 * developed in parallel without editing shared files.
 */
export interface FeatureModule {
  /** Routes under /app (paths relative to /app). Wrap elements in <Guard anyOf={[…]}>. */
  routes?: RouteObject[];
  nav?: Array<{ group: NavGroupKey; item: NavItem }>;
  vehicleTabs?: VehicleTab[];
  /** Small widgets in the top bar (e.g. the notifications bell). */
  headerWidgets?: ComponentType[];
  /** Routes outside the signed-in app (absolute paths, no session), e.g. the public showroom. */
  publicRoutes?: RouteObject[];
}

let registered: FeatureModule[] = [];

/** Called once by features/modules.ts when the module list is built. */
export function registerFeatureModules(list: FeatureModule[]): void {
  registered = list;
}

/**
 * Every registered feature module. Feature code reads the list through this getter instead of
 * importing features/modules.ts, which imports the features themselves (an import cycle).
 */
export function featureModules(): readonly FeatureModule[] {
  return registered;
}
