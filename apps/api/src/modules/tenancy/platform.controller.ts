import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { zProvisionTenant } from '@autohub/shared';
import { getEnv } from '../../config/env';
import { AuthContext, AuthCtx, NoTransaction, PlatformAdmin, Public } from '../../common/context';
import { AppError, conflict } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { ProvisioningService } from './provisioning.service';

class ProvisionDto extends createZodDto(zProvisionTenant) {}

@ApiTags('platform')
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly dbs: DbService,
  ) {}

  @Get('tenants')
  @PlatformAdmin()
  tenants() {
    return this.dbs.query('SELECT * FROM app_platform_tenants()');
  }

  @Post('tenants')
  @PlatformAdmin()
  @NoTransaction()
  provision(@AuthCtx() auth: AuthContext, @Body() body: ProvisionDto) {
    return this.provisioning.provision(body, auth.userId);
  }

  /** Optional self-service sign-up (disabled unless ALLOW_TENANT_SELF_SIGNUP=true). */
  @Post('signup')
  @Public()
  @NoTransaction()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  async signup(@Body() body: ProvisionDto) {
    if (!getEnv().ALLOW_TENANT_SELF_SIGNUP)
      throw new AppError('signup_disabled', 403, 'Self-service sign-up is disabled');
    const exists = await this.dbs.runInTenant({ tenantId: null, userId: null }, () =>
      this.dbs.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE email = $1', [
        body.owner.email,
      ]),
    );
    if ((exists[0]?.n ?? 0) > 0)
      throw conflict('email_taken', 'An account with this email already exists. Sign in instead.');
    const result = await this.provisioning.provision(body, null);
    return { tenantId: result.tenantId };
  }
}
