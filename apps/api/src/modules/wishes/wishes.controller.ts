import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { zWishClose, zWishCreate, zWishListQuery, zWishUpdate } from '@autohub/shared';
import { Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { WishesService } from './wishes.service';

class WishCreateDto extends createZodDto(zWishCreate) {}
class WishUpdateDto extends createZodDto(zWishUpdate) {}
class WishListQueryDto extends createZodDto(zWishListQuery) {}
class WishCloseDto extends createZodDto(zWishClose) {}

@ApiTags('crm')
@Controller('wishes')
export class WishesController {
  constructor(private readonly wishes: WishesService) {}

  @Get()
  @RequirePermissions('customers.read')
  list(@Ctx() ctx: TenantContext, @Query() q: WishListQueryDto) {
    return this.wishes.list(ctx, q);
  }

  @Post()
  @RequirePermissions('customers.manage')
  create(@Ctx() ctx: TenantContext, @Body() body: WishCreateDto) {
    return this.wishes.create(ctx, body);
  }

  @Get('for-vehicle/:vehicleId')
  @RequirePermissions('customers.read')
  forVehicle(@Ctx() ctx: TenantContext, @Param('vehicleId', ParseUUIDPipe) vehicleId: string) {
    return this.wishes.forVehicle(ctx, vehicleId);
  }

  @Get(':id')
  @RequirePermissions('customers.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.wishes.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('customers.manage')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: WishUpdateDto) {
    return this.wishes.update(ctx, id, body);
  }

  @Post(':id/fulfil')
  @HttpCode(200)
  @RequirePermissions('customers.manage')
  fulfil(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: WishCloseDto) {
    return this.wishes.close(ctx, id, 'fulfilled', body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('customers.manage')
  cancel(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: WishCloseDto) {
    return this.wishes.close(ctx, id, 'cancelled', body);
  }

  @Get(':id/explain/:vehicleId')
  @RequirePermissions('customers.read')
  explain(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('vehicleId', ParseUUIDPipe) vehicleId: string) {
    return this.wishes.explain(ctx, id, vehicleId);
  }

  @Post(':id/matches/:vehicleId/dismiss')
  @HttpCode(200)
  @RequirePermissions('customers.manage')
  dismiss(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('vehicleId', ParseUUIDPipe) vehicleId: string) {
    return this.wishes.dismissMatch(ctx, id, vehicleId);
  }
}
