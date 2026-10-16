import { Injectable } from '@nestjs/common';
import {
  AccountStatement,
  BalanceSheet,
  d,
  IncomeStatement,
  LedgerAccountBalance,
  LedgerAccountType,
  LedgerEntriesQuery,
  LedgerEntry,
  LedgerLine,
  LedgerPeriodQuery,
  LedgerStatementQuery,
  StatementLine,
  sum,
  TrialBalance,
  TrialBalanceRow,
} from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { ACCOUNTS } from '../ledger/chart';
import { assertCompanyScope, iso, Params, period, today } from './accounting.util';

const ZERO = '0.00';
const fx2 = (v: string | null | undefined) => d(v ?? 0).toFixed(2);
const DEBIT_NORMAL: ReadonlySet<LedgerAccountType> = new Set(['asset', 'expense']);

type AccountRow = { code: string; name_en: string; name_ar: string; type: LedgerAccountType; is_active: boolean };

interface EntryRow extends Record<string, unknown> {
  id: string;
  entry_no: number;
  entry_date: string;
  source_type: string;
  source_id: string;
  event: string;
  description: string;
  branch_id: string | null;
  reversal_of_id: string | null;
  reversed_by_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  entry_id: string;
  line_no: number;
  account_code: string;
  name_en: string;
  name_ar: string;
  debit: string;
  credit: string;
  branch_id: string | null;
  vehicle_id: string | null;
  customer_id: string | null;
  supplier_id: string | null;
  cash_account_id: string | null;
  sale_id: string | null;
  user_id: string | null;
  memo: string | null;
}

/**
 * General-ledger reports, all computed set-based from journal_lines (base currency). Every report
 * is company-wide (see assertCompanyScope). Where a `branchId` filter exists on a period report it
 * selects the journal ENTRIES recorded by that branch (journal_entries.branch_id), so a branch trial
 * balance is still made of whole, balanced entries; company-level entries (branch NULL, e.g.
 * movements of a head-office bank account) are only in the unfiltered report.
 */
@Injectable()
export class LedgerReportsService {
  constructor(private readonly dbs: DbService) {}

  private async assertBranch(branchId: string | undefined) {
    if (!branchId) return;
    const [b] = await this.dbs.query<{ id: string }>(`SELECT id FROM branches WHERE id = $1::uuid`, [branchId]);
    if (!b) throw notFound('Branch');
  }

  /** Chart of accounts with balances as of a date (default: everything posted). */
  async accounts(ctx: TenantContext, asOf?: string): Promise<{ currency: string; asOf: string | null; items: LedgerAccountBalance[] }> {
    assertCompanyScope(ctx);
    const rows = await this.dbs.query<AccountRow & { debit: string; credit: string; balance: string }>(
      `SELECT la.code, la.name_en, la.name_ar, la.type, la.is_active,
              coalesce(b.dr, 0)::numeric(18,2)::text AS debit,
              coalesce(b.cr, 0)::numeric(18,2)::text AS credit,
              coalesce(b.dr - b.cr, 0)::numeric(18,2)::text AS balance
         FROM ledger_accounts la
         LEFT JOIN (
           SELECT jl.account_code, sum(jl.debit) AS dr, sum(jl.credit) AS cr
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id
            WHERE $1::date IS NULL OR je.entry_date <= $1::date
            GROUP BY jl.account_code
         ) b ON b.account_code = la.code
        ORDER BY la.code`,
      [asOf ?? null],
    );
    return {
      currency: ctx.tenant.baseCurrency,
      asOf: asOf ?? null,
      items: rows.map((r) => ({
        code: r.code,
        nameEn: r.name_en,
        nameAr: r.name_ar,
        type: r.type,
        isActive: r.is_active,
        debit: r.debit,
        credit: r.credit,
        balance: r.balance,
        naturalBalance: DEBIT_NORMAL.has(r.type) ? r.balance : d(r.balance).negated().toFixed(2),
      })),
    };
  }

