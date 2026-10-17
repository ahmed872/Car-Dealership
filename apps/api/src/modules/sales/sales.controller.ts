import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  zCommissionListQuery,
  zCommissionPay,
  zEarlySettlement,
  zExternalFinanceDecision,
  zInstallmentListQuery,
  zIssueDocument,
  zSaleCancel,
  zSaleCreate,
  zSaleDecision,
  zSaleDeliver,
  zSaleListQuery,
  zSalePreview,
  zSaleReject,
  zSaleReturn,
  zSaleUpdate,
  zSaleVersion,
  zSettlementQuoteQuery,
  zTradeInInput,
  zVoidDocument,
} from '@autohub/shared';
import { Authenticated, Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { CommissionsService } from './commissions.service';
import { SaleDocumentsService } from './documents.service';
import { InstallmentsService } from './installments.service';
import { SalesService } from './sales.service';

class SaleCreateDto extends createZodDto(zSaleCreate) {}
class SalePreviewDto extends createZodDto(zSalePreview) {}
class SaleUpdateDto extends createZodDto(zSaleUpdate) {}
class SaleListQueryDto extends createZodDto(zSaleListQuery) {}
class SaleVersionDto extends createZodDto(zSaleVersion) {}
class SaleDecisionDto extends createZodDto(zSaleDecision) {}
class SaleRejectDto extends createZodDto(zSaleReject) {}
class SaleDeliverDto extends createZodDto(zSaleDeliver) {}
class SaleCancelDto extends createZodDto(zSaleCancel) {}
class SaleReturnDto extends createZodDto(zSaleReturn) {}
class ExternalFinanceDto extends createZodDto(zExternalFinanceDecision) {}
class TradeInDto extends createZodDto(zTradeInInput.extend({ version: z.number().int().min(1) })) {}
class IssueDocumentDto extends createZodDto(zIssueDocument) {}
class VoidDocumentDto extends createZodDto(zVoidDocument) {}
class InstallmentListQueryDto extends createZodDto(zInstallmentListQuery) {}
class SettlementQuoteQueryDto extends createZodDto(zSettlementQuoteQuery) {}
class EarlySettlementDto extends createZodDto(zEarlySettlement) {}
class CommissionListQueryDto extends createZodDto(zCommissionListQuery) {}
class CommissionPayDto extends createZodDto(zCommissionPay) {}

@ApiTags('sales')
@Controller('sales')
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly documents: SaleDocumentsService,
  ) {}

  @Get()
  @RequirePermissions('sales.read')
  list(@Ctx() ctx: TenantContext, @Query() q: SaleListQueryDto) {
    return this.sales.list(ctx, q);
  }

  /** Price, discount, tax and schedule for a proposed sale (nothing is saved). */
  @Post('preview')
  @HttpCode(200)
  @RequirePermissions('sales.create')
  preview(@Ctx() ctx: TenantContext, @Body() body: SalePreviewDto) {
    return this.sales.preview(ctx, body);
  }

  @Post()
  @RequirePermissions('sales.create')
  create(@Ctx() ctx: TenantContext, @Body() body: SaleCreateDto) {
    return this.sales.create(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('sales.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('sales.create')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaleUpdateDto) {
    return this.sales.update(ctx, id, body);
  }

  @Post(':id/trade-ins')
  @RequirePermissions('sales.create')
  addTradeIn(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TradeInDto) {
    return this.sales.addTradeIn(ctx, id, body);
  }

  @Post(':id/trade-ins/:tradeInId/remove')
  @HttpCode(200)
  @RequirePermissions('sales.create')
  removeTradeIn(
    @Ctx() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tradeInId', ParseUUIDPipe) tradeInId: string,
    @Body() body: SaleVersionDto,
  ) {
    return this.sales.removeTradeIn(ctx, id, tradeInId, body.version);
  }

  /** Needs sales.approve_discount or sales.approve_below_floor (checked against the sale). */
  @Post(':id/approve')
  @HttpCode(200)
  @Authenticated()
  approve(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaleDecisionDto) {
    return this.sales.approve(ctx, id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Authenticated()
  reject(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaleRejectDto) {
    return this.sales.reject(ctx, id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('sales.confirm')
  confirm(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaleVersionDto) {
    return this.sales.confirm(ctx, id, body);
  }

  @Post(':id/external-finance')
  @HttpCode(200)
  @RequirePermissions('sales.confirm')
  externalFinance(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ExternalFinanceDto) {
    return this.sales.decideExternalFinance(ctx, id, body);
  }

  @Post(':id/deliver')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('sales.deliver')
  deliver(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaleDeliverDto) {
    return this.sales.deliver(ctx, id, body);
  }

  /** sales.cancel for drafts; sales.cancel_confirmed once confirmed (checked in the service). */
  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent()
  @Authenticated()
  cancel(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaleCancelDto) {
    return this.sales.cancel(ctx, id, body);
  }

  @Post(':id/return')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('sales.return')
  returnSale(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaleReturnDto) {
    return this.sales.returnSale(ctx, id, body);
  }

  @Post(':id/documents')
  @RequirePermissions('documents.issue')
  issue(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: IssueDocumentDto) {
    return this.documents.issue(ctx, id, body);
  }
}

@ApiTags('sales')
@Controller('sale-documents')
export class SaleDocumentsController {
  constructor(private readonly documents: SaleDocumentsService) {}

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermissions('documents.void')
  void(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: VoidDocumentDto) {
    return this.documents.void(ctx, id, body.reason);
  }

  @Get(':id/pdf')
  @RequirePermissions('sales.read')
  async pdf(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { filename, body } = await this.documents.renderPdf(ctx, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return new StreamableFile(body);
  }
}

@ApiTags('sales')
@Controller('installment-plans')
export class InstallmentPlansController {
  constructor(private readonly installments: InstallmentsService) {}

  @Get()
  @RequirePermissions('installments.read')
  list(@Ctx() ctx: TenantContext, @Query() q: InstallmentListQueryDto) {
    return this.installments.list(ctx, q);
  }

  @Get(':id')
  @RequirePermissions('installments.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.installments.get(ctx, id);
  }

  @Get(':id/settlement-quote')
  @RequirePermissions('installments.read')
  quote(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: SettlementQuoteQueryDto) {
    return this.installments.quote(ctx, id, q);
  }

  @Post(':id/settle')
  @Idempotent()
  @RequirePermissions('installments.settle', 'payments.receive')
  settle(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: EarlySettlementDto) {
    return this.installments.settle(ctx, id, body);
  }
}

@ApiTags('sales')
@Controller('commissions')
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  /** Own commissions with commissions.read_own; everyone's with commissions.read. */
  @Get()
  @Authenticated()
  list(@Ctx() ctx: TenantContext, @Query() q: CommissionListQueryDto) {
    return this.commissions.list(ctx, q);
  }

  @Get(':id')
  @Authenticated()
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.commissions.get(ctx, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('commissions.approve')
  approve(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.commissions.approve(ctx, id);
  }

  @Post(':id/pay')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('commissions.pay')
  pay(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CommissionPayDto) {
    return this.commissions.pay(ctx, id, body);
  }
}
