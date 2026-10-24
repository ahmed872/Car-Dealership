import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  zPayablesOpenQuery,
  zPayablesSummaryQuery,
  zSupplierCreate,
  zSupplierDuplicateCheck,
  zSupplierListQuery,
  zSupplierStatementQuery,
  zSupplierUpdate,
} from '@autohub/shared';
import { Authenticated, Ctx, hasPermission, RequirePermissions, TenantContext } from '../../common/context';
import { forbidden } from '../../common/errors';
import { PayablesReportService } from './payables-report.service';
import { SuppliersService } from './suppliers.service';

class SupplierDto extends createZodDto(zSupplierCreate) {}
class SupplierUpdateDto extends createZodDto(zSupplierUpdate) {}
class SupplierListQueryDto extends createZodDto(zSupplierListQuery) {}
class SupplierDuplicateCheckDto extends createZodDto(zSupplierDuplicateCheck) {}
class SupplierStatementQueryDto extends createZodDto(zSupplierStatementQuery) {}
class PayablesOpenQueryDto extends createZodDto(zPayablesOpenQuery) {}
class PayablesSummaryQueryDto extends createZodDto(zPayablesSummaryQuery) {}

@ApiTags('purchasing')
@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly reports: PayablesReportService,
  ) {}

  @Get()
  @RequirePermissions('suppliers.read')
  list(@Query() q: SupplierListQueryDto) {
    return this.suppliers.list(q);
  }

  /**
   * Possible duplicates while filling the create/edit form. POST so a national ID never appears in
   * a URL (access logs, browser history).
   */
  @Post('check-duplicates')
  @HttpCode(200)
  @RequirePermissions('suppliers.read')
  duplicates(@Body() body: SupplierDuplicateCheckDto) {
    return this.suppliers.findDuplicates(body);
  }

  @Post()
  @RequirePermissions('suppliers.manage')
  create(@Ctx() ctx: TenantContext, @Body() body: SupplierDto) {
    return this.suppliers.create(ctx, body);
  }

  /**
   * Supplier 360: the supplier plus its accounts-payable summary. The money summary is financial
   * data, so it is only included for callers with payments.read (otherwise `summary: null`).
   */
  @Get(':id')
  @RequirePermissions('suppliers.read')
  async get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    const supplier = await this.suppliers.get(id);
    const summary = hasPermission(ctx, 'payments.read') ? await this.reports.supplierSummary(ctx, id) : null;
    return { ...supplier, summary };
  }

  /** Full national ID (D-047): suppliers.view_sensitive on top of suppliers.read; every read is audited. */
  @Get(':id/sensitive')
  @RequirePermissions('suppliers.read', 'suppliers.view_sensitive')
  sensitive(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.sensitive(ctx, id);
  }

  @Get(':id/statement')
  @RequirePermissions('suppliers.read', 'payments.read')
  statement(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: SupplierStatementQueryDto) {
    return this.reports.statement(ctx, id, q);
  }

  @Patch(':id')
  @RequirePermissions('suppliers.manage')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SupplierUpdateDto) {
    return this.suppliers.update(ctx, id, body);
  }
}

@ApiTags('purchasing')
@Controller('payables')
export class PayablesController {
  constructor(private readonly reports: PayablesReportService) {}

  /**
   * Open payable documents (outstanding > 0) for the supplier-payment form or AP review.
   * supplierId=none lists direct purchases (no supplier). Needs supplier_payments.create, or
   * suppliers.read + payments.read (payables show purchase prices: never for sales-side roles).
   */
  @Get('open')
  @Authenticated()
  open(@Ctx() ctx: TenantContext, @Query() q: PayablesOpenQueryDto) {
    const apReader = hasPermission(ctx, 'suppliers.read') && hasPermission(ctx, 'payments.read');
    if (!hasPermission(ctx, 'supplier_payments.create') && !apReader) {
      throw forbidden('You do not have permission to view payables', { permission: ['supplier_payments.create', 'suppliers.read+payments.read'] });
    }
    return this.reports.open(ctx, q);
  }

  /** Aging per supplier as of a date, with the GL 2000 reconciliation for company-wide users. */
  @Get('summary')
  @RequirePermissions('suppliers.read', 'payments.read')
  summary(@Ctx() ctx: TenantContext, @Query() q: PayablesSummaryQueryDto) {
    return this.reports.summary(ctx, q.asOf);
  }
}
