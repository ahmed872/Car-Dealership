import { z } from 'zod';
import { zIsoDate, zLocale, zUuid } from './common';
import { LEAD_SOURCES } from './crm';
import { SALE_PAYMENT_TYPES } from './sales';

export const REPORT_KEYS = ['inventory', 'sales', 'leads', 'cash-flow', 'receivables'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const STOCK_AGE_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type StockAgeBucket = (typeof STOCK_AGE_BUCKETS)[number];

/** Period filter: `to` defaults to today in the company's time zone, `from` to the 1st of that month. */
const zPeriod = z.object({ from: zIsoDate.optional(), to: zIsoDate.optional(), branchId: zUuid.optional() });

export const zDashboardQuery = zPeriod;
export const zInventoryReportQuery = z.object({
  branchId: zUuid.optional(),
  status: z.string().trim().max(40).optional(),
  bucket: z.enum(STOCK_AGE_BUCKETS).optional(),
});
export const SALES_GROUPS = ['salesperson', 'branch', 'source', 'paymentType', 'month'] as const;
export const zSalesReportQuery = zPeriod.extend({
  groupBy: z.enum(SALES_GROUPS).optional(),
  salespersonId: zUuid.optional(),
  paymentType: z.enum(SALE_PAYMENT_TYPES).optional(),
});
export const LEAD_GROUPS = ['source', 'assignee'] as const;
export const zLeadsReportQuery = zPeriod.extend({
  groupBy: z.enum(LEAD_GROUPS).default('source'),
  source: z.enum(LEAD_SOURCES).optional(),
});
export const zCashFlowReportQuery = zPeriod.extend({ cashAccountId: zUuid.optional() });
export const zReceivablesReportQuery = z.object({ asOf: zIsoDate.optional(), branchId: zUuid.optional() });

/** Export query: the report's own filters plus the output format and language. */
export const zExportQuery = z.object({ format: z.enum(EXPORT_FORMATS), locale: zLocale.optional() }).passthrough();

export const REPORT_QUERY_SCHEMAS = {
  inventory: zInventoryReportQuery,
  sales: zSalesReportQuery,
  leads: zLeadsReportQuery,
  'cash-flow': zCashFlowReportQuery,
  receivables: zReceivablesReportQuery,
} as const satisfies Record<ReportKey, z.ZodType>;

export type ReportColumnType = 'text' | 'money' | 'number' | 'date' | 'percent' | 'enum';
export interface ReportColumn {
  key: string;
  labelEn: string;
  labelAr: string;
  type: ReportColumnType;
  /** Cost/profit figures: removed for users without `vehicles.view_cost` (API and exports alike). */
  sensitive?: boolean;
  /** For `enum` columns: display labels of the coded values. */
  options?: Record<string, { en: string; ar: string }>;
}
export type ReportCell = string | number | null;
export interface ReportSummaryItem {
  key: string;
  labelEn: string;
  labelAr: string;
  type: ReportColumnType;
  value: ReportCell;
}
/** A finished report: the same structure feeds the screen and every export format. */
export interface ReportResult {
  key: ReportKey;
  titleEn: string;
  titleAr: string;
  /** The effective filters (defaults applied). */
  params: Record<string, string | null>;
  columns: ReportColumn[];
  rows: Array<Record<string, ReportCell>>;
  totals: Record<string, ReportCell> | null;
  summary: ReportSummaryItem[];
  /** Report totals compared with the general ledger (company-wide runs only). */
  reconciliation: Array<{ labelEn: string; labelAr: string; report: string; ledger: string; difference: string }> | null;
  /** Links rows to their documents (route templates resolved by the client). */
  drillDown?: { idKey: string; kind: 'vehicle' | 'sale' | 'cash_account' | 'lead' } | null;
  generatedAt: string;
  truncated: boolean;
}
