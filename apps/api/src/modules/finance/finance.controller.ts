import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { zCashAccountCreate, zCashAccountUpdate, zPaginationQuery, zReasonRequired, zSupplierPaymentCreate, zUuid } from '@autohub/shared';
import { Authenticated, Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { APPROVAL_TYPES } from '../../db/schema';
import { ApprovalsService } from './approvals.service';
import { CashAccountsService } from './cash-accounts.service';
import { SupplierPaymentsService } from './supplier-payments.service';

class SupplierPaymentDto extends createZodDto(zSupplierPaymentCreate) {}
class ReasonDto extends createZodDto(zReasonRequired) {}
class CashAccountCreateDto extends createZodDto(zCashAccountCreate) {}
class CashAccountUpdateDto extends createZodDto(zCashAccountUpdate) {}
class CashAccountListQueryDto extends createZodDto(z.object({ includeInactive: z.enum(['true', 'false']).optional() })) {}
class SupplierPaymentListQueryDto extends createZodDto(
  zPaginationQuery.extend({
    supplierId: zUuid.optional(),
    cashAccountId: zUuid.optional(),
    status: z.enum(['posted', 'voided']).optional(),
  }),
) {}

@ApiTags('finance')
@Controller('supplier-payments')
export class SupplierPaymentsController {
  constructor(private readonly payments: SupplierPaymentsService) {}

  /** Supplier payments are accounts-payable data: suppliers.read + payments.read (not sales-side payments.read alone). */
  @Get()
  @RequirePermissions('suppliers.read', 'payments.read')
  list(@Ctx() ctx: TenantContext, @Query() q: SupplierPaymentListQueryDto) {
    return this.payments.list(ctx, q);
  }

  @Post()
  @Idempotent()
  @RequirePermissions('supplier_payments.create')
  create(@Ctx() ctx: TenantContext, @Body() body: SupplierPaymentDto) {
    return this.payments.pay(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('suppliers.read', 'payments.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(ctx, id);
  }

  @Post(':id/void')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('payments.void')
  void(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.payments.void(ctx, id, body.reason);
  }
}

@ApiTags('finance')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /**
   * What awaits a decision the caller is permitted to make (permission + branch). Items the caller
   * raised, created or edited are flagged `canDecide: false` (maker-checker, B-016/D-020).
   */
  @Get()
  @Authenticated()
  async pending(@Ctx() ctx: TenantContext) {
    return this.approvals.pendingFor(ctx);
  }

  /** Exact inbox badge counts (same permission/branch filter as GET /approvals, no row cap). */
  @Get('summary')
  @Authenticated()
  async summary(@Ctx() ctx: TenantContext) {
    const counts = await this.approvals.countPendingFor(ctx);
    const byType = Object.fromEntries(APPROVAL_TYPES.map((t) => [t, counts[t] ?? 0])) as Record<string, number>;
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    return { total, byType, truncated: false };
  }
}

@ApiTags('finance')
@Controller('cash-accounts')
export class CashAccountsController {
  constructor(private readonly accounts: CashAccountsService) {}

  @Get()
  @RequirePermissions('cash.read')
  list(@Ctx() ctx: TenantContext, @Query() q: CashAccountListQueryDto) {
    return this.accounts.list(ctx, { includeInactive: q.includeInactive === 'true' });
  }

  /** Minimal list for payment pickers: anyone who may pay or receive money needs to choose an account. */
  @Get('options')
  @Authenticated()
  async options(@Ctx() ctx: TenantContext) {
    const rows = await this.accounts.list(ctx);
    return rows.map((r) => ({ id: r.id, type: r.type, name: r.name, currency: r.currency, branchId: r.branchId }));
  }

  @Post()
  @Idempotent()
  @RequirePermissions('cash.manage_accounts')
  create(@Ctx() ctx: TenantContext, @Body() body: CashAccountCreateDto) {
    return this.accounts.create(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('cash.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('cash.manage_accounts')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CashAccountUpdateDto) {
    return this.accounts.update(ctx, id, body);
  }
}
