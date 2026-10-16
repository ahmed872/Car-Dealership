import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CashBook, CashBookQuery, CashBookRow, d } from '@autohub/shared';
import { assertBranchAccess, TenantContext } from '../../common/context';
import { notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { cashAccounts } from '../../db/schema';
import { iso, Params, period } from './accounting.util';

const SIGNED = `CASE WHEN ct.direction = 'in' THEN ct.amount ELSE -ct.amount END`;
const SIGNED_BASE = `CASE WHEN ct.direction = 'in' THEN ct.amount_base ELSE -ct.amount_base END`;
/** Rows on or after `from` ($2); the upper bound ($3) is applied in the WHERE clause. */
const IN_RANGE = `($2::date IS NULL OR ct.business_date >= $2::date)`;

/**
 * Cash-book view of one account: opening balance before `from`, every movement in the period with
 * its running balance (account currency and base), and the closing balance. Rows are in
 * chronological order (business date, then recording time); the running balance is computed over
 * the whole period with a window function, so it is correct on every page.
 */
@Injectable()
export class CashBookService {
  constructor(private readonly dbs: DbService) {}

  async book(ctx: TenantContext, accountId: string, q: CashBookQuery): Promise<CashBook> {
    const [acct] = await this.dbs.db.select().from(cashAccounts).where(eq(cashAccounts.id, accountId));
    if (!acct) throw notFound('Cash account');
    assertBranchAccess(ctx, acct.branchId);
    const { from, to } = period(ctx, q.from, q.to);

    const [agg] = await this.dbs.query<{
      opening: string;
      opening_base: string;
      total_in: string;
      total_out: string;
      total_in_base: string;
      total_out_base: string;
      n: number;
    }>(
      `SELECT coalesce(sum(${SIGNED}) FILTER (WHERE $2::date IS NOT NULL AND ct.business_date < $2::date), 0)::numeric(18,2)::text AS opening,
              coalesce(sum(${SIGNED_BASE}) FILTER (WHERE $2::date IS NOT NULL AND ct.business_date < $2::date), 0)::numeric(18,2)::text AS opening_base,
              coalesce(sum(ct.amount) FILTER (WHERE ct.direction = 'in' AND ${IN_RANGE}), 0)::numeric(18,2)::text AS total_in,
              coalesce(sum(ct.amount) FILTER (WHERE ct.direction = 'out' AND ${IN_RANGE}), 0)::numeric(18,2)::text AS total_out,
              coalesce(sum(ct.amount_base) FILTER (WHERE ct.direction = 'in' AND ${IN_RANGE}), 0)::numeric(18,2)::text AS total_in_base,
              coalesce(sum(ct.amount_base) FILTER (WHERE ct.direction = 'out' AND ${IN_RANGE}), 0)::numeric(18,2)::text AS total_out_base,
              (count(*) FILTER (WHERE ${IN_RANGE}))::int AS n
         FROM cash_transactions ct
        WHERE ct.cash_account_id = $1::uuid AND ct.business_date <= $3::date`,
      [acct.id, from, to],
    );
    const opening = agg?.opening ?? '0.00';
    const openingBase = agg?.opening_base ?? '0.00';

    const p = new Params();
    const idP = p.add(acct.id);
    const fromP = p.add(from);
    const toP = p.add(to);
    const openP = p.add(opening);
    const openBaseP = p.add(openingBase);
    const limitP = p.add(q.pageSize);
    const offsetP = p.add((q.page - 1) * q.pageSize);
    const rows = await this.dbs.query<{
      id: string;
      business_date: string;
      direction: 'in' | 'out';
      kind: string;
      amount: string;
      amount_base: string;
      exchange_rate: string;
      signed: string;
      running: string;
      running_base: string;
      source_type: string;
      source_id: string;
      payment_number: string | null;
      counterpart_id: string | null;
      counterpart_name: string | null;
      reference: string | null;
      description: string;
      reversal_of_id: string | null;
      reversed_by_id: string | null;
      journal_entry_id: string | null;
      created_at: Date;
    }>(
      `WITH r AS (
         SELECT ct.*, ${SIGNED} AS signed, ${SIGNED_BASE} AS signed_base
           FROM cash_transactions ct
          WHERE ct.cash_account_id = ${idP}::uuid
            AND (${fromP}::date IS NULL OR ct.business_date >= ${fromP}::date)
            AND ct.business_date <= ${toP}::date
       ), w AS (
         SELECT r.*,
                sum(r.signed) OVER (ORDER BY r.business_date, r.created_at, r.id ROWS UNBOUNDED PRECEDING) AS run,
                sum(r.signed_base) OVER (ORDER BY r.business_date, r.created_at, r.id ROWS UNBOUNDED PRECEDING) AS run_base
           FROM r
       )
       SELECT w.id, w.business_date, w.direction, w.kind, w.amount, w.amount_base, w.exchange_rate,
              w.signed::numeric(18,2)::text AS signed,
              (${openP}::numeric + w.run)::numeric(18,2)::text AS running,
              (${openBaseP}::numeric + w.run_base)::numeric(18,2)::text AS running_base,
              w.source_type, w.source_id, sp.number AS payment_number,
              cp.cash_account_id AS counterpart_id, ca.name AS counterpart_name,
              w.reference, w.description, w.reversal_of_id,
              (SELECT rv.id FROM cash_transactions rv WHERE rv.reversal_of_id = w.id LIMIT 1) AS reversed_by_id,
              w.journal_entry_id, w.created_at
         FROM w
         LEFT JOIN supplier_payments sp ON w.source_type = 'supplier_payment' AND sp.id = w.source_id
         LEFT JOIN LATERAL (
           SELECT c2.cash_account_id FROM cash_transactions c2
            WHERE w.source_type = 'cash_transfer' AND c2.source_type = 'cash_transfer'
              AND c2.source_id = w.source_id AND c2.cash_account_id <> w.cash_account_id
            LIMIT 1
         ) cp ON true
         LEFT JOIN cash_accounts ca ON ca.id = cp.cash_account_id
        ORDER BY w.business_date, w.created_at, w.id
        LIMIT ${limitP} OFFSET ${offsetP}`,
      p.values,
    );

    const items: CashBookRow[] = rows.map((r) => ({
      id: r.id,
      businessDate: r.business_date,
      direction: r.direction,
      kind: r.kind,
      amount: r.amount,
      amountBase: r.amount_base,
      exchangeRate: r.exchange_rate,
      signedAmount: r.signed,
      runningBalance: r.running,
      runningBalanceBase: r.running_base,
      sourceType: r.source_type,
      sourceId: r.source_id,
      documentNumber: r.payment_number,
      counterpartAccountId: r.counterpart_id,
      counterpartAccountName: r.counterpart_name,
      reference: r.reference,
      description: r.description,
      isReversal: r.reversal_of_id !== null,
      reversalOfId: r.reversal_of_id,
      reversedById: r.reversed_by_id,
      journalEntryId: r.journal_entry_id,
      createdAt: iso(r.created_at)!,
    }));
    const totals = {
      in: agg?.total_in ?? '0.00',
      out: agg?.total_out ?? '0.00',
      inBase: agg?.total_in_base ?? '0.00',
      outBase: agg?.total_out_base ?? '0.00',
    };
    const closing = {
      amount: d(opening).plus(totals.in).minus(totals.out).toFixed(2),
      amountBase: d(openingBase).plus(totals.inBase).minus(totals.outBase).toFixed(2),
    };
    return {
      account: { id: acct.id, name: acct.name, type: acct.type as 'cashbox' | 'bank', currency: acct.currency, branchId: acct.branchId, isActive: acct.isActive },
      baseCurrency: ctx.tenant.baseCurrency,
      from,
      to,
      opening: { amount: opening, amountBase: openingBase },
      totals,
      closing,
      rows: items,
      total: agg?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }
}
