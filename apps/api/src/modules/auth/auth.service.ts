import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
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
   * Verifies credentials with lockout. Unknown emails take the same time as wrong passwords and
   * return the same error, so the endpoint does not reveal which accounts exist.
   */
  async login(input: LoginInput, ip: string | null, userAgent: string | null) {
    const env = getEnv();
    const user = await this.dbs.runInTenant({ tenantId: null, userId: null }, async () => {
      const [u] = await this.dbs.db.select().from(users).where(eq(users.email, input.email)).limit(1);
      return u ?? null;
    });

    if (!user) {
      await this.passwords.verifyDummy(input.password);
      this.logger.warn({ event: 'login_failed', reason: 'unknown_email', ip }, 'login failed');
      throw new AppError('invalid_credentials', 401, 'Invalid email or password');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.passwords.verifyDummy(input.password);
      throw new AppError('account_locked', 429, 'Too many failed sign-in attempts. Please try again later.');
    }
    const ok = user.status === 'active' && (await this.passwords.verify(user.passwordHash, input.password));
    if (!ok) {
      await this.dbs.runInTenant({ tenantId: null, userId: null }, async () => {
        // Atomic increment; lock when the threshold is reached.
        await this.dbs.db
          .update(users)
          .set({
            failedLoginCount: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${env.LOGIN_MAX_FAILURES} THEN 0 ELSE ${users.failedLoginCount} + 1 END`,
            lockedUntil: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${env.LOGIN_MAX_FAILURES}
              THEN now() + make_interval(mins => ${env.LOGIN_LOCKOUT_MINUTES}) ELSE ${users.lockedUntil} END`,
          })
          .where(eq(users.id, user.id));
      });
      this.logger.warn({ event: 'login_failed', reason: 'bad_password', userId: user.id, ip }, 'login failed');
      throw new AppError('invalid_credentials', 401, 'Invalid email or password');
    }

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
        this.audit.record({ action: 'auth.login', entityType: 'user', entityId: user.id, summary: `Signed in: ${user.email}` }),
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
    if (currentPassword === newPassword) throw new AppError('password_unchanged', 422, 'Choose a different password');
    const hash = await this.passwords.hash(newPassword);
    await this.dbs.runInTenant({ tenantId: null, userId: null }, () =>
      this.dbs.db.update(users).set({ passwordHash: hash, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id)),
    );
    await this.sessions.revokeAllForUser(user.id, auth.sessionId);
    if (auth.tenant) {
      await this.dbs.runInTenant({ tenantId: auth.tenant.id, userId: auth.userId }, () =>
        this.audit.record({ action: 'auth.password_changed', entityType: 'user', entityId: auth.userId }),
      );
    }
  }
}
