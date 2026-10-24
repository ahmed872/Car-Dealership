import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { PERMISSIONS, zAssignableMembersQuery, zCreateUser, zResetPassword, zRoleInput, zUpdateMembership } from '@autohub/shared';
import { Authenticated, Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { UsersService } from './users.service';

class CreateUserDto extends createZodDto(zCreateUser) {}
class UpdateMembershipDto extends createZodDto(zUpdateMembership) {}
class ResetPasswordDto extends createZodDto(zResetPassword) {}
class RoleDto extends createZodDto(zRoleInput) {}
class AssignableMembersQueryDto extends createZodDto(zAssignableMembersQuery) {}

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @RequirePermissions('users.read')
  list(@Ctx() ctx: TenantContext) {
    return this.users.list(ctx);
  }

  /**
   * Staff who can be given a kind of work (id and name only), for assignee pickers. Any member of
   * the company may ask; the member directory itself (GET /users) stays behind users.read.
   */
  @Get('members/assignable')
  @Authenticated()
  assignable(@Ctx() ctx: TenantContext, @Query() q: AssignableMembersQueryDto) {
    return this.users.assignable(ctx, q.permission, q.branchId ?? null);
  }

  @Post('users')
  @RequirePermissions('users.manage')
  create(@Ctx() ctx: TenantContext, @Body() body: CreateUserDto) {
    return this.users.create(ctx, body);
  }

  @Patch('users/:membershipId')
  @RequirePermissions('users.manage')
  update(
    @Ctx() ctx: TenantContext,
    @Param('membershipId', ParseUUIDPipe) id: string,
    @Body() body: UpdateMembershipDto,
  ) {
    return this.users.update(ctx, id, body);
  }

  @Post('users/:membershipId/reset-password')
  @HttpCode(200)
  @RequirePermissions('users.manage')
  resetPassword(
    @Ctx() ctx: TenantContext,
    @Param('membershipId', ParseUUIDPipe) id: string,
    @Body() body: ResetPasswordDto,
  ) {
    return this.users.resetPassword(ctx, id, body.newPassword);
  }

  @Get('roles')
  @RequirePermissions('users.read')
  roles() {
    return this.users.listRoles();
  }

  @Post('roles')
  @RequirePermissions('roles.manage')
  createRole(@Ctx() ctx: TenantContext, @Body() body: RoleDto) {
    return this.users.createRole(ctx, body);
  }

  @Put('roles/:id')
  @RequirePermissions('roles.manage')
  updateRole(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RoleDto) {
    return this.users.updateRole(ctx, id, body);
  }

  @Delete('roles/:id')
  @RequirePermissions('roles.manage')
  deleteRole(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.deleteRole(id);
  }

  @Get('permissions')
  @Authenticated()
  permissions() {
    return Object.entries(PERMISSIONS).map(([key, v]) => ({ key, ...v }));
  }
}
