import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { zReasonRequired, zReceiptCreate, zReceiptListQuery, zRefundDecision, zRefundListQuery, zRefundPay, zRefundRequest } from '@autohub/shared';
import { Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { ReceiptsService } from './receipts.service';
import { RefundsService } from './refunds.service';

class ReceiptCreateDto extends createZodDto(zReceiptCreate) {}
class ReceiptListQueryDto extends createZodDto(zReceiptListQuery) {}
class ReasonDto extends createZodDto(zReasonRequired) {}
class RefundRequestDto extends createZodDto(zRefundRequest) {}
class RefundListQueryDto extends createZodDto(zRefundListQuery) {}
class RefundDecisionDto extends createZodDto(zRefundDecision) {}
class RefundPayDto extends createZodDto(zRefundPay) {}

@ApiTags('finance')
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get()
  @RequirePermissions('payments.read')
  list(@Ctx() ctx: TenantContext, @Query() q: ReceiptListQueryDto) {
    return this.receipts.list(ctx, q);
  }

  @Post()
  @Idempotent()
  @RequirePermissions('payments.receive')
  create(@Ctx() ctx: TenantContext, @Body() body: ReceiptCreateDto) {
    return this.receipts.receive(ctx, { ...body, allocations: body.allocations });
  }

  @Get(':id')
  @RequirePermissions('payments.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.get(ctx, id);
  }

  @Post(':id/void')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('payments.void')
  void(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.receipts.void(ctx, id, body.reason);
  }
}

@ApiTags('finance')
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @RequirePermissions('payments.read')
  list(@Ctx() ctx: TenantContext, @Query() q: RefundListQueryDto) {
    return this.refunds.list(ctx, q);
  }

  @Post()
  @Idempotent()
  @RequirePermissions('refunds.create')
  request(@Ctx() ctx: TenantContext, @Body() body: RefundRequestDto) {
    return this.refunds.request(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('payments.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.refunds.get(ctx, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('refunds.approve')
  approve(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RefundDecisionDto) {
    return this.refunds.approve(ctx, id, body.note);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('refunds.approve')
  reject(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.refunds.reject(ctx, id, body.reason);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('payments.read')
  cancel(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.refunds.cancel(ctx, id, body.reason);
  }

  @Post(':id/pay')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('payments.receive')
  pay(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RefundPayDto) {
    return this.refunds.pay(ctx, id, body);
  }
}
