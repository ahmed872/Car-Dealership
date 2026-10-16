import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  zReasonRequired,
  zWorkOrderApprove,
  zWorkOrderCreate,
  zWorkOrderItem,
  zWorkOrderItemUpdate,
  zWorkOrderListFilter,
  zWorkOrderPatch,
} from '@autohub/shared';
import { Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { WorkOrdersService } from './work-orders.service';

class WorkOrderCreateDto extends createZodDto(zWorkOrderCreate) {}
class WorkOrderPatchDto extends createZodDto(zWorkOrderPatch) {}
class WorkOrderItemDto extends createZodDto(zWorkOrderItem) {}
class WorkOrderItemUpdateDto extends createZodDto(zWorkOrderItemUpdate) {}
class WorkOrderApproveDto extends createZodDto(zWorkOrderApprove) {}
class WorkOrderListQueryDto extends createZodDto(zWorkOrderListFilter) {}
class ReasonDto extends createZodDto(zReasonRequired) {}

@ApiTags('work-orders')
@Controller()
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  @Get('work-orders')
  @RequirePermissions('work_orders.read')
  list(@Ctx() ctx: TenantContext, @Query() q: WorkOrderListQueryDto) {
    return this.workOrders.list(ctx, q);
  }

  @Post('work-orders')
  @RequirePermissions('work_orders.manage')
  create(@Ctx() ctx: TenantContext, @Body() body: WorkOrderCreateDto) {
    return this.workOrders.create(ctx, body);
  }

  @Get('vehicles/:id/work-orders')
  @RequirePermissions('work_orders.read')
  forVehicle(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.workOrders.forVehicle(ctx, id);
  }

  @Get('work-orders/:id')
  @RequirePermissions('work_orders.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.workOrders.get(ctx, id);
  }

  @Patch('work-orders/:id')
  @RequirePermissions('work_orders.manage')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: WorkOrderPatchDto) {
    return this.workOrders.update(ctx, id, body);
  }

  @Post('work-orders/:id/items')
  @RequirePermissions('work_orders.manage')
  addItem(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: WorkOrderItemDto) {
    return this.workOrders.addItem(ctx, id, body);
  }

  @Patch('work-orders/:id/items/:itemId')
  @RequirePermissions('work_orders.manage')
  updateItem(
    @Ctx() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: WorkOrderItemUpdateDto,
  ) {
    return this.workOrders.updateItem(ctx, id, itemId, body);
  }

  @Delete('work-orders/:id/items/:itemId')
  @RequirePermissions('work_orders.manage')
  removeItem(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.workOrders.removeItem(ctx, id, itemId);
  }

  @Post('work-orders/:id/start')
  @HttpCode(200)
  @RequirePermissions('work_orders.manage')
  start(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.workOrders.start(ctx, id);
  }

  @Post('work-orders/:id/complete')
  @HttpCode(200)
  @RequirePermissions('work_orders.manage')
  complete(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.workOrders.complete(ctx, id);
  }

  /** Posts the items as vehicle costs (and optionally pays supplier-less items). Money-creating. */
  @Post('work-orders/:id/approve')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('work_orders.approve')
  approve(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: WorkOrderApproveDto) {
    return this.workOrders.approve(ctx, id, body);
  }

  @Post('work-orders/:id/reject')
  @HttpCode(200)
  @RequirePermissions('work_orders.approve')
  reject(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.workOrders.reject(ctx, id, body.reason);
  }

  @Post('work-orders/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('work_orders.manage')
  cancel(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.workOrders.cancel(ctx, id, body.reason);
  }
}
