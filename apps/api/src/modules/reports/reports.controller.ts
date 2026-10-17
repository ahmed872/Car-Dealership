import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto, ZodValidationException } from 'nestjs-zod';
import {
  REPORT_KEYS,
  REPORT_QUERY_SCHEMAS,
  ReportKey,
  ReportResult,
  todayInZone,
  zCashFlowReportQuery,
  zDashboardQuery,
  zExportQuery,
  zInventoryReportQuery,
  zLeadsReportQuery,
  zReceivablesReportQuery,
  zSalesReportQuery,
} from '@autohub/shared';
import { Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { notFound } from '../../common/errors';
import { AuditService } from '../audit/audit.service';
import { DashboardService } from './dashboard.service';
import { ReportExportService } from './report-export.service';
import { ReportsService } from './reports.service';

class DashboardQueryDto extends createZodDto(zDashboardQuery) {}
class InventoryQueryDto extends createZodDto(zInventoryReportQuery) {}
class SalesQueryDto extends createZodDto(zSalesReportQuery) {}
class LeadsQueryDto extends createZodDto(zLeadsReportQuery) {}
class CashFlowQueryDto extends createZodDto(zCashFlowReportQuery) {}
class ReceivablesQueryDto extends createZodDto(zReceivablesReportQuery) {}

@ApiTags('reports')
@Controller()
export class ReportsController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly reports: ReportsService,
    private readonly exporter: ReportExportService,
    private readonly audit: AuditService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('dashboard.view')
  getDashboard(@Ctx() ctx: TenantContext, @Query() q: DashboardQueryDto) {
    return this.dashboard.get(ctx, q);
  }

  @Get('reports/inventory')
  @RequirePermissions('reports.view', 'vehicles.read')
  inventory(@Ctx() ctx: TenantContext, @Query() q: InventoryQueryDto) {
    return this.reports.inventory(ctx, q);
  }

  @Get('reports/sales')
  @RequirePermissions('reports.view')
  sales(@Ctx() ctx: TenantContext, @Query() q: SalesQueryDto) {
    return this.reports.sales(ctx, q);
  }

  @Get('reports/leads')
  @RequirePermissions('reports.view')
  leads(@Ctx() ctx: TenantContext, @Query() q: LeadsQueryDto) {
    return this.reports.leads(ctx, q);
  }

  @Get('reports/cash-flow')
  @RequirePermissions('reports.financial', 'cash.read')
  cashFlow(@Ctx() ctx: TenantContext, @Query() q: CashFlowQueryDto) {
    return this.reports.cashFlow(ctx, q);
  }

  @Get('reports/receivables')
  @RequirePermissions('reports.financial')
  receivables(@Ctx() ctx: TenantContext, @Query() q: ReceivablesQueryDto) {
    return this.reports.receivables(ctx, q);
  }

  /** CSV / XLSX / PDF of a report with the same filters and the same column policy as the screen. */
  @Get('reports/:key/export')
  @RequirePermissions('reports.export')
  async export(@Ctx() ctx: TenantContext, @Param('key') key: string, @Query() raw: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    if (!(REPORT_KEYS as readonly string[]).includes(key)) throw notFound('Report');
    const opts = zExportQuery.safeParse(raw);
    if (!opts.success) throw new ZodValidationException(opts.error);
    const { format, locale: _l, ...filters } = opts.data as Record<string, unknown> & { format: 'csv' | 'xlsx' | 'pdf'; locale?: 'ar' | 'en' };
    const parsed = REPORT_QUERY_SCHEMAS[key as ReportKey].safeParse(filters);
    if (!parsed.success) throw new ZodValidationException(parsed.error);
    const report = await this.run(ctx, key as ReportKey, parsed.data);
    const locale = opts.data.locale ?? ctx.tenant.settings.locale;
    const company = (locale === 'ar' ? ctx.tenant.settings.documents.legalNameAr : ctx.tenant.settings.documents.legalNameEn) ?? ctx.tenant.name;
    const file = await this.exporter.render(report, format, locale, company, ctx.tenant.baseCurrency);
    await this.audit.record({
      action: 'report.exported',
      entityType: 'report',
      entityId: key,
      summary: `${key} (${format}, ${report.rows.length} rows)`,
      after: { format, params: report.params, columns: report.columns.map((c) => c.key), rows: report.rows.length },
    });
    const filename = `${key}-${todayInZone(ctx.tenant.settings.timezone)}.${file.ext}`;
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(file.body);
  }

  private run(ctx: TenantContext, key: ReportKey, q: unknown): Promise<ReportResult> {
    switch (key) {
      case 'inventory':
        return this.reports.inventory(ctx, q as never);
      case 'sales':
        return this.reports.sales(ctx, q as never);
      case 'leads':
        return this.reports.leads(ctx, q as never);
      case 'cash-flow':
        return this.reports.cashFlow(ctx, q as never);
      case 'receivables':
        return this.reports.receivables(ctx, q as never);
    }
  }
}
