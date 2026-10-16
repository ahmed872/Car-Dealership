import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { CurrencyCode, d, money } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { cashAccounts, cashTransactions } from '../../db/schema';
import { ACCOUNTS } from '../ledger/chart';
import { PostingLine, PostingService } from '../ledger/posting.service';
import { resolveFx } from './fx';

export interface CashMove {
  cashAccountId: string;
  direction: 'in' | 'out';
  /** Amount in the cash account's own currency. */
  amount: string;
  /** Required when the account currency differs from the company base currency. */
  exchangeRate?: string | null;
  kind: string;
  sourceType: string;
  sourceId: string;
  /** Ledger event key; (sourceType, sourceId, event) must be unique. */
  event: string;
  businessDate: string;
  description: string;
  reference?: string | null;
  branchId?: string | null;
  /**
   * The other side(s) of the entry in BASE currency. For an inflow they are credits, for an
   * outflow debits; they must total the cash line's base amount.
   */
  counterLines: PostingLine[];
}

export type CashAccountRow = typeof cashAccounts.$inferSelect;

/**
 * The cash book. Every movement of money in or out of a cash box or bank account goes through
 * move(): it writes the append-only cash transaction AND the balanced GL entry (1100 + counter
 * lines) in the same transaction, so the cash book always reconciles to the ledger.
 */
@Injectable()
export class CashService {
  /** Registered by the closing module: returns true when (account, date) is already closed. */
  static closedDateChecker: ((dbs: DbService, accountId: string, date: string) => Promise<boolean>) | null = null;

  constructor(
    private readonly dbs: DbService,
    private readonly posting: PostingService,
  ) {}

  /** Locks the account row: serialises movements on one account (balance checks, closings). */
  async lockAccount(ctx: TenantContext, id: string): Promise<CashAccountRow> {
    const [a] = await this.dbs.db.select().from(cashAccounts).where(eq(cashAccounts.id, id)).for('update');
    if (!a) throw notFound('Cash account');
    if (a.branchId && !ctx.allBranches && !ctx.branchIds.includes(a.branchId)) {
      throw forbidden('This cash account belongs to a branch you cannot access');
    }
    return a;
  }

  async balance(accountId: string): Promise<{ amount: string; amountBase: string }> {
    const [row] = await this.dbs.db
      .select({
        amount: sql<string>`coalesce(sum(CASE WHEN ${cashTransactions.direction} = 'in' THEN ${cashTransactions.amount} ELSE -${cashTransactions.amount} END), 0)::numeric(18,2)::text`,
        amountBase: sql<string>`coalesce(sum(CASE WHEN ${cashTransactions.direction} = 'in' THEN ${cashTransactions.amountBase} ELSE -${cashTransactions.amountBase} END), 0)::numeric(18,2)::text`,
      })
      .from(cashTransactions)
      .where(eq(cashTransactions.cashAccountId, accountId));
    return { amount: row?.amount ?? '0.00', amountBase: row?.amountBase ?? '0.00' };
  }

  async move(ctx: TenantContext, m: CashMove): Promise<{ cashTransactionId: string; amountBase: string; journalEntryId: string | null }> {
    if (d(m.amount).lte(0)) throw unprocessable('invalid_amount', 'Amount must be positive');
    const acct = await this.lockAccount(ctx, m.cashAccountId);
    if (!acct.isActive) throw conflict('cash_account_inactive', 'This cash account is inactive');
    if (CashService.closedDateChecker && (await CashService.closedDateChecker(this.dbs, acct.id, m.businessDate))) {
      throw conflict('cash_day_closed', `The cash day ${m.businessDate} is already closed for this account`);
    }
    const fx = resolveFx(ctx, acct.currency as CurrencyCode, m.exchangeRate);
    const amount = money(m.amount, acct.currency as CurrencyCode);
    const amountBase = fx.toBase(amount);
    if (m.direction === 'out' && acct.type === 'cashbox') {
      const bal = await this.balance(acct.id);
      if (d(bal.amount).lt(amount)) {
        throw conflict('insufficient_cash', 'The cash box does not hold enough money for this payment', {
          available: bal.amount,
          required: amount,
        });
      }
    }
    const cashLine: PostingLine =
      m.direction === 'in'
        ? { account: ACCOUNTS.CASH, debit: amountBase, cashAccountId: acct.id, memo: m.kind }
        : { account: ACCOUNTS.CASH, credit: amountBase, cashAccountId: acct.id, memo: m.kind };
    const journalEntryId = await this.posting.post({
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      event: m.event,
      date: m.businessDate,
      description: m.description,
      branchId: m.branchId ?? acct.branchId,
      lines: [cashLine, ...m.counterLines],
    });
    const [tx] = await this.dbs.db
      .insert(cashTransactions)
      .values({
        tenantId: ctx.tenant.id,
        cashAccountId: acct.id,
        direction: m.direction,
        amount,
        amountBase,
        exchangeRate: fx.rate,
        kind: m.kind,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        businessDate: m.businessDate,
        reference: m.reference ?? null,
        description: m.description.slice(0, 500),
        journalEntryId,
        createdBy: ctx.userId,
      })
      .returning({ id: cashTransactions.id });
    return { cashTransactionId: tx!.id, amountBase, journalEntryId };
  }

