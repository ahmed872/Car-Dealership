import { HttpStatus } from '@nestjs/common';

/** Domain error with a stable machine-readable code. Messages are safe to show to users. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (entity: string, details?: Record<string, unknown>) =>
  new AppError('not_found', HttpStatus.NOT_FOUND, `${entity} not found`, details);

export const forbidden = (message = 'You do not have permission to perform this action', details?: Record<string, unknown>) =>
  new AppError('forbidden', HttpStatus.FORBIDDEN, message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError('unauthorized', HttpStatus.UNAUTHORIZED, message);

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, HttpStatus.CONFLICT, message, details);

export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, HttpStatus.UNPROCESSABLE_ENTITY, message, details);

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, HttpStatus.BAD_REQUEST, message, details);

/** Maps known unique constraint names to user-facing conflicts. Extended by modules. */
export const UNIQUE_CONSTRAINT_MESSAGES: Record<string, { code: string; message: string }> = {
  users_email_uq: { code: 'email_taken', message: 'A user with this email already exists' },
  tenants_slug_uq: { code: 'slug_taken', message: 'This company identifier is already in use' },
  branches_tenant_code_uq: { code: 'branch_code_taken', message: 'Branch code already exists' },
  roles_tenant_name_uq: { code: 'role_name_taken', message: 'A role with this name already exists' },
  memberships_tenant_user_uq: { code: 'already_member', message: 'User is already a member of this company' },
  journal_entries_source_event_uq: { code: 'already_posted', message: 'This transaction has already been posted' },
};

export function registerUniqueConstraint(name: string, code: string, message: string): void {
  UNIQUE_CONSTRAINT_MESSAGES[name] = { code, message };
}
