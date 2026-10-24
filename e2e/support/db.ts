import { Pool } from 'pg';
import { DATABASE_MIGRATION_URL } from './env';

/**
 * Read-only books checks through the owner connection (bypasses RLS), the same invariants as the
 * API suite's assertLedgerIntegrity. Returns the problems found (empty = healthy) so a spec can
 * assert with a readable diff.
 */
export async function ledgerProblems(tenantId: string): Promise<Record<string, unknown[]>> {
  const pool = new Pool({ connectionString: DATABASE_MIGRATION_URL, max: 1 });
  try {
    const q = async (sql: string) => (await pool.query(sql, [tenantId])).rows;
    return {
      trialBalance: await q(
        `SELECT sum(debit)::text AS dr, sum(credit)::text AS cr FROM journal_lines
          WHERE tenant_id = $1 HAVING coalesce(sum(debit), 0) <> coalesce(sum(credit), 0)`,
      ),
      unbalancedEntries: await q(
        `SELECT entry_id FROM journal_lines WHERE tenant_id = $1 GROUP BY entry_id HAVING sum(debit) <> sum(credit)`,
      ),
      cashBookVsGl: await q(
        `WITH book AS (
            SELECT cash_account_id AS id, sum(CASE WHEN direction = 'in' THEN amount_base ELSE -amount_base END) AS b
              FROM cash_transactions WHERE tenant_id = $1 GROUP BY 1),
          gl AS (
            SELECT cash_account_id AS id, sum(debit - credit) AS b
              FROM journal_lines WHERE tenant_id = $1 AND account_code = '1100' GROUP BY 1)
         SELECT coalesce(book.id, gl.id) AS id, coalesce(book.b, 0)::text AS book, coalesce(gl.b, 0)::text AS gl
           FROM book FULL JOIN gl ON gl.id = book.id
          WHERE coalesce(book.b, 0) <> coalesce(gl.b, 0)`,
      ),
      cashRowsWithoutEntry: await q(
        `SELECT ct.id FROM cash_transactions ct LEFT JOIN journal_entries je ON je.id = ct.journal_entry_id
          WHERE ct.tenant_id = $1 AND je.id IS NULL`,
      ),
    };
  } finally {
    await pool.end();
  }
}

/** GL balance (debit − credit) of one account, optionally for one cash account / customer / sale. */
export async function glBalance(
  tenantId: string,
  account: string,
  dim?: { col: 'cash_account_id' | 'customer_id' | 'sale_id' | 'vehicle_id'; id: string },
): Promise<string> {
  const pool = new Pool({ connectionString: DATABASE_MIGRATION_URL, max: 1 });
  try {
    const r = await pool.query(
      `SELECT coalesce(sum(debit - credit), 0)::numeric(18,2)::text AS b FROM journal_lines
        WHERE tenant_id = $1 AND account_code = $2 ${dim ? `AND ${dim.col} = $3` : ''}`,
      dim ? [tenantId, account, dim.id] : [tenantId, account],
    );
    return r.rows[0].b as string;
  } finally {
    await pool.end();
  }
}
