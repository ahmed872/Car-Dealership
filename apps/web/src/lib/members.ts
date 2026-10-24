import type { AssignablePermission } from '@autohub/shared';
import { useApi } from './hooks';

/** GET /members/assignable items: id and name only. */
export interface AssignableMember {
  id: string;
  fullName: string;
}

/** Query-key prefix of the assignee lists (invalidate it when members change). */
export const ASSIGNABLE_MEMBERS_KEY = 'members-assignable';

/**
 * Staff who can be given work needing `permission` (active members whose role holds it), limited
 * to those who can reach `branchId` when one is given. Any company member may ask; whether the
 * caller may assign work to someone else is still decided by the API (e.g. leads.assign).
 */
export function useAssignableMembers(permission: AssignablePermission, branchId?: string | null, enabled = true) {
  return useApi<AssignableMember[]>(
    [ASSIGNABLE_MEMBERS_KEY, permission],
    enabled ? '/members/assignable' : null,
    { permission, branchId: branchId || undefined },
    { staleTime: 60_000 },
  );
}