  async trialBalance(ctx: TenantContext, q: LedgerPeriodQuery): Promise<TrialBalance> {
    assertCompanyScope(ctx);
    await this.assertBranch(q.branchId);
    const { from, to } = period(ctx, q.from, q.to);
    const rows = await this.dbs.query<AccountRow & { opening: string; period_debit: string; period_credit: string; closing: string }>(
      `SELECT la.code, la.name_en, la.name_ar, la.type,
              coalesce(sum(jl.debit - jl.credit) FILTER (WHERE $1::date IS NOT NULL AND je.entry_date < $1::date), 0)::numeric(18,2)::text AS opening,
              coalesce(sum(jl.debit) FILTER (WHERE $1::date IS NULL OR je.entry_date >= $1::date), 0)::numeric(18,2)::text AS period_debit,
              coalesce(sum(jl.credit) FILTER (WHERE $1::date IS NULL OR je.entry_date >= $1::date), 0)::numeric(18,2)::text AS period_credit,
              coalesce(sum(jl.debit - jl.credit), 0)::numeric(18,2)::text AS closing
         FROM ledger_accounts la
         LEFT JOIN (journal_lines jl
                    JOIN journal_entries je ON je.id = jl.entry_id
                     AND je.entry_date <= $2::date
                     AND ($3::uuid IS NULL OR je.branch_id = $3::uuid))
           ON jl.account_code = la.code
        GROUP BY la.code, la.name_en, la.name_ar, la.type
        ORDER BY la.code`,
      [from, to, q.branchId ?? null],
    );
    const out: TrialBalanceRow[] = rows.map((r) => {
      const c = d(r.closing);
      return {
        code: r.code,
        nameEn: r.name_en,
        nameAr: r.name_ar,
        type: r.type,
        opening: r.opening,
        periodDebit: r.period_debit,
        periodCredit: r.period_credit,
        closing: r.closing,
        closingDebit: c.gt(0) ? c.toFixed(2) : ZERO,
        closingCredit: c.lt(0) ? c.negated().toFixed(2) : ZERO,
      };
    });
    const tot = (pick: (r: TrialBalanceRow) => string) => sum(out.map(pick)).toFixed(2);
    const totals = {
      opening: tot((r) => r.opening),
      periodDebit: tot((r) => r.periodDebit),
      periodCredit: tot((r) => r.periodCredit),
      closing: tot((r) => r.closing),
      closingDebit: tot((r) => r.closingDebit),
      closingCredit: tot((r) => r.closingCredit),
    };
    const isBalanced =
      d(totals.periodDebit).eq(totals.periodCredit) && d(totals.closingDebit).eq(totals.closingCredit) && d(totals.opening).isZero() && d(totals.closing).isZero();
    return { currency: ctx.tenant.baseCurrency, from, to, branchId: q.branchId ?? null, rows: out, totals, isBalanced };
  }

  // ── Journal entries ───────────────────────────────────────────────────────────────────────

  private entrySelect(): string {
    return `
      SELECT je.id, je.entry_no, je.entry_date, je.source_type, je.source_id, je.event, je.description, je.branch_id,
             je.reversal_of_id,
             (SELECT r.id FROM journal_entries r WHERE r.reversal_of_id = je.id ORDER BY r.entry_no LIMIT 1) AS reversed_by_id,
             je.created_by, u.full_name AS created_by_name, je.created_at
        FROM journal_entries je
        LEFT JOIN users u ON u.id = je.created_by`;
  }

  private async withLines(entries: EntryRow[]): Promise<LedgerEntry[]> {
    if (!entries.length) return [];
    const lines = await this.dbs.query<LineRow>(
      `SELECT jl.id, jl.entry_id, jl.line_no, jl.account_code, la.name_en, la.name_ar, jl.debit, jl.credit,
              jl.branch_id, jl.vehicle_id, jl.customer_id, jl.supplier_id, jl.cash_account_id, jl.sale_id, jl.user_id, jl.memo
         FROM journal_lines jl
         JOIN ledger_accounts la ON la.code = jl.account_code
        WHERE jl.entry_id = ANY($1::uuid[])
        ORDER BY jl.entry_id, jl.line_no`,
      [entries.map((e) => e.id)],
    );
    const byEntry = new Map<string, LedgerLine[]>();
    for (const l of lines) {
      const list = byEntry.get(l.entry_id) ?? [];
      list.push({
        id: l.id,
        lineNo: l.line_no,
        accountCode: l.account_code,
        accountNameEn: l.name_en,
        accountNameAr: l.name_ar,
        debit: l.debit,
        credit: l.credit,
        branchId: l.branch_id,
        vehicleId: l.vehicle_id,
        customerId: l.customer_id,
        supplierId: l.supplier_id,
        cashAccountId: l.cash_account_id,
        saleId: l.sale_id,
        userId: l.user_id,
        memo: l.memo,
      });
      byEntry.set(l.entry_id, list);
    }
    return entries.map((e) => {
      const ls = byEntry.get(e.id) ?? [];
      return {
        id: e.id,
        entryNo: e.entry_no,
        entryDate: e.entry_date,
        sourceType: e.source_type,
        sourceId: e.source_id,
        event: e.event,
        description: e.description,
        branchId: e.branch_id,
        reversalOfId: e.reversal_of_id,
        reversedById: e.reversed_by_id,
        createdBy: e.created_by,
        createdByName: e.created_by_name,
        createdAt: iso(e.created_at)!,
        totalDebit: sum(ls.map((l) => l.debit)).toFixed(2),
        totalCredit: sum(ls.map((l) => l.credit)).toFixed(2),
        lines: ls,
      };
    });
  }

