import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { isPermission, Permission, TenantSettings, CurrencyCode, MarketCode } from '@autohub/shared';
import { getEnv } from '../../config/env';
import { AuthContext } from '../../common/context';
import { randomToken, safeEqualHex, sha256Hex } from '../../common/crypto';
import { DbService } from '../../db/db.service';
import { membershipBranches, memberships, roles, sessions, tenants, users } from '../../db/schema';

export interface SessionRow {
  id: string;
  userId: string;
  tenantId: string | null;
  csrfHash: string;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  status: string;
}

@Injectable()
export class SessionService {
  constructor(private readonly dbs: DbService) {}

  private noTenant<T>(fn: () => Promise<T>): Promise<T> {
    return this.dbs.runInTenant({ tenantId: null, userId: null }, fn);
  }

  async create(userId: string, tenantId: string | null, ip: string | null, userAgent: string | null) {
    const env = getEnv();
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + env.SESSION_ABSOLUTE_HOURS * 3600_000);
    const [row] = await this.noTenant(() => this.dbs.db
      .insert(sessions)
      .values({
        userId,
        tenantId,
        tokenHash: sha256Hex(token),
        csrfHash: sha256Hex(csrfToken),
        ip,
        userAgent: userAgent?.slice(0, 300) ?? null,
        expiresAt,
      })
      .returning({ id: sessions.id }));
    return { token, csrfToken, sessionId: row!.id, expiresAt };
  }

  /** Validates a raw session token: not revoked, within absolute and idle limits, user active. */
  async validate(token: string): Promise<{ session: SessionRow; user: UserRow } | null> {
    if (!token || token.length > 128) return null;
    const env = getEnv();
    return this.noTenant(async () => {
      const db = this.dbs.db;
      const idleCutoff = new Date(Date.now() - env.SESSION_IDLE_MINUTES * 60_000);
      const rows = await db
        .select({
          session: {
            id: sessions.id,
            userId: sessions.userId,
            tenantId: sessions.tenantId,
            csrfHash: sessions.csrfHash,
            lastSeenAt: sessions.lastSeenAt,
            expiresAt: sessions.expiresAt,
          },
          user: {
            id: users.id,
            email: users.email,
            fullName: users.fullName,
            isPlatformAdmin: users.isPlatformAdmin,
            status: users.status,
          },
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, sha256Hex(token)),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
            gt(sessions.lastSeenAt, idleCutoff),
          ),
        )
        .limit(1);
      const r = rows[0];
      if (!r || r.user.status !== 'active') return null;
      // Throttle last_seen updates to one write per minute per session.
      if (Date.now() - r.session.lastSeenAt.getTime() > 60_000) {
        await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, r.session.id));
      }
      return r;
    });
  }

  csrfMatches(csrfHash: string, headerToken: string | undefined): boolean {
    if (!headerToken || headerToken.length > 128) return false;
    return safeEqualHex(sha256Hex(headerToken), csrfHash);
  }

  async setTenant(sessionId: string, tenantId: string | null): Promise<void> {
    await this.noTenant(() => this.dbs.db.update(sessions).set({ tenantId }).where(eq(sessions.id, sessionId)));
  }

  async revoke(sessionId: string): Promise<void> {
    await this.noTenant(() =>
      this.dbs.db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt))),
    );
  }

  /** Revokes every session of a user, optionally keeping one (e.g. after a password change). */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    const conds = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
    if (exceptSessionId) conds.push(ne(sessions.id, exceptSessionId));
    const run = () => this.dbs.db.update(sessions).set({ revokedAt: new Date() }).where(and(...conds));
    if (this.dbs.inTransaction) await run();
    else await this.noTenant(run);
  }

  /**
   * Loads the tenant membership, role permissions and branch scope for a user.
   * Returns null when the user is not an active member of the tenant.
   */
  async loadTenantContext(userId: string, tenantId: string): Promise<Omit<AuthContext, 'sessionId' | 'email' | 'fullName' | 'isPlatformAdmin' | 'userId'> | null> {
    return this.dbs.runInTenant({ tenantId, userId }, async () => {
      const db = this.dbs.db;
      const rows = await db
        .select({
          membershipId: memberships.id,
          allBranches: memberships.allBranches,
          status: memberships.status,
          roleId: roles.id,
          roleName: roles.name,
          roleKey: roles.key,
          permissions: roles.permissions,
          maxDiscountPct: roles.maxDiscountPct,
          tenant: {
            id: tenants.id,
            name: tenants.name,
            slug: tenants.slug,
            market: tenants.market,
            baseCurrency: tenants.baseCurrency,
            settings: tenants.settings,
            status: tenants.status,
          },
        })
        .from(memberships)
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
        .limit(1);
      const m = rows[0];
      if (!m || m.status !== 'active' || m.tenant.status !== 'active') return null;
      const branchRows = m.allBranches
        ? []
        : await db
            .select({ branchId: membershipBranches.branchId })
            .from(membershipBranches)
            .where(eq(membershipBranches.membershipId, m.membershipId));
      const perms = new Set<Permission>(m.permissions.filter(isPermission));
      return {
        tenant: {
          id: m.tenant.id,
          name: m.tenant.name,
          slug: m.tenant.slug,
          market: m.tenant.market as MarketCode,
          baseCurrency: m.tenant.baseCurrency as CurrencyCode,
          settings: m.tenant.settings as TenantSettings,
        },
        membershipId: m.membershipId,
        roleId: m.roleId,
        roleName: m.roleName,
        permissions: perms,
        allBranches: m.allBranches,
        branchIds: branchRows.map((b) => b.branchId),
        maxDiscountPct: m.maxDiscountPct,
      };
    });
  }

  /** Tenants the user can switch to (active memberships of active tenants). */
  async listMemberships(userId: string) {
    const run = () =>
      this.dbs.db
        .select({ tenantId: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active'), eq(tenants.status, 'active')));
    // Inside a request transaction the user context is already set (policy own_membership_read).
    if (this.dbs.inTransaction && this.dbs.context?.userId === userId) return run();
    return this.dbs.runInTenant({ tenantId: null, userId }, run);
  }
}
