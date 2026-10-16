import { Injectable } from '@nestjs/common';
import { and, asc, eq, SQL, sql } from 'drizzle-orm';
import { PaginationQuery, SupplierCreateInput, SupplierDuplicate, SupplierDuplicateQuery, SupplierUpdateInput } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { suppliers } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';

export interface SupplierListQuery extends PaginationQuery {
  type?: string;
  active?: 'true' | 'false';
}

/** Arabic-Indic and Extended Arabic-Indic digits → ASCII, then digits only. */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const ASCII_DIGITS = '01234567890123456789';
export function normalizePhone(v: string | null | undefined): string | null {
  if (!v) return null;
  const digits = [...v].map((ch) => {
    const i = ARABIC_DIGITS.indexOf(ch);
    return i >= 0 ? ASCII_DIGITS[i] : ch;
  });
  const out = digits.join('').replace(/\D/g, '');
  return out.length >= 6 ? out : null;
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

  /**
   * Possible duplicates for the create/edit form: same phone (digits only, Arabic-Indic digits
   * folded), same tax number or national id (trimmed, case-insensitive), or the same name ignoring
   * case and repeated spaces. Identifier values are not echoed back, only which field matched.
   */
  async findDuplicates(q: SupplierDuplicateQuery): Promise<SupplierDuplicate[]> {
    const phone = normalizePhone(q.phone);
    const tax = q.taxNumber?.trim() || null;
    const nid = q.nationalId?.trim() || null;
    const name = q.name?.trim() || null;
    if (!phone && !tax && !nid && !name) return [];
    const rows = await this.dbs.query<{ id: string; name: string; type: string; phone: string | null; is_active: boolean; m_phone: boolean; m_tax: boolean; m_nid: boolean; m_name: boolean }>(
      `WITH m AS (
         SELECT s.id, s.name, s.type, s.phone, s.is_active,
                coalesce($1::text IS NOT NULL
                  AND regexp_replace(translate(s.phone, '${ARABIC_DIGITS}', '${ASCII_DIGITS}'), '[^0-9]', '', 'g') = $1::text, false) AS m_phone,
                coalesce($2::text IS NOT NULL AND upper(btrim(s.tax_number)) = upper($2::text), false) AS m_tax,
                coalesce($3::text IS NOT NULL AND upper(btrim(s.national_id)) = upper($3::text), false) AS m_nid,
                coalesce($4::text IS NOT NULL
                  AND lower(regexp_replace(btrim(s.name), '\\s+', ' ', 'g')) = lower(regexp_replace($4::text, '\\s+', ' ', 'g')), false) AS m_name
           FROM suppliers s
          WHERE ($5::uuid IS NULL OR s.id <> $5::uuid)
       )
       SELECT * FROM m WHERE m_phone OR m_tax OR m_nid OR m_name
        ORDER BY (m_tax OR m_nid) DESC, m_phone DESC, name
        LIMIT 20`,
      [phone, tax, nid, name, q.excludeId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      phone: r.phone,
      isActive: r.is_active,
      matchedOn: [
        ...(r.m_phone ? (['phone'] as const) : []),
        ...(r.m_tax ? (['taxNumber'] as const) : []),
        ...(r.m_nid ? (['nationalId'] as const) : []),
        ...(r.m_name ? (['name'] as const) : []),
      ],
    }));
  }

  async create(ctx: TenantContext, input: SupplierCreateInput) {
    const [s] = await this.dbs.db
      .insert(suppliers)
      .values({ ...input, tenantId: ctx.tenant.id, createdBy: ctx.userId })
      .returning();
    await this.audit.record({ action: 'supplier.created', entityType: 'supplier', entityId: s!.id, summary: s!.name, after: s });
    return s!;
  }

  async update(ctx: TenantContext, id: string, input: SupplierUpdateInput) {
    const [before] = await this.dbs.db.select().from(suppliers).where(eq(suppliers.id, id)).for('update');
    if (!before) throw notFound('Supplier');
    const [after] = await this.dbs.db
      .update(suppliers)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(suppliers.id, id))
      .returning();
    const change = diff(before, after!);
    const action = input.isActive === false && before.isActive ? 'supplier.deactivated' : input.isActive === true && !before.isActive ? 'supplier.reactivated' : 'supplier.updated';
    await this.audit.record({ action, entityType: 'supplier', entityId: id, summary: after!.name, ...change });
    void ctx;
    return after!;
  }
}
