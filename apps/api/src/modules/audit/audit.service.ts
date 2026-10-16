import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, SQL, sql } from 'drizzle-orm';
import { currentRequestInfo } from '../../common/request-info';
import { DbService } from '../../db/db.service';
import { auditLogs, users } from '../../db/schema';

const REDACT_KEYS = /pass(word)?|token|secret|hash|national_?id|nationalId|apiKey/i;

/** Redacts secrets and personal identifiers before they enter the immutable audit log. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 6) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? (v == null ? null : '[REDACTED]') : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

/** Returns only the keys whose values changed (before/after), for compact audit entries. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before || !after) return { before, after };
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updatedAt' || key === 'version') continue;
    const bv = before[key] instanceof Date ? (before[key] as Date).toISOString() : before[key];
    const av = after[key] instanceof Date ? (after[key] as Date).toISOString() : after[key];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[key] = bv;
      a[key] = av;
    }
  }
  return { before: b, after: a };
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly dbs: DbService) {}

  /** Writes an audit entry in the CURRENT transaction (so it commits/rolls back with the change). */
  async record(entry: AuditEntry): Promise<void> {
    const ctx = this.dbs.context;
    if (!ctx?.tenantId) throw new Error('Audit requires a tenant context');
    const info = currentRequestInfo();
    await this.dbs.db.insert(auditLogs).values({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary?.slice(0, 500) ?? null,
      before: (redact(entry.before) as object) ?? null,
      after: (redact(entry.after) as object) ?? null,
      metadata: { ...(entry.metadata ?? {}), requestId: info?.requestId ?? null, ip: info?.ip ?? null },
    });
  }

  async list(filter: { entityType?: string; entityId?: string; actorUserId?: string; from?: string; to?: string; page: number; pageSize: number }) {
    const db = this.dbs.db;
    const conds: SQL[] = [];
    if (filter.entityType) conds.push(eq(auditLogs.entityType, filter.entityType));
    if (filter.entityId) conds.push(eq(auditLogs.entityId, filter.entityId));
    if (filter.actorUserId) conds.push(eq(auditLogs.actorUserId, filter.actorUserId));
    if (filter.from) conds.push(gte(auditLogs.createdAt, new Date(filter.from)));
    if (filter.to) conds.push(lte(auditLogs.createdAt, new Date(filter.to)));
    const where = conds.length ? and(...conds) : undefined;
    const [items, [count]] = await Promise.all([
      db
        .select({
          id: auditLogs.id,
          seq: auditLogs.seq,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          summary: auditLogs.summary,
          before: auditLogs.before,
          after: auditLogs.after,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
          actorUserId: auditLogs.actorUserId,
          actorName: users.fullName,
          hash: auditLogs.hash,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(where)
        .orderBy(desc(auditLogs.seq))
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize),
      db.select({ total: sql<number>`count(*)::int` }).from(auditLogs).where(where),
    ]);
    return { items, total: count?.total ?? 0, page: filter.page, pageSize: filter.pageSize };
  }

  async verify(): Promise<{ ok: boolean; checked: number; firstBadSeq: number | null; reason: string | null }> {
    const rows = await this.dbs.query<{ ok: boolean; checked: string; first_bad_seq: string | null; reason: string | null }>(
      'SELECT * FROM audit_verify_chain()',
    );
    const r = rows[0]!;
    return { ok: r.ok, checked: Number(r.checked), firstBadSeq: r.first_bad_seq === null ? null : Number(r.first_bad_seq), reason: r.reason };
  }
}
