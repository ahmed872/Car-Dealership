import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { todayInZone, zCashClosing, zCashReopen, zIsoDate } from '@autohub/shared';
import { Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { CashClosingService } from './cash-closing.service';

class CashClosingDto extends createZodDto(zCashClosing) {}
class CashReopenDto extends createZodDto(zCashReopen) {}
class ExpectedQueryDto extends createZodDto(z.object({ date: zIsoDate.optional() })) {}

@ApiTags('finance')
@Controller()
export class CashClosingController {
  constructor(private readonly closings: CashClosingService) {}

  @Get('cash-accounts/:id/closings')
  @RequirePermissions('cash.read')
  list(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.closings.list(ctx, id);
  }

  @Get('cash-accounts/:id/closings/expected')
  @RequirePermissions('cash.read')
  expected(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ExpectedQueryDto) {
    return this.closings.expected(ctx, id, q.date ?? todayInZone(ctx.tenant.settings.timezone));
  }

  @Post('cash-accounts/:id/closings')
  @Idempotent()
  @RequirePermissions('cash.close')
  close(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CashClosingDto) {
    return this.closings.close(ctx, id, body);
  }

  @Post('cash-closings/:id/reopen')
  @HttpCode(200)
  @RequirePermissions('cash.reopen')
  reopen(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CashReopenDto) {
    return this.closings.reopen(ctx, id, body.reason);
  }
}
