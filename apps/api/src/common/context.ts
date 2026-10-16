import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { CurrencyCode, MarketCode, Permission, TenantSettings } from '@autohub/shared';
import { forbidden, unauthorized } from './errors';

export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  market: MarketCode;
  baseCurrency: CurrencyCode;
  settings: TenantSettings;
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  tenant: TenantInfo | null;
  membershipId: string | null;
  roleId: string | null;
  roleName: string | null;
  permissions: ReadonlySet<Permission>;
  allBranches: boolean;
  branchIds: string[];
  maxDiscountPct: string;
}

/** Context for a request that has an active tenant (the common case). */
export interface TenantContext extends AuthContext {
  tenant: TenantInfo;
  membershipId: string;
}

export interface AppRequest extends Request {
  auth?: AuthContext;
}

export const IS_PUBLIC = 'ah:public';
export const PERMISSIONS_KEY = 'ah:permissions';
export const AUTHENTICATED_ONLY = 'ah:authenticated';
export const PLATFORM_ADMIN = 'ah:platform_admin';
export const NO_TRANSACTION = 'ah:no_tx';
export const ALLOW_NO_TENANT = 'ah:allow_no_tenant';
export const IDEMPOTENT = 'ah:idempotent';

/** No session required (login, public showroom, health). CSRF Origin checks still apply to mutations. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Requires ALL listed permissions in the active tenant. */
export const RequirePermissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS_KEY, perms);
/** Any signed-in member of the active tenant (no specific permission). */
export const Authenticated = () => SetMetadata(AUTHENTICATED_ONLY, true);
/** Platform (super) administrators only. Implies no tenant requirement. */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN, true);
/** Endpoint works without an active tenant (e.g. /auth/me before choosing a company). */
export const AllowNoTenant = () => SetMetadata(ALLOW_NO_TENANT, true);
/** Handler manages its own transactions (long-running work such as PDF rendering or uploads). */
export const NoTransaction = () => SetMetadata(NO_TRANSACTION, true);
/** Requires an Idempotency-Key header; duplicate requests replay the first response. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  const auth = req.auth;
  if (!auth) throw unauthorized();
  if (!auth.tenant || !auth.membershipId) throw forbidden('No active company selected');
  return auth as TenantContext;
});

export const AuthCtx = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.auth) throw unauthorized();
  return req.auth;
});

export function hasPermission(ctx: AuthContext, perm: Permission): boolean {
  return ctx.permissions.has(perm);
}

export function assertPermission(ctx: AuthContext, perm: Permission): void {
  if (!ctx.permissions.has(perm)) throw forbidden('You do not have permission to perform this action', { permission: perm });
}

/** Branch scope: null means "all branches". */
export function branchScope(ctx: AuthContext): string[] | null {
  return ctx.allBranches ? null : ctx.branchIds;
}

export function assertBranchAccess(ctx: AuthContext, branchId: string | null | undefined): void {
  if (ctx.allBranches || !branchId) return;
  if (!ctx.branchIds.includes(branchId)) throw forbidden('This record belongs to a branch you cannot access');
}
