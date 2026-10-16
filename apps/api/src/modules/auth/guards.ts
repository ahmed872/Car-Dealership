import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@autohub/shared';
import { getEnv } from '../../config/env';
import {
  ALLOW_NO_TENANT,
  AppRequest,
  AUTHENTICATED_ONLY,
  IS_PUBLIC,
  PERMISSIONS_KEY,
  PLATFORM_ADMIN,
} from '../../common/context';
import { AppError, forbidden, unauthorized } from '../../common/errors';
import { SessionService } from './session.service';
import { cookieNames } from './cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function meta<T>(reflector: Reflector, key: string, ctx: ExecutionContext): T | undefined {
  return reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
}

/** Resolves the session cookie into req.auth. Public routes skip authentication. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (meta<boolean>(this.reflector, IS_PUBLIC, context)) return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.[cookieNames().session];
    if (!token) throw unauthorized();
    const found = await this.sessions.validate(token);
    if (!found) throw new AppError('session_expired', 401, 'Your session has expired. Please sign in again.');
    const { session, user } = found;

    const tenantCtx = session.tenantId
      ? await this.sessions.loadTenantContext(user.id, session.tenantId)
      : null;
    req.auth = {
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      isPlatformAdmin: user.isPlatformAdmin,
      tenant: tenantCtx?.tenant ?? null,
      membershipId: tenantCtx?.membershipId ?? null,
      roleId: tenantCtx?.roleId ?? null,
      roleName: tenantCtx?.roleName ?? null,
      permissions: tenantCtx?.permissions ?? new Set<Permission>(),
      allBranches: tenantCtx?.allBranches ?? false,
      branchIds: tenantCtx?.branchIds ?? [],
      maxDiscountPct: tenantCtx?.maxDiscountPct ?? '0',
    };
    (req as AppRequest & { sessionCsrfHash?: string }).sessionCsrfHash = session.csrfHash;

    if (meta<boolean>(this.reflector, PLATFORM_ADMIN, context)) {
      if (!user.isPlatformAdmin) throw forbidden('Platform administrators only');
      return true;
    }
    if (!meta<boolean>(this.reflector, ALLOW_NO_TENANT, context) && !req.auth.tenant) {
      throw new AppError('no_active_tenant', 403, 'Select a company to continue');
    }
    return true;
  }
}

/**
 * CSRF defence for cookie-authenticated requests:
 *  1. Origin (or Referer) must be an allowed origin when present — applies to public mutations too.
 *  2. Authenticated mutations must carry X-CSRF-Token matching the token bound to the session.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest & { sessionCsrfHash?: string }>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
    if (origin && !getEnv().origins.includes(origin)) throw forbidden('Cross-site request rejected');

    if (meta<boolean>(this.reflector, IS_PUBLIC, context)) return true;
    const header = req.headers['x-csrf-token'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!req.sessionCsrfHash || !this.sessions.csrfMatches(req.sessionCsrfHash, value)) {
      throw new AppError('csrf_failed', 403, 'Security token missing or invalid. Please reload the page.');
    }
    return true;
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Server-side permission enforcement. Routes must declare their access policy explicitly. */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (meta<boolean>(this.reflector, IS_PUBLIC, context)) return true;
    if (meta<boolean>(this.reflector, PLATFORM_ADMIN, context)) return true; // enforced in SessionGuard
    const req = context.switchToHttp().getRequest<AppRequest>();
    const required = meta<Permission[]>(this.reflector, PERMISSIONS_KEY, context);
    if (required?.length) {
      const missing = required.filter((p) => !req.auth?.permissions.has(p));
      if (missing.length) throw forbidden('You do not have permission to perform this action', { missing });
      return true;
    }
    if (
      meta<boolean>(this.reflector, AUTHENTICATED_ONLY, context) ||
      meta<boolean>(this.reflector, ALLOW_NO_TENANT, context)
    ) {
      return true;
    }
    // Secure by default: an undecorated route is a programming error, never an open door.
    this.logger.error(`Route ${req.method} ${req.path} has no access policy`);
    throw forbidden('Access policy not configured');
  }
}
