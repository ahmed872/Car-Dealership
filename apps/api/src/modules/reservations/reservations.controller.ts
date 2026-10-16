import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { zDepositInput, zReservationCancel, zReservationCreate, zReservationExtend, zReservationListQuery } from '@autohub/shared';
import { Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { ReservationsService } from './reservations.service';

class ReservationCreateDto extends createZodDto(zReservationCreate) {}
class ReservationExtendDto extends createZodDto(zReservationExtend) {}
class ReservationCancelDto extends createZodDto(zReservationCancel) {}
class ReservationListQueryDto extends createZodDto(zReservationListQuery) {}
class DepositDto extends createZodDto(zDepositInput) {}

@ApiTags('reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  @RequirePermissions('reservations.read')
  list(@Ctx() ctx: TenantContext, @Query() q: ReservationListQueryDto) {
    return this.reservations.list(ctx, q);
  }

  @Post()
  @Idempotent()
  @RequirePermissions('reservations.create')
  create(@Ctx() ctx: TenantContext, @Body() body: ReservationCreateDto) {
    return this.reservations.create(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('reservations.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.get(ctx, id);
  }

  @Post(':id/deposits')
  @Idempotent()
  @RequirePermissions('reservations.read', 'payments.receive')
  deposit(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: DepositDto) {
    return this.reservations.addDeposit(ctx, id, body);
  }

  @Post(':id/extend')
  @HttpCode(200)
  @RequirePermissions('reservations.extend')
  extend(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReservationExtendDto) {
    return this.reservations.extend(ctx, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('reservations.cancel')
  cancel(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReservationCancelDto) {
    return this.reservations.cancel(ctx, id, body);
  }
}
