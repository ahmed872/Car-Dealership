import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AuthContext } from '../../common/context';
import { notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { memberships } from '../../db/schema';
import { AuditService } from '../audit/audit.service';

export interface Invitation {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  roleName: string;
  invitedAt: string;
}

/**
 * Invitations of an EXISTING account to a company (see UsersService.create). Only the invited person
 * can accept or decline one, after signing in; until then the membership grants nothing.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  /** The signed-in user's pending invitations (runs in the request transaction). */
  async list(): Promise<Invitation[]> {
    const rows = await this.dbs.query<{
      membership_id: string;
      tenant_id: string;
      tenant_name: string;
      role_name: string;
      invited_at: Date;
    }>('SELECT * FROM app_my_invitations()');
    return rows.map((r) => ({
      membershipId: r.membership_id,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      roleName: r.role_name,
      invitedAt: new Date(r.invited_at).toISOString(),
    }));
  }

  /**
   * Accepts (membership becomes active) or declines (the invitation is removed) one of the user's
   * own invitations. Runs in the inviting company's context, which comes from the user's own
   * membership row (never from the client), so the change and its audit entry land in that company.
   */
  async respond(auth: AuthContext, membershipId: string, accept: boolean): Promise<{ ok: true; tenantId: string | null }> {
    const own = await this.dbs.runInTenant(
      { tenantId: null, userId: auth.userId },
      async () => {
        const [m] = await this.dbs.db
          .select({ tenantId: memberships.tenantId, status: memberships.status })
          .from(memberships)
          .where(and(eq(memberships.id, membershipId), eq(memberships.userId, auth.userId)));
        return m ?? null;
      },
      { write: false },
    );
    if (!own || own.status !== 'invited') throw notFound('Invitation');

    return this.dbs.runInTenant({ tenantId: own.tenantId, userId: auth.userId }, async () => {
      const db = this.dbs.db;
      const [m] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.id, membershipId), eq(memberships.userId, auth.userId)))
        .for('update');
      if (!m || m.status !== 'invited') throw notFound('Invitation');
      if (accept) {
        await db.update(memberships).set({ status: 'active', updatedAt: new Date() }).where(eq(memberships.id, m.id));
        await this.audit.record({
          action: 'user.invitation_accepted',
          entityType: 'membership',
          entityId: m.id,
          summary: `${auth.email} accepted the invitation`,
          before: { status: 'invited' },
          after: { status: 'active', roleId: m.roleId, allBranches: m.allBranches },
        });
        return { ok: true as const, tenantId: m.tenantId };
      }
      // Branch links go with the membership (ON DELETE CASCADE); the company may invite again later.
      await db.delete(memberships).where(eq(memberships.id, m.id));
      await this.audit.record({
        action: 'user.invitation_declined',
        entityType: 'membership',
        entityId: m.id,
        summary: `${auth.email} declined the invitation`,
        before: { status: 'invited', roleId: m.roleId, allBranches: m.allBranches },
      });
      return { ok: true as const, tenantId: null };
    });
  }
}
