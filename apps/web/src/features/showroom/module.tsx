import { Hourglass, Inbox, PlugZap, Store } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { AgingPage } from './AgingPage';
import { InquiriesPage } from './InquiriesPage';
import { IntegrationsPage } from './IntegrationsPage';
import { ListingEditorPage } from './ListingEditorPage';
import { ListingPanel } from './ListingPanel';
import { ListingsPage } from './ListingsPage';
import { PublicShowroomPage } from './public/PublicShowroomPage';
import { PublicVehiclePage } from './public/PublicVehiclePage';

/** Digital showroom (Phase 7): public pages, listings, inquiries, integrations and pricing insights. */
export const showroomModule: FeatureModule = {
  routes: [
    { path: 'showroom', element: <Guard anyOf={['showroom.manage']}><ListingsPage /></Guard> },
    { path: 'showroom/inquiries', element: <Guard anyOf={['leads.assign']}><InquiriesPage /></Guard> },
    // GET /vehicles/:id/listing needs vehicles.read; editing re-checks showroom.manage.
    { path: 'showroom/vehicles/:vehicleId', element: <Guard anyOf={['vehicles.read']}><ListingEditorPage /></Guard> },
    { path: 'inventory/aging', element: <Guard anyOf={['pricing.update']}><AgingPage /></Guard> },
    { path: 'settings/integrations', element: <Guard anyOf={['integrations.manage']}><IntegrationsPage /></Guard> },
  ],
  nav: [
    { group: 'sales', item: { to: '/app/showroom', labelKey: 'showroom.nav.listings', icon: Store, anyOf: ['showroom.manage'], end: true } },
    { group: 'crm', item: { to: '/app/showroom/inquiries', labelKey: 'showroom.nav.inquiries', icon: Inbox, anyOf: ['leads.assign'] } },
    { group: 'inventory', item: { to: '/app/inventory/aging', labelKey: 'showroom.nav.aging', icon: Hourglass, anyOf: ['pricing.update'] } },
    { group: 'admin', item: { to: '/app/settings/integrations', labelKey: 'showroom.nav.integrations', icon: PlugZap, anyOf: ['integrations.manage'] } },
  ],
  vehicleTabs: [{ key: 'listing', labelKey: 'showroom.tab.label', anyOf: ['vehicles.read'], component: ListingPanel }],
  // Absolute paths, no session: the share links are `${PUBLIC_WEB_URL}/showroom/:slug/vehicles/:listingId`.
  publicRoutes: [
    { path: '/showroom/:slug', element: <PublicShowroomPage /> },
    { path: '/showroom/:slug/vehicles/:listingId', element: <PublicVehiclePage /> },
  ],
};
