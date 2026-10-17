import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  zCommissionPolicyCreate,
  zCommissionPolicyDeactivate,
  zCommissionPolicyListQuery,
  zCommissionPolicyVersion,
  zCommissionPreview,
  zCommissionResolveQuery,
  zEmployeeProfileUpdate,
} from '@autohub/shared';
import { assertPermission, Authenticated, Ctx, hasPermission, RequirePermissions, TenantContext } from '../../common/context';
import { CommissionPoliciesService } from './commission-policies.service';
import { EmployeesService } from './employees.service';

class EmployeeProfileDto extends createZodDto(zEmployeeProfileUpdate) {}
class PolicyCreateDto extends createZodDto(zCommissionPolicyCreate) {}
class PolicyVersionDto extends createZodDto(zCommissionPolicyVersion) {}
class PolicyListQueryDto extends createZodDto(zCommissionPolicyListQuery) {}
class PolicyDeactivateDto extends createZodDto(zCommissionPolicyDeactivate) {}
class PolicyResolveQueryDto extends createZodDto(zCommissionResolveQuery) {}
class PolicyPreviewDto extends createZodDto(zCommissionPreview) {}

@ApiTags('hr')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermissions('users.read')
  list(@Ctx() ctx: TenantContext) {
    return this.employees.list(ctx);
  }

  /** Own profile for everyone; others' with users.read (checked in the service). */
  @Get(':userId')
  @Authenticated()
  get(@Ctx() ctx: TenantContext, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.employees.get(ctx, userId);
  }

  @Put(':userId/profile')
  @RequirePermissions('users.manage')
  upsert(@Ctx() ctx: TenantContext, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: EmployeeProfileDto) {
    return this.employees.upsert(ctx, userId, body);
  }
}

@ApiTags('hr')
@Controller('commission-policies')
export class CommissionPoliciesController {
  constructor(private readonly policies: CommissionPoliciesService) {}

  /** Policies are visible to commission readers and policy managers. */
  @Get()
  @Authenticated()
  list(@Ctx() ctx: TenantContext, @Query() q: PolicyListQueryDto) {
    if (!hasPermission(ctx, 'commissions.manage_policies')) assertPermission(ctx, 'commissions.read');
    return this.policies.list(ctx, q.includeHistory === 'true');
  }

  @Post()
  @RequirePermissions('commissions.manage_policies')
  create(@Ctx() ctx: TenantContext, @Body() body: PolicyCreateDto) {
    return this.policies.create(ctx, body);
  }

  /** Own policy with commissions.read_own; anyone's with commissions.read (checked in the service). */
  @Get('resolve')
  @Authenticated()
  resolve(@Ctx() ctx: TenantContext, @Query() q: PolicyResolveQueryDto) {
    if (!hasPermission(ctx, 'commissions.read')) assertPermission(ctx, 'commissions.read_own');
    return this.policies.resolveFor(ctx, q.userId, q.date);
  }

  @Post('preview')
  @HttpCode(200)
  @Authenticated()
  preview(@Ctx() ctx: TenantContext, @Body() body: PolicyPreviewDto) {
    return this.policies.previewInput(ctx, body);
  }

  @Post(':id/versions')
  @RequirePermissions('commissions.manage_policies')
  addVersion(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PolicyVersionDto) {
    return this.policies.addVersion(ctx, id, body);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('commissions.manage_policies')
  deactivate(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PolicyDeactivateDto) {
    return this.policies.deactivate(ctx, id, body.reason);
  }
}
