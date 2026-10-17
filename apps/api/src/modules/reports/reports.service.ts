import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  d,
  ON_HAND_STATUSES,
  ReportCell,
  ReportResult,
  sum as dsum,
  todayInZone,
  zCashFlowReportQuery,
  zInventoryReportQuery,
  zLeadsReportQuery,
  zReceivablesReportQuery,
  zSalesReportQuery,
} from '@autohub/shared';
import { hasPermission, TenantContext } from '../../common/context';
import { DbService } from '../../db/db.service';
import { Params } from '../accounting/accounting.util';
import {
  applyColumnPolicy,
  branchFilter,
  cashKindOptions,
  col,
  LEAD_SOURCE_OPTIONS,
  MAX_REPORT_ROWS,
  money2,
  PAYMENT_TYPE_OPTIONS,
  RECEIVABLE_AGE_OPTIONS,
  requireAll,
  resolvePeriod,
  SALE_STATUS_OPTIONS,
  STOCK_AGE_OPTIONS,
  stockAgeBucket,
  sum,
  VEHICLE_STATUS_OPTIONS,
} from './report-kit';

type Row = Record<string, ReportCell>;

const pct = (part: string, whole: string): string | null => (d(whole).isZero() ? null : d(part).div(whole).times(100).toFixed(2));
const recon = (labelEn: string, labelAr: string, report: string, ledger: string, sensitive = false) => ({
  labelEn,
  labelAr,
  report: money2(report),
  ledger: money2(ledger),
  difference: d(report).minus(ledger).toFixed(2),
  ...(sensitive ? { sensitive: true } : {}),
});

