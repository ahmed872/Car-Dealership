import {
  AlarmClock,
  BadgeCheck,
  CalendarClock,
  CalendarDays,
  CarFront,
  ClipboardCheck,
  Coins,
  FileClock,
  Gauge,
  Handshake,
  HandCoins,
  Hourglass,
  PackageCheck,
  Percent,
  PiggyBank,
  ReceiptText,
  TrendingUp,
  UserPlus,
  Wallet,
  Warehouse,
} from 'lucide-react';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { d, type Permission, type ReportKey } from '@autohub/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { PageHeader } from '@/components/ui/Layout';
import { DashboardData, reportDef, useBranchOptions } from '@/features/reports/api';
import { BranchFilter, PeriodFilter, RevenueTrend, useFilterParams, usePeriod } from '@/features/reports/components';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtPct } from '@/lib/format';
import { useApi } from '@/lib/hooks';

/** Home dashboard: the welcome header and, with dashboard.view, the KPI blocks the API returns. */
export function DashboardPage() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  return (
    <>
      <PageHeader title={t('dashboard.welcome', { name: me?.user.fullName })} subtitle={t('dashboard.subtitle')} />
      {can('dashboard.view') ? (
        <Dashboard />
      ) : (
        <Card>
          <EmptyState icon={<Gauge className="h-5 w-5" />} title={t('reports.dashboard.noAccess')} description={t('reports.dashboard.noAccessHint')} />
        </Card>
      )}
    </>
  );
}

