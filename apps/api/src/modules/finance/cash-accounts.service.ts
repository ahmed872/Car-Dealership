import { Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { CurrencyCode, d, money, todayInZone } from '@autohub/shared';
import { assertBranchAccess, assertPermission, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { branches, cashAccounts } from '../../db/schema';
import { AuditService, diff } from '../audit/audit.service';
import { ACCOUNTS } from '../ledger/chart';
import { CashService } from './cash.service';
import { resolveFx } from './fx';

registerUniqueConstraint('cash_accounts_name_uq', 'cash_account_name_taken', 'A cash or bank account with this name already exists');

export interface CashAccountCreate {
  type: 'cashbox' | 'bank';
  name: string;
  currency: CurrencyCode;
  branchId?: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
  iban?: string | null;
  openingBalance?: string;
  exchangeRate?: string;
  openingDate?: string;
}

/**
 * Cash boxes and bank accounts. Balances are always derived from the cash book (never stored), and
 * an opening balance is a real cash-book row posted against owner's equity (Dr 1100 / Cr 3000).
 */
@Injectable()
export class CashAccountsService {
  constructor(
    private readonly dbs: DbService,
    private readonly cash: CashService,
    private readonly audit: AuditService,
  ) {}

  private balanceSql() {
    return {
      balance: sql<string>`(SELECT coalesce(sum(CASE WHEN ct.direction = 'in' THEN ct.amount ELSE -ct.amount END), 0) FROM cash_transactions ct WHERE ct.cash_account_id = cash_accounts.id)::numeric(18,2)::text`,
      balanceBase: sql<string>`(SELECT coalesce(sum(CASE WHEN ct.direction = 'in' THEN ct.amount_base ELSE -ct.amount_base END), 0) FROM cash_transactions ct WHERE ct.cash_account_id = cash_accounts.id)::numeric(18,2)::text`,
    };
  }

  async list(ctx: TenantContext, opts: { includeInactive?: boolean } = {}) {
    const rows = await this.dbs.db
      .select({
        id: cashAccounts.id,
        type: cashAccounts.type,
        name: cashAccounts.name,
        currency: cashAccounts.currency,
        branchId: cashAccounts.branchId,
        branchName: branches.name,
        bankName: cashAccounts.bankName,
        accountNumber: cashAccounts.accountNumber,
        iban: cashAccounts.iban,
        isActive: cashAccounts.isActive,
        createdAt: cashAccounts.createdAt,
        ...this.balanceSql(),
      })
      .from(cashAccounts)
      .leftJoin(branches, eq(branches.id, cashAccounts.branchId))
      .orderBy(asc(cashAccounts.type), asc(cashAccounts.name));
    return rows.filter((r) => (opts.includeInactive || r.isActive) && (ctx.allBranches || !r.branchId || ctx.branchIds.includes(r.branchId)));
  }

  async get(ctx: TenantContext, id: string) {
    const [a] = await this.dbs.db
      .select({ account: cashAccounts, ...this.balanceSql() })
      .from(cashAccounts)
      .where(eq(cashAccounts.id, id));
    if (!a) throw notFound('Cash account');
    assertBranchAccess(ctx, a.account.branchId);
    return { ...a.account, balance: a.balance, balanceBase: a.balanceBase };
  }

  async create(ctx: TenantContext, input: CashAccountCreate) {
    if (input.branchId) {
      assertBranchAccess(ctx, input.branchId);
      const [b] = await this.dbs.db.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
      if (!b) throw notFound('Branch');
    }
    const { openingBalance, exchangeRate, openingDate, ...fields } = input;
    const [a] = await this.dbs.db
      .insert(cashAccounts)
      .values({ ...fields, branchId: fields.branchId ?? null, tenantId: ctx.tenant.id, createdBy: ctx.userId })
      .returning();
    await this.audit.record({ action: 'cash_account.created', entityType: 'cash_account', entityId: a!.id, summary: `${a!.name} (${a!.currency})`, after: a });
    if (openingBalance && d(openingBalance).gt(0)) {
      assertPermission(ctx, 'ledger.post_manual');
      const fx = resolveFx(ctx, input.currency, exchangeRate);
      const amount = money(openingBalance, input.currency);
      const amountBase = fx.toBase(amount);
      await this.cash.move(ctx, {
        cashAccountId: a!.id,
        direction: 'in',
        amount,
        exchangeRate: fx.rate,
        kind: 'opening_balance',
        sourceType: 'cash_account',
        sourceId: a!.id,
        event: 'cash_account.opening_balance',
        businessDate: openingDate ?? todayInZone(ctx.tenant.settings.timezone),
        description: `Opening balance — ${a!.name}`,
        counterLines: [{ account: ACCOUNTS.EQUITY, credit: amountBase }],
      });
      await this.audit.record({ action: 'cash_account.opening_balance', entityType: 'cash_account', entityId: a!.id, after: { amount, currency: input.currency, amountBase } });
    }
    return this.get(ctx, a!.id);
  }

  async update(ctx: TenantContext, id: string, input: { name?: string; branchId?: string | null; bankName?: string | null; accountNumber?: string | null; iban?: string | null; isActive?: boolean }) {
    const before = await this.cash.lockAccount(ctx, id);
    if (input.branchId) {
      assertBranchAccess(ctx, input.branchId);
      // RLS-scoped lookup: a foreign-key check alone would accept another company's branch id.
      const [b] = await this.dbs.db.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
      if (!b) throw notFound('Branch');
    }
    if (input.isActive === false && before.isActive) {
      const bal = await this.cash.balance(id);
      if (!d(bal.amount).isZero()) throw conflict('cash_account_not_empty', 'Transfer the balance out before deactivating this account', { balance: bal.amount });
    }
    const [after] = await this.dbs.db.update(cashAccounts).set(input).where(eq(cashAccounts.id, id)).returning();
    await this.audit.record({ action: 'cash_account.updated', entityType: 'cash_account', entityId: id, ...diff(before, after!) });
    return this.get(ctx, id);
  }
}
