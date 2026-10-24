import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, SQL, sql } from 'drizzle-orm';
import {
  maskNationalId,
  normalizeNationalId,
  PaginationQuery,
  SupplierCreateInput,
  SupplierDuplicate,
  SupplierDuplicateCheckInput,
  SupplierSensitive,
  SupplierUpdateInput,
} from '@autohub/shared';
import { assertPermission, TenantContext } from '../../common/context';
import { decryptSecret, encryptSecret, hmacHex } from '../../common/crypto';
import { notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { suppliers } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';

export type SupplierRow = typeof suppliers.$inferSelect;
type SupplierInsert = typeof suppliers.$inferInsert;
type NationalIdColumns = Pick<SupplierInsert, 'legacyNationalId' | 'nationalIdEnc' | 'nationalIdHash' | 'nationalIdLast4'>;

/** What the API exposes: the encrypted national ID, its hash and any old plain-text copy never leave the server. */
export type SupplierView = Omit<SupplierRow, 'legacyNationalId' | 'nationalIdEnc' | 'nationalIdHash' | 'nationalIdLast4'> & {
  nationalIdMasked: string | null;
  hasNationalId: boolean;
};

/** Last 4 characters of a plain-text value written before D-047 (until the backfill has run). */
const legacyLast4 = (raw: string | null): string | null => {
  const v = raw ? (normalizeNationalId(raw) ?? raw.replace(/\s+/g, '')) : '';
  return v ? v.slice(-4) : null;
};

export function presentSupplier(row: SupplierRow): SupplierView {
  const { legacyNationalId, nationalIdEnc: _enc, nationalIdHash: _hash, nationalIdLast4, ...rest } = row;
  const last4 = nationalIdLast4 ?? legacyLast4(legacyNationalId);
  return { ...rest, nationalIdMasked: maskNationalId(last4), hasNationalId: !!last4 };
}

export type LegacyNationalIdOutcome = 'encrypted' | 'unrecognised' | 'cleared';

/**
 * Columns that replace a plain-text national ID written before D-047. A recognisable ID is stored
 * like a new one (normalised, encrypted, hashed); anything else is kept encrypted exactly as typed,
 * without a lookup hash. A row that already has the encrypted value, or a blank one, only loses the
 * plain text.
 */
export function legacyNationalIdColumns(row: Pick<SupplierRow, 'legacyNationalId' | 'nationalIdEnc'>): { cols: NationalIdColumns; outcome: LegacyNationalIdOutcome } {
  const raw = row.legacyNationalId?.trim() ?? '';
  if (!raw || row.nationalIdEnc) return { cols: { legacyNationalId: null }, outcome: 'cleared' };
  const nid = normalizeNationalId(raw);
  if (nid) {
    return { cols: { legacyNationalId: null, nationalIdEnc: encryptSecret(nid), nationalIdHash: hmacHex(nid), nationalIdLast4: nid.slice(-4) }, outcome: 'encrypted' };
  }
  return { cols: { legacyNationalId: null, nationalIdEnc: encryptSecret(raw), nationalIdHash: null, nationalIdLast4: legacyLast4(raw) }, outcome: 'unrecognised' };
}

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

/**
 * Suppliers (purchasing master data). National IDs are stored like customers' (B-023, D-047):
 * encrypted, with a keyed hash of the normalised value for duplicate checks and the last 4
 * characters for display; the full value is revealed only with suppliers.view_sensitive (audited).
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Encrypted columns for a national ID from a create/update body (null/empty removes it). */
  private nationalIdColumns(raw: string | null): NationalIdColumns {
    if (!raw?.trim()) return { legacyNationalId: null, nationalIdEnc: null, nationalIdHash: null, nationalIdLast4: null };
    const nid = normalizeNationalId(raw);
    if (!nid) throw unprocessable('invalid_national_id', 'The national ID / Iqama number is not valid', { field: 'nationalId' });
    return { legacyNationalId: null, nationalIdEnc: encryptSecret(nid), nationalIdHash: hmacHex(nid), nationalIdLast4: nid.slice(-4) };
  }

  private async row(id: string, lock = false): Promise<SupplierRow> {
    const q = this.dbs.db.select().from(suppliers).where(eq(suppliers.id, id));
    const [s] = lock ? await q.for('update') : await q;
    if (!s) throw notFound('Supplier');
    return s;
  }

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
    return { items: items.map(presentSupplier), total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string): Promise<SupplierView> {
    return presentSupplier(await this.row(id));
  }

  /** Full national ID (suppliers.view_sensitive). Every read is recorded in the audit log, never the value. */
  async sensitive(ctx: TenantContext, id: string): Promise<SupplierSensitive> {
    assertPermission(ctx, 'suppliers.view_sensitive');
    const s = await this.row(id);
    const nationalId = s.nationalIdEnc ? decryptSecret(s.nationalIdEnc) : s.legacyNationalId?.trim() || null;
    await this.audit.record({
      action: 'supplier.sensitive_viewed',
      entityType: 'supplier',
      entityId: s.id,
      summary: `National ID of ${s.name} viewed`,
      metadata: { fields: ['nationalId'] },
    });
    return { id: s.id, nationalId, nationalIdMasked: presentSupplier(s).nationalIdMasked };
  }

  /**
   * Possible duplicates for the create/edit form: same phone (digits only, Arabic-Indic digits
   * folded), same tax number (trimmed, case-insensitive), same national ID (keyed hash of the
   * normalised value: case, spaces and separators do not matter), or the same name ignoring case and
   * repeated spaces. Identifier values are not echoed back, only which field matched.
   */
  async findDuplicates(q: SupplierDuplicateCheckInput): Promise<SupplierDuplicate[]> {
    const phone = normalizePhone(q.phone);
    const tax = q.taxNumber?.trim() || null;
    const nidNorm = normalizeNationalId(q.nationalId);
    const nid = nidNorm ? hmacHex(nidNorm) : null;
    const name = q.name?.trim() || null;
    if (!phone && !tax && !nid && !name) return [];
    const rows = await this.dbs.query<{ id: string; name: string; type: string; phone: string | null; is_active: boolean; m_phone: boolean; m_tax: boolean; m_nid: boolean; m_name: boolean }>(
      `WITH m AS (
         SELECT s.id, s.name, s.type, s.phone, s.is_active,
                coalesce($1::text IS NOT NULL
                  AND regexp_replace(translate(s.phone, '${ARABIC_DIGITS}', '${ASCII_DIGITS}'), '[^0-9]', '', 'g') = $1::text, false) AS m_phone,
                coalesce($2::text IS NOT NULL AND upper(btrim(s.tax_number)) = upper($2::text), false) AS m_tax,
                coalesce($3::text IS NOT NULL AND s.national_id_hash = $3::text, false) AS m_nid,
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

  async create(ctx: TenantContext, input: SupplierCreateInput): Promise<SupplierView> {
    const { nationalId, ...fields } = input;
    const [s] = await this.dbs.db
      .insert(suppliers)
      .values({ ...fields, ...this.nationalIdColumns(nationalId ?? null), tenantId: ctx.tenant.id, createdBy: ctx.userId })
      .returning();
    // The audit log redacts the national-ID columns (audit.service REDACT_KEYS).
    await this.audit.record({ action: 'supplier.created', entityType: 'supplier', entityId: s!.id, summary: s!.name, after: s });
    return presentSupplier(s!);
  }

  /** PATCH: an absent nationalId keeps the stored one; null removes it. */
  async update(ctx: TenantContext, id: string, input: SupplierUpdateInput): Promise<SupplierView> {
    const before = await this.row(id, true);
    const { nationalId, ...fields } = input;
    // A plain-text value from before D-047 is moved into the encrypted columns on the first edit.
    const idCols =
      nationalId !== undefined
        ? this.nationalIdColumns(nationalId)
        : before.legacyNationalId !== null
          ? legacyNationalIdColumns(before).cols
          : {};
    const [after] = await this.dbs.db
      .update(suppliers)
      .set({ ...fields, ...idCols, updatedAt: new Date() })
      .where(eq(suppliers.id, id))
      .returning();
    const change = diff(before, after!);
    const action = input.isActive === false && before.isActive ? 'supplier.deactivated' : input.isActive === true && !before.isActive ? 'supplier.reactivated' : 'supplier.updated';
    await this.audit.record({ action, entityType: 'supplier', entityId: id, summary: after!.name, ...change });
    void ctx;
    return presentSupplier(after!);
  }

  /**
   * Moves the plain-text national IDs written before D-047 into the encrypted columns, for the
   * company of the current transaction (`cli.js encrypt-supplier-ids`). Safe to run again: rows
   * without a plain-text value are not touched. Records one audit entry when anything changed.
   */
  async encryptLegacyNationalIds(batchSize = 500): Promise<Record<LegacyNationalIdOutcome, number>> {
    const totals: Record<LegacyNationalIdOutcome, number> = { encrypted: 0, unrecognised: 0, cleared: 0 };
    for (;;) {
      const rows = await this.dbs.db
        .select({ id: suppliers.id, legacyNationalId: suppliers.legacyNationalId, nationalIdEnc: suppliers.nationalIdEnc })
        .from(suppliers)
        .where(isNotNull(suppliers.legacyNationalId))
        .orderBy(asc(suppliers.id))
        .limit(batchSize)
        .for('update');
      if (!rows.length) break;
      for (const r of rows) {
        const { cols, outcome } = legacyNationalIdColumns(r);
        await this.dbs.db.update(suppliers).set(cols).where(eq(suppliers.id, r.id));
        totals[outcome]++;
      }
    }
    const changed = totals.encrypted + totals.unrecognised + totals.cleared;
    if (changed) {
      await this.audit.record({
        action: 'supplier.national_ids_encrypted',
        entityType: 'supplier',
        summary: `Plain-text national IDs of ${changed} supplier(s) moved to encrypted storage`,
        metadata: { ...totals },
      });
    }
    return totals;
  }
}