function Section({ title, badge, action, children }: { title: string; badge?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const id = `dash-${title.replace(/\s+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={id} className="text-[15px] font-semibold text-ink">
            {title}
          </h2>
          {badge}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me, can, canAny, currency } = useAuth();
  const tz = me?.tenant?.settings.timezone;
  const lp = useFilterParams();
  const period = usePeriod(lp);
  const { branches, show: showBranches } = useBranchOptions();
  const branchId = lp.get('branchId');
  const q = useApi<DashboardData>(['dashboard'], period.invalid ? null : '/dashboard', { ...period.query, branchId: branchId || undefined }, { placeholderData: (p) => p });
  const data = q.data;

  const go = (to: string, ...perms: Permission[]) => (perms.length === 0 || canAny(...perms) ? () => navigate(to) : undefined);
  const canReport = (k: ReportKey) => can(...reportDef(k).perms);
  const reportLink = (k: ReportKey) =>
    canReport(k) ? (
      <Link to={`/app/reports/${k}`} className="text-[13px] font-medium text-brand-strong hover:underline">
        {t('reports.dashboard.viewReport')}
      </Link>
    ) : undefined;
  const money = (v: string | null | undefined) => fmtMoney(v, currency);
  const num = (v: number) => fmtNumber(v);
  const positive = (v: string) => d(v).gt(0);

  const ownBadge = <Badge tone="info">{t('reports.dashboard.ownScope')}</Badge>;
  const blocks = data ? [data.sales, data.inventory, data.leads, data.appointments, data.cash, data.receivables, data.approvals].filter(Boolean).length : 0;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <PeriodFilter lp={lp} period={period} />
            {showBranches && <BranchFilter value={branchId} onChange={(v) => lp.set({ branchId: v })} branches={branches} />}
          </div>
          {data && (
            <div className="text-[12.5px] text-muted sm:text-end">
              <p className="num">{t('reports.dashboard.periodLabel', { from: fmtDate(data.period.from), to: fmtDate(data.period.to) })}</p>
              <p className="num">{t('reports.dashboard.updatedAt', { time: fmtDateTime(data.generatedAt, tz) })}</p>
            </div>
          )}
        </div>
      </Card>

      {period.invalid ? null : q.error ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[84px] rounded-[14px]" />
          ))}
        </div>
      ) : blocks === 0 ? (
        <Card>
          <EmptyState icon={<Gauge className="h-5 w-5" />} title={t('reports.dashboard.noBlocks')} />
        </Card>
      ) : (
        <div className="space-y-8" aria-busy={q.isFetching || undefined}>
          {data.sales && (
            <Section title={t('reports.dashboard.sections.sales')} badge={data.sales.scope === 'own' ? ownBadge : undefined} action={reportLink('sales')}>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <StatCard
                  label={t('reports.dashboard.sales.netRevenue')}
                  value={money(data.sales.netRevenue)}
                  hint={t('reports.dashboard.sales.netRevenueHint')}
                  icon={<TrendingUp className="h-5 w-5" />}
                  tone="brand"
                  onClick={canReport('sales') ? () => navigate('/app/reports/sales') : go('/app/sales', 'sales.read')}
                />
                <StatCard
                  label={t('reports.dashboard.sales.units')}
                  value={num(data.sales.units)}
                  hint={t('reports.dashboard.sales.unitsHint')}
                  icon={<CarFront className="h-5 w-5" />}
                  tone="info"
                  onClick={go('/app/sales', 'sales.read')}
                />
                {data.sales.grossProfit !== undefined && (
                  <StatCard
                    label={t('reports.dashboard.sales.grossProfit')}
                    value={money(data.sales.grossProfit)}
                    icon={<Coins className="h-5 w-5" />}
                    tone={d(data.sales.grossProfit).isNegative() ? 'danger' : 'success'}
                    onClick={canReport('sales') ? () => navigate('/app/reports/sales') : undefined}
                  />
                )}
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Card>
                  <CardHeader title={t('reports.dashboard.sales.trendTitle')} subtitle={t('reports.dashboard.sales.trendSubtitle')} />
                  <RevenueTrend monthly={data.sales.monthly} endMonth={data.period.to.slice(0, 7)} currency={currency} />
                </Card>
                <div className="grid content-start gap-4">
                  <StatCard
                    label={t('reports.dashboard.sales.drafts')}
                    value={num(data.sales.drafts)}
                    icon={<FileClock className="h-5 w-5" />}
                    onClick={go('/app/sales?status=draft', 'sales.read')}
                  />
                  <StatCard
                    label={t('reports.dashboard.sales.awaitingApproval')}
                    value={num(data.sales.awaitingApproval)}
                    icon={<Hourglass className="h-5 w-5" />}
                    tone={data.sales.awaitingApproval > 0 ? 'warning' : 'default'}
                    onClick={go('/app/sales', 'sales.read')}
                  />
                  <StatCard
                    label={t('reports.dashboard.sales.awaitingDelivery')}
                    value={num(data.sales.awaitingDelivery)}
                    icon={<PackageCheck className="h-5 w-5" />}
                    tone={data.sales.awaitingDelivery > 0 ? 'info' : 'default'}
                    onClick={go('/app/sales?status=confirmed', 'sales.read')}
                  />
                </div>
              </div>
            </Section>
          )}

          {data.inventory && (
            <Section title={t('reports.dashboard.sections.inventory')} action={reportLink('inventory')}>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <StatCard
                  label={t('reports.dashboard.inventory.onHand')}
                  value={num(data.inventory.onHand)}
                  icon={<Warehouse className="h-5 w-5" />}
                  tone="brand"
                  onClick={go(`/app/vehicles${branchId ? `?branchId=${branchId}` : ''}`, 'vehicles.read')}
                />
                <StatCard
                  label={t('reports.dashboard.inventory.available')}
                  value={num(data.inventory.available)}
                  icon={<BadgeCheck className="h-5 w-5" />}
                  tone="success"
                  onClick={go(`/app/vehicles?status=available${branchId ? `&branchId=${branchId}` : ''}`, 'vehicles.read')}
                />
                <StatCard
                  label={t('reports.dashboard.inventory.reservedOrPending')}
                  value={num(data.inventory.reservedOrPending)}
                  icon={<CalendarClock className="h-5 w-5" />}
                  tone="info"
                  onClick={go(`/app/vehicles${branchId ? `?branchId=${branchId}` : ''}`, 'vehicles.read')}
                />
                <StatCard
                  label={t('reports.dashboard.inventory.agedWarning', { days: data.inventory.staleDaysWarning })}
                  value={num(data.inventory.agedWarning)}
                  hint={t('reports.dashboard.inventory.agedHint')}
                  icon={<AlarmClock className="h-5 w-5" />}
                  tone={data.inventory.agedWarning > 0 ? 'warning' : 'default'}
                  onClick={go(`/app/vehicles?stale=warning${branchId ? `&branchId=${branchId}` : ''}`, 'vehicles.read')}
                />
                <StatCard
                  label={t('reports.dashboard.inventory.agedCritical', { days: data.inventory.staleDaysCritical })}
                  value={num(data.inventory.agedCritical)}
                  hint={t('reports.dashboard.inventory.agedHint')}
                  icon={<AlarmClock className="h-5 w-5" />}
                  tone={data.inventory.agedCritical > 0 ? 'danger' : 'default'}
                  onClick={go(`/app/vehicles?stale=critical${branchId ? `&branchId=${branchId}` : ''}`, 'vehicles.read')}
                />
                {data.inventory.inventoryValue !== undefined && (
                  <StatCard
                    label={t('reports.dashboard.inventory.inventoryValue')}
                    value={money(data.inventory.inventoryValue)}
                    icon={<PiggyBank className="h-5 w-5" />}
                    tone="brand"
                    onClick={canReport('inventory') ? () => navigate('/app/reports/inventory') : undefined}
                  />
                )}
              </div>
            </Section>
          )}

          {(data.leads || data.appointments) && (
            <Section
              title={t('reports.dashboard.sections.crm')}
              badge={data.leads?.scope === 'own' ? ownBadge : undefined}
              action={data.leads ? reportLink('leads') : undefined}
            >
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.leads && (
                  <>
                    <StatCard
                      label={t('reports.dashboard.leads.open')}
                      value={num(data.leads.open)}
                      icon={<Handshake className="h-5 w-5" />}
                      tone="brand"
                      onClick={go('/app/leads', 'leads.read')}
                    />
                    <StatCard
                      label={t('reports.dashboard.leads.newInPeriod')}
                      value={num(data.leads.newInPeriod)}
                      icon={<UserPlus className="h-5 w-5" />}
                      tone="info"
                      onClick={canReport('leads') ? () => navigate('/app/reports/leads') : go('/app/leads/list', 'leads.read')}
                    />
                    <StatCard
                      label={t('reports.dashboard.leads.wonInPeriod')}
                      value={num(data.leads.wonInPeriod)}
                      icon={<BadgeCheck className="h-5 w-5" />}
                      tone="success"
                      onClick={canReport('leads') ? () => navigate('/app/reports/leads') : undefined}
                    />
                    <StatCard
                      label={t('reports.dashboard.leads.conversion')}
                      value={data.leads.conversionPct === null ? '—' : fmtPct(data.leads.conversionPct, 1)}
                      hint={t('reports.dashboard.leads.conversionHint')}
                      icon={<Percent className="h-5 w-5" />}
                      onClick={canReport('leads') ? () => navigate('/app/reports/leads') : undefined}
                    />
                    <StatCard
                      label={t('reports.dashboard.leads.followUpsDue')}
                      value={num(data.leads.followUpsDue)}
                      icon={<CalendarClock className="h-5 w-5" />}
                      tone={data.leads.followUpsDue > 0 ? 'warning' : 'default'}
                      onClick={go('/app/follow-ups', 'leads.read')}
                    />
                  </>
                )}
                {data.appointments && (
                  <StatCard label={t('reports.dashboard.leads.appointmentsToday')} value={num(data.appointments.today)} icon={<CalendarDays className="h-5 w-5" />} tone="info" />
                )}
              </div>
            </Section>
          )}

          {(data.cash || data.receivables || data.approvals) && (
            <Section title={t('reports.dashboard.sections.finance')}>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.cash && (
                  <StatCard
                    label={t('reports.dashboard.cash.balance')}
                    value={money(data.cash.balanceBase)}
                    hint={t('reports.dashboard.cash.accounts', { count: data.cash.accounts })}
                    icon={<Wallet className="h-5 w-5" />}
                    tone={d(data.cash.balanceBase).isNegative() ? 'danger' : 'success'}
                    onClick={canReport('cash-flow') ? () => navigate('/app/reports/cash-flow') : go('/app/cash/accounts', 'cash.read')}
                  />
                )}
                {data.receivables && (
                  <>
                    <StatCard
                      label={t('reports.dashboard.receivables.total')}
                      value={money(data.receivables.total)}
                      icon={<ReceiptText className="h-5 w-5" />}
                      tone="info"
                      onClick={canReport('receivables') ? () => navigate('/app/reports/receivables') : undefined}
                    />
                    <StatCard
                      label={t('reports.dashboard.receivables.overdueInstallments')}
                      value={money(data.receivables.overdueInstallments)}
                      icon={<AlarmClock className="h-5 w-5" />}
                      tone={positive(data.receivables.overdueInstallments) ? 'danger' : 'default'}
                      onClick={go('/app/installments', 'installments.read')}
                    />
                    <StatCard
                      label={t('reports.dashboard.receivables.plansOverdue')}
                      value={num(data.receivables.plansOverdue)}
                      hint={t('reports.dashboard.receivables.plansOverdueHint')}
                      icon={<CalendarClock className="h-5 w-5" />}
                      tone={data.receivables.plansOverdue > 0 ? 'danger' : 'default'}
                      onClick={go('/app/installments', 'installments.read')}
                    />
                    {data.receivables.customerAdvances !== null && (
                      <StatCard
                        label={t('reports.dashboard.receivables.customerAdvances')}
                        value={money(data.receivables.customerAdvances)}
                        hint={t('reports.dashboard.receivables.customerAdvancesHint')}
                        icon={<HandCoins className="h-5 w-5" />}
                      />
                    )}
                  </>
                )}
                {data.approvals && (
                  <StatCard
                    label={t('reports.dashboard.approvals.pending')}
                    value={num(data.approvals.pending)}
                    hint={
                      data.approvals.pending > 0
                        ? Object.entries(data.approvals.byType)
                            .filter(([, n]) => n > 0)
                            .map(([type, n]) => `${t(`approvals.types.${type}`, { defaultValue: type })}: ${fmtNumber(n)}`)
                            .join(' · ')
                        : t('reports.dashboard.approvals.none')
                    }
                    icon={<ClipboardCheck className="h-5 w-5" />}
                    tone={data.approvals.pending > 0 ? 'warning' : 'default'}
                    onClick={() => navigate('/app/approvals')}
                  />
                )}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
