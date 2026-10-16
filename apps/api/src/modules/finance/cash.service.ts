import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
   * The other side(s) of the entry in BASE currency at the transaction rate. For an inflow they
   * are credits, for an outflow debits; they must total amount × rate. For outflows from a
   * foreign-currency account the cash leg is relieved at the account's carrying cost instead and
   * the difference is posted to realized FX (4300) automatically.
   */
  counterLines: PostingLine[];
}

export type CashAccountRow = typeof cashAccounts.$inferSelect;

/** FX line that makes an entry balance: positive diff = loss (debit), negative = gain (credit). */
export function fxLine(diff: Decimal, memo: string, branchId?: string | null): PostingLine | null {
  if (diff.isZero()) return null;
  return diff.isPositive()
    ? { account: ACCOUNTS.FX_GAIN_LOSS, debit: diff.toFixed(2), branchId: branchId ?? null, memo }
    : { account: ACCOUNTS.FX_GAIN_LOSS, credit: diff.negated().toFixed(2), branchId: branchId ?? null, memo };
}
type Decimal = ReturnType<typeof d>;

/**
 * The cash book. Every movement of money in or out of a cash box or bank account goes through
 * move(): it writes the append-only cash transaction AND the balanced GL entry (1100 + counter
 * lines) in the same transaction, so the cash book always reconciles to the ledger.
 *
 * Foreign-currency accounts are carried at weighted-average base cost: inflows add base at the
 * transaction rate; outflows relieve base proportionally (all of it when the account is emptied).
 * The difference between that carrying cost and the transaction value is a realized FX gain or
 * loss (4300), so an emptied foreign account never strands base value (F-005).
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

  /**
   * Lowest balance (account currency) on any day from `date` onward. A cash box may only pay
   * `amount` on `date` if this minimum covers it — otherwise a back-dated payment would make the
   * box negative on the days before later receipts arrived (F-004).
   */
  async minBalanceFrom(accountId: string, date: string): Promise<string> {
    const rows = await this.dbs.query<{ v: string | null }>(
      `WITH daily AS (
         SELECT business_date, sum(CASE WHEN direction = 'in' THEN amount ELSE -amount END) AS s
           FROM cash_transactions WHERE cash_account_id = $1 GROUP BY business_date),
       running AS (SELECT business_date, sum(s) OVER (ORDER BY business_date) AS bal FROM daily)
       SELECT least(
         (SELECT coalesce(sum(s), 0) FROM daily WHERE business_date <= $2::date),
         coalesce((SELECT min(bal) FROM running WHERE business_date > $2::date), 'Infinity'::numeric)
       )::text AS v`,
      [accountId, date],
    );
    return d(rows[0]?.v ?? '0').toFixed(2);
  }

  private async assertCashboxCovers(acct: CashAccountRow, amount: string, date: string, message: string) {
    if (acct.type !== 'cashbox') return; // bank accounts may be overdrawn (B-019)
    const min = await this.minBalanceFrom(acct.id, date);
    if (d(min).lt(amount)) {
      throw conflict('insufficient_cash', message, { available: min, required: amount, date });
    }
  }

  /**
   * Base value relieved when `amount` (account currency) leaves the account: proportional
   * carrying cost, the whole remaining base when emptied, and the transaction rate for any part
   * that overdraws a bank account.
   */
  async carryingOut(acct: CashAccountRow, amount: string, txnRate: string): Promise<string> {
    if (acct.currency === undefined) return amount;
    const bal = await this.balance(acct.id);
    const balAmt = d(bal.amount);
    const amt = d(amount);
    if (balAmt.lte(0)) return amt.times(txnRate).toDecimalPlaces(2).toFixed(2);
    if (amt.eq(balAmt)) return d(bal.amountBase).toFixed(2);
    if (amt.lt(balAmt)) return d(bal.amountBase).times(amt).dividedBy(balAmt).toDecimalPlaces(2).toFixed(2);
    return d(bal.amountBase).plus(amt.minus(balAmt).times(txnRate)).toDecimalPlaces(2).toFixed(2);
  }

  async move(ctx: TenantContext, m: CashMove): Promise<{ cashTransactionId: string; amountBase: string; journalEntryId: string | null }> {
    if (d(m.amount).lte(0)) throw unprocessable('invalid_amount', 'Amount must be positive');
    const acct = await this.lockAccount(ctx, m.cashAccountId);
    if (!acct.isActive) throw conflict('cash_account_inactive', 'This cash account is inactive');
    if (CashService.closedDateChecker && (await CashService.closedDateChecker(this.dbs, acct.id, m.businessDate))) {
      throw conflict('cash_day_closed', `The cash day ${m.businessDate} is already closed for this account`);
    }
    const currency = acct.currency as CurrencyCode;
    const fx = resolveFx(ctx, currency, currency === ctx.tenant.baseCurrency ? null : m.exchangeRate);
    const amount = money(m.amount, currency);
    const txnBase = fx.toBase(amount);
    if (m.direction === 'out') await this.assertCashboxCovers(acct, amount, m.businessDate, 'The cash box does not hold enough money for this payment');
    const foreignOut = m.direction === 'out' && currency !== ctx.tenant.baseCurrency;
    const amountBase = foreignOut ? await this.carryingOut(acct, amount, fx.rate) : txnBase;
    const branchId = m.branchId ?? acct.branchId;
    const cashLine: PostingLine =
      m.direction === 'in'
        ? { account: ACCOUNTS.CASH, debit: amountBase, cashAccountId: acct.id, memo: m.kind }
        : { account: ACCOUNTS.CASH, credit: amountBase, cashAccountId: acct.id, memo: m.kind };
    // Outflow: counter debits total txnBase, the cash credit is the carrying cost → FX = carrying − txn.
    const fx4300 = foreignOut ? fxLine(d(amountBase).minus(txnBase), 'fx:cash', branchId) : null;
    const journalEntryId = await this.posting.post({
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      event: m.event,
      date: m.businessDate,
      description: m.description,
      branchId,
      lines: [cashLine, ...m.counterLines, ...(fx4300 ? [fx4300] : [])],
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
   * The reversal is never dated before the movement it reverses.
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
    if (!acct.isActive) throw conflict('cash_account_inactive', 'This cash account is inactive; reactivate it before reversing movements into or out of it');
    const date = businessDate < tx.businessDate ? tx.businessDate : businessDate;
    if (CashService.closedDateChecker && (await CashService.closedDateChecker(this.dbs, acct.id, date))) {
      throw conflict('cash_day_closed', `The cash day ${date} is already closed for this account`);
    }
    if (tx.direction === 'in') await this.assertCashboxCovers(acct, tx.amount, date, 'The cash box does not hold enough money to reverse this receipt');
    const journalEntryId = await this.posting.reverse(original, `${original.event}.reversed`, date, `Reversal: ${reason}`.slice(0, 500));
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
        businessDate: date,
        reference: tx.reference,
        description: `Reversal: ${reason}`.slice(0, 500),
        reversalOfId: tx.id,
        journalEntryId,
        createdBy: ctx.userId,
      })
      .returning({ id: cashTransactions.id });
    return { cashTransactionId: rev!.id, businessDate: date };
  }

  /**
   * Moves money between two of the company's own accounts: ONE balanced GL entry and two cash-book
   * rows sharing the same source id. The source leg is relieved at its carrying cost; the
   * destination receives the transaction value (amountTo for a base-currency destination, the
   * converted value otherwise); any difference is realized FX (4300).
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
    const base = ctx.tenant.baseCurrency;
    const fromFx = resolveFx(ctx, from.currency as CurrencyCode, from.currency === base ? null : t.exchangeRate);
    const amount = money(t.amount, from.currency as CurrencyCode);
    const txnBase = fromFx.toBase(amount);
    let amountTo: string;
    if (to.currency === from.currency) amountTo = amount;
    else if (to.currency === base) amountTo = t.amountTo ? money(t.amountTo, to.currency as CurrencyCode) : txnBase;
    else {
      if (!t.amountTo) throw unprocessable('amount_to_required', 'State the amount received in the destination currency');
      amountTo = money(t.amountTo, to.currency as CurrencyCode);
    }
    await this.assertCashboxCovers(from, amount, t.businessDate, 'The cash box does not hold enough money');
    const fromBase = from.currency === base ? amount : await this.carryingOut(from, amount, fromFx.rate);
    // Destination value: a base-currency account receives exactly amountTo; a foreign one the
    // transaction value (same currency as the source → it inherits the carrying cost, no FX).
    const toBase = to.currency === base ? amountTo : to.currency === from.currency ? fromBase : txnBase;
    const fx = fxLine(d(fromBase).minus(toBase), 'fx:transfer', from.branchId);
    const journalEntryId = await this.posting.post({
      sourceType: 'cash_transfer',
      sourceId: t.transferId,
      event: 'cash_transfer.posted',
      date: t.businessDate,
      description: t.description,
      branchId: from.branchId,
      lines: [
        // Each leg carries its own account's branch, so per-branch GL 1100 matches the cash book.
        { account: ACCOUNTS.CASH, debit: toBase, cashAccountId: to.id, branchId: to.branchId, memo: 'transfer_in' },
        { account: ACCOUNTS.CASH, credit: fromBase, cashAccountId: from.id, branchId: from.branchId, memo: 'transfer_out' },
        ...(fx ? [fx] : []),
      ],
    });
    const rateTo = d(toBase).dividedBy(amountTo).toDecimalPlaces(8).toFixed(8);
    const common = { tenantId: ctx.tenant.id, sourceType: 'cash_transfer', sourceId: t.transferId, businessDate: t.businessDate, reference: t.reference ?? null, description: t.description.slice(0, 500), journalEntryId, createdBy: ctx.userId };
    await this.dbs.db.insert(cashTransactions).values([
      // exchange_rate keeps the transaction rate the user stated; amount_base is the carrying cost relieved.
      { ...common, cashAccountId: from.id, direction: 'out', amount, amountBase: fromBase, exchangeRate: fromFx.rate, kind: 'transfer_out' },
      { ...common, cashAccountId: to.id, direction: 'in', amount: amountTo, amountBase: toBase, exchangeRate: rateTo, kind: 'transfer_in' },
    ]);
    return { amount, amountTo, amountBase: toBase, fromBase, fxDifference: d(toBase).minus(fromBase).toFixed(2), journalEntryId };
  }

  /**
   * Reverses a whole transfer: ONE mirrored GL entry (`cash_transfer.reversed`) and two opposite
   * cash-book rows, each pointing at the leg it reverses. Both accounts are locked in the same
   * stable order as transfer(); the destination must still hold the money it received when it is
   * a cash box. A transfer can be reversed once (checked under the locks, and by the unique
   * reversal_of_id / source-event indexes).
   */
  async reverseTransfer(ctx: TenantContext, transferId: string, businessDate: string, reason: string) {
    const legs = await this.dbs.db
      .select()
      .from(cashTransactions)
      .where(and(eq(cashTransactions.sourceType, 'cash_transfer'), eq(cashTransactions.sourceId, transferId), sql`${cashTransactions.reversalOfId} IS NULL`));
    if (legs.length === 0) throw notFound('Cash transfer');
    const out = legs.find((l) => l.kind === 'transfer_out');
    const inn = legs.find((l) => l.kind === 'transfer_in');
    if (legs.length !== 2 || !out || !inn) throw conflict('invalid_transfer', 'This transfer does not have exactly one outgoing and one incoming leg');

    const [firstId, secondId] = [out.cashAccountId, inn.cashAccountId].sort();
    const first = await this.lockAccount(ctx, firstId!);
    const second = await this.lockAccount(ctx, secondId!);
    const from = first.id === out.cashAccountId ? first : second;
    const to = first.id === inn.cashAccountId ? first : second;

    // Re-read under the locks: a concurrent reversal that committed meanwhile is now visible.
    const reversed = await this.dbs.db
      .select({ id: cashTransactions.id })
      .from(cashTransactions)
      .where(inArray(cashTransactions.reversalOfId, [out.id, inn.id]))
      .limit(1);
    if (reversed.length > 0 || (await this.posting.hasEvent('cash_transfer', transferId, 'cash_transfer.reversed'))) {
      throw conflict('already_reversed', 'This transfer has already been reversed');
    }
    const date = businessDate < out.businessDate ? out.businessDate : businessDate;
    for (const a of [from, to]) {
      if (!a.isActive) throw conflict('cash_account_inactive', `Cash account ${a.name} is inactive`);
      if (CashService.closedDateChecker && (await CashService.closedDateChecker(this.dbs, a.id, date))) {
        throw conflict('cash_day_closed', `The cash day ${date} is already closed for ${a.name}`);
      }
    }
    await this.assertCashboxCovers(to, inn.amount, date, 'The destination cash box no longer holds the transferred money');
    const description = `Reversal: ${reason}`.slice(0, 500);
    const journalEntryId = await this.posting.reverse(
      { sourceType: 'cash_transfer', sourceId: transferId, event: 'cash_transfer.posted' },
      'cash_transfer.reversed',
      date,
      description,
    );
    if (!journalEntryId) throw conflict('transfer_not_posted', 'The ledger entry of this transfer was not found');
    const common = { tenantId: ctx.tenant.id, sourceType: 'cash_transfer', sourceId: transferId, businessDate: date, description, journalEntryId, createdBy: ctx.userId };
    const rows = await this.dbs.db
      .insert(cashTransactions)
      .values([
        { ...common, cashAccountId: from.id, direction: 'in', amount: out.amount, amountBase: out.amountBase, exchangeRate: out.exchangeRate, kind: 'transfer_out_reversal', reference: out.reference, reversalOfId: out.id },
        { ...common, cashAccountId: to.id, direction: 'out', amount: inn.amount, amountBase: inn.amountBase, exchangeRate: inn.exchangeRate, kind: 'transfer_in_reversal', reference: inn.reference, reversalOfId: inn.id },
      ])
      .returning({ id: cashTransactions.id, reversalOfId: cashTransactions.reversalOfId });
    return {
      transferId,
      journalEntryId,
      businessDate: date,
      fromReversalId: rows.find((r) => r.reversalOfId === out.id)!.id,
      toReversalId: rows.find((r) => r.reversalOfId === inn.id)!.id,
    };
  }
}
