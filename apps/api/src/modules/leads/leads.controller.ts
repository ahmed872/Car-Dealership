import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  zLeadAssign,
  zLeadBoardQuery,
  zLeadCreate,
  zLeadFollowUpQuery,
  zLeadListQuery,
  zLeadLost,
  zLeadReopen,
  zLeadStageChange,
  zLeadUpdate,
  zPipelineStageCreate,
  zPipelineStageDeactivate,
  zPipelineStageListQuery,
  zPipelineStageUpdate,
} from '@autohub/shared';
import { Authenticated, Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { LeadsService } from './leads.service';
import { PipelineService } from './pipeline.service';

class LeadCreateDto extends createZodDto(zLeadCreate) {}
class LeadUpdateDto extends createZodDto(zLeadUpdate) {}
class LeadListQueryDto extends createZodDto(zLeadListQuery) {}
class LeadStageChangeDto extends createZodDto(zLeadStageChange) {}
class LeadLostDto extends createZodDto(zLeadLost) {}
class LeadReopenDto extends createZodDto(zLeadReopen) {}
class LeadAssignDto extends createZodDto(zLeadAssign) {}
class LeadBoardQueryDto extends createZodDto(zLeadBoardQuery) {}
class LeadFollowUpQueryDto extends createZodDto(zLeadFollowUpQuery) {}
class StageCreateDto extends createZodDto(zPipelineStageCreate) {}
class StageUpdateDto extends createZodDto(zPipelineStageUpdate) {}
class StageDeactivateDto extends createZodDto(zPipelineStageDeactivate) {}
class StageListQueryDto extends createZodDto(zPipelineStageListQuery) {}

@ApiTags('crm')
@Controller('pipeline-stages')
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get()
  @Authenticated()
  list(@Query() q: StageListQueryDto) {
    return this.pipeline.list(q.includeInactive === 'true');
  }

  @Post()
  @RequirePermissions('settings.manage')
  create(@Ctx() ctx: TenantContext, @Body() body: StageCreateDto) {
    return this.pipeline.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermissions('settings.manage')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: StageUpdateDto) {
    return this.pipeline.update(ctx, id, body);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  deactivate(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: StageDeactivateDto) {
    return this.pipeline.deactivate(ctx, id, body);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermissions('settings.manage')
  activate(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.activate(ctx, id);
  }
}

@ApiTags('crm')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermissions('leads.read')
  list(@Ctx() ctx: TenantContext, @Query() q: LeadListQueryDto) {
    return this.leads.list(ctx, q);
  }

  @Get('board')
  @RequirePermissions('leads.read')
  board(@Ctx() ctx: TenantContext, @Query() q: LeadBoardQueryDto) {
    return this.leads.board(ctx, q);
  }

  @Get('follow-ups')
  @RequirePermissions('leads.read')
  followUps(@Ctx() ctx: TenantContext, @Query() q: LeadFollowUpQueryDto) {
    return this.leads.followUps(ctx, q);
  }

  @Post()
  @RequirePermissions('leads.manage')
  create(@Ctx() ctx: TenantContext, @Body() body: LeadCreateDto) {
    return this.leads.create(ctx, body);
  }

  @Get(':id')
  @RequirePermissions('leads.read')
  get(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.leads.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('leads.manage')
  update(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LeadUpdateDto) {
    return this.leads.update(ctx, id, body);
  }

  @Post(':id/stage')
  @HttpCode(200)
  @RequirePermissions('leads.manage')
  stage(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LeadStageChangeDto) {
    return this.leads.changeStage(ctx, id, body);
  }

  @Post(':id/lost')
  @HttpCode(200)
  @RequirePermissions('leads.manage')
  lost(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LeadLostDto) {
    return this.leads.markLost(ctx, id, body);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermissions('leads.manage')
  reopen(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LeadReopenDto) {
    return this.leads.reopen(ctx, id, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('leads.assign')
  assign(@Ctx() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LeadAssignDto) {
    return this.leads.assign(ctx, id, body);
  }
}
