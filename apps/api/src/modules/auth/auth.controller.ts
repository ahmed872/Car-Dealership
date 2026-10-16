import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { zChangePassword, zLogin, zSwitchTenant } from '@autohub/shared';
import { getEnv } from '../../config/env';
import { AllowNoTenant, AppRequest, AuthContext, AuthCtx, NoTransaction, Public } from '../../common/context';
import { AuthService } from './auth.service';
import { clearAuthCookies, setAuthCookies } from './cookies';
import { SessionService } from './session.service';

class LoginDto extends createZodDto(zLogin) {}
class SwitchTenantDto extends createZodDto(zSwitchTenant) {}
class ChangePasswordDto extends createZodDto(zChangePassword) {}

export function serializeAuth(auth: AuthContext) {
  return {
    user: { id: auth.userId, email: auth.email, fullName: auth.fullName, isPlatformAdmin: auth.isPlatformAdmin },
    tenant: auth.tenant
      ? {
          id: auth.tenant.id,
          name: auth.tenant.name,
          slug: auth.tenant.slug,
          market: auth.tenant.market,
          baseCurrency: auth.tenant.baseCurrency,
          settings: auth.tenant.settings,
        }
      : null,
    role: auth.roleId ? { id: auth.roleId, name: auth.roleName, maxDiscountPct: auth.maxDiscountPct } : null,
    permissions: [...auth.permissions].sort(),
    allBranches: auth.allBranches,
    branchIds: auth.branchIds,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('login')
  @Public()
  @NoTransaction()
  @HttpCode(200)
  @Throttle({ default: { limit: () => getEnv().AUTH_RATE_LIMIT_PER_MIN, ttl: 60_000 } })
  async login(@Body() body: LoginDto, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(body, req.ip ?? null, req.headers['user-agent'] ?? null);
    setAuthCookies(res, result.session.token, result.session.csrfToken, result.session.expiresAt);
    return {
      activeTenantId: result.activeTenantId,
      tenants: result.tenants,
      requiresTenantSelection: !result.activeTenantId && result.tenants.length > 1,
    };
  }

  @Post('logout')
  @AllowNoTenant()
  @NoTransaction()
  @HttpCode(200)
  async logout(@AuthCtx() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(auth.sessionId);
    clearAuthCookies(res);
    return { ok: true };
  }

  @Get('me')
  @AllowNoTenant()
  async me(@AuthCtx() auth: AuthContext) {
    return { ...serializeAuth(auth), tenants: await this.sessions.listMemberships(auth.userId) };
  }

  @Post('switch-tenant')
  @AllowNoTenant()
  @NoTransaction()
  @HttpCode(200)
  async switchTenant(@AuthCtx() auth: AuthContext, @Body() body: SwitchTenantDto) {
    await this.auth.switchTenant(auth, body.tenantId);
    return { ok: true };
  }

  @Post('change-password')
  @AllowNoTenant()
  @NoTransaction()
  @HttpCode(200)
  @Throttle({ default: { limit: () => Math.max(3, Math.floor(getEnv().AUTH_RATE_LIMIT_PER_MIN / 2)), ttl: 60_000 } })
  async changePassword(@AuthCtx() auth: AuthContext, @Body() body: ChangePasswordDto) {
    await this.auth.changePassword(auth, body.currentPassword, body.newPassword);
    return { ok: true };
  }
}
