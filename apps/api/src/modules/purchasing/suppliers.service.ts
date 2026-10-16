import { Injectable } from '@nestjs/common';
import { and, asc, eq, SQL, sql } from 'drizzle-orm';
import { PaginationQuery, SupplierInput } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { suppliers } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';

export interface SupplierListQuery extends PaginationQuery {
  type?: string;
  active?: 'true' | 'false';
}

@Injectable()
export class SuppliersService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(q: SupplierListQuery) {
    const conds: SQL[] = [];
    if (q.type) conds.push(eq(suppliers.type, q.type));
    if (q.active) conds.push(eq(suppliers.isActive, q.active === 'true'));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(sql`(${suppliers.name} ILIKE ${like} OR ${suppliers.phone} ILIKE ${like} OR ${suppliers.taxNumber} ILIKE ${like})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const items = await this.dbs.db
      .select()
      .from(suppliers)
      .where(where)
      .orderBy(asc(suppliers.name))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [c] = await this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(suppliers).where(where);
    return { items, total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string) {
    const [s] = await this.dbs.db.select().from(suppliers).where(eq(suppliers.id, id));
    if (!s) throw notFound('Supplier');
    return s;
  }

  async create(ctx: TenantContext, input: SupplierInput) {
    const [s] = await this.dbs.db
      .insert(suppliers)
      .values({ ...input, tenantId: ctx.tenant.id, createdBy: ctx.userId })
      .returning();
    await this.audit.record({ action: 'supplier.created', entityType: 'supplier', entityId: s!.id, summary: s!.name, after: s });
    return s!;
  }

  async update(ctx: TenantContext, id: string, input: Partial<SupplierInput>) {
    const [before] = await this.dbs.db.select().from(suppliers).where(eq(suppliers.id, id)).for('update');
    if (!before) throw notFound('Supplier');
    const [after] = await this.dbs.db
      .update(suppliers)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(suppliers.id, id))
      .returning();
    await this.audit.record({ action: 'supplier.updated', entityType: 'supplier', entityId: id, ...diff(before, after!) });
    void ctx;
    return after!;
  }
}
