import { CalendarClock, Handshake, Layers } from 'lucide-react';
import { Guard } from '@/app/Guard';
import type { FeatureModule } from '@/features/registry';
import { FollowUpsPage } from './FollowUpsPage';
import { LeadDetailPage } from './LeadDetailPage';
import { LeadsBoardPage } from './LeadsBoardPage';
import { LeadsListPage } from './LeadsListPage';
import { PipelineStagesPage } from './PipelineStagesPage';

/** Sales leads: kanban board, list, lead 360, my follow-ups and the pipeline stage settings. */
export const leadsModule: FeatureModule = {
  routes: [
    { path: 'leads', element: <Guard anyOf={['leads.read']}><LeadsBoardPage /></Guard> },
    { path: 'leads/list', element: <Guard anyOf={['leads.read']}><LeadsListPage /></Guard> },
    { path: 'leads/:id', element: <Guard anyOf={['leads.read']}><LeadDetailPage /></Guard> },
    { path: 'follow-ups', element: <Guard anyOf={['leads.read']}><FollowUpsPage /></Guard> },
    { path: 'settings/pipeline', element: <Guard anyOf={['settings.manage']}><PipelineStagesPage /></Guard> },
  ],
  nav: [
    { group: 'crm', item: { to: '/app/leads', labelKey: 'nav.leads', icon: Handshake, anyOf: ['leads.read'] } },
    { group: 'crm', item: { to: '/app/follow-ups', labelKey: 'leads.nav.followUps', icon: CalendarClock, anyOf: ['leads.read'] } },
    { group: 'admin', item: { to: '/app/settings/pipeline', labelKey: 'leads.nav.pipeline', icon: Layers, anyOf: ['settings.manage'] } },
  ],
};
