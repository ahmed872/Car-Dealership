import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { addMonths, d, ON_HAND_STATUSES, sum, todayInZone, UNSOLD_STATUSES, zDashboardQuery } from '@autohub/shared';
import { hasPermission, TenantContext } from '../../common/context';
import { DbService } from '../../db/db.service';
import { Params } from '../accounting/accounting.util';
import { ApprovalsService } from '../finance/approvals.service';
import { branchFilter, resolvePeriod } from './report-kit';

/**
 * The home dashboard. Each block appears only for users holding its permission, and every figure
 * respects the user's branch scope; cost and profit need `vehicles.view_cost`. Sales figures come
 * from the ledger (recognised revenue in the period), so they agree with the sales report.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly dbs: DbService,
    private readonly approvals: ApprovalsService,
  ) {}

  async get(ctx: TenantContext, q: z.infer<typeof zDashboardQuery>) {
    const { from, to } = resolvePeriod(ctx, q.from, q.to);
    const scope = branchFilter(ctx, q.branchId);
    const can = (p: string) => hasPermission(ctx, p as never);
    const seeCost = can('vehicles.view_cost');
    const tz = ctx.tenant.settings.timezone;
    const today = todayInZone(tz);
    const out: Record<string, unknown> = { period: { from, to }, branchId: q.branchId ?? null, generatedAt: new Date().toISOString() };

    if (can('vehicles.read')) {
      const p = new Params();
      const where = [`v.status = ANY(${p.add(ON_HAND_STATUSES)}::text[])`];
      if (scope.ids) where.push(`v.branch_id = ANY(${p.add(scope.ids)}::uuid[])`);
      const unsold = p.add(UNSOLD_STATUSES);
      const warn = p.add(ctx.tenant.settings.inventory.staleDaysWarning);
      const crit = p.add(ctx.tenant.settings.inventory.staleDaysCritical);
      const [r] = await this.dbs.query<{ on_hand: number; available: number; reserved: number; warning: number; critical: number; cost: string }>(
        `SELECT count(*)::int AS on_hand,
                count(*) FILTER (WHERE v.status = 'available')::int AS available,
                count(*) FILTER (WHERE v.status IN ('reserved', 'sale_pending'))::int AS reserved,
                count(*) FILTER (WHERE v.status = ANY(${unsold}::text[]) AND v.stocked_at < now() - make_interval(days => ${warn}::int))::int AS warning,
                count(*) FILTER (WHERE v.status = ANY(${unsold}::text[]) AND v.stocked_at < now() - make_interval(days => ${crit}::int))::int AS critical,
                coalesce(sum((SELECT sum(l.debit - l.credit) FROM journal_lines l WHERE l.vehicle_id = v.id AND l.account_code = '1300')), 0)::numeric(18,2)::text AS cost
           FROM vehicles v WHERE ${where.join(' AND ')}`,
        p.values,
      );
      out.inventory = {
        onHand: r!.on_hand,
        available: r!.available,
        reservedOrPending: r!.reserved,
        agedWarning: r!.warning,
        agedCritical: r!.critical,
        staleDaysWarning: ctx.tenant.settings.inventory.staleDaysWarning,
        staleDaysCritical: ctx.tenant.settings.inventory.staleDaysCritical,
        ...(seeCost ? { inventoryValue: r!.cost } : {}),
      };
    }

    if (can('sales.read')) {
      // Reps (no leads.assign, no customers.read_all) see their own sales only, as in the sales list.
      const own = !can('leads.assign') && !can('customers.read_all');
      const monthsFrom = `${addMonths(`${to.slice(0, 7)}-01`, -5)}`;
      const p = new Params();
      const conds = [`e.entry_date >= ${p.add(monthsFrom)}::date`, `e.entry_date <= ${p.add(to)}::date`];
      if (scope.ids) conds.push(`s.branch_id = ANY(${p.add(scope.ids)}::uuid[])`);
      if (own) conds.push(`s.salesperson_id = ${p.add(ctx.userId)}::uuid`);
      const pfrom = p.add(from);
      const months = await this.dbs.query<{ month: string; net: string; cogs: string; units: number; in_period_net: string; in_period_cogs: string; in_period_units: number }>(
        `SELECT to_char(e.entry_date, 'YYYY-MM') AS month,
                coalesce(sum(CASE WHEN l.account_code = '4000' THEN l.credit - l.debit END), 0)::numeric(18,2)::text AS net,
                coalesce(sum(CASE WHEN l.account_code = '5000' THEN l.debit - l.credit END), 0)::numeric(18,2)::text AS cogs,
                count(DISTINCT e.id) FILTER (WHERE l.account_code = '4000' AND e.event = 'sale.recognized')::int
                  - count(DISTINCT e.id) FILTER (WHERE l.account_code = '4000' AND e.event = 'sale.recognized.reversed')::int AS units,
                coalesce(sum(CASE WHEN l.account_code = '4000' AND e.entry_date >= ${pfrom}::date THEN l.credit - l.debit END), 0)::numeric(18,2)::text AS in_period_net,
                coalesce(sum(CASE WHEN l.account_code = '5000' AND e.entry_date >= ${pfrom}::date THEN l.debit - l.credit END), 0)::numeric(18,2)::text AS in_period_cogs,
                (count(DISTINCT e.id) FILTER (WHERE l.account_code = '4000' AND e.event = 'sale.recognized' AND e.entry_date >= ${pfrom}::date)
                  - count(DISTINCT e.id) FILTER (WHERE l.account_code = '4000' AND e.event = 'sale.recognized.reversed' AND e.entry_date >= ${pfrom}::date))::int AS in_period_units
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
           JOIN sales s ON s.id = l.sale_id
          WHERE l.account_code IN ('4000', '5000') AND ${conds.join(' AND ')}
          GROUP BY 1 ORDER BY 1`,
        p.values,
      );
      const ps = new Params();
      const sc: string[] = [];
      if (scope.ids) sc.push(`branch_id = ANY(${ps.add(scope.ids)}::uuid[])`);
      if (own) sc.push(`salesperson_id = ${ps.add(ctx.userId)}::uuid`);
      const [pipe] = await this.dbs.query<{ drafts: number; pending: number; awaiting_delivery: number }>(
        `SELECT count(*) FILTER (WHERE status = 'draft')::int AS drafts,
                count(*) FILTER (WHERE status IN ('pending_approval', 'approved'))::int AS pending,
                count(*) FILTER (WHERE status = 'confirmed')::int AS awaiting_delivery
           FROM sales ${sc.length ? `WHERE ${sc.join(' AND ')}` : ''}`,
        ps.values,
      );
      const net = sum(months.map((m) => m.in_period_net));
      const cogs = sum(months.map((m) => m.in_period_cogs));
      out.sales = {
        scope: own ? 'own' : 'all',
        units: months.reduce((a, m) => a + m.in_period_units, 0),
        netRevenue: net.toFixed(2),
        ...(seeCost ? { grossProfit: net.minus(cogs).toFixed(2) } : {}),
        drafts: pipe!.drafts,
        awaitingApproval: pipe!.pending,
        awaitingDelivery: pipe!.awaiting_delivery,
        monthly: months.map((m) => ({ month: m.month, units: m.units, netRevenue: m.net, ...(seeCost ? { grossProfit: d(m.net).minus(m.cogs).toFixed(2) } : {}) })),
      };
    }

    if (can('leads.read')) {
      const own = !can('leads.assign');
      const p = new Params();
      const conds: string[] = [];
      if (scope.ids) conds.push(`branch_id = ANY(${p.add(scope.ids)}::uuid[])`);
      if (own) conds.push(`assigned_user_id = ${p.add(ctx.userId)}::uuid`);
      const ptz = p.add(tz);
      const pf = p.add(from);
      const pt = p.add(to);
      const [r] = await this.dbs.query<{ open: number; created: number; won: number; follow_ups_due: number }>(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE (created_at AT TIME ZONE ${ptz})::date BETWEEN ${pf}::date AND ${pt}::date)::int AS created,
                count(*) FILTER (WHERE status = 'won' AND (closed_at AT TIME ZONE ${ptz})::date BETWEEN ${pf}::date AND ${pt}::date)::int AS won,
                count(*) FILTER (WHERE status = 'open' AND next_follow_up_at <= now())::int AS follow_ups_due
           FROM leads ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}`,
        p.values,
      );
      out.leads = {
        scope: own ? 'own' : 'all',
        open: r!.open,
        newInPeriod: r!.created,
        wonInPeriod: r!.won,
        followUpsDue: r!.follow_ups_due,
        conversionPct: r!.created ? d(r!.won).div(r!.created).times(100).toFixed(2) : null,
      };
    }

    if (can('appointments.read')) {
      const p = new Params();
      const conds = [`(starts_at AT TIME ZONE ${p.add(tz)})::date = ${p.add(today)}::date`, `status NOT IN ('cancelled')`];
      if (scope.ids) conds.push(`branch_id = ANY(${p.add(scope.ids)}::uuid[])`);
      const [r] = await this.dbs.query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments WHERE ${conds.join(' AND ')}`, p.values);
      out.appointments = { today: r!.n };
    }

    if (can('cash.read')) {
      const p = new Params();
      const conds = ['a.is_active'];
      if (scope.ids) conds.push(`a.branch_id = ANY(${p.add(scope.ids)}::uuid[])`);
      const [r] = await this.dbs.query<{ base: string; accounts: number }>(
        `SELECT coalesce(sum((SELECT sum(CASE WHEN t.direction = 'in' THEN t.amount_base ELSE -t.amount_base END) FROM cash_transactions t WHERE t.cash_account_id = a.id)), 0)::numeric(18,2)::text AS base,
                count(*)::int AS accounts
           FROM cash_accounts a WHERE ${conds.join(' AND ')}`,
        p.values,
      );
      out.cash = { balanceBase: r!.base, accounts: r!.accounts };
    }

    if (can('reports.financial')) {
      const p = new Params();
      const sc = scope.ids ? `AND s.branch_id = ANY(${p.add(scope.ids)}::uuid[])` : '';
      const pt = p.add(today);
      const [r] = await this.dbs.query<{ ar: string; advances: string; overdue: string; overdue_plans: number }>(
        `SELECT coalesce((SELECT sum(l.debit - l.credit) FROM journal_lines l JOIN sales s ON s.id = l.sale_id WHERE l.account_code = '1200' ${sc}), 0)::numeric(18,2)::text AS ar,
                coalesce((SELECT -sum(l.debit - l.credit) FROM journal_lines l WHERE l.account_code = '2100'), 0)::numeric(18,2)::text AS advances,
                coalesce((SELECT sum(i.total_due - coalesce((SELECT sum(a.principal + a.interest + a.fees) FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.installment_id = i.id AND r.status = 'posted'), 0))
                            FROM installments i JOIN installment_plans pl ON pl.id = i.plan_id JOIN sales s ON s.id = pl.sale_id
                           WHERE pl.status = 'active' AND i.due_date < ${pt}::date ${sc}), 0)::numeric(18,2)::text AS overdue,
                (SELECT count(DISTINCT pl.id) FROM installments i JOIN installment_plans pl ON pl.id = i.plan_id JOIN sales s ON s.id = pl.sale_id
                  WHERE pl.status = 'active' AND i.due_date < ${pt}::date ${sc}
                    AND i.total_due > coalesce((SELECT sum(a.principal + a.interest + a.fees) FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id WHERE a.installment_id = i.id AND r.status = 'posted'), 0))::int AS overdue_plans`,
        p.values,
      );
      // Customer advances include reservation deposits, which carry no branch: company-wide users only.
      out.receivables = { total: r!.ar, customerAdvances: scope.companyWide ? r!.advances : null, overdueInstallments: r!.overdue, plansOverdue: r!.overdue_plans };
    }

    const pending = await this.approvals.countPendingFor(ctx);
    const pendingTotal = Object.values(pending).reduce((a, b) => a + b, 0);
    if (pendingTotal > 0 || can('approvals.read')) out.approvals = { pending: pendingTotal, byType: pending };
    return out;
  }
}
