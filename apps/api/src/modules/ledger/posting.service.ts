import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { d, sum } from '@autohub/shared';
import { DbService } from '../../db/db.service';
import { journalEntries, journalLines } from '../../db/schema';
import { AccountCode } from './chart';

export interface PostingLine {
  account: AccountCode;
  debit?: string;
  credit?: string;
  branchId?: string | null;
  vehicleId?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  cashAccountId?: string | null;
  saleId?: string | null;
  userId?: string | null;
  memo?: string | null;
}

export interface PostingRequest {
  sourceType: string;
  sourceId: string;
  /** Business event, e.g. "acquisition.approved". (sourceType, sourceId, event) is unique. */
  event: string;
  date: string;
  description: string;
  branchId?: string | null;
  lines: PostingLine[];
  reversalOfId?: string | null;
}

export class UnbalancedPostingError extends Error {}

/**
 * Double-entry posting engine. Validates balance in the application (clear errors) and the DB
 * enforces it again at commit (deferred trigger). Entries are immutable; corrections are reversals.
 */
@Injectable()
export class PostingService {
  constructor(private readonly dbs: DbService) {}

  async post(req: PostingRequest): Promise<string | null> {
    const lines = req.lines.filter((l) => !d(l.debit ?? 0).isZero() || !d(l.credit ?? 0).isZero());
    for (const l of lines) {
      const dr = d(l.debit ?? 0);
      const cr = d(l.credit ?? 0);
      if (dr.isNegative() || cr.isNegative()) throw new UnbalancedPostingError(`Negative amount on ${l.account}`);
      if (!dr.isZero() && !cr.isZero()) throw new UnbalancedPostingError(`Line on ${l.account} has both debit and credit`);
      if (dr.decimalPlaces() > 2 || cr.decimalPlaces() > 2) throw new UnbalancedPostingError('Amounts must be rounded to 2 decimals');
    }
    if (lines.length === 0) return null; // nothing to post (e.g. zero-value event)
    const totalDr = sum(lines.map((l) => l.debit ?? 0));
    const totalCr = sum(lines.map((l) => l.credit ?? 0));
    if (!totalDr.eq(totalCr)) {
      throw new UnbalancedPostingError(`Unbalanced posting ${req.event}: debit ${totalDr.toFixed(2)} credit ${totalCr.toFixed(2)}`);
    }
    if (lines.length < 2) throw new UnbalancedPostingError('A journal entry needs at least two lines');

    const ctx = this.dbs.context;
    if (!ctx?.tenantId) throw new Error('Posting requires tenant context');
    const [{ n }] = (await this.dbs.query<{ n: string }>(`SELECT app_next_number('journal') AS n`)) as [{ n: string }];
    const [entry] = await this.dbs.db
      .insert(journalEntries)
      .values({
        tenantId: ctx.tenantId,
        entryNo: Number(n),
        entryDate: req.date,
        sourceType: req.sourceType,
        sourceId: req.sourceId,
        event: req.event,
        description: req.description.slice(0, 500),
        branchId: req.branchId ?? null,
        reversalOfId: req.reversalOfId ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: journalEntries.id });
    await this.dbs.db.insert(journalLines).values(
      lines.map((l, i) => ({
        tenantId: ctx.tenantId!,
        entryId: entry!.id,
        lineNo: i + 1,
        accountCode: l.account,
        debit: d(l.debit ?? 0).toFixed(2),
        credit: d(l.credit ?? 0).toFixed(2),
        branchId: l.branchId ?? req.branchId ?? null,
        vehicleId: l.vehicleId ?? null,
        customerId: l.customerId ?? null,
        supplierId: l.supplierId ?? null,
        cashAccountId: l.cashAccountId ?? null,
        saleId: l.saleId ?? null,
        userId: l.userId ?? null,
        memo: l.memo ?? null,
      })),
    );
    return entry!.id;
  }

  /** Posts the mirror image of an existing entry (debits ↔ credits) as a new entry. */
  async reverse(
    original: { sourceType: string; sourceId: string; event: string },
    reversalEvent: string,
    date: string,
    description: string,
  ): Promise<string | null> {
    const db = this.dbs.db;
    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.sourceType, original.sourceType),
          eq(journalEntries.sourceId, original.sourceId),
          eq(journalEntries.event, original.event),
        ),
      )
      .limit(1);
    if (!entry) return null;
    const lines = await db.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).orderBy(asc(journalLines.lineNo));
    return this.post({
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      event: reversalEvent,
      date,
      description,
      branchId: entry.branchId,
      reversalOfId: entry.id,
      lines: lines.map((l) => ({
        account: l.accountCode as AccountCode,
        debit: l.credit,
        credit: l.debit,
        branchId: l.branchId,
        vehicleId: l.vehicleId,
        customerId: l.customerId,
        supplierId: l.supplierId,
        cashAccountId: l.cashAccountId,
        saleId: l.saleId,
        userId: l.userId,
        memo: l.memo,
      })),
    });
  }

  /** Balance (debit − credit) of an account, optionally filtered by a dimension. */
  async balance(account: AccountCode, dims: Partial<Record<'vehicleId' | 'customerId' | 'supplierId' | 'cashAccountId' | 'saleId' | 'userId', string>> = {}): Promise<string> {
    const conds = [eq(journalLines.accountCode, account)];
    if (dims.vehicleId) conds.push(eq(journalLines.vehicleId, dims.vehicleId));
    if (dims.customerId) conds.push(eq(journalLines.customerId, dims.customerId));
    if (dims.supplierId) conds.push(eq(journalLines.supplierId, dims.supplierId));
    if (dims.cashAccountId) conds.push(eq(journalLines.cashAccountId, dims.cashAccountId));
    if (dims.saleId) conds.push(eq(journalLines.saleId, dims.saleId));
    if (dims.userId) conds.push(eq(journalLines.userId, dims.userId));
    const [row] = await this.dbs.db
      .select({ bal: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::numeric(18,2)::text` })
      .from(journalLines)
      .where(and(...conds));
    return row?.bal ?? '0.00';
  }

  async hasEvent(sourceType: string, sourceId: string, event: string): Promise<boolean> {
    const rows = await this.dbs.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.sourceType, sourceType), eq(journalEntries.sourceId, sourceId), eq(journalEntries.event, event)))
      .limit(1);
    return rows.length > 0;
  }
}
