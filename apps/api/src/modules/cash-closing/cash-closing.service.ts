import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { d, money, todayInZone } from '@autohub/shared';
import { assertBranchAccess, assertPermission, hasPermission, TenantContext } from '../../common/context';
import { conflict, forbidden, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { cashAccounts, cashDayClosings } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { CashService } from '../finance/cash.service';
import { ACCOUNTS } from '../ledger/chart';

registerUniqueConstraint('cash_day_closings_live_uq', 'cash_day_closed', 'This cash day is already closed');

/**
 * Daily cash closing (D-032). Closing a day for an account records the counted balance against
 * the cash book; any difference is posted to 6200 cash over/short (needs cash.adjust). A closed
 * day — and every day before it — accepts no further movements, so a closed balance can never
 * change behind the closer's back. Only the latest closing can be reopened (cash.reopen, reason).
 */
@Injectable()
export class CashClosingService {
  constructor(
    private readonly dbs: DbService,
    private readonly cash: CashService,
    private readonly audit: AuditService,
  ) {
    CashService.closedDateChecker = async (dbs, accountId, date) => {
      const rows = await dbs.query<{ x: number }>(
        `SELECT 1 AS x FROM cash_day_closings WHERE cash_account_id = $1 AND status = 'closed' AND business_date >= $2::date LIMIT 1`,
        [accountId, date],
      );
      return rows.length > 0;
    };
  }

  /** Cash-book balance (account currency) at the end of `date`. */
  private async balanceAt(accountId: string, date: string): Promise<string> {
    const [r] = await this.dbs.query<{ v: string }>(
      `SELECT coalesce(sum(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0)::numeric(18,2)::text AS v
         FROM cash_transactions WHERE cash_account_id = $1 AND business_date <= $2::date`,
      [accountId, date],
    );
    return r?.v ?? '0.00';
  }

  async close(ctx: TenantContext, accountId: string, input: { businessDate: string; countedBalance: string; notes?: string | null }) {
    assertPermission(ctx, 'cash.close');
    const acct = await this.cash.lockAccount(ctx, accountId);
    if (!acct.isActive) throw conflict('cash_account_inactive', 'This cash account is inactive');
    const today = todayInZone(ctx.tenant.settings.timezone);
    if (input.businessDate > today) throw unprocessable('future_date', 'A future day cannot be closed', { field: 'businessDate' });
    const [latest] = await this.dbs.db
      .select({ businessDate: cashDayClosings.businessDate })
      .from(cashDayClosings)
      .where(and(eq(cashDayClosings.cashAccountId, acct.id), eq(cashDayClosings.status, 'closed')))
      .orderBy(desc(cashDayClosings.businessDate))
      .limit(1);
    if (latest && latest.businessDate >= input.businessDate) {
      throw conflict('cash_day_closed', `Days up to ${latest.businessDate} are already closed for this account`, { closedThrough: latest.businessDate });
    }
    const currency = acct.currency as Parameters<typeof money>[1];
    const expected = await this.balanceAt(acct.id, input.businessDate);
    const counted = money(input.countedBalance, currency);
    const difference = d(counted).minus(expected);
    if (!difference.isZero()) {
      if (!hasPermission(ctx, 'cash.adjust')) {
        throw forbidden('The count differs from the cash book; a user with cash.adjust must record this closing', { expected, counted, difference: difference.toFixed(2) });
      }
      if (acct.currency !== ctx.tenant.baseCurrency) {
        throw unprocessable('foreign_difference', 'Differences on foreign-currency accounts must be corrected with a transfer before closing', { difference: difference.toFixed(2) });
      }
    }
    // The difference is posted first, dated on the day being closed, while that day is still open.
    const closingId = randomUUID();
    if (!difference.isZero()) {
      // Over: Dr 1100 / Cr 6200. Short: Dr 6200 / Cr 1100.
      const abs = difference.abs().toFixed(2);
      await this.cash.move(ctx, {
        cashAccountId: acct.id,
        direction: difference.isPositive() ? 'in' : 'out',
        amount: abs,
        exchangeRate: '1',
        kind: difference.isPositive() ? 'cash_over' : 'cash_short',
        sourceType: 'cash_closing',
        sourceId: closingId,
        event: 'cash_closing.difference',
        businessDate: input.businessDate,
        description: `Cash ${difference.isPositive() ? 'over' : 'short'} at closing ${input.businessDate}`,
        reference: null,
        branchId: acct.branchId,
        counterLines: [difference.isPositive() ? { account: ACCOUNTS.CASH_OVER_SHORT, credit: abs } : { account: ACCOUNTS.CASH_OVER_SHORT, debit: abs }],
      });
    }
    const [row] = await this.dbs.db
      .insert(cashDayClosings)
      .values({
        id: closingId,
        tenantId: ctx.tenant.id,
        cashAccountId: acct.id,
        businessDate: input.businessDate,
        expectedBalance: expected,
        countedBalance: counted,
        difference: difference.toFixed(2),
        notes: input.notes ?? null,
        closedBy: ctx.userId,
      })
      .returning();
    await this.audit.record({
      action: 'cash.day_closed',
      entityType: 'cash_account',
      entityId: acct.id,
      summary: `${acct.name} ${input.businessDate}`,
      after: { closingId: row!.id, expected, counted, difference: difference.toFixed(2), notes: input.notes ?? null },
    });
    return row!;
  }

  async reopen(ctx: TenantContext, closingId: string, reason: string) {
    assertPermission(ctx, 'cash.reopen');
    const [c] = await this.dbs.db.select().from(cashDayClosings).where(eq(cashDayClosings.id, closingId)).for('update');
    if (!c) throw notFound('Cash closing');
    await this.cash.lockAccount(ctx, c.cashAccountId);
    if (c.status !== 'closed') throw conflict('closing_reopened', 'This closing was already reopened');
    const [later] = await this.dbs.db
      .select({ id: cashDayClosings.id })
      .from(cashDayClosings)
      .where(and(eq(cashDayClosings.cashAccountId, c.cashAccountId), eq(cashDayClosings.status, 'closed')))
      .orderBy(desc(cashDayClosings.businessDate))
      .limit(1);
    if (later && later.id !== c.id) throw conflict('not_latest_closing', 'Reopen the most recent closing first');
    const [after] = await this.dbs.db
      .update(cashDayClosings)
      .set({ status: 'reopened', reopenedBy: ctx.userId, reopenedAt: new Date(), reopenReason: reason })
      .where(eq(cashDayClosings.id, closingId))
      .returning();
    await this.audit.record({ action: 'cash.day_reopened', entityType: 'cash_account', entityId: c.cashAccountId, summary: c.businessDate, before: { status: 'closed' }, after: { status: 'reopened', reason } });
    return after!;
  }

  private async readableAccount(ctx: TenantContext, accountId: string) {
    const [a] = await this.dbs.db.select().from(cashAccounts).where(eq(cashAccounts.id, accountId));
    if (!a) throw notFound('Cash account');
    assertBranchAccess(ctx, a.branchId);
    return a;
  }

  async list(ctx: TenantContext, accountId: string) {
    await this.readableAccount(ctx, accountId);
    return this.dbs.db.select().from(cashDayClosings).where(eq(cashDayClosings.cashAccountId, accountId)).orderBy(desc(cashDayClosings.businessDate), desc(cashDayClosings.closedAt)).limit(366);
  }

  /** Expected balance for a day (what the count will be compared with). */
  async expected(ctx: TenantContext, accountId: string, date: string) {
    const acct = await this.readableAccount(ctx, accountId);
    return { cashAccountId: acct.id, currency: acct.currency, businessDate: date, expectedBalance: await this.balanceAt(acct.id, date) };
  }
}
