import { HttpStatus } from '@nestjs/common';
import { todayInZone } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { AppError, unprocessable } from '../../common/errors';

/** Positional parameter collector for raw SQL ($1, $2, …). */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/**
 * General-ledger reports are company-wide documents: entries are not reliably attributable to a
 * single branch (payments from company-level accounts carry no branch), so a branch-scoped user
 * would see balances that do not exist. Users without access to all branches get 403.
 */
export function assertCompanyScope(ctx: TenantContext): void {
  if (!ctx.allBranches) {
    throw new AppError('company_scope_required', HttpStatus.FORBIDDEN, 'General-ledger reports cover the whole company; they require access to all branches');
  }
}

export function today(ctx: TenantContext): string {
  return todayInZone(ctx.tenant.settings.timezone);
}

/** Validates an optional from/to pair (to defaults to today in the tenant's time zone). */
export function period(ctx: TenantContext, from: string | undefined, to: string | undefined): { from: string | null; to: string } {
  const end = to ?? today(ctx);
  if (from && from > end) throw unprocessable('invalid_range', 'The start date must be on or before the end date', { from, to: end });
  return { from: from ?? null, to: end };
}

export const iso = (v: Date | string | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : v);

/** Branch-scope array for `= ANY($n::uuid[])` (a dummy id keeps the array non-empty). */
export const scopeIds = (ctx: TenantContext): string[] => (ctx.branchIds.length ? ctx.branchIds : ['00000000-0000-0000-0000-000000000000']);
