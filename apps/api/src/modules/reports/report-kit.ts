import { HttpStatus } from '@nestjs/common';
import {
  d,
  LEAD_SOURCES,
  ReportCell,
  ReportColumn,
  ReportColumnType,
  ReportResult,
  ReportSummaryItem,
  SALE_PAYMENT_TYPES,
  SALE_STATUSES,
  todayInZone,
  VEHICLE_STATUS_LABELS,
  VEHICLE_STATUSES,
} from '@autohub/shared';
import { assertBranchAccess, hasPermission, TenantContext } from '../../common/context';
import { AppError, unprocessable } from '../../common/errors';

/** Rows returned by one report run (screen or export). Larger results are cut and flagged. */
export const MAX_REPORT_ROWS = 20_000;

type Labels = Record<string, { en: string; ar: string }>;

export const col = (key: string, labelEn: string, labelAr: string, type: ReportColumnType, extra: Partial<ReportColumn> = {}): ReportColumn => ({
  key,
  labelEn,
  labelAr,
  type,
  ...extra,
});
export const sum = (key: string, labelEn: string, labelAr: string, type: ReportColumnType, value: ReportCell, sensitive = false) =>
  ({ key, labelEn, labelAr, type, value, ...(sensitive ? { sensitive: true } : {}) }) as ReportSummaryItem & { sensitive?: boolean };

export const VEHICLE_STATUS_OPTIONS: Labels = Object.fromEntries(VEHICLE_STATUSES.map((s) => [s, { en: VEHICLE_STATUS_LABELS[s].en, ar: VEHICLE_STATUS_LABELS[s].ar }]));

export const SALE_STATUS_OPTIONS: Labels = Object.fromEntries(
  SALE_STATUSES.map((s) => [
    s,
    {
      draft: { en: 'Draft', ar: 'مسودة' },
      pending_approval: { en: 'Pending approval', ar: 'بانتظار الاعتماد' },
      approved: { en: 'Approved', ar: 'معتمدة' },
      confirmed: { en: 'Confirmed', ar: 'مؤكدة' },
      delivered: { en: 'Delivered', ar: 'مسلّمة' },
      cancelled: { en: 'Cancelled', ar: 'ملغاة' },
      returned: { en: 'Returned', ar: 'مرتجعة' },
    }[s],
  ]),
);

export const PAYMENT_TYPE_OPTIONS: Labels = Object.fromEntries(
  SALE_PAYMENT_TYPES.map((p) => [
    p,
    { cash: { en: 'Cash', ar: 'نقدًا' }, installments: { en: 'Installments', ar: 'تقسيط' }, external_finance: { en: 'External finance', ar: 'تمويل خارجي' } }[p],
  ]),
);

export const LEAD_SOURCE_OPTIONS: Labels = {
  ...Object.fromEntries(
    LEAD_SOURCES.map((s) => [
      s,
      {
        walk_in: { en: 'Walk-in', ar: 'زيارة مباشرة' },
        phone: { en: 'Phone', ar: 'هاتف' },
        whatsapp: { en: 'WhatsApp', ar: 'واتساب' },
        website: { en: 'Website', ar: 'الموقع الإلكتروني' },
        showroom: { en: 'Online showroom', ar: 'المعرض الإلكتروني' },
        referral: { en: 'Referral', ar: 'ترشيح' },
        social: { en: 'Social media', ar: 'وسائل التواصل' },
        marketplace: { en: 'Marketplace', ar: 'منصات الإعلانات' },
        campaign: { en: 'Campaign', ar: 'حملة' },
        other: { en: 'Other', ar: 'أخرى' },
      }[s],
    ]),
  ),
  direct: { en: 'Direct (no lead)', ar: 'مباشر (بدون عميل محتمل)' },
};

