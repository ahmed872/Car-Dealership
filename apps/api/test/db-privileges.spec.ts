import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool } from './helpers';

/**
 * The application role's table privileges after ALL migrations. Earlier security migrations each
 * re-ran a blanket GRANT that silently undid the revokes before them; this pins the final state so
 * a future migration cannot do that again unnoticed.
 */
const DENIED: Record<string, string[]> = {
  UPDATE: [
    'audit_logs', 'journal_entries', 'journal_lines', 'audit_chain_heads', 'subscription_plans',
    'vehicle_status_history', 'vehicle_price_history', 'odometer_readings', 'cash_transactions',
    'supplier_payment_allocations', 'lead_stage_history', 'receipt_allocations', 'installments',
    'installment_allocations', 'message_log', 'showroom_inquiries',
  ],
  DELETE: [
    'audit_logs', 'journal_entries', 'journal_lines', 'audit_chain_heads', 'subscription_plans',
    'vehicle_status_history', 'vehicle_price_history', 'odometer_readings', 'cash_transactions',
    'supplier_payment_allocations', 'lead_stage_history', 'receipt_allocations', 'acquisitions',
    'vehicle_costs', 'supplier_payments', 'expenses', 'reservations', 'receipts', 'refunds', 'customers',
    'leads', 'commission_policies', 'sales', 'trade_ins', 'installment_plans', 'installments',
    'installment_allocations', 'commissions', 'sale_documents', 'cash_day_closings', 'vehicle_listings',
    'integration_settings', 'message_log', 'showroom_inquiries',
  ],
  INSERT: ['subscription_plans', 'audit_chain_heads'],
  TRUNCATE: ['audit_logs', 'journal_entries', 'journal_lines', 'cash_transactions', 'customers', 'sales', 'receipts'],
};

describe('database privileges of the application role', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = ownerPool();
  });
  afterAll(() => pool.end());

  it('cannot change or delete append-only records and business documents', async () => {
    const granted: string[] = [];
    for (const [priv, tables] of Object.entries(DENIED)) {
      for (const t of tables) {
        const r = await pool.query<{ ok: boolean }>(`SELECT has_table_privilege('autohub_app', $1, $2) AS ok`, [t, priv]);
        if (r.rows[0]!.ok) granted.push(`${priv} ${t}`);
      }
    }
    expect(granted).toEqual([]);
  });

  it('keeps ordinary read/write access where the application needs it', async () => {
    for (const [t, priv] of [
      ['vehicles', 'UPDATE'],
      ['customers', 'UPDATE'],
      ['sales', 'UPDATE'],
      ['vehicle_listings', 'UPDATE'],
      ['journal_entries', 'INSERT'],
      ['message_log', 'INSERT'],
      ['vehicle_media', 'DELETE'],
    ] as const) {
      const r = await pool.query<{ ok: boolean }>(`SELECT has_table_privilege('autohub_app', $1, $2) AS ok`, [t, priv]);
      expect(r.rows[0]!.ok, `${priv} ${t}`).toBe(true);
    }
  });
});
