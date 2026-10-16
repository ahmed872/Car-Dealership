import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';

export const NUMBER_PREFIXES = {
  vehicle: 'STK',
  acquisition: 'PO',
  reservation: 'RSV',
  sale: 'SO',
  contract: 'CTR',
  invoice: 'INV',
  receipt: 'RCT',
  refund: 'RFD',
  work_order: 'WO',
  expense: 'EXP',
  supplier_payment: 'SPY',
  delivery: 'DLV',
  transfer: 'TRF',
  stock_count: 'CNT',
  credit_note: 'CN',
} as const;
export type NumberKind = keyof typeof NUMBER_PREFIXES;

/**
 * Gapless per-tenant, per-year document numbers (e.g. INV-2026-000042). The counter row is
 * locked until the transaction ends, and a rollback returns the number, so committed documents
 * have no gaps or duplicates. A unique constraint on each table is the final safety net.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly dbs: DbService) {}

  /** @param year defaults to the current year in the tenant's timezone (not UTC). */
  async next(kind: NumberKind, year?: number): Promise<string> {
    year ??= await this.tenantYear();
    const key = `${kind}:${year}`;
    const [row] = await this.dbs.query<{ n: string }>(`SELECT app_next_number($1) AS n`, [key]);
    return `${NUMBER_PREFIXES[kind]}-${year}-${String(row!.n).padStart(6, '0')}`;
  }

  private async tenantYear(): Promise<number> {
    const [row] = await this.dbs.query<{ y: number }>(
      `SELECT extract(year FROM now() AT TIME ZONE coalesce((SELECT settings->>'timezone' FROM tenants WHERE id = app_current_tenant()), 'UTC'))::int AS y`,
    );
    return Number(row!.y);
  }
}
