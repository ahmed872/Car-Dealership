import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  zCustomerAssign,
  zCustomerCreate,
  zCustomerDeactivate,
  zCustomerDuplicateCheck,
  zCustomerPatch,
  zCustomerReactivate,
  zCustomerSearchQuery,
  zInteractionCreate,
  zInteractionListQuery,
} from '@autohub/shared';
import { Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { CustomersService } from './customers.service';

class CustomerCreateDto extends createZodDto(zCustomerCreate) {}
class CustomerPatchDto extends createZodDto(zCustomerPatch) {}
class CustomerSearchQueryDto extends createZodDto(zCustomerSearchQuery) {}
class DuplicateCheckDto extends createZodDto(zCustomerDuplicateCheck) {}
class AssignDto extends createZodDto(zCustomerAssign) {}
class DeactivateDto extends createZodDto(zCustomerDeactivate) {}
class ReactivateDto extends createZodDto(zCustomerReactivate) {}
class InteractionCreateDto extends createZodDto(zInteractionCreate) {}
class InteractionListQueryDto extends createZodDto(zInteractionListQuery) {}

@ApiTags('crm')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('customers.read')
  list(@Ctx() ctx: TenantContext, @Query() q: CustomerSearchQueryDto) {
    return this.customers.list(ctx, q);
  }

  @Post('check-duplicates')
  @HttpCode(200)
  @RequirePermissions('customers.read')
  checkDuplicates(@Ctx() ctx: TenantContext, @Body() body: DuplicateCheckDto) {
    return this.customers.checkDuplicates(ctx, body);
  }

  @Post()
  @RequirePermissions('customers.manage')
  create(@Ctx() ctx: TenantContext, @Body() body: CustomerCreateDto) {
    return this.customers.create(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('customers.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(ctx, id);
  }

  @Get(':id/sensitive')
  @RequirePermissions('customers.view_sensitive')
  sensitive(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.sensitive(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('customers.manage')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CustomerPatchDto) {
    return this.customers.update(ctx, id, body);
  }

  /** Assign / reassign / unassign; the service requires leads.assign or customers.read_all. */
  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('customers.read')
  assign(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AssignDto) {
    return this.customers.assign(ctx, id, body);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('customers.manage')
  deactivate(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: DeactivateDto) {
    return this.customers.deactivate(ctx, id, body);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('customers.manage')
  reactivate(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReactivateDto) {
    return this.customers.reactivate(ctx, id, body);
  }

  @Get(':id/interactions')
  @RequirePermissions('customers.read')
  interactions(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: InteractionListQueryDto) {
    return this.customers.interactions(ctx, id, q);
  }
}

@ApiTags('crm')
@Controller('interactions')
export class InteractionsController {
  constructor(private readonly customers: CustomersService) {}

  /** Requires customers.manage or leads.manage (checked in the service). */
  @Post()
  @RequirePermissions('customers.read')
  log(@Ctx() ctx: TenantContext, @Body() body: InteractionCreateDto) {
    return this.customers.logInteraction(ctx, body);
  }
}
