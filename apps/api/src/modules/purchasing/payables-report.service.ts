import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AgingBuckets,
  d,
  OpenPayable,
  PayablesAgingRow,
  PayablesOpenQuery,
  PayablesSummary,
  SupplierFinancialSummary,
  SupplierStatement,
  SupplierStatementQuery,
  SupplierStatementRow,
  sum,
  todayInZone,
} from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { AppError, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { ACCOUNTS } from '../ledger/chart';

/** Positional parameter collector for raw SQL ($1, $2, …). */
class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/**
 * Which documents count and how:
 *  - current: what is payable right now (status approved/posted; payments not voided). This matches
 *    PayablesService.describe(), which guards new payments, so the open list never offers more
 *    than a payment may settle.
 *  - asOf: the position on a past date, rebuilt from event dates so it reconciles with GL 2000
 *    filtered by entry_date ≤ asOf. A document counts once its posting date has passed and until
 *    its reversal entry is dated; a payment counts from paid_at until its void reversal is dated.
 */
type Mode = { kind: 'current' } | { kind: 'asOf'; asOf: string };

const STATEMENT_MAX_ROWS = 5000;

const zero = (v: string | null | undefined) => v ?? '0.00';

@Injectable()
export class PayablesReportService {
  constructor(private readonly dbs: DbService) {}

  /**
   * CTEs `docs` (one row per payable document) and `paid` (allocations per document), plus `rows`
   * joining them with total/paid/outstanding. Trade-in costs are excluded: they credit customer
   * advances (2100), not supplier payables, so they are not supplier documents. Purchase-price cost
   * rows are excluded because the acquisition is the payable document for them.
   */
  private rowsCte(mode: Mode, p: Params, filters: { branchIds: string[] | null; supplierId?: string | 'none' }): string {
    let docs: string;
    let paid: string;
    if (mode.kind === 'current') {
      docs = `
        SELECT 'acquisition'::text AS target_type, a.id AS target_id, a.supplier_id, a.branch_id,
               a.number AS number, a.number AS label, NULL::text AS description,
               a.purchase_date AS doc_date, a.due_date, a.vehicle_id, a.purchase_price_base AS total_base
          FROM acquisitions a
         WHERE a.status = 'approved'
        UNION ALL
        SELECT 'vehicle_cost', c.id, c.supplier_id, v.branch_id,
               NULL, v.stock_number || ' · ' || c.description, c.description,
               c.cost_date, NULL::date, c.vehicle_id, c.amount_base
          FROM vehicle_costs c
          JOIN vehicles v ON v.id = c.vehicle_id
         WHERE c.status = 'posted' AND c.source_type NOT IN ('acquisition', 'trade_in')
        UNION ALL
        SELECT 'expense', e.id, e.supplier_id, e.branch_id,
               e.number, e.number, e.description,
               e.expense_date, NULL::date, NULL::uuid, e.amount_base
          FROM expenses e
         WHERE e.status = 'posted'`;
      paid = `
        SELECT spa.target_type, spa.target_id, sum(spa.amount_base) AS paid_base, max(sp.paid_at) AS last_paid_at
          FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
         WHERE sp.status = 'posted'
         GROUP BY spa.target_type, spa.target_id`;
    } else {
      const asOf = p.add(mode.asOf);
      // "Reversed on or before asOf", looked up by the reversal entry's own business date.
      const reversedBy = (sourceType: string, idCol: string) =>
        `EXISTS (SELECT 1 FROM journal_entries r WHERE r.source_type = '${sourceType}' AND r.source_id = ${idCol}
                   AND r.reversal_of_id IS NOT NULL AND r.entry_date <= ${asOf}::date)`;
      docs = `
        SELECT 'acquisition'::text AS target_type, a.id AS target_id, a.supplier_id, a.branch_id,
               a.number AS number, a.number AS label, NULL::text AS description,
               a.purchase_date AS doc_date, a.due_date, a.vehicle_id,
               CASE WHEN pc.cost_date <= ${asOf}::date AND NOT ${reversedBy('vehicle_cost', 'pc.id')}
                    THEN a.purchase_price_base ELSE 0 END AS total_base
          FROM acquisitions a
          JOIN vehicle_costs pc ON pc.source_type = 'acquisition' AND pc.source_id = a.id AND pc.status IN ('posted', 'reversed')
         WHERE a.status IN ('approved', 'cancelled')
        UNION ALL
        SELECT 'vehicle_cost', c.id, c.supplier_id, v.branch_id,
               NULL, v.stock_number || ' · ' || c.description, c.description,
               c.cost_date, NULL::date, c.vehicle_id,
               CASE WHEN c.cost_date <= ${asOf}::date AND NOT ${reversedBy('vehicle_cost', 'c.id')}
                    THEN c.amount_base ELSE 0 END
          FROM vehicle_costs c
          JOIN vehicles v ON v.id = c.vehicle_id
         WHERE c.status IN ('posted', 'reversed') AND c.source_type NOT IN ('acquisition', 'trade_in')
        UNION ALL
        SELECT 'expense', e.id, e.supplier_id, e.branch_id,
               e.number, e.number, e.description,
               e.expense_date, NULL::date, NULL::uuid,
               CASE WHEN e.expense_date <= ${asOf}::date AND NOT ${reversedBy('expense', 'e.id')}
                    THEN e.amount_base ELSE 0 END
          FROM expenses e
         WHERE e.status IN ('posted', 'reversed')`;
      paid = `
        SELECT spa.target_type, spa.target_id, sum(spa.amount_base) AS paid_base, max(sp.paid_at) AS last_paid_at
          FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
         WHERE sp.paid_at <= ${asOf}::date AND NOT ${reversedBy('supplier_payment', 'sp.id')}
         GROUP BY spa.target_type, spa.target_id`;
    }
    const conds: string[] = [];
    if (filters.branchIds) conds.push(`d.branch_id = ANY(${p.add(filters.branchIds)}::uuid[])`);
    if (filters.supplierId === 'none') conds.push('d.supplier_id IS NULL');
    else if (filters.supplierId) conds.push(`d.supplier_id = ${p.add(filters.supplierId)}::uuid`);
    return `
      docs AS (${docs}),
      paid AS (${paid}),
      rows AS (
        SELECT d.*, coalesce(pd.paid_base, 0) AS paid_base, d.total_base - coalesce(pd.paid_base, 0) AS outstanding_base,
               pd.last_paid_at
          FROM docs d
          LEFT JOIN paid pd ON pd.target_type = d.target_type AND pd.target_id = d.target_id
         ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      )`;
  }

  private branchIds(ctx: TenantContext): string[] | null {
    return ctx.allBranches ? null : ctx.branchIds;
  }

  /** Supplier 360 totals over the documents the caller can see (branch scope). */
  async supplierSummary(ctx: TenantContext, supplierId: string): Promise<SupplierFinancialSummary> {
    const p = new Params();
    const cte = this.rowsCte({ kind: 'current' }, p, { branchIds: this.branchIds(ctx), supplierId });
    const [r] = await this.dbs.query<{ outstanding: string; purchased: string; paid: string; last_paid: string | null; open_docs: number }>(
      `WITH ${cte}
       SELECT coalesce(sum(outstanding_base), 0)::numeric(18,2)::text AS outstanding,
              coalesce(sum(total_base), 0)::numeric(18,2)::text AS purchased,
              coalesce(sum(paid_base), 0)::numeric(18,2)::text AS paid,
              max(last_paid_at) AS last_paid,
              (count(*) FILTER (WHERE outstanding_base > 0))::int AS open_docs
         FROM rows`,
      p.values,
    );
    return {
      currency: ctx.tenant.baseCurrency,
      outstandingBase: zero(r?.outstanding),
      totalPurchasedBase: zero(r?.purchased),
      totalPaidBase: zero(r?.paid),
      lastPaymentDate: r?.last_paid ?? null,
      openDocuments: r?.open_docs ?? 0,
    };
  }

  /** Documents with something left to pay, oldest due first (for the payment form). */
  async open(ctx: TenantContext, q: PayablesOpenQuery): Promise<{ currency: string; items: OpenPayable[]; totals: { totalBase: string; paidBase: string; outstandingBase: string } }> {
    const p = new Params();
    const cte = this.rowsCte({ kind: 'current' }, p, { branchIds: this.branchIds(ctx), supplierId: q.supplierId });
    const typeCond = q.targetType ? `AND r.target_type = ${p.add(q.targetType)}` : '';
    const rows = await this.dbs.query<{
      target_type: OpenPayable['targetType'];
      target_id: string;
      supplier_id: string | null;
      supplier_name: string | null;
      branch_id: string;
      number: string | null;
      label: string;
      description: string | null;
      doc_date: string;
      due_date: string | null;
      vehicle_id: string | null;
      stock_number: string | null;
      total_base: string;
      paid_base: string;
      outstanding_base: string;
    }>(
      `WITH ${cte}
       SELECT r.target_type, r.target_id, r.supplier_id, s.name AS supplier_name, r.branch_id, r.number, r.label,
              r.description, r.doc_date, r.due_date, r.vehicle_id, v.stock_number,
              r.total_base::numeric(18,2)::text AS total_base,
              r.paid_base::numeric(18,2)::text AS paid_base,
              r.outstanding_base::numeric(18,2)::text AS outstanding_base
         FROM rows r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
        WHERE r.outstanding_base > 0 ${typeCond}
        ORDER BY coalesce(r.due_date, r.doc_date), r.doc_date, r.label, r.target_id`,
      p.values,
    );
    const items: OpenPayable[] = rows.map((r) => ({
      targetType: r.target_type,
      targetId: r.target_id,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      branchId: r.branch_id,
      number: r.number,
      label: r.label,
      description: r.description,
      docDate: r.doc_date,
      dueDate: r.due_date,
      vehicleId: r.vehicle_id,
      vehicleStockNumber: r.stock_number,
      totalBase: r.total_base,
      paidBase: r.paid_base,
      outstandingBase: r.outstanding_base,
    }));
    return {
      currency: ctx.tenant.baseCurrency,
      items,
      totals: {
        totalBase: sum(items.map((i) => i.totalBase)).toFixed(2),
        paidBase: sum(items.map((i) => i.paidBase)).toFixed(2),
        outstandingBase: sum(items.map((i) => i.outstandingBase)).toFixed(2),
      },
    };
  }

  /**
   * Accounts-payable aging as of a date, per supplier plus a "direct purchases" bucket. Age is
   * counted from the acquisition due date, otherwise from the document date. For company-wide
   * callers the sub-ledger is reconciled with the GL 2000 control account.
   */
  async summary(ctx: TenantContext, asOfInput?: string): Promise<PayablesSummary> {
    const asOf = asOfInput ?? todayInZone(ctx.tenant.settings.timezone);
    const p = new Params();
    const cte = this.rowsCte({ kind: 'asOf', asOf }, p, { branchIds: this.branchIds(ctx) });
    const asOfP = p.add(asOf);
    const bucket = (cond: string) => `coalesce(sum(a.amt) FILTER (WHERE ${cond}), 0)::numeric(18,2)::text`;
    const rows = await this.dbs.query<{
      supplier_id: string | null;
      supplier_name: string | null;
      documents: number;
      outstanding: string;
      not_due: string;
      d1_30: string;
      d31_60: string;
      d61_90: string;
      d90plus: string;
    }>(
      `WITH ${cte},
       aged AS (
         SELECT r.supplier_id, r.outstanding_base AS amt, (${asOfP}::date - coalesce(r.due_date, r.doc_date)) AS age
           FROM rows r
          WHERE r.outstanding_base <> 0
       )
       SELECT a.supplier_id, s.name AS supplier_name, count(*)::int AS documents,
              sum(a.amt)::numeric(18,2)::text AS outstanding,
              ${bucket('a.age <= 0')} AS not_due,
              ${bucket('a.age BETWEEN 1 AND 30')} AS d1_30,
              ${bucket('a.age BETWEEN 31 AND 60')} AS d31_60,
              ${bucket('a.age BETWEEN 61 AND 90')} AS d61_90,
              ${bucket('a.age > 90')} AS d90plus
         FROM aged a
         LEFT JOIN suppliers s ON s.id = a.supplier_id
        GROUP BY a.supplier_id, s.name
        ORDER BY (a.supplier_id IS NULL), s.name, a.supplier_id`,
      p.values,
    );
    const out: PayablesAgingRow[] = rows.map((r) => ({
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      isDirect: r.supplier_id === null,
      documents: r.documents,
      outstandingBase: r.outstanding,
      buckets: { notDue: r.not_due, d1_30: r.d1_30, d31_60: r.d31_60, d61_90: r.d61_90, d90plus: r.d90plus },
    }));
    const total = (pick: (r: PayablesAgingRow) => string) => sum(out.map(pick)).toFixed(2);
    const totals = {
      documents: out.reduce((n, r) => n + r.documents, 0),
      outstandingBase: total((r) => r.outstandingBase),
      buckets: {
        notDue: total((r) => r.buckets.notDue),
        d1_30: total((r) => r.buckets.d1_30),
        d31_60: total((r) => r.buckets.d31_60),
        d61_90: total((r) => r.buckets.d61_90),
        d90plus: total((r) => r.buckets.d90plus),
      } satisfies AgingBuckets,
    };
    return {
      asOf,
      currency: ctx.tenant.baseCurrency,
      scope: ctx.allBranches ? 'all' : 'branches',
      rows: out,
      totals,
      // GL lines are not reliably attributable to one branch (payments from company-level accounts
      // carry no branch), so the control-account check is only meaningful company-wide.
      reconciliation: ctx.allBranches ? await this.reconcile(asOf, out, totals.outstandingBase) : null,
    };
  }

  private async reconcile(asOf: string, rows: PayablesAgingRow[], subledgerTotal: string): Promise<NonNullable<PayablesSummary['reconciliation']>> {
    const gl = await this.dbs.query<{ supplier_id: string | null; supplier_name: string | null; bal: string }>(
      `SELECT jl.supplier_id, s.name AS supplier_name, sum(jl.credit - jl.debit)::numeric(18,2)::text AS bal
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         LEFT JOIN suppliers s ON s.id = jl.supplier_id
        WHERE jl.account_code = $1 AND je.entry_date <= $2::date
        GROUP BY jl.supplier_id, s.name`,
      [ACCOUNTS.PAYABLES, asOf],
    );
    const glTotal = sum(gl.map((g) => g.bal)).toFixed(2);
    const key = (id: string | null) => id ?? 'direct';
    const bySupplier = new Map<string, { supplierId: string | null; supplierName: string | null; subledgerBase: string; glBase: string }>();
    for (const r of rows) bySupplier.set(key(r.supplierId), { supplierId: r.supplierId, supplierName: r.supplierName, subledgerBase: r.outstandingBase, glBase: '0.00' });
    for (const g of gl) {
      const cur = bySupplier.get(key(g.supplier_id));
      if (cur) cur.glBase = g.bal;
      else bySupplier.set(key(g.supplier_id), { supplierId: g.supplier_id, supplierName: g.supplier_name, subledgerBase: '0.00', glBase: g.bal });
    }
    const mismatches = [...bySupplier.values()]
      .map((m) => ({ ...m, difference: d(m.glBase).minus(m.subledgerBase).toFixed(2) }))
      .filter((m) => !d(m.difference).isZero());
    return {
      subledgerTotal,
      glPayablesBalance: glTotal,
      difference: d(glTotal).minus(subledgerTotal).toFixed(2),
      mismatches,
    };
  }

  /**
   * Supplier statement from the GL: account 2000 lines carrying this supplier, oldest first.
   * Balances are presented as the amount owed to the supplier (credit − debit, "payable" side).
   */
  async statement(ctx: TenantContext, supplierId: string, q: SupplierStatementQuery): Promise<SupplierStatement> {
    if (!ctx.allBranches) {
      // Payment lines from company-level accounts carry no branch, so a branch-filtered statement
      // would show balances that do not exist. The statement is a company-level document.
      throw new AppError('all_branches_required', HttpStatus.FORBIDDEN, 'The supplier statement covers all branches; it requires access to all branches');
    }
    const [s] = await this.dbs.query<{ id: string; name: string }>(`SELECT id, name FROM suppliers WHERE id = $1`, [supplierId]);
    if (!s) throw notFound('Supplier');
    const from = q.from ?? null;
    const to = q.to ?? null;
    let opening = '0.00';
    if (from) {
      const [o] = await this.dbs.query<{ bal: string }>(
        `SELECT coalesce(sum(jl.credit - jl.debit), 0)::numeric(18,2)::text AS bal
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.account_code = $1 AND jl.supplier_id = $2 AND je.entry_date < $3::date`,
        [ACCOUNTS.PAYABLES, supplierId, from],
      );
      opening = zero(o?.bal);
    }
    const lines = await this.dbs.query<{
      entry_date: string;
      entry_id: string;
      entry_no: number;
      event: string;
      is_reversal: boolean;
      source_type: string;
      source_id: string;
      description: string;
      debit: string;
      credit: string;
      payment_number: string | null;
      expense_number: string | null;
      cost_id: string | null;
      cost_source_type: string | null;
      cost_description: string | null;
      acquisition_id: string | null;
      acquisition_number: string | null;
      stock_number: string | null;
    }>(
      `SELECT je.entry_date, je.id AS entry_id, je.entry_no, je.event, (je.reversal_of_id IS NOT NULL) AS is_reversal,
              je.source_type, je.source_id, je.description, jl.debit, jl.credit,
              sp.number AS payment_number, ex.number AS expense_number,
              vc.id AS cost_id, vc.source_type AS cost_source_type, vc.description AS cost_description,
              acq.id AS acquisition_id, acq.number AS acquisition_number, vv.stock_number
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         LEFT JOIN supplier_payments sp ON je.source_type = 'supplier_payment' AND sp.id = je.source_id
         LEFT JOIN expenses ex ON je.source_type = 'expense' AND ex.id = je.source_id
         LEFT JOIN vehicle_costs vc ON je.source_type = 'vehicle_cost' AND vc.id = je.source_id
         LEFT JOIN acquisitions acq ON vc.source_type = 'acquisition' AND acq.id = vc.source_id
         LEFT JOIN vehicles vv ON vv.id = vc.vehicle_id
        WHERE jl.account_code = $1 AND jl.supplier_id = $2
          AND ($3::date IS NULL OR je.entry_date >= $3::date)
          AND ($4::date IS NULL OR je.entry_date <= $4::date)
        ORDER BY je.entry_date, je.entry_no, jl.line_no
        LIMIT ${STATEMENT_MAX_ROWS + 1}`,
      [ACCOUNTS.PAYABLES, supplierId, from, to],
    );
    if (lines.length > STATEMENT_MAX_ROWS) {
      throw unprocessable('statement_range_too_large', `The statement has more than ${STATEMENT_MAX_ROWS} lines; choose a shorter period`, { maxRows: STATEMENT_MAX_ROWS });
    }
    let running = d(opening);
    const rows: SupplierStatementRow[] = lines.map((l) => {
      running = running.plus(l.credit).minus(l.debit);
      let documentType: SupplierStatementRow['documentType'] = null;
      let documentId: string | null = null;
      let documentNumber: string | null = null;
      let label = l.description;
      if (l.source_type === 'supplier_payment' && l.payment_number) {
        documentType = 'supplier_payment';
        documentId = l.source_id;
        documentNumber = l.payment_number;
        label = l.payment_number;
      } else if (l.source_type === 'expense' && l.expense_number) {
        documentType = 'expense';
        documentId = l.source_id;
        documentNumber = l.expense_number;
        label = l.expense_number;
      } else if (l.source_type === 'vehicle_cost' && l.cost_id) {
        if (l.cost_source_type === 'acquisition' && l.acquisition_id) {
          documentType = 'acquisition';
          documentId = l.acquisition_id;
          documentNumber = l.acquisition_number;
          label = `${l.acquisition_number} · ${l.stock_number}`;
        } else {
          documentType = 'vehicle_cost';
          documentId = l.cost_id;
          documentNumber = l.stock_number;
          label = `${l.stock_number} · ${l.cost_description}`;
        }
      }
      return {
        date: l.entry_date,
        entryId: l.entry_id,
        entryNo: l.entry_no,
        event: l.event,
        isReversal: l.is_reversal,
        sourceType: l.source_type,
        sourceId: l.source_id,
        documentType,
        documentId,
        documentNumber,
        vehicleStockNumber: l.stock_number,
        label,
        description: l.description,
        debit: l.debit,
        credit: l.credit,
        runningBalance: running.toFixed(2),
      };
    });
    return {
      supplierId: s.id,
      supplierName: s.name,
      currency: ctx.tenant.baseCurrency,
      account: ACCOUNTS.PAYABLES,
      balanceSide: 'payable',
      from,
      to,
      openingBalance: opening,
      totalDebit: sum(lines.map((l) => l.debit)).toFixed(2),
      totalCredit: sum(lines.map((l) => l.credit)).toFixed(2),
      closingBalance: running.toFixed(2),
      rows,
    };
  }
}
