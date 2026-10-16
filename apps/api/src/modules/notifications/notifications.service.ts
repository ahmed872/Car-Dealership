import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { TenantContext } from '../../common/context';
import { notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { notifications } from '../../db/schema';
import { SYSTEM_USER_ID } from '../jobs/system-context';

export interface NotificationInput {
  userIds: Array<string | null | undefined>;
  type: string;
  titleAr: string;
  titleEn: string;
  bodyAr?: string | null;
  bodyEn?: string | null;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Stable key for the event; with the recipient it makes the notification exactly-once. */
  dedupeKey: string;
  severity?: 'info' | 'success' | 'warning' | 'danger';
}

/** In-app notification inbox. Re-running a job or retrying a request never duplicates a row. */
@Injectable()
export class NotificationsService {
  constructor(private readonly dbs: DbService) {}

  async notify(ctx: TenantContext, n: NotificationInput): Promise<number> {
    const recipients = [...new Set(n.userIds.filter((u): u is string => !!u && u !== SYSTEM_USER_ID))];
    if (!recipients.length) return 0;
    const rows = await this.dbs.db
      .insert(notifications)
      .values(
        recipients.map((userId) => ({
          tenantId: ctx.tenant.id,
          userId,
          type: n.type,
          titleAr: n.titleAr.slice(0, 300),
          titleEn: n.titleEn.slice(0, 300),
          bodyAr: n.bodyAr?.slice(0, 1000) ?? null,
          bodyEn: n.bodyEn?.slice(0, 1000) ?? null,
          link: n.link ?? null,
          entityType: n.entityType ?? null,
          entityId: n.entityId ?? null,
          dedupeKey: `${n.dedupeKey}:${userId}`,
          severity: n.severity ?? 'info',
        })),
      )
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    return rows.length;
  }

  async list(ctx: TenantContext, f: { unreadOnly?: boolean; page: number; pageSize: number }) {
    const where = and(eq(notifications.userId, ctx.userId), f.unreadOnly ? isNull(notifications.readAt) : undefined);
    const items = await this.dbs.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);
    const [c] = await this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(where);
    return { items, total: c?.n ?? 0, page: f.page, pageSize: f.pageSize };
  }

  async unreadCount(ctx: TenantContext): Promise<{ unread: number }> {
    const [c] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, ctx.userId), isNull(notifications.readAt)));
    return { unread: c?.n ?? 0 };
  }

  async markRead(ctx: TenantContext, id: string) {
    const [n] = await this.dbs.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, ctx.userId)))
      .returning();
    if (!n) throw notFound('Notification');
    return n;
  }

  async markAllRead(ctx: TenantContext) {
    const rows = await this.dbs.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.userId, ctx.userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { updated: rows.length };
  }
}
