import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { INTEGRATION_PROVIDER_KEYS, IntegrationProvider, zIntegrationUpdate } from '@autohub/shared';
import { Ctx, RequirePermissions, TenantContext } from '../../common/context';
import { notFound } from '../../common/errors';
import { IntegrationsService } from './integrations.service';
import { VinDecoderService } from './vin-decoder.service';

class IntegrationUpdateDto extends createZodDto(zIntegrationUpdate) {}

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly vin: VinDecoderService,
  ) {}

  @Get()
  @RequirePermissions('integrations.manage')
  list(@Ctx() ctx: TenantContext) {
    return this.integrations.list(ctx);
  }

  @Put(':provider')
  @RequirePermissions('integrations.manage')
  update(@Ctx() ctx: TenantContext, @Param('provider') provider: string, @Body() body: IntegrationUpdateDto) {
    if (!(INTEGRATION_PROVIDER_KEYS as readonly string[]).includes(provider)) throw notFound('Integration');
    return this.integrations.update(ctx, provider as IntegrationProvider, body);
  }

  /** Suggests vehicle fields from a VIN (the form still decides what to save). */
  @Get('vin-decode/:vin')
  @RequirePermissions('vehicles.create')
  decode(@Ctx() ctx: TenantContext, @Param('vin') vin: string) {
    return this.vin.decode(ctx, vin);
  }
}
