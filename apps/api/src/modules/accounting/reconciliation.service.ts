import { Injectable } from '@nestjs/common';
import { d, Reconciliation, ReconciliationMismatch, ReconciliationSection } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { DbService } from '../../db/db.service';
import { ACCOUNTS } from '../ledger/chart';
import { assertCompanyScope, today } from './accounting.util';

const MAX_MISMATCHES = 500;

/** "Dated on or before $1" as 1/0 (NULL dates count as 0). */
const on = (col: string) => `coalesce((${col} <= $1::date)::int, 0)`;
/** Date of the reversal entry of a source document (NULL when not reversed). */
const reversalDate = (sourceType: string, idCol: string) =>
  `(SELECT min(r.entry_date) FROM journal_entries r WHERE r.source_type = '${sourceType}' AND r.source_id = ${idCol} AND r.reversal_of_id IS NOT NULL)`;

interface SectionRow extends Record<string, unknown> {
  sub_total: string;
  gl_total: string;
  mismatch_count: number;
  mismatches: Array<Record<string, unknown> & { key: string | null; label: string; sub: string; gl: string; diff: string }>;
}

/**
 * Sub-ledger ↔ GL control-account reconciliation as of a business date (FINANCIAL_POLICIES §7).
 * Each section builds a CTE `x(key, label, sub, gl, …)` with one row per sub-ledger item; the
 * section reports both totals and every item whose difference is not zero.
 *
 * As-of rules mirror how each event is dated in the GL: a document counts from its own date
 * until the date of its reversal entry (so a void dated before a post-dated payment nets out
 * exactly as it does in the GL).
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly dbs: DbService) {}

  private async section(name: ReconciliationSection['name'], account: string, cte: string, params: unknown[], extra: string): Promise<ReconciliationSection> {
    const [r] = await this.dbs.query<SectionRow>(
      `WITH ${cte}
       SELECT coalesce(sum(x.sub), 0)::numeric(18,2)::text AS sub_total,
              coalesce(sum(x.gl), 0)::numeric(18,2)::text AS gl_total,
              (count(*) FILTER (WHERE x.sub <> x.gl))::int AS mismatch_count,
              coalesce(
                json_agg(json_build_object(
                  'key', x.key, 'label', x.label,
                  'sub', x.sub::numeric(18,2)::text, 'gl', x.gl::numeric(18,2)::text,
                  'diff', (x.gl - x.sub)::numeric(18,2)::text${extra ? `, ${extra}` : ''}
                ) ORDER BY abs(x.gl - x.sub) DESC, x.label) FILTER (WHERE x.sub <> x.gl),
                '[]'::json) AS mismatches
         FROM x`,
      params,
    );
    const subTotal = r?.sub_total ?? '0.00';
    const glTotal = r?.gl_total ?? '0.00';
    const mismatches: ReconciliationMismatch[] = (r?.mismatches ?? []).slice(0, MAX_MISMATCHES).map(({ key, label, sub, gl, diff, ...rest }) => ({
      key,
      label,
      subledgerBase: sub,
      glBase: gl,
      difference: diff,
      ...rest,
    }));
    const difference = d(glTotal).minus(subTotal).toFixed(2);
    const mismatchCount = r?.mismatch_count ?? 0;
    return { name, account, subledgerTotal: subTotal, glTotal, difference, mismatchCount, mismatches, ok: mismatchCount === 0 && d(difference).isZero() };
  }

  /** (a) Cash book (signed base amounts) vs GL 1100 per cash account. */
  private cash(asOf: string) {
    const cte = `
      book AS (
        SELECT ct.cash_account_id AS id, sum(CASE WHEN ct.direction = 'in' THEN ct.amount_base ELSE -ct.amount_base END) AS bal
          FROM cash_transactions ct
         WHERE ct.business_date <= $1::date
         GROUP BY ct.cash_account_id
      ),
      gl AS (
        SELECT jl.cash_account_id AS id, sum(jl.debit - jl.credit) AS bal
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_code = '${ACCOUNTS.CASH}' AND je.entry_date <= $1::date
         GROUP BY jl.cash_account_id
      ),
      x AS (
        SELECT coalesce(b.id, g.id) AS key,
               coalesce(ca.name, 'GL lines without a cash account') AS label,
               ca.currency, ca.type,
               coalesce(b.bal, 0) AS sub, coalesce(g.bal, 0) AS gl
          FROM book b
          FULL JOIN gl g ON g.id = b.id
          LEFT JOIN cash_accounts ca ON ca.id = coalesce(b.id, g.id)
      )`;
    return this.section('cash', ACCOUNTS.CASH, cte, [asOf], `'currency', x.currency, 'accountType', x.type`);
  }

  /**
   * (b) Inventory: per vehicle, posted pre-sale costs (not post_sale; reversal entries dated by
   * asOf netted out) vs GL 1300. A vehicle removed from stock (write-off) or whose sale was
   * recognised (cost_locked_at) on or before asOf must carry nothing on 1300.
   */
  private inventory(asOf: string, timezone: string) {
    const cte = `
      veh AS (
        SELECT v.id, v.stock_number, v.status,
               -- Removal date: the write-off entry, else the status change (in the tenant's zone).
               (v.status = 'removed' AND coalesce(coalesce(
                  (SELECT min(w.entry_date) FROM journal_entries w WHERE w.source_type = 'vehicle' AND w.source_id = v.id AND w.event = 'vehicle.written_off'),
                  (SELECT min((h.created_at AT TIME ZONE $2)::date) FROM vehicle_status_history h WHERE h.vehicle_id = v.id AND h.to_status = 'removed')
                ) <= $1::date, true)) AS removed,
               coalesce((v.cost_locked_at AT TIME ZONE $2)::date <= $1::date, false) AS locked
          FROM vehicles v
      ),
      costs AS (
        SELECT c.vehicle_id, sum(c.amount_base * (${on('c.cost_date')} - ${on(reversalDate('vehicle_cost', 'c.id'))})) AS amt
          FROM vehicle_costs c
         WHERE c.status IN ('posted', 'reversed') AND NOT c.post_sale
         GROUP BY c.vehicle_id
      ),
      gl AS (
        SELECT jl.vehicle_id, sum(jl.debit - jl.credit) AS bal
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_code = '${ACCOUNTS.INVENTORY}' AND je.entry_date <= $1::date
         GROUP BY jl.vehicle_id
      ),
      x AS (
        SELECT coalesce(veh.id, g.vehicle_id) AS key,
               coalesce(veh.stock_number, 'GL lines without a vehicle') AS label,
               veh.status,
               CASE WHEN veh.id IS NULL OR veh.removed OR veh.locked THEN 0 ELSE coalesce(c.amt, 0) END AS sub,
               coalesce(g.bal, 0) AS gl
          FROM veh
          LEFT JOIN costs c ON c.vehicle_id = veh.id
          FULL JOIN gl g ON g.vehicle_id = veh.id
      )`;
    return this.section('inventory', ACCOUNTS.INVENTORY, cte, [asOf, timezone], `'vehicleStatus', x.status`);
  }

  /**
   * (c) Payables: outstanding of payable documents (approved acquisitions via their purchase-cost
   * posting, posted non-acquisition / non-trade-in vehicle costs, posted expenses) minus
   * allocations of supplier payments, vs the GL 2000 credit balance, per supplier (NULL = direct
   * purchases without a supplier).
   */
  private payables(asOf: string) {
    const cte = `
      docs AS (
        SELECT a.supplier_id, a.purchase_price_base * (${on('pc.cost_date')} - ${on(reversalDate('vehicle_cost', 'pc.id'))}) AS amt
          FROM acquisitions a
          JOIN vehicle_costs pc ON pc.source_type = 'acquisition' AND pc.source_id = a.id AND pc.status IN ('posted', 'reversed')
        UNION ALL
        SELECT c.supplier_id, c.amount_base * (${on('c.cost_date')} - ${on(reversalDate('vehicle_cost', 'c.id'))})
          FROM vehicle_costs c
         WHERE c.status IN ('posted', 'reversed') AND c.source_type NOT IN ('acquisition', 'trade_in')
        UNION ALL
        SELECT e.supplier_id, e.amount_base * (${on('e.expense_date')} - ${on(reversalDate('expense', 'e.id'))})
          FROM expenses e
         WHERE e.status IN ('posted', 'reversed')
      ),
      paid AS (
        SELECT sp.supplier_id, spa.amount_base * (${on('sp.paid_at')} - ${on(reversalDate('supplier_payment', 'sp.id'))}) AS amt
          FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
      ),
      sub AS (
        SELECT supplier_id, sum(amt) AS bal
          FROM (SELECT supplier_id, amt FROM docs UNION ALL SELECT supplier_id, -amt FROM paid) m
         GROUP BY supplier_id
      ),
      gl AS (
        SELECT jl.supplier_id, sum(jl.credit - jl.debit) AS bal
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
         WHERE jl.account_code = '${ACCOUNTS.PAYABLES}' AND je.entry_date <= $1::date
         GROUP BY jl.supplier_id
      ),
      keys AS (SELECT supplier_id FROM sub UNION SELECT supplier_id FROM gl),
      x AS (
        SELECT k.supplier_id AS key,
               CASE WHEN k.supplier_id IS NULL THEN 'Direct purchases (no supplier)' ELSE coalesce(s.name, k.supplier_id::text) END AS label,
               coalesce(sb.bal, 0) AS sub, coalesce(g.bal, 0) AS gl
          FROM keys k
          LEFT JOIN sub sb ON sb.supplier_id IS NOT DISTINCT FROM k.supplier_id
          LEFT JOIN gl g ON g.supplier_id IS NOT DISTINCT FROM k.supplier_id
          LEFT JOIN suppliers s ON s.id = k.supplier_id
      )`;
    return this.section('payables', ACCOUNTS.PAYABLES, cte, [asOf], '');
  }

  async reconcile(ctx: TenantContext, asOfInput?: string): Promise<Reconciliation> {
    assertCompanyScope(ctx);
    const asOf = asOfInput ?? today(ctx);
    const sections = [await this.cash(asOf), await this.inventory(asOf, ctx.tenant.settings.timezone), await this.payables(asOf)];
    const [tb] = await this.dbs.query<{ dr: string; cr: string }>(
      `SELECT coalesce(sum(jl.debit), 0)::numeric(18,2)::text AS dr, coalesce(sum(jl.credit), 0)::numeric(18,2)::text AS cr
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.entry_date <= $1::date`,
      [asOf],
    );
    const tbDiff = d(tb?.dr ?? 0).minus(tb?.cr ?? 0);
    const trialBalance = { totalDebit: tb?.dr ?? '0.00', totalCredit: tb?.cr ?? '0.00', difference: tbDiff.toFixed(2), isBalanced: tbDiff.isZero() };
    return {
      asOf,
      currency: ctx.tenant.baseCurrency,
      sections,
      trialBalance,
      ok: trialBalance.isBalanced && sections.every((s) => s.ok),
    };
  }
}
