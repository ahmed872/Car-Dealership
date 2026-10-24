import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { randomUUID } from 'node:crypto';
import { getEnv } from './config/env';
import { IdempotencyInterceptor, TenantTransactionInterceptor } from './common/interceptors';
import { CoreModule } from './core.module';
import { AuditController } from './modules/audit/audit.controller';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { CsrfGuard, PermissionGuard, SessionGuard } from './modules/auth/guards';
import { HealthController } from './modules/health/health.controller';
import { PlatformController } from './modules/tenancy/platform.controller';
import { ProvisioningService } from './modules/tenancy/provisioning.service';
import { TenancyController } from './modules/tenancy/tenancy.controller';
import { InvitationsController } from './modules/users/invitations.controller';
import { InvitationsService } from './modules/users/invitations.service';
import { UsersController } from './modules/users/users.controller';
import { UsersService } from './modules/users/users.service';
import { DOMAIN_MODULES } from './domain-modules';

const env = getEnv();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: (req) => String((req as { id?: string }).id ?? randomUUID()),
        // Never log secrets or personal identifiers.
        redact: {
          paths: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.headers["x-csrf-token"]',
            'res.headers["set-cookie"]',
            '*.password',
            '*.newPassword',
            '*.currentPassword',
            '*.nationalId',
          ],
          censor: '[REDACTED]',
        },
        autoLogging: env.NODE_ENV !== 'test',
        quietReqLogger: true,
        transport: undefined,
      },
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: env.RATE_LIMIT_PER_MIN }]),
    CoreModule,
    ...DOMAIN_MODULES,
  ],
  controllers: [
    HealthController,
    AuthController,
    TenancyController,
    UsersController,
    InvitationsController,
    AuditController,
    PlatformController,
  ],
  providers: [
    AuthService,
    ProvisioningService,
    UsersService,
    InvitationsService,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Guard order matters: rate limit → session → CSRF → permissions.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Interceptor order: transaction first, idempotency inside it.
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
