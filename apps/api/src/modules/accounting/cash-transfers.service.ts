import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { CashTransfer, CashTransferListQuery, CurrencyCode, d, money, zCashTransfer } from '@autohub/shared';
import { assertPermission, TenantContext } from '../../common/context';
import { forbidden, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { cashAccounts } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { CashService } from '../finance/cash.service';
import { resolveFx } from '../finance/fx';
import { iso, Params, scopeIds, today } from './accounting.util';

export type CashTransferInput = z.infer<typeof zCashTransfer>;

interface TransferRow extends Record<string, unknown> {
  transfer_id: string;
  business_date: string;
  amount_base: string;
  to_amount_base: string;
  reference: string | null;
  description: string;
  journal_entry_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  from_id: string;
  from_name: string;
  from_type: 'cashbox' | 'bank';
  from_currency: string;
  from_branch_id: string | null;
  from_amount: string;
  from_rate: string;
  to_id: string;
  to_name: string;
  to_type: 'cashbox' | 'bank';
  to_currency: string;
  to_branch_id: string | null;
  to_amount: string;
  to_rate: string;
  rev_date: string | null;
  rev_description: string | null;
  rev_journal_entry_id: string | null;
  rev_created_at: Date | null;
}

/**
 * Transfers between the company's own cash boxes and bank accounts. Money moves only through
 * CashService.transfer / reverseTransfer (one GL entry + two cash-book rows each). A transfer is
 * identified by the source id shared by its two cash-book legs.
 */
@Injectable()
export class CashTransfersService {
  constructor(
    private readonly dbs: DbService,
    private readonly cash: CashService,
    private readonly audit: AuditService,
  ) {}

  async create(ctx: TenantContext, input: CashTransferInput): Promise<CashTransfer> {
    assertPermission(ctx, 'cash.transfer');
    const accts = await this.dbs.db
      .select({ id: cashAccounts.id, name: cashAccounts.name, currency: cashAccounts.currency })
      .from(cashAccounts)
      .where(inArray(cashAccounts.id, [input.fromAccountId, input.toAccountId]));
    const from = accts.find((a) => a.id === input.fromAccountId);
    const to = accts.find((a) => a.id === input.toAccountId);
    // Missing accounts (or another tenant's, hidden by RLS) and branch checks are reported by the
    // locking inside CashService.transfer; only validate the currency rules here.
    if (from && to && from.id !== to.id) this.assertAmounts(ctx, input, from.currency as CurrencyCode, to.currency as CurrencyCode);

    const transferId = randomUUID();
    const notes = input.notes?.trim();
    const description = `Transfer ${from?.name ?? input.fromAccountId} → ${to?.name ?? input.toAccountId}${notes ? `: ${notes}` : ''}`;
    const result = await this.cash.transfer(ctx, {
      transferId,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amount: input.amount,
      amountTo: input.amountTo ?? null,
      exchangeRate: input.exchangeRate ?? null,
      businessDate: input.date,
      reference: input.reference ?? null,
      description,
    });
    await this.audit.record({
      action: 'cash_transfer.posted',
      entityType: 'cash_transfer',
      entityId: transferId,
      summary: `${from!.name} → ${to!.name}: ${result.amount} ${from!.currency} / ${result.amountTo} ${to!.currency}`,
      after: { transferId, fromAccountId: from!.id, toAccountId: to!.id, ...result, businessDate: input.date, reference: input.reference ?? null },
    });
    return this.get(ctx, transferId);
  }

  /**
   * Rejects inputs CashService.transfer would otherwise silently ignore: an `amountTo` that does
   * not match what the destination will actually receive, or a rate on a base-currency source.
   */
  private assertAmounts(ctx: TenantContext, input: CashTransferInput, fromCur: CurrencyCode, toCur: CurrencyCode) {
    const base = ctx.tenant.baseCurrency;
    if (fromCur === base && input.exchangeRate && !d(input.exchangeRate).eq(1)) {
      throw unprocessable('fx_rate_invalid', 'The source account is in the base currency; state the amount received (amountTo) instead of a rate');
    }
    if (!input.amountTo) return;
    let expected: string | null = null;
    if (toCur === fromCur) expected = money(input.amount, fromCur);
    else if (toCur === base) expected = resolveFx(ctx, fromCur, input.exchangeRate).toBase(money(input.amount, fromCur));
    if (expected !== null && !d(input.amountTo).eq(expected)) {
      throw unprocessable('amount_to_mismatch', 'The amount received does not match the amount sent at this rate', { expected, amountTo: input.amountTo });
    }
  }

  async reverse(ctx: TenantContext, transferId: string, reason: string): Promise<CashTransfer> {
    assertPermission(ctx, 'cash.transfer');
    assertPermission(ctx, 'payments.void');
    const before = await this.get(ctx, transferId);
    // Never date a reversal before the transfer itself (the cash book would dip below zero).
    const now = today(ctx);
    const businessDate = before.businessDate > now ? before.businessDate : now;
    const result = await this.cash.reverseTransfer(ctx, transferId, businessDate, reason);
    await this.audit.record({
      action: 'cash_transfer.reversed',
      entityType: 'cash_transfer',
      entityId: transferId,
      summary: `${before.from.cashAccountName} → ${before.to.cashAccountName}: ${before.amountBase} ${before.baseCurrency} reversed`,
      before: { status: 'posted', journalEntryId: before.journalEntryId },
      after: { status: 'reversed', reason, ...result },
    });
    return this.get(ctx, transferId);
  }

  private baseSql(where: string[]): string {
    return `
      FROM cash_transactions o
      JOIN cash_transactions i ON i.source_type = 'cash_transfer' AND i.source_id = o.source_id
                              AND i.kind = 'transfer_in' AND i.reversal_of_id IS NULL
      JOIN cash_accounts fa ON fa.id = o.cash_account_id
      JOIN cash_accounts ta ON ta.id = i.cash_account_id
      LEFT JOIN cash_transactions r ON r.reversal_of_id = o.id
      LEFT JOIN users u ON u.id = o.created_by
     WHERE o.source_type = 'cash_transfer' AND o.kind = 'transfer_out' AND o.reversal_of_id IS NULL
       ${where.length ? `AND ${where.join(' AND ')}` : ''}`;
  }

  private selectSql(): string {
    return `
      SELECT o.source_id AS transfer_id, o.business_date, o.amount_base, o.reference, o.description, o.journal_entry_id,
             o.created_by, u.full_name AS created_by_name, o.created_at,
             fa.id AS from_id, fa.name AS from_name, fa.type AS from_type, fa.currency AS from_currency, fa.branch_id AS from_branch_id,
             o.amount AS from_amount, o.exchange_rate AS from_rate,
             ta.id AS to_id, ta.name AS to_name, ta.type AS to_type, ta.currency AS to_currency, ta.branch_id AS to_branch_id,
             i.amount AS to_amount, i.exchange_rate AS to_rate, i.amount_base AS to_amount_base,
             r.business_date AS rev_date, r.description AS rev_description, r.journal_entry_id AS rev_journal_entry_id, r.created_at AS rev_created_at`;
  }

  /** A transfer is visible when the caller can access either of its accounts. */
  private scopeCond(ctx: TenantContext, p: Params): string | null {
    if (ctx.allBranches) return null;
    const ids = p.add(scopeIds(ctx));
    return `(fa.branch_id IS NULL OR fa.branch_id = ANY(${ids}::uuid[]) OR ta.branch_id IS NULL OR ta.branch_id = ANY(${ids}::uuid[]))`;
  }

  async list(ctx: TenantContext, q: CashTransferListQuery) {
    if (q.from && q.to && q.from > q.to) throw unprocessable('invalid_range', 'The start date must be on or before the end date', { from: q.from, to: q.to });
    const p = new Params();
    const where: string[] = [];
    const scope = this.scopeCond(ctx, p);
    if (scope) where.push(scope);
    if (q.cashAccountId) {
      const id = p.add(q.cashAccountId);
      where.push(`(o.cash_account_id = ${id}::uuid OR i.cash_account_id = ${id}::uuid)`);
    }
    if (q.status === 'posted') where.push('r.id IS NULL');
    if (q.status === 'reversed') where.push('r.id IS NOT NULL');
    if (q.from) where.push(`o.business_date >= ${p.add(q.from)}::date`);
    if (q.to) where.push(`o.business_date <= ${p.add(q.to)}::date`);
    const body = this.baseSql(where);
    const [c] = await this.dbs.query<{ n: number }>(`SELECT count(*)::int AS n ${body}`, p.values);
    const limit = p.add(q.pageSize);
    const offset = p.add((q.page - 1) * q.pageSize);
    const rows = await this.dbs.query<TransferRow>(
      `${this.selectSql()} ${body} ORDER BY o.business_date DESC, o.created_at DESC, o.source_id LIMIT ${limit} OFFSET ${offset}`,
      p.values,
    );
    return { items: rows.map((r) => this.toDto(ctx, r)), total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(ctx: TenantContext, transferId: string): Promise<CashTransfer> {
    const p = new Params();
    const id = p.add(transferId);
    const [row] = await this.dbs.query<TransferRow>(`${this.selectSql()} ${this.baseSql([`o.source_id = ${id}::uuid`])}`, p.values);
    if (!row) throw notFound('Cash transfer');
    if (!ctx.allBranches) {
      const ok = (b: string | null) => !b || ctx.branchIds.includes(b);
      if (!ok(row.from_branch_id) && !ok(row.to_branch_id)) throw forbidden('This transfer belongs to branches you cannot access');
    }
    return this.toDto(ctx, row);
  }

  private toDto(ctx: TenantContext, r: TransferRow): CashTransfer {
    return {
      transferId: r.transfer_id,
      businessDate: r.business_date,
      // Value received at the destination; the source leg is relieved at its carrying cost
      // (fromBase) and any difference is realized FX (4300).
      amountBase: r.to_amount_base,
      fromBase: r.amount_base,
      fxDifference: d(r.to_amount_base).minus(r.amount_base).toFixed(2),
      baseCurrency: ctx.tenant.baseCurrency,
      from: {
        cashAccountId: r.from_id,
        cashAccountName: r.from_name,
        cashAccountType: r.from_type,
        currency: r.from_currency,
        branchId: r.from_branch_id,
        amount: r.from_amount,
        exchangeRate: r.from_rate,
      },
      to: {
        cashAccountId: r.to_id,
        cashAccountName: r.to_name,
        cashAccountType: r.to_type,
        currency: r.to_currency,
        branchId: r.to_branch_id,
        amount: r.to_amount,
        exchangeRate: r.to_rate,
      },
      reference: r.reference,
      description: r.description,
      status: r.rev_date ? 'reversed' : 'posted',
      journalEntryId: r.journal_entry_id,
      reversal: r.rev_date
        ? { businessDate: r.rev_date, description: r.rev_description ?? '', journalEntryId: r.rev_journal_entry_id, createdAt: iso(r.rev_created_at)! }
        : null,
      createdBy: r.created_by,
      createdByName: r.created_by_name,
      createdAt: iso(r.created_at)!,
    };
  }
}
