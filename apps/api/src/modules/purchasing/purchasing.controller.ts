import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  zAcquisitionApprove,
  zAcquisitionCreate,
  zAcquisitionListQuery,
  zAcquisitionUpdate,
  zCostAllocation,
  zDecisionNote,
  zOwnershipTransfer,
  zReasonRequired,
  zVehicleCostCreate,
} from '@autohub/shared';
import { Authenticated, Ctx, Idempotent, RequirePermissions, TenantContext } from '../../common/context';
import { AcquisitionsService } from './acquisitions.service';
import { CostsService } from './costs.service';

class AcquisitionCreateDto extends createZodDto(zAcquisitionCreate) {}
class AcquisitionUpdateDto extends createZodDto(zAcquisitionUpdate) {}
class AcquisitionListQueryDto extends createZodDto(zAcquisitionListQuery) {}
class AcquisitionApproveDto extends createZodDto(zAcquisitionApprove) {}
class OwnershipDto extends createZodDto(zOwnershipTransfer) {}
class ReasonDto extends createZodDto(zReasonRequired) {}
class NoteDto extends createZodDto(zDecisionNote) {}
class CostCreateDto extends createZodDto(zVehicleCostCreate) {}
class CostAllocationDto extends createZodDto(zCostAllocation) {}

@ApiTags('purchasing')
@Controller('acquisitions')
export class AcquisitionsController {
  constructor(private readonly acquisitions: AcquisitionsService) {}

  @Get()
  @RequirePermissions('acquisitions.read')
  list(@Ctx() ctx: TenantContext, @Query() q: AcquisitionListQueryDto) {
    return this.acquisitions.list(ctx, q);
  }

  @Post()
  @Idempotent()
  @RequirePermissions('acquisitions.create')
  create(@Ctx() ctx: TenantContext, @Body() body: AcquisitionCreateDto) {
    return this.acquisitions.create(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('acquisitions.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.acquisitions.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('acquisitions.create')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AcquisitionUpdateDto) {
    return this.acquisitions.update(ctx, id, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermissions('acquisitions.create')
  submit(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.acquisitions.submit(ctx, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('acquisitions.approve')
  approve(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AcquisitionApproveDto) {
    return this.acquisitions.approve(ctx, id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('acquisitions.approve')
  reject(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.acquisitions.reject(ctx, id, body.reason);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('acquisitions.cancel')
  cancel(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.acquisitions.cancel(ctx, id, body.reason);
  }

  @Put(':id/ownership')
  @RequirePermissions('acquisitions.create')
  ownership(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: OwnershipDto) {
    return this.acquisitions.setOwnershipTransfer(ctx, id, body.status);
  }
}

@ApiTags('costs')
@Controller()
export class CostsController {
  constructor(private readonly costs: CostsService) {}

  @Get('cost-categories')
  @Authenticated()
  categories() {
    return this.costs.categories();
  }

  @Get('vehicles/:id/costs')
  @RequirePermissions('costs.read')
  vehicleCosts(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.costs.vehicleSummary(ctx, id);
  }

  @Post('vehicle-costs')
  @Idempotent()
  @RequirePermissions('costs.create')
  create(@Ctx() ctx: TenantContext, @Body() body: CostCreateDto) {
    return this.costs.create(ctx, body, { sourceType: 'manual' });
  }

  @Post('vehicle-costs/allocate')
  @Idempotent()
  @RequirePermissions('costs.create')
  allocate(@Ctx() ctx: TenantContext, @Body() body: CostAllocationDto) {
    return this.costs.allocate(ctx, body);
  }

  @Get('vehicle-costs/pending')
  @RequirePermissions('costs.approve')
  pending(@Ctx() ctx: TenantContext) {
    return this.costs.listPending(ctx);
  }

  @Get('vehicle-costs/:id')
  @RequirePermissions('costs.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.costs.get(ctx, id);
  }

  @Post('vehicle-costs/:id/approve')
  @HttpCode(200)
  @RequirePermissions('costs.approve')
  approve(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: NoteDto) {
    return this.costs.approve(ctx, id, body.note);
  }

  @Post('vehicle-costs/:id/reject')
  @HttpCode(200)
  @RequirePermissions('costs.approve')
  reject(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.costs.reject(ctx, id, body.reason);
  }

  @Post('vehicle-costs/:id/reverse')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('costs.reverse')
  reverse(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto) {
    return this.costs.reverse(ctx, id, body.reason);
  }
}