/**
 * Operational and financial reports (Phase 6). Money figures come from the general ledger where
 * one exists (sales profitability, receivables, cash), so report totals reconcile to the books;
 * company-wide runs include that reconciliation. Branch-scoped users only ever see their branches.
 * Every report returns the same `ReportResult` shape, which the exports render.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly dbs: DbService) {}

  private result(ctx: TenantContext, r: Omit<ReportResult, 'generatedAt' | 'truncated'>, truncated: boolean): ReportResult {
    return applyColumnPolicy(ctx, { ...r, generatedAt: new Date().toISOString(), truncated });
  }

  // ── Inventory valuation & aging ───────────────────────────────────────────────────────

  async inventory(ctx: TenantContext, q: z.infer<typeof zInventoryReportQuery>): Promise<ReportResult> {
    requireAll(ctx, ['reports.view', 'vehicles.read']);
    const scope = branchFilter(ctx, q.branchId);
    const today = todayInZone(ctx.tenant.settings.timezone);
    const p = new Params();
    const where = [`v.status = ANY(${p.add(ON_HAND_STATUSES)}::text[])`];
    if (scope.ids) where.push(`v.branch_id = ANY(${p.add(scope.ids)}::uuid[])`);
    if (q.status) where.push(`v.status = ${p.add(q.status)}`);
    const rows = await this.dbs.query<{
      id: string;
      stock_number: string;
      vin: string | null;
      status: string;
      model_year: number;
      make_en: string;
      model_en: string;
      branch: string;
      asking: string | null;
      floor: string | null;
      cost: string;
      days: number;
    }>(
      `SELECT v.id, v.stock_number, v.vin, v.status, v.model_year, mk.name_en AS make_en, md.name_en AS model_en, b.name AS branch,
              v.asking_price::text AS asking, v.min_price::text AS floor,
              coalesce((SELECT sum(l.debit - l.credit) FROM journal_lines l WHERE l.vehicle_id = v.id AND l.account_code = '1300'), 0)::numeric(18,2)::text AS cost,
              (${p.add(today)}::date - (v.stocked_at AT TIME ZONE ${p.add(ctx.tenant.settings.timezone)})::date)::int AS days
         FROM vehicles v
         JOIN vehicle_makes mk ON mk.id = v.make_id
         JOIN vehicle_models md ON md.id = v.model_id
         JOIN branches b ON b.id = v.branch_id
        WHERE ${where.join(' AND ')}
        ORDER BY v.stocked_at, v.stock_number
        LIMIT ${MAX_REPORT_ROWS + 1}`,
      p.values,
    );
    const truncated = rows.length > MAX_REPORT_ROWS;
    const out: Row[] = rows
      .slice(0, MAX_REPORT_ROWS)
      .map((r) => {
        const bucket = stockAgeBucket(Math.max(r.days, 0));
        const margin = r.asking ? d(r.asking).minus(r.cost) : null;
        return {
          id: r.id,
          stockNumber: r.stock_number,
          vehicle: `${r.make_en} ${r.model_en} ${r.model_year}`,
          vin: r.vin,
          branch: r.branch,
          status: r.status,
          daysInStock: r.days,
          bucket,
          askingPrice: r.asking,
          floorPrice: r.floor,
          cost: r.cost,
          expectedMargin: margin ? margin.toFixed(2) : null,
          marginPct: margin && r.asking ? pct(margin.toFixed(2), r.asking) : null,
        };
      })
      .filter((r) => !q.bucket || r.bucket === q.bucket);
    const totalCost = dsum(out.map((r) => r.cost as string)).toFixed(2);
    const totalAsking = dsum(out.map((r) => (r.askingPrice as string | null) ?? '0')).toFixed(2);
    const summary = [
      sum('count', 'Vehicles', 'عدد السيارات', 'number', out.length),
      sum('asking', 'Total asking price', 'إجمالي أسعار العرض', 'money', totalAsking),
      sum('cost', 'Total cost (inventory value)', 'إجمالي التكلفة (قيمة المخزون)', 'money', totalCost, true),
      ...Object.keys(STOCK_AGE_OPTIONS).flatMap((b) => {
        const inB = out.filter((r) => r.bucket === b);
        return [
          sum(`count:${b}`, `Vehicles ${STOCK_AGE_OPTIONS[b]!.en}`, `السيارات ${STOCK_AGE_OPTIONS[b]!.ar}`, 'number', inB.length),
          sum(`cost:${b}`, `Cost ${STOCK_AGE_OPTIONS[b]!.en}`, `التكلفة ${STOCK_AGE_OPTIONS[b]!.ar}`, 'money', dsum(inB.map((r) => r.cost as string)).toFixed(2), true),
        ];
      }),
    ];
    let reconciliation = null;
    if (scope.companyWide && !q.status && !q.bucket && !truncated) {
      const [gl] = await this.dbs.query<{ b: string }>(`SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines WHERE account_code = '1300'`);
      reconciliation = [recon('Inventory value vs ledger 1300', 'قيمة المخزون مقابل الحساب 1300', totalCost, gl!.b, true)];
    }
    return this.result(
      ctx,
      {
        key: 'inventory',
        titleEn: 'Inventory valuation and aging',
        titleAr: 'تقييم المخزون وأعماره',
        params: { asOf: today, branchId: q.branchId ?? null, status: q.status ?? null, bucket: q.bucket ?? null },
        columns: [
          col('stockNumber', 'Stock no.', 'رقم المخزون', 'text'),
          col('vehicle', 'Vehicle', 'السيارة', 'text'),
          col('vin', 'VIN', 'رقم الشاسيه', 'text'),
          col('branch', 'Branch', 'الفرع', 'text'),
          col('status', 'Status', 'الحالة', 'enum', { options: VEHICLE_STATUS_OPTIONS }),
          col('daysInStock', 'Days in stock', 'أيام في المخزون', 'number'),
          col('bucket', 'Age', 'العمر', 'enum', { options: STOCK_AGE_OPTIONS }),
          col('askingPrice', 'Asking price', 'سعر العرض', 'money'),
          col('floorPrice', 'Floor price', 'الحد الأدنى', 'money', { sensitive: true }),
          col('cost', 'Cost', 'التكلفة', 'money', { sensitive: true }),
          col('expectedMargin', 'Expected margin', 'الربح المتوقع', 'money', { sensitive: true }),
          col('marginPct', 'Margin %', 'نسبة الربح', 'percent', { sensitive: true }),
        ],
        rows: out,
        totals: { stockNumber: null, askingPrice: totalAsking, cost: totalCost },
        summary,
        reconciliation,
        drillDown: { idKey: 'id', kind: 'vehicle' },
      },
      truncated,
    );
  }

  // ── Sales & profitability (from the ledger) ───────────────────────────────────────────

  async sales(ctx: TenantContext, q: z.infer<typeof zSalesReportQuery>): Promise<ReportResult> {
    requireAll(ctx, ['reports.view']);
    const { from, to } = resolvePeriod(ctx, q.from, q.to);
    const scope = branchFilter(ctx, q.branchId);
    // Per sale and month: revenue, tax, finance income, cost of sale and commission posted in the period.
    const p = new Params();
    const gl = await this.dbs.query<{ sale_id: string; month: string; net: string; tax: string; finance: string; cogs: string; commission: string }>(
      `SELECT l.sale_id, to_char(e.entry_date, 'YYYY-MM') AS month,
              sum(CASE WHEN l.account_code = '4000' THEN l.credit - l.debit ELSE 0 END)::numeric(18,2)::text AS net,
              sum(CASE WHEN l.account_code = '2200' THEN l.credit - l.debit ELSE 0 END)::numeric(18,2)::text AS tax,
              sum(CASE WHEN l.account_code = '4100' THEN l.credit - l.debit ELSE 0 END)::numeric(18,2)::text AS finance,
              sum(CASE WHEN l.account_code = '5000' THEN l.debit - l.credit ELSE 0 END)::numeric(18,2)::text AS cogs,
              sum(CASE WHEN l.account_code = '6100' THEN l.debit - l.credit ELSE 0 END)::numeric(18,2)::text AS commission
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.sale_id IS NOT NULL AND l.account_code IN ('4000', '2200', '4100', '5000', '6100')
          AND e.entry_date >= ${p.add(from)}::date AND e.entry_date <= ${p.add(to)}::date
        GROUP BY l.sale_id, month`,
      p.values,
    );
    const pu = new Params();
    const units = await this.dbs.query<{ sale_id: string; month: string; units: number }>(
      `SELECT source_id AS sale_id, to_char(entry_date, 'YYYY-MM') AS month,
              sum(CASE WHEN event = 'sale.recognized' THEN 1 ELSE -1 END)::int AS units
         FROM journal_entries
        WHERE source_type = 'sale' AND event IN ('sale.recognized', 'sale.recognized.reversed')
          AND entry_date >= ${pu.add(from)}::date AND entry_date <= ${pu.add(to)}::date
        GROUP BY 1, 2`,
      pu.values,
    );
    const key = (s: string, m: string) => `${s}|${m}`;
    const cells = new Map<string, { saleId: string; month: string; net: string; tax: string; finance: string; cogs: string; commission: string; units: number }>();
    for (const g of gl) cells.set(key(g.sale_id, g.month), { saleId: g.sale_id, month: g.month, net: g.net, tax: g.tax, finance: g.finance, cogs: g.cogs, commission: g.commission, units: 0 });
    for (const u of units) {
      const c = cells.get(key(u.sale_id, u.month)) ?? { saleId: u.sale_id, month: u.month, net: '0', tax: '0', finance: '0', cogs: '0', commission: '0', units: 0 };
      c.units += u.units;
      cells.set(key(u.sale_id, u.month), c);
    }
    const saleIds = [...new Set([...cells.values()].map((c) => c.saleId))];
    const pm = new Params();
    const where = [`s.id = ANY(${pm.add(saleIds)}::uuid[])`];
    if (scope.ids) where.push(`s.branch_id = ANY(${pm.add(scope.ids)}::uuid[])`);
    if (q.salespersonId) where.push(`s.salesperson_id = ${pm.add(q.salespersonId)}::uuid`);
    if (q.paymentType) where.push(`s.payment_type = ${pm.add(q.paymentType)}`);
    const meta = saleIds.length
      ? await this.dbs.query<{
          id: string;
          number: string;
          status: string;
          recognition_date: string | null;
          payment_type: string;
          branch_id: string;
          branch: string;
          salesperson_id: string;
          salesperson: string | null;
          customer: string;
          vehicle: string;
          stock_number: string;
          source: string;
        }>(
          `SELECT s.id, s.number, s.status, s.recognition_date::text, s.payment_type, s.branch_id, b.name AS branch,
                  s.salesperson_id, u.full_name AS salesperson, c.full_name AS customer,
                  concat_ws(' ', s.vehicle_snapshot->>'makeEn', s.vehicle_snapshot->>'modelEn', s.vehicle_snapshot->>'modelYear') AS vehicle,
                  s.vehicle_snapshot->>'stockNumber' AS stock_number, coalesce(ld.source, 'direct') AS source
             FROM sales s
             JOIN branches b ON b.id = s.branch_id
             JOIN customers c ON c.id = s.customer_id
             LEFT JOIN users u ON u.id = s.salesperson_id
             LEFT JOIN leads ld ON ld.id = s.lead_id
            WHERE ${where.join(' AND ')}`,
          pm.values,
        )
      : [];
    const byId = new Map(meta.map((m) => [m.id, m]));
    const included = [...cells.values()].filter((c) => byId.has(c.saleId));

    const figures = (cs: typeof included) => {
      const net = dsum(cs.map((c) => c.net));
      const cogs = dsum(cs.map((c) => c.cogs));
      const commission = dsum(cs.map((c) => c.commission));
      const finance = dsum(cs.map((c) => c.finance));
      const gross = net.minus(cogs);
      return {
        units: cs.reduce((a, c) => a + c.units, 0),
        netRevenue: net.toFixed(2),
        tax: dsum(cs.map((c) => c.tax)).toFixed(2),
        financeIncome: finance.toFixed(2),
        cogs: cogs.toFixed(2),
        grossProfit: gross.toFixed(2),
        commission: commission.toFixed(2),
        contribution: gross.minus(commission).plus(finance).toFixed(2),
        marginPct: pct(gross.toFixed(2), net.toFixed(2)),
      };
    };
    const FIGURE_COLUMNS = [
      col('units', 'Units', 'عدد السيارات', 'number'),
      col('netRevenue', 'Net revenue', 'صافي الإيراد', 'money'),
      col('tax', 'Tax', 'الضريبة', 'money'),
      col('financeIncome', 'Finance income', 'إيراد التمويل', 'money'),
      col('cogs', 'Cost of sale', 'تكلفة المبيعات', 'money', { sensitive: true }),
      col('grossProfit', 'Gross profit', 'مجمل الربح', 'money', { sensitive: true }),
      col('commission', 'Commission', 'العمولة', 'money', { sensitive: true }),
      col('contribution', 'Contribution', 'صافي المساهمة', 'money', { sensitive: true }),
      col('marginPct', 'Gross margin %', 'نسبة مجمل الربح', 'percent', { sensitive: true }),
    ];

    let columns;
    let rows: Row[];
    if (q.groupBy) {
      const groupKey = (c: (typeof included)[number]): { key: string; label: string } => {
        const m = byId.get(c.saleId)!;
        switch (q.groupBy) {
          case 'salesperson':
            return { key: m.salesperson_id, label: m.salesperson ?? '—' };
          case 'branch':
            return { key: m.branch_id, label: m.branch };
          case 'source':
            return { key: m.source, label: m.source };
          case 'paymentType':
            return { key: m.payment_type, label: m.payment_type };
          default:
            return { key: c.month, label: c.month };
        }
      };
      const groups = new Map<string, { label: string; cells: typeof included; sales: Set<string> }>();
      for (const c of included) {
        const g = groupKey(c);
        const e = groups.get(g.key) ?? { label: g.label, cells: [], sales: new Set<string>() };
        e.cells.push(c);
        e.sales.add(c.saleId);
        groups.set(g.key, e);
      }
      const options = q.groupBy === 'source' ? LEAD_SOURCE_OPTIONS : q.groupBy === 'paymentType' ? PAYMENT_TYPE_OPTIONS : undefined;
      const groupLabel = { salesperson: ['Salesperson', 'مندوب المبيعات'], branch: ['Branch', 'الفرع'], source: ['Lead source', 'مصدر العميل'], paymentType: ['Payment type', 'طريقة الدفع'], month: ['Month', 'الشهر'] }[q.groupBy];
      columns = [col('group', groupLabel[0]!, groupLabel[1]!, options ? 'enum' : 'text', options ? { options } : {}), col('sales', 'Sales', 'عمليات البيع', 'number'), ...FIGURE_COLUMNS];
      rows = [...groups.entries()]
        .map(([k, g]) => ({ groupKey: k, group: g.label, sales: g.sales.size, ...figures(g.cells) }) as Row)
        .sort((a, b) => (q.groupBy === 'month' ? String(a.group).localeCompare(String(b.group)) : d(b.netRevenue as string).cmp(a.netRevenue as string)));
    } else {
      const perSale = new Map<string, typeof included>();
      for (const c of included) perSale.set(c.saleId, [...(perSale.get(c.saleId) ?? []), c]);
      columns = [
        col('number', 'Sale no.', 'رقم البيع', 'text'),
        col('recognitionDate', 'Recognised on', 'تاريخ الاعتراف', 'date'),
        col('status', 'Status', 'الحالة', 'enum', { options: SALE_STATUS_OPTIONS }),
        col('branch', 'Branch', 'الفرع', 'text'),
        col('salesperson', 'Salesperson', 'المندوب', 'text'),
        col('customer', 'Customer', 'العميل', 'text'),
        col('stockNumber', 'Stock no.', 'رقم المخزون', 'text'),
        col('vehicle', 'Vehicle', 'السيارة', 'text'),
        col('paymentType', 'Payment', 'طريقة الدفع', 'enum', { options: PAYMENT_TYPE_OPTIONS }),
        col('source', 'Lead source', 'مصدر العميل', 'enum', { options: LEAD_SOURCE_OPTIONS }),
        ...FIGURE_COLUMNS,
      ];
      rows = [...perSale.entries()]
        .map(([id, cs]) => {
          const m = byId.get(id)!;
          return {
            id,
            number: m.number,
            recognitionDate: m.recognition_date,
            status: m.status,
            branch: m.branch,
            salesperson: m.salesperson,
            customer: m.customer,
            stockNumber: m.stock_number,
            vehicle: m.vehicle,
            paymentType: m.payment_type,
            source: m.source,
            ...figures(cs),
          } as Row;
        })
        .sort((a, b) => String(a.number).localeCompare(String(b.number)));
    }
    const truncated = rows.length > MAX_REPORT_ROWS;
    rows = rows.slice(0, MAX_REPORT_ROWS);
    const t = figures(included);
    const totals: Row = { ...t, ...(q.groupBy ? { sales: new Set(included.map((c) => c.saleId)).size } : {}) };
    let reconciliation = null;
    if (scope.companyWide && !q.salespersonId && !q.paymentType) {
      const pr = new Params();
      const [g] = await this.dbs.query<{ revenue: string; cogs: string }>(
        `SELECT coalesce(sum(CASE WHEN l.account_code = '4000' THEN l.credit - l.debit END), 0)::numeric(18,2)::text AS revenue,
                coalesce(sum(CASE WHEN l.account_code = '5000' THEN l.debit - l.credit END), 0)::numeric(18,2)::text AS cogs
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.account_code IN ('4000', '5000') AND e.entry_date >= ${pr.add(from)}::date AND e.entry_date <= ${pr.add(to)}::date`,
        pr.values,
      );
      reconciliation = [
        recon('Net revenue vs ledger 4000', 'صافي الإيراد مقابل الحساب 4000', t.netRevenue, g!.revenue),
        recon('Cost of sale vs ledger 5000', 'تكلفة المبيعات مقابل الحساب 5000', t.cogs, g!.cogs, true),
      ];
    }
    return this.result(
      ctx,
      {
        key: 'sales',
        titleEn: 'Sales and profitability',
        titleAr: 'المبيعات والربحية',
        params: { from, to, branchId: q.branchId ?? null, groupBy: q.groupBy ?? null, salespersonId: q.salespersonId ?? null, paymentType: q.paymentType ?? null },
        columns,
        rows,
        totals,
        summary: [
          sum('units', 'Units sold (net of returns)', 'السيارات المباعة (بعد المرتجعات)', 'number', t.units),
          sum('netRevenue', 'Net revenue', 'صافي الإيراد', 'money', t.netRevenue),
          sum('grossProfit', 'Gross profit', 'مجمل الربح', 'money', t.grossProfit, true),
          sum('marginPct', 'Gross margin %', 'نسبة مجمل الربح', 'percent', t.marginPct, true),
          sum('financeIncome', 'Finance income', 'إيراد التمويل', 'money', t.financeIncome),
        ],
        reconciliation,
        drillDown: q.groupBy ? null : { idKey: 'id', kind: 'sale' },
      },
      truncated,
    );
  }

  // ── Lead conversion ───────────────────────────────────────────────────────────────────

  async leads(ctx: TenantContext, q: z.infer<typeof zLeadsReportQuery>): Promise<ReportResult> {
    requireAll(ctx, ['reports.view']);
    const { from, to } = resolvePeriod(ctx, q.from, q.to);
    const scope = branchFilter(ctx, q.branchId);
    const p = new Params();
    const tz = p.add(ctx.tenant.settings.timezone);
    const where = [`(l.created_at AT TIME ZONE ${tz})::date >= ${p.add(from)}::date`, `(l.created_at AT TIME ZONE ${tz})::date <= ${p.add(to)}::date`];
    if (scope.ids) where.push(`l.branch_id = ANY(${p.add(scope.ids)}::uuid[])`);
    if (q.source) where.push(`l.source = ${p.add(q.source)}`);
    const keyExpr = q.groupBy === 'assignee' ? `coalesce(l.assigned_user_id::text, 'unassigned')` : 'l.source';
    const labelExpr = q.groupBy === 'assignee' ? `coalesce(max(u.full_name), '—')` : 'l.source';
    const rows = await this.dbs.query<{ k: string; label: string; total: number; open: number; won: number; lost: number; avg_days: string | null }>(
      `SELECT ${keyExpr} AS k, ${labelExpr} AS label, count(*)::int AS total,
              count(*) FILTER (WHERE l.status = 'open')::int AS open,
              count(*) FILTER (WHERE l.status = 'won')::int AS won,
              count(*) FILTER (WHERE l.status = 'lost')::int AS lost,
              (avg(EXTRACT(EPOCH FROM (l.closed_at - l.created_at)) / 86400) FILTER (WHERE l.status = 'won'))::numeric(10,1)::text AS avg_days
         FROM leads l LEFT JOIN users u ON u.id = l.assigned_user_id
        WHERE ${where.join(' AND ')}
        GROUP BY ${keyExpr}${q.groupBy === 'assignee' ? '' : ', l.source'}
        ORDER BY total DESC`,
      p.values,
    );
    const out: Row[] = rows.map((r) => ({
      groupKey: r.k,
      group: r.label,
      total: r.total,
      open: r.open,
      won: r.won,
      lost: r.lost,
      conversionPct: r.total ? pct(String(r.won), String(r.total)) : null,
      avgDaysToWin: r.avg_days,
    }));
    const tot = { total: 0, open: 0, won: 0, lost: 0 };
    for (const r of rows) {
      tot.total += r.total;
      tot.open += r.open;
      tot.won += r.won;
      tot.lost += r.lost;
    }
    const conversion = tot.total ? pct(String(tot.won), String(tot.total)) : null;
    return this.result(
      ctx,
      {
        key: 'leads',
        titleEn: 'Lead conversion',
        titleAr: 'تحويل العملاء المحتملين',
        params: { from, to, branchId: q.branchId ?? null, groupBy: q.groupBy, source: q.source ?? null },
        columns: [
          q.groupBy === 'assignee'
            ? col('group', 'Assigned to', 'المسؤول', 'text')
            : col('group', 'Lead source', 'مصدر العميل', 'enum', { options: LEAD_SOURCE_OPTIONS }),
          col('total', 'New leads', 'عملاء جدد', 'number'),
          col('open', 'Open', 'مفتوحة', 'number'),
          col('won', 'Won', 'ناجحة', 'number'),
          col('lost', 'Lost', 'خاسرة', 'number'),
          col('conversionPct', 'Conversion %', 'نسبة التحويل', 'percent'),
          col('avgDaysToWin', 'Avg. days to win', 'متوسط أيام الإغلاق', 'number'),
        ],
        rows: out,
        totals: { ...tot, conversionPct: conversion },
        summary: [
          sum('total', 'New leads', 'عملاء جدد', 'number', tot.total),
          sum('won', 'Won', 'ناجحة', 'number', tot.won),
          sum('conversionPct', 'Conversion %', 'نسبة التحويل', 'percent', conversion),
        ],
        reconciliation: null,
        drillDown: null,
      },
      false,
    );
  }

  // ── Cash flow ─────────────────────────────────────────────────────────────────────────

  async cashFlow(ctx: TenantContext, q: z.infer<typeof zCashFlowReportQuery>): Promise<ReportResult> {
    requireAll(ctx, ['reports.financial', 'cash.read']);
    const { from, to } = resolvePeriod(ctx, q.from, q.to);
    const scope = branchFilter(ctx, q.branchId);
    const p = new Params();
    const pf = p.add(from);
    const pt = p.add(to);
    const where: string[] = [];
    // Company-level accounts (no branch) belong to all-branch users only.
    if (scope.ids) where.push(`a.branch_id = ANY(${p.add(scope.ids)}::uuid[])`);
    if (q.cashAccountId) where.push(`a.id = ${p.add(q.cashAccountId)}::uuid`);
    const signed = (col: string) => `CASE WHEN t.direction = 'in' THEN t.${col} ELSE -t.${col} END`;
    const accounts = await this.dbs.query<{
      id: string;
      name: string;
      currency: string;
      type: string;
      branch: string | null;
      opening: string;
      inflow: string;
      outflow: string;
      closing: string;
      opening_base: string;
      inflow_base: string;
      outflow_base: string;
      closing_base: string;
    }>(
      `SELECT a.id, a.name, a.currency, a.type, b.name AS branch,
              coalesce(sum(${signed('amount')}) FILTER (WHERE t.business_date < ${pf}::date), 0)::numeric(18,2)::text AS opening,
              coalesce(sum(t.amount) FILTER (WHERE t.direction = 'in' AND t.business_date BETWEEN ${pf}::date AND ${pt}::date), 0)::numeric(18,2)::text AS inflow,
              coalesce(sum(t.amount) FILTER (WHERE t.direction = 'out' AND t.business_date BETWEEN ${pf}::date AND ${pt}::date), 0)::numeric(18,2)::text AS outflow,
              coalesce(sum(${signed('amount')}) FILTER (WHERE t.business_date <= ${pt}::date), 0)::numeric(18,2)::text AS closing,
              coalesce(sum(${signed('amount_base')}) FILTER (WHERE t.business_date < ${pf}::date), 0)::numeric(18,2)::text AS opening_base,
              coalesce(sum(t.amount_base) FILTER (WHERE t.direction = 'in' AND t.business_date BETWEEN ${pf}::date AND ${pt}::date), 0)::numeric(18,2)::text AS inflow_base,
              coalesce(sum(t.amount_base) FILTER (WHERE t.direction = 'out' AND t.business_date BETWEEN ${pf}::date AND ${pt}::date), 0)::numeric(18,2)::text AS outflow_base,
              coalesce(sum(${signed('amount_base')}) FILTER (WHERE t.business_date <= ${pt}::date), 0)::numeric(18,2)::text AS closing_base
         FROM cash_accounts a
         LEFT JOIN branches b ON b.id = a.branch_id
         LEFT JOIN cash_transactions t ON t.cash_account_id = a.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY a.id, b.name
        ORDER BY a.name`,
      p.values,
    );
    const pk = new Params();
    const kw = [`t.business_date >= ${pk.add(from)}::date`, `t.business_date <= ${pk.add(to)}::date`];
    if (scope.ids) kw.push(`a.branch_id = ANY(${pk.add(scope.ids)}::uuid[])`);
    if (q.cashAccountId) kw.push(`a.id = ${pk.add(q.cashAccountId)}::uuid`);
    const kinds = await this.dbs.query<{ kind: string; inflow: string; outflow: string }>(
      `SELECT t.kind, coalesce(sum(t.amount_base) FILTER (WHERE t.direction = 'in'), 0)::numeric(18,2)::text AS inflow,
              coalesce(sum(t.amount_base) FILTER (WHERE t.direction = 'out'), 0)::numeric(18,2)::text AS outflow
         FROM cash_transactions t JOIN cash_accounts a ON a.id = t.cash_account_id
        WHERE ${kw.join(' AND ')}
        GROUP BY t.kind ORDER BY t.kind`,
      pk.values,
    );
    const kindLabels = cashKindOptions(kinds.map((k) => k.kind));
    const rows: Row[] = accounts.map((a) => ({
      id: a.id,
      account: a.name,
      branch: a.branch,
      currency: a.currency,
      opening: a.opening,
      inflow: a.inflow,
      outflow: a.outflow,
      closing: a.closing,
      closingBase: a.closing_base,
    }));
    const base = (k: 'opening_base' | 'inflow_base' | 'outflow_base' | 'closing_base') => dsum(accounts.map((a) => a[k])).toFixed(2);
    let reconciliation = null;
    if (scope.companyWide && !q.cashAccountId) {
      const pg = new Params();
      const [g] = await this.dbs.query<{ closing: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS closing
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.account_code = '1100' AND e.entry_date <= ${pg.add(to)}::date`,
        pg.values,
      );
      reconciliation = [recon('Closing cash vs ledger 1100', 'رصيد النقدية الختامي مقابل الحساب 1100', base('closing_base'), g!.closing)];
    }
    return this.result(
      ctx,
      {
        key: 'cash-flow',
        titleEn: 'Cash flow',
        titleAr: 'التدفقات النقدية',
        params: { from, to, branchId: q.branchId ?? null, cashAccountId: q.cashAccountId ?? null },
        columns: [
          col('account', 'Account', 'الحساب', 'text'),
          col('branch', 'Branch', 'الفرع', 'text'),
          col('currency', 'Currency', 'العملة', 'text'),
          col('opening', 'Opening', 'الرصيد الافتتاحي', 'money'),
          col('inflow', 'In', 'وارد', 'money'),
          col('outflow', 'Out', 'منصرف', 'money'),
          col('closing', 'Closing', 'الرصيد الختامي', 'money'),
          col('closingBase', 'Closing (base currency)', 'الرصيد الختامي (العملة الأساسية)', 'money'),
        ],
        rows,
        totals: { opening: base('opening_base'), inflow: base('inflow_base'), outflow: base('outflow_base'), closingBase: base('closing_base') },
        summary: [
          sum('openingBase', 'Opening (base)', 'الافتتاحي (أساسية)', 'money', base('opening_base')),
          sum('inflowBase', 'Total in (base)', 'إجمالي الوارد (أساسية)', 'money', base('inflow_base')),
          sum('outflowBase', 'Total out (base)', 'إجمالي المنصرف (أساسية)', 'money', base('outflow_base')),
          sum('closingBase', 'Closing (base)', 'الختامي (أساسية)', 'money', base('closing_base')),
          ...kinds.flatMap((k) => [
            ...(d(k.inflow).isZero() ? [] : [sum(`in:${k.kind}`, `In: ${kindLabels[k.kind]!.en}`, `وارد: ${kindLabels[k.kind]!.ar}`, 'money', k.inflow)]),
            ...(d(k.outflow).isZero() ? [] : [sum(`out:${k.kind}`, `Out: ${kindLabels[k.kind]!.en}`, `منصرف: ${kindLabels[k.kind]!.ar}`, 'money', k.outflow)]),
          ]),
        ],
        reconciliation,
        drillDown: { idKey: 'id', kind: 'cash_account' },
      },
      false,
    );
  }

  // ── Receivables & installment aging ───────────────────────────────────────────────────

  async receivables(ctx: TenantContext, q: z.infer<typeof zReceivablesReportQuery>): Promise<ReportResult> {
    requireAll(ctx, ['reports.financial']);
    const asOf = q.asOf ?? todayInZone(ctx.tenant.settings.timezone);
    const scope = branchFilter(ctx, q.branchId);
    const p = new Params();
    const pa = p.add(asOf);
    const scopeSql = scope.ids ? `AND s.branch_id = ANY(${p.add(scope.ids)}::uuid[])` : '';
    // Installments unpaid at the date (receipts received after it do not count).
    const unpaid = `i.total_due - coalesce((SELECT sum(a.principal + a.interest + a.fees) FROM installment_allocations a JOIN receipts r ON r.id = a.receipt_id
                      WHERE a.installment_id = i.id AND r.status = 'posted' AND r.received_at <= ${pa}::date), 0)`;
    const rows = await this.dbs.query<{
      id: string;
      number: string;
      status: string;
      payment_type: string;
      recognition_date: string | null;
      branch: string;
      customer: string;
      phone: string | null;
      balance: string;
      oldest_due: string | null;
      overdue: string;
    }>(
      `WITH ar AS (
          SELECT l.sale_id, sum(l.debit - l.credit) AS bal
            FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
           WHERE l.account_code = '1200' AND l.sale_id IS NOT NULL AND e.entry_date <= ${pa}::date
           GROUP BY l.sale_id HAVING sum(l.debit - l.credit) <> 0)
       SELECT s.id, s.number, s.status, s.payment_type, s.recognition_date::text, b.name AS branch, c.full_name AS customer, c.phone,
              ar.bal::numeric(18,2)::text AS balance,
              (SELECT min(i.due_date)::text FROM installments i JOIN installment_plans p ON p.id = i.plan_id
                WHERE p.sale_id = s.id AND p.status IN ('active', 'completed') AND i.due_date <= ${pa}::date AND ${unpaid} > 0) AS oldest_due,
              coalesce((SELECT sum(${unpaid}) FROM installments i JOIN installment_plans p ON p.id = i.plan_id
                WHERE p.sale_id = s.id AND p.status IN ('active', 'completed') AND i.due_date <= ${pa}::date AND ${unpaid} > 0), 0)::numeric(18,2)::text AS overdue
         FROM ar JOIN sales s ON s.id = ar.sale_id
         JOIN branches b ON b.id = s.branch_id
         JOIN customers c ON c.id = s.customer_id
        WHERE true ${scopeSql}
        ORDER BY s.number
        LIMIT ${MAX_REPORT_ROWS + 1}`,
      p.values,
    );
    const truncated = rows.length > MAX_REPORT_ROWS;
    const days = (from: string) => Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    const out: Row[] = rows.slice(0, MAX_REPORT_ROWS).map((r) => {
      // Installment sales age by their oldest unpaid due installment; other sales by recognition date.
      const age = r.payment_type === 'installments' ? (r.oldest_due ? days(r.oldest_due) : null) : r.recognition_date ? days(r.recognition_date) : null;
      return {
        id: r.id,
        number: r.number,
        customer: r.customer,
        phone: r.phone,
        branch: r.branch,
        paymentType: r.payment_type,
        status: r.status,
        recognitionDate: r.recognition_date,
        balance: r.balance,
        overdue: r.payment_type === 'installments' ? r.overdue : d(r.balance).gt(0) ? r.balance : '0.00',
        daysOverdue: age,
        bucket: age === null ? 'current' : stockAgeBucket(Math.max(age, 0)),
      };
    });
    const total = dsum(out.map((r) => r.balance as string)).toFixed(2);
    const overdue = dsum(out.map((r) => r.overdue as string)).toFixed(2);
    let reconciliation = null;
    if (scope.companyWide && !truncated) {
      const pg = new Params();
      const [g] = await this.dbs.query<{ b: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.account_code = '1200' AND e.entry_date <= ${pg.add(asOf)}::date`,
        pg.values,
      );
      reconciliation = [recon('Receivables vs ledger 1200', 'الذمم المدينة مقابل الحساب 1200', total, g!.b)];
    }
    return this.result(
      ctx,
      {
        key: 'receivables',
        titleEn: 'Receivables and installment aging',
        titleAr: 'أعمار الذمم المدينة والأقساط',
        params: { asOf, branchId: q.branchId ?? null },
        columns: [
          col('number', 'Sale no.', 'رقم البيع', 'text'),
          col('customer', 'Customer', 'العميل', 'text'),
          col('phone', 'Phone', 'الهاتف', 'text'),
          col('branch', 'Branch', 'الفرع', 'text'),
          col('paymentType', 'Payment', 'طريقة الدفع', 'enum', { options: PAYMENT_TYPE_OPTIONS }),
          col('recognitionDate', 'Recognised on', 'تاريخ الاعتراف', 'date'),
          col('balance', 'Balance', 'الرصيد', 'money'),
          col('overdue', 'Overdue', 'المتأخر', 'money'),
          col('daysOverdue', 'Days', 'الأيام', 'number'),
          col('bucket', 'Age', 'العمر', 'enum', { options: RECEIVABLE_AGE_OPTIONS }),
        ],
        rows: out,
        totals: { balance: total, overdue },
        summary: [
          sum('total', 'Total receivables', 'إجمالي الذمم المدينة', 'money', total),
          sum('overdue', 'Overdue', 'المتأخر', 'money', overdue),
          ...Object.keys(RECEIVABLE_AGE_OPTIONS).map((b) =>
            sum(`bucket:${b}`, RECEIVABLE_AGE_OPTIONS[b]!.en, RECEIVABLE_AGE_OPTIONS[b]!.ar, 'money', dsum(out.filter((r) => r.bucket === b).map((r) => r.balance as string)).toFixed(2)),
          ),
        ],
        reconciliation,
        drillDown: { idKey: 'id', kind: 'sale' },
      },
      truncated,
    );
  }

  canSeeCost(ctx: TenantContext): boolean {
    return hasPermission(ctx, 'vehicles.view_cost');
  }
}
