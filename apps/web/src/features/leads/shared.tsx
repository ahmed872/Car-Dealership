import clsx from 'clsx';
import { KanbanSquare, List, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { LEAD_SOURCES } from '@autohub/shared';
import { Button } from '@/components/ui/Button';
import { Checkbox, Select } from '@/components/ui/Field';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/lib/hooks';
import { useBranches } from '@/pages/settings/BranchesPage';
import { useAssignees } from '@/features/customers/api';
import { LeadCreateModal } from './components';

/** Board / list switch shown in the page header of both lead views. */
export function LeadViewSwitch() {
  const { t } = useTranslation();
  const cls = ({ isActive }: { isActive: boolean }) =>
    clsx('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium', isActive ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink');
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5" role="group" aria-label={t('leads.view.label')}>
      <NavLink to="/app/leads" end className={cls}>
        <KanbanSquare className="h-4 w-4" aria-hidden />
        {t('leads.view.board')}
      </NavLink>
      <NavLink to="/app/leads/list" className={cls}>
        <List className="h-4 w-4" aria-hidden />
        {t('leads.view.list')}
      </NavLink>
    </div>
  );
}

/** "New lead" button + the create dialog (customer picked by search). */
export function NewLeadButton() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  if (!can('leads.manage')) return null;
  return (
    <>
      <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
        {t('leads.create.button')}
      </Button>
      {open && <LeadCreateModal onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Branch / salesperson / source / "mine" filters shared by the board and the list. Reps see only
 * their own leads (the API enforces it), so the people filters are offered to managers only.
 */
export function LeadCommonFilters({ lp }: { lp: ReturnType<typeof useListParams> }) {
  const { t } = useTranslation();
  const { canAny } = useAuth();
  const branches = useBranches();
  const seesOthers = canAny('leads.assign', 'customers.read_all');
  const assignees = useAssignees({ perm: 'leads.read', enabled: seesOthers });
  return (
    <>
      {(branches.data?.length ?? 0) > 1 && (
        <Select className="w-auto min-w-[140px]" value={lp.get('branchId')} onChange={(e) => lp.set({ branchId: e.target.value })} aria-label={t('common.branch')}>
          <option value="">{t('common.allBranches')}</option>
          {branches.data?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      )}
      <Select className="w-auto min-w-[140px]" value={lp.get('source')} onChange={(e) => lp.set({ source: e.target.value })} aria-label={t('leads.fields.source')}>
        <option value="">
          {t('leads.fields.source')}: {t('common.all')}
        </option>
        {LEAD_SOURCES.map((s) => (
          <option key={s} value={s}>
            {t(`customers.enums.source.${s}`)}
          </option>
        ))}
      </Select>
      {seesOthers && (
        <Select
          className="w-auto min-w-[160px]"
          value={lp.get('assignedUserId')}
          onChange={(e) => lp.set({ assignedUserId: e.target.value, mine: null })}
          aria-label={t('leads.fields.assignee')}
        >
          <option value="">
            {t('leads.fields.assignee')}: {t('common.all')}
          </option>
          {assignees.list.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.fullName}
            </option>
          ))}
        </Select>
      )}
      {seesOthers && (
        <Checkbox label={t('leads.filters.mine')} checked={lp.get('mine') === 'true'} onChange={(e) => lp.set({ mine: e.target.checked ? 'true' : null, assignedUserId: null })} />
      )}
    </>
  );
}