const CASH_KINDS: Labels = {
  opening_balance: { en: 'Opening balance', ar: 'رصيد افتتاحي' },
  customer_receipt: { en: 'Customer receipts', ar: 'مقبوضات العملاء' },
  customer_refund: { en: 'Customer refunds', ar: 'مردودات للعملاء' },
  supplier_payment: { en: 'Supplier payments', ar: 'مدفوعات الموردين' },
  commission_payment: { en: 'Commission payments', ar: 'صرف العمولات' },
  transfer_in: { en: 'Transfers in', ar: 'تحويلات واردة' },
  transfer_out: { en: 'Transfers out', ar: 'تحويلات صادرة' },
  cash_over: { en: 'Cash over (closing)', ar: 'زيادة الخزينة (الإغلاق)' },
  cash_short: { en: 'Cash short (closing)', ar: 'عجز الخزينة (الإغلاق)' },
};
/** Display labels for cash-book kinds, including their reversals. */
export function cashKindOptions(kinds: string[]): Labels {
  const out: Labels = {};
  for (const k of kinds) {
    const base = k.endsWith('_reversal') ? k.slice(0, -'_reversal'.length) : k;
    const l = CASH_KINDS[base] ?? { en: base.replace(/_/g, ' '), ar: base.replace(/_/g, ' ') };
    out[k] = k === base ? l : { en: `${l.en} (reversal)`, ar: `${l.ar} (عكس)` };
  }
  return out;
}

export const STOCK_AGE_OPTIONS: Labels = {
  '0-30': { en: '0–30 days', ar: '0–30 يومًا' },
  '31-60': { en: '31–60 days', ar: '31–60 يومًا' },
  '61-90': { en: '61–90 days', ar: '61–90 يومًا' },
  '90+': { en: 'Over 90 days', ar: 'أكثر من 90 يومًا' },
};
export const stockAgeBucket = (days: number): string => (days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');

export const RECEIVABLE_AGE_OPTIONS: Labels = {
  current: { en: 'Not yet due', ar: 'غير مستحق بعد' },
  ...STOCK_AGE_OPTIONS,
};

export const money2 = (v: unknown): string => d((v as string | number | null) ?? 0).toFixed(2);

/** Default period: the 1st of the current month to today (company time zone). */
export function resolvePeriod(ctx: TenantContext, from?: string, to?: string): { from: string; to: string } {
  const today = todayInZone(ctx.tenant.settings.timezone);
  const end = to ?? today;
  const start = from ?? `${end.slice(0, 7)}-01`;
  if (start > end) throw unprocessable('invalid_range', 'The start date must be on or before the end date', { from: start, to: end });
  return { from: start, to: end };
}

/** Branch restriction for a report run: an explicit branch (checked) or the user's branch scope. */
export function branchFilter(ctx: TenantContext, branchId?: string): { ids: string[] | null; companyWide: boolean } {
  if (branchId) {
    assertBranchAccess(ctx, branchId);
    return { ids: [branchId], companyWide: false };
  }
  if (ctx.allBranches) return { ids: null, companyWide: true };
  return { ids: ctx.branchIds.length ? ctx.branchIds : ['00000000-0000-0000-0000-000000000000'], companyWide: false };
}

export function requireAll(ctx: TenantContext, perms: string[]): void {
  const missing = perms.filter((p) => !hasPermission(ctx, p as never));
  if (missing.length) throw new AppError('forbidden', HttpStatus.FORBIDDEN, 'You do not have permission to view this report', { missing });
}

/**
 * Column-level policy: cost and profit columns (and summary items) are removed — not blanked —
 * for users without `vehicles.view_cost`, so neither the screen nor any export carries them.
 */
export function applyColumnPolicy(ctx: TenantContext, r: ReportResult): ReportResult {
  if (hasPermission(ctx, 'vehicles.view_cost')) return r;
  const hidden = new Set(r.columns.filter((c) => c.sensitive).map((c) => c.key));
  const strip = (row: Record<string, ReportCell> | null) => (row ? Object.fromEntries(Object.entries(row).filter(([k]) => !hidden.has(k))) : row);
  return {
    ...r,
    columns: r.columns.filter((c) => !c.sensitive),
    rows: r.rows.map((row) => strip(row)!),
    totals: strip(r.totals),
    summary: r.summary.filter((s) => !(s as { sensitive?: boolean }).sensitive),
    reconciliation: r.reconciliation?.filter((x) => !(x as { sensitive?: boolean }).sensitive) ?? null,
  };
}