  /**
   * Reverses a single-row cash movement (opposite cash row + mirrored GL entry). Each row can be
   * reversed once (unique reversal_of_id). Multi-row sources (transfers) use reverseTransfer().
   */
  async reverse(ctx: TenantContext, original: { sourceType: string; sourceId: string; event: string }, businessDate: string, reason: string) {
    const rows = await this.dbs.db
      .select()
      .from(cashTransactions)
      .where(and(eq(cashTransactions.sourceType, original.sourceType), eq(cashTransactions.sourceId, original.sourceId), sql`${cashTransactions.reversalOfId} IS NULL`));
    if (rows.length === 0) throw notFound('Cash transaction');
    if (rows.length > 1) throw conflict('ambiguous_cash_source', 'This source has several cash movements; reverse them explicitly');
    const tx = rows[0]!;
    const acct = await this.lockAccount(ctx, tx.cashAccountId);
    if (CashService.closedDateChecker && (await CashService.closedDateChecker(this.dbs, acct.id, businessDate))) {
      throw conflict('cash_day_closed', `The cash day ${businessDate} is already closed for this account`);
    }
    if (tx.direction === 'in' && acct.type === 'cashbox') {
      const bal = await this.balance(acct.id);
      if (d(bal.amount).lt(tx.amount)) throw conflict('insufficient_cash', 'The cash box does not hold enough money to reverse this receipt');
    }
    const journalEntryId = await this.posting.reverse(original, `${original.event}.reversed`, businessDate, `Reversal: ${reason}`.slice(0, 500));
    const [rev] = await this.dbs.db
      .insert(cashTransactions)
      .values({
        tenantId: ctx.tenant.id,
        cashAccountId: tx.cashAccountId,
        direction: tx.direction === 'in' ? 'out' : 'in',
        amount: tx.amount,
        amountBase: tx.amountBase,
        exchangeRate: tx.exchangeRate,
        kind: `${tx.kind}_reversal`,
        sourceType: tx.sourceType,
        sourceId: tx.sourceId,
        businessDate,
        reference: tx.reference,
        description: `Reversal: ${reason}`.slice(0, 500),
        reversalOfId: tx.id,
        journalEntryId,
        createdBy: ctx.userId,
      })
      .returning({ id: cashTransactions.id });
    return { cashTransactionId: rev!.id };
  }

  /**
   * Moves money between two of the company's own accounts: ONE balanced GL entry (Dr 1100 to /
   * Cr 1100 from) and two cash-book rows sharing the same source id. Cross-currency transfers
   * carry the same base amount on both legs (the destination's implied rate absorbs rounding).
   */
  async transfer(
    ctx: TenantContext,
    t: { transferId: string; fromAccountId: string; toAccountId: string; amount: string; amountTo?: string | null; exchangeRate?: string | null; businessDate: string; reference?: string | null; description: string },
  ) {
    if (t.fromAccountId === t.toAccountId) throw unprocessable('same_account', 'Choose two different accounts');
    // Lock in a stable order to avoid deadlocks between opposite transfers.
    const [firstId, secondId] = [t.fromAccountId, t.toAccountId].sort();
    const first = await this.lockAccount(ctx, firstId!);
    const second = await this.lockAccount(ctx, secondId!);
    const from = first.id === t.fromAccountId ? first : second;
    const to = first.id === t.toAccountId ? first : second;
    for (const a of [from, to]) {
      if (!a.isActive) throw conflict('cash_account_inactive', `Cash account ${a.name} is inactive`);
      if (CashService.closedDateChecker && (await CashService.closedDateChecker(this.dbs, a.id, t.businessDate))) {
        throw conflict('cash_day_closed', `The cash day ${t.businessDate} is already closed for ${a.name}`);
      }
    }
    const fromFx = resolveFx(ctx, from.currency as CurrencyCode, from.currency === ctx.tenant.baseCurrency ? null : t.exchangeRate);
    const amount = money(t.amount, from.currency as CurrencyCode);
    const amountBase = fromFx.toBase(amount);
    let amountTo: string;
    if (to.currency === from.currency) amountTo = amount;
    else if (to.currency === ctx.tenant.baseCurrency) amountTo = amountBase;
    else {
      if (!t.amountTo) throw unprocessable('amount_to_required', 'State the amount received in the destination currency');
      amountTo = money(t.amountTo, to.currency as CurrencyCode);
    }
    if (from.type === 'cashbox') {
      const bal = await this.balance(from.id);
      if (d(bal.amount).lt(amount)) throw conflict('insufficient_cash', 'The cash box does not hold enough money', { available: bal.amount, required: amount });
    }
    const journalEntryId = await this.posting.post({
      sourceType: 'cash_transfer',
      sourceId: t.transferId,
      event: 'cash_transfer.posted',
      date: t.businessDate,
      description: t.description,
      branchId: from.branchId,
      lines: [
        { account: ACCOUNTS.CASH, debit: amountBase, cashAccountId: to.id, memo: 'transfer_in' },
        { account: ACCOUNTS.CASH, credit: amountBase, cashAccountId: from.id, memo: 'transfer_out' },
      ],
    });
    const rateTo = d(amountBase).dividedBy(amountTo).toDecimalPlaces(8).toFixed(8);
    const common = { tenantId: ctx.tenant.id, sourceType: 'cash_transfer', sourceId: t.transferId, businessDate: t.businessDate, reference: t.reference ?? null, description: t.description.slice(0, 500), journalEntryId, createdBy: ctx.userId };
    await this.dbs.db.insert(cashTransactions).values([
      { ...common, cashAccountId: from.id, direction: 'out', amount, amountBase, exchangeRate: fromFx.rate, kind: 'transfer_out' },
      { ...common, cashAccountId: to.id, direction: 'in', amount: amountTo, amountBase, exchangeRate: rateTo, kind: 'transfer_in' },
    ]);
    return { amount, amountTo, amountBase, journalEntryId };
  }
}
