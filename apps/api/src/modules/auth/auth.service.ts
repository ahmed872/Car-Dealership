import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { LoginInput } from '@autohub/shared';
import { getEnv } from '../../config/env';
import { AuthContext } from '../../common/context';
import { AppError, unauthorized } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Security');

  constructor(
    private readonly dbs: DbService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verifies credentials with lockout. Each attempt is RESERVED atomically before the password is
   * checked: one UPDATE counts it and, at the limit, locks the account — and refuses to count (so the
   * password is never checked) while the lock lasts. Parallel guesses therefore cannot exceed
   * LOGIN_MAX_FAILURES verifications per lockout window. A success clears the counter.
   *
   * Unknown emails, locked accounts, disabled accounts and wrong passwords all get the same 401
   * `invalid_credentials` after one Argon2 verification, so the endpoint reveals neither which
   * accounts exist nor which are locked.
   */
  async login(input: LoginInput, ip: string | null, userAgent: string | null) {
    const env = getEnv();
    const fail = () => new AppError('invalid_credentials', 401, 'Invalid email or password');
    const reserved = await this.dbs.runInTenant({ tenantId: null, userId: null }, async () => {
      // An expired lock starts a fresh window (the attempt counts as the first of it).
      const rows = await this.dbs.query<{ id: string; email: string; password_hash: string; status: string }>(
        `WITH next AS (
           SELECT id, CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_login_count + 1 END AS n
             FROM users
            WHERE email = $1 AND (locked_until IS NULL OR locked_until <= now())
            FOR UPDATE
         )
         UPDATE users u
            SET failed_login_count = next.n,
                locked_until = CASE WHEN next.n >= $2 THEN now() + make_interval(mins => $3) ELSE NULL END
           FROM next
          WHERE u.id = next.id
          RETURNING u.id, u.email, u.password_hash, u.status`,
        [input.email, env.LOGIN_MAX_FAILURES, env.LOGIN_LOCKOUT_MINUTES],
      );
      return rows[0] ?? null;
    });

    if (!reserved) {
      // Unknown email, or an account inside its lockout window: same work, same answer.
      await this.passwords.verifyDummy(input.password);
      this.logger.warn({ event: 'login_failed', reason: 'unknown_or_locked', ip }, 'login failed');
      throw fail();
    }
    const ok = await this.passwords.verify(reserved.password_hash, input.password);
    if (!ok || reserved.status !== 'active') {
      this.logger.warn(
        { event: 'login_failed', reason: ok ? 'inactive_user' : 'bad_password', userId: reserved.id, ip },
        'login failed',
      );
      throw fail();
    }
    const user = { id: reserved.id, email: reserved.email };

    await this.dbs.runInTenant({ tenantId: null, userId: null }, () =>
      this.dbs.db
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id)),
    );

    const tenants = await this.sessions.listMemberships(user.id);
    let activeTenantId: string | null = null;
    if (input.tenantSlug) {
      const match = tenants.find((t) => t.slug === input.tenantSlug!.toLowerCase());
      if (!match) throw new AppError('invalid_credentials', 401, 'Invalid email or password');
      activeTenantId = match.tenantId;
    } else if (tenants.length === 1) {
      activeTenantId = tenants[0]!.tenantId;
    }

    const session = await this.sessions.create(user.id, activeTenantId, ip, userAgent);
    if (activeTenantId) {
      await this.dbs.runInTenant({ tenantId: activeTenantId, userId: user.id }, () =>
        this.audit.record({
          action: 'auth.login',
          entityType: 'user',
          entityId: user.id,
          summary: `Signed in: ${user.email}`,
        }),
      );
    }
    return { session, userId: user.id, activeTenantId, tenants };
  }

  async switchTenant(auth: AuthContext, tenantId: string) {
    const ctx = await this.sessions.loadTenantContext(auth.userId, tenantId);
    if (!ctx) throw unauthorized('You are not an active member of this company');
    await this.sessions.setTenant(auth.sessionId, tenantId);
    await this.dbs.runInTenant({ tenantId, userId: auth.userId }, () =>
      this.audit.record({ action: 'auth.switch_tenant', entityType: 'user', entityId: auth.userId }),
    );
  }

  async changePassword(auth: AuthContext, currentPassword: string, newPassword: string): Promise<void> {
    const [user] = await this.dbs.runInTenant({ tenantId: null, userId: null }, () =>
      this.dbs.db.select().from(users).where(eq(users.id, auth.userId)).limit(1),
    );
    if (!user || !(await this.passwords.verify(user.passwordHash, currentPassword))) {
      throw new AppError('invalid_credentials', 401, 'Current password is incorrect');
    }
    if (currentPassword === newPassword)
      throw new AppError('password_unchanged', 422, 'Choose a different password');
    const hash = await this.passwords.hash(newPassword);
    await this.dbs.runInTenant({ tenantId: null, userId: null }, () =>
      this.dbs.db
        .update(users)
        .set({ passwordHash: hash, passwordChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, user.id)),
    );
    await this.sessions.revokeAllForUser(user.id, auth.sessionId);
    if (auth.tenant) {
      await this.dbs.runInTenant({ tenantId: auth.tenant.id, userId: auth.userId }, () =>
        this.audit.record({ action: 'auth.password_changed', entityType: 'user', entityId: auth.userId }),
      );
    }
  }
}
