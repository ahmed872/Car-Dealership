import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  zAppointmentCancel,
  zAppointmentComplete,
  zAppointmentConfirm,
  zAppointmentCreate,
  zAppointmentListQuery,
  zAppointmentNoShow,
  zAppointmentUpdate,
  zTestDriveFinish,
  zTestDriveStart,
} from '@autohub/shared';
import { Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { AppointmentsService } from './appointments.service';

class AppointmentCreateDto extends createZodDto(zAppointmentCreate) {}
class AppointmentUpdateDto extends createZodDto(zAppointmentUpdate) {}
class AppointmentListQueryDto extends createZodDto(zAppointmentListQuery) {}
class AppointmentCancelDto extends createZodDto(zAppointmentCancel) {}
class AppointmentCompleteDto extends createZodDto(zAppointmentComplete) {}
class AppointmentNoShowDto extends createZodDto(zAppointmentNoShow) {}
class AppointmentConfirmDto extends createZodDto(zAppointmentConfirm) {}
class TestDriveStartDto extends createZodDto(zTestDriveStart) {}
class TestDriveFinishDto extends createZodDto(zTestDriveFinish) {}

@ApiTags('crm')
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @RequirePermissions('appointments.read')
  list(@Ctx() ctx: TenantContext, @Query() q: AppointmentListQueryDto) {
    return this.appointments.list(ctx, q);
  }

  @Post()
  @RequirePermissions('appointments.manage')
  create(@Ctx() ctx: TenantContext, @Body() body: AppointmentCreateDto) {
    return this.appointments.create(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('appointments.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('appointments.manage')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AppointmentUpdateDto) {
    return this.appointments.update(ctx, id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermissions('appointments.manage')
  confirm(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AppointmentConfirmDto) {
    return this.appointments.confirm(ctx, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('appointments.manage')
  cancel(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AppointmentCancelDto) {
    return this.appointments.cancel(ctx, id, body);
  }

  @Post(':id/no-show')
  @HttpCode(200)
  @RequirePermissions('appointments.manage')
  noShow(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AppointmentNoShowDto) {
    return this.appointments.noShow(ctx, id, body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('appointments.manage')
  complete(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AppointmentCompleteDto) {
    return this.appointments.complete(ctx, id, body);
  }

  @Post(':id/start-test-drive')
  @HttpCode(200)
  @RequirePermissions('appointments.manage')
  start(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TestDriveStartDto) {
    return this.appointments.startTestDrive(ctx, id, body);
  }

  @Post(':id/finish-test-drive')
  @HttpCode(200)
  @RequirePermissions('appointments.manage')
  finish(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: TestDriveFinishDto) {
    return this.appointments.finishTestDrive(ctx, id, body);
  }
}
