import { PERMISSIONS, Permission } from '@autohub/shared';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { NotificationBell } from './NotificationBell';
import { NotificationsPage } from './NotificationsPage';

/** The inbox is open to every company member (GET /notifications is @Authenticated, own rows only). */
const ANY_MEMBER = Object.keys(PERMISSIONS) as Permission[];

/** Notifications: the top-bar bell and the full inbox page. */
export const notificationsModule: FeatureModule = {
  routes: [{ path: 'notifications', element: <Guard anyOf={ANY_MEMBER}><NotificationsPage /></Guard> }],
  headerWidgets: [NotificationBell],
};