  /** Entries (newest first) matching entry filters and, when given, having a line matching ALL line filters. */
  async entries(ctx: TenantContext, q: LedgerEntriesQuery) {
    assertCompanyScope(ctx);
    if (q.from && q.to && q.from > q.to) throw unprocessable('invalid_range', 'The start date must be on or before the end date', { from: q.from, to: q.to });
    const p = new Params();
    const where: string[] = [];
    if (q.from) where.push(`je.entry_date >= ${p.add(q.from)}::date`);
    if (q.to) where.push(`je.entry_date <= ${p.add(q.to)}::date`);
    if (q.sourceType) where.push(`je.source_type = ${p.add(q.sourceType)}`);
    if (q.branchId) where.push(`je.branch_id = ${p.add(q.branchId)}::uuid`);
    const lineConds: string[] = [];
    if (q.accountCode) lineConds.push(`jl.account_code = ${p.add(q.accountCode)}`);
    const dims: Array<[keyof LedgerEntriesQuery, string]> = [
      ['vehicleId', 'vehicle_id'],
      ['supplierId', 'supplier_id'],
      ['customerId', 'customer_id'],
      ['cashAccountId', 'cash_account_id'],
      ['saleId', 'sale_id'],
    ];
    for (const [key, col] of dims) {
      const v = q[key];
      if (v) lineConds.push(`jl.${col} = ${p.add(v)}::uuid`);
    }
    if (lineConds.length) where.push(`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.entry_id = je.id AND ${lineConds.join(' AND ')})`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [c] = await this.dbs.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries je ${whereSql}`, p.values);
    const limit = p.add(q.pageSize);
    const offset = p.add((q.page - 1) * q.pageSize);
    const rows = await this.dbs.query<EntryRow>(
      `${this.entrySelect()} ${whereSql} ORDER BY je.entry_date DESC, je.entry_no DESC LIMIT ${limit} OFFSET ${offset}`,
      p.values,
    );
    return { currency: ctx.tenant.baseCurrency, items: await this.withLines(rows), total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async entry(ctx: TenantContext, id: string): Promise<LedgerEntry & { currency: string }> {
    assertCompanyScope(ctx);
    const rows = await this.dbs.query<EntryRow>(`${this.entrySelect()} WHERE je.id = $1::uuid`, [id]);
    if (!rows.length) throw notFound('Journal entry');
    const [e] = await this.withLines(rows);
    return { ...e!, currency: ctx.tenant.baseCurrency };
  }

  // ── Account statement ─────────────────────────────────────────────────────────────────────

  private async account(code: string): Promise<AccountRow> {
    if (!/^\d{4}$/.test(code)) throw notFound('Ledger account');
    const [a] = await this.dbs.query<AccountRow>(`SELECT code, name_en, name_ar, type, is_active FROM ledger_accounts WHERE code = $1`, [code]);
    if (!a) throw notFound('Ledger account');
    return a;
  }

  /**
   * Lines of one account (optionally narrowed by line dimensions, including the LINE branch), with
   * opening balance before `from`, running balance and closing. Balances are debit − credit.
   */
  async statement(ctx: TenantContext, code: string, q: LedgerStatementQuery): Promise<AccountStatement> {
    assertCompanyScope(ctx);
    const acct = await this.account(code);
    const { from, to } = period(ctx, q.from, q.to);
    const p = new Params();
    const codeP = p.add(acct.code);
    const fromP = p.add(from);
    const toP = p.add(to);
    const conds = [`jl.account_code = ${codeP}`];
    const filters: Record<string, string> = {};
    const dims: Array<[keyof LedgerStatementQuery, string]> = [
      ['branchId', 'branch_id'],
      ['vehicleId', 'vehicle_id'],
      ['supplierId', 'supplier_id'],
      ['customerId', 'customer_id'],
      ['cashAccountId', 'cash_account_id'],
      ['saleId', 'sale_id'],
    ];
    for (const [key, col] of dims) {
      const v = q[key];
      if (typeof v === 'string') {
        conds.push(`jl.${col} = ${p.add(v)}::uuid`);
        filters[key] = v;
      }
    }
    const lineWhere = conds.join(' AND ');
    const [agg] = await this.dbs.query<{ opening: string; total_debit: string; total_credit: string; n: number }>(
      `SELECT coalesce(sum(jl.debit - jl.credit) FILTER (WHERE ${fromP}::date IS NOT NULL AND je.entry_date < ${fromP}::date), 0)::numeric(18,2)::text AS opening,
              coalesce(sum(jl.debit) FILTER (WHERE ${fromP}::date IS NULL OR je.entry_date >= ${fromP}::date), 0)::numeric(18,2)::text AS total_debit,
              coalesce(sum(jl.credit) FILTER (WHERE ${fromP}::date IS NULL OR je.entry_date >= ${fromP}::date), 0)::numeric(18,2)::text AS total_credit,
              (count(*) FILTER (WHERE ${fromP}::date IS NULL OR je.entry_date >= ${fromP}::date))::int AS n
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE ${lineWhere} AND je.entry_date <= ${toP}::date`,
      p.values,
    );
    const opening = agg?.opening ?? ZERO;
    const openP = p.add(opening);
    const limitP = p.add(q.pageSize);
    const offsetP = p.add((q.page - 1) * q.pageSize);
    const lines = await this.dbs.query<{
      entry_id: string;
      entry_no: number;
      entry_date: string;
      source_type: string;
      source_id: string;
      event: string;
      is_reversal: boolean;
      description: string;
      line_no: number;
      memo: string | null;
      debit: string;
      credit: string;
      running: string;
    }>(
      `WITH w AS (
         SELECT je.id AS entry_id, je.entry_no, je.entry_date, je.source_type, je.source_id, je.event,
                (je.reversal_of_id IS NOT NULL) AS is_reversal, je.description, jl.line_no, jl.memo, jl.debit, jl.credit,
                sum(jl.debit - jl.credit) OVER (ORDER BY je.entry_date, je.entry_no, jl.line_no ROWS UNBOUNDED PRECEDING) AS run
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
          WHERE ${lineWhere}
            AND (${fromP}::date IS NULL OR je.entry_date >= ${fromP}::date)
            AND je.entry_date <= ${toP}::date
       )
       SELECT entry_id, entry_no, entry_date, source_type, source_id, event, is_reversal, description, line_no, memo, debit, credit,
              (${openP}::numeric + run)::numeric(18,2)::text AS running
         FROM w
        ORDER BY entry_date, entry_no, line_no
        LIMIT ${limitP} OFFSET ${offsetP}`,
      p.values,
    );
    const totalDebit = agg?.total_debit ?? ZERO;
    const totalCredit = agg?.total_credit ?? ZERO;
    return {
      account: { code: acct.code, nameEn: acct.name_en, nameAr: acct.name_ar, type: acct.type },
      currency: ctx.tenant.baseCurrency,
      from,
      to,
      filters,
      normalSide: DEBIT_NORMAL.has(acct.type) ? 'debit' : 'credit',
      opening,
      totalDebit,
      totalCredit,
      closing: d(opening).plus(totalDebit).minus(totalCredit).toFixed(2),
      rows: lines.map((l) => ({
        entryId: l.entry_id,
        entryNo: l.entry_no,
        entryDate: l.entry_date,
        sourceType: l.source_type,
        sourceId: l.source_id,
        event: l.event,
        isReversal: l.is_reversal,
        description: l.description,
        lineNo: l.line_no,
        memo: l.memo,
        debit: l.debit,
        credit: l.credit,
        runningBalance: l.running,
      })),
      total: agg?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  // ── Financial statements ──────────────────────────────────────────────────────────────────

  /** Per-account movement (debit − credit) for entries dated in [from, to], optionally one branch's entries. */
  private async movements(from: string | null, to: string, branchId: string | null) {
    return this.dbs.query<AccountRow & { net: string }>(
      `SELECT la.code, la.name_en, la.name_ar, la.type, la.is_active,
              coalesce(sum(jl.debit - jl.credit), 0)::numeric(18,2)::text AS net
         FROM ledger_accounts la
         LEFT JOIN (journal_lines jl
                    JOIN journal_entries je ON je.id = jl.entry_id
                     AND ($1::date IS NULL OR je.entry_date >= $1::date)
                     AND je.entry_date <= $2::date
                     AND ($3::uuid IS NULL OR je.branch_id = $3::uuid))
           ON jl.account_code = la.code
        GROUP BY la.code, la.name_en, la.name_ar, la.type, la.is_active
        ORDER BY la.code`,
      [from, to, branchId],
    );
  }

  private static line(r: AccountRow & { net: string }, creditNormal: boolean): StatementLine {
    return { code: r.code, nameEn: r.name_en, nameAr: r.name_ar, amount: creditNormal ? d(r.net).negated().toFixed(2) : fx2(r.net) };
  }

  private static section(lines: StatementLine[]) {
    return { lines, total: sum(lines.map((l) => l.amount)).toFixed(2) };
  }

  /**
   * Profit and loss for a period: revenue (income accounts, credit-positive), cost of vehicles sold
   * (5000), gross profit, operating and other expenses (remaining expense accounts) and net income.
   * Defaults: from = 1 January of the `to` year, to = today.
   */
  async incomeStatement(ctx: TenantContext, q: LedgerPeriodQuery): Promise<IncomeStatement> {
    assertCompanyScope(ctx);
    await this.assertBranch(q.branchId);
    const to = q.to ?? today(ctx);
    const from = q.from ?? `${to.slice(0, 4)}-01-01`;
    if (from > to) throw unprocessable('invalid_range', 'The start date must be on or before the end date', { from, to });
    const rows = await this.movements(from, to, q.branchId ?? null);
    const revenue = LedgerReportsService.section(rows.filter((r) => r.type === 'income').map((r) => LedgerReportsService.line(r, true)));
    const costOfSales = LedgerReportsService.section(rows.filter((r) => r.code === ACCOUNTS.COGS).map((r) => LedgerReportsService.line(r, false)));
    const expenses = LedgerReportsService.section(
      rows.filter((r) => r.type === 'expense' && r.code !== ACCOUNTS.COGS).map((r) => LedgerReportsService.line(r, false)),
    );
    const grossProfit = d(revenue.total).minus(costOfSales.total);
    return {
      currency: ctx.tenant.baseCurrency,
      from,
      to,
      branchId: q.branchId ?? null,
      revenue,
      costOfSales,
      grossProfit: grossProfit.toFixed(2),
      expenses,
      netIncome: grossProfit.minus(expenses.total).toFixed(2),
    };
  }

  /**
   * Balance sheet as of a date. There is no year-end closing entry yet, so equity shows the equity
   * accounts plus all unclosed earnings (income − expenses) up to the date; assets must equal
   * liabilities + equity (check.difference = assets − (liabilities + equity)).
   */
  async balanceSheet(ctx: TenantContext, asOfInput?: string): Promise<BalanceSheet> {
    assertCompanyScope(ctx);
    const asOf = asOfInput ?? today(ctx);
    const rows = await this.movements(null, asOf, null);
    const assets = LedgerReportsService.section(rows.filter((r) => r.type === 'asset').map((r) => LedgerReportsService.line(r, false)));
    const liabilities = LedgerReportsService.section(rows.filter((r) => r.type === 'liability').map((r) => LedgerReportsService.line(r, true)));
    const equityLines = rows.filter((r) => r.type === 'equity').map((r) => LedgerReportsService.line(r, true));
    // Earnings = −Σ(debit − credit) over income and expense accounts (credit-positive).
    const earnings = sum(rows.filter((r) => r.type === 'income' || r.type === 'expense').map((r) => r.net)).negated();
    const equityTotal = sum(equityLines.map((l) => l.amount)).plus(earnings);
    const liabilitiesAndEquity = d(liabilities.total).plus(equityTotal);
    const difference = d(assets.total).minus(liabilitiesAndEquity);
    return {
      currency: ctx.tenant.baseCurrency,
      asOf,
      assets,
      liabilities,
      equity: { lines: equityLines, earnings: earnings.toFixed(2), total: equityTotal.toFixed(2) },
      liabilitiesAndEquity: liabilitiesAndEquity.toFixed(2),
      check: { difference: difference.toFixed(2), isBalanced: difference.isZero() },
    };
  }
}
