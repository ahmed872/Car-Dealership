import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  d,
  EXPENSE_SORT_KEYS,
  ExpenseCreateInput,
  ExpenseListQuery,
  ExpenseSortKey,
  ExpenseSummaryQuery,
  money,
  PayNowInput,
  sum,
  todayInZone,
} from '@autohub/shared';
import { assertBranchAccess, hasPermission, TenantContext } from '../../common/context';
import { conflict, notFound, registerUniqueConstraint, unprocessable } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { branches, costCategories, expenses, journalEntries, suppliers, users } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../finance/approvals.service';
import { CashService } from '../finance/cash.service';
import { resolveFx } from '../finance/fx';
import { PayablesService } from '../finance/payables.service';
import { SupplierPaymentsService } from '../finance/supplier-payments.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingService } from '../ledger/posting.service';
import { NumberingService } from '../numbering/numbering.service';

registerUniqueConstraint('expenses_number_uq', 'expense_number_taken', 'An expense with this number already exists');

type ExpenseRow = typeof expenses.$inferSelect;

const NO_BRANCH = '00000000-0000-0000-0000-000000000000';
const approver = alias(users, 'approver');

/**
 * Paid amount of an expense from non-voided supplier payments. Correlated on the literal outer
 * column `expenses.id` (see CLAUDE.md: never `${expenses.id}` inside a correlated subquery).
 */
const paidSql = sql`(SELECT coalesce(sum(spa.amount_base), 0) FROM supplier_payment_allocations spa JOIN supplier_payments sp ON sp.id = spa.payment_id WHERE spa.target_type = 'expense' AND spa.target_id = expenses.id AND sp.status = 'posted')`;

/**
 * Operating expenses (P&L). A posted expense has exactly one ledger entry
 * (Dr 6000 Operating expenses [branch] / Cr 2000 Payables [supplier]) and becomes a payable
 * document settled through SupplierPaymentsService. Users with `expenses.approve` post directly;
 * others create a pending expense that waits in the approval inbox. Posted amounts are frozen
 * (posted_amount_guard trigger); corrections are reversals.
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly dbs: DbService,
    private readonly posting: PostingService,
    private readonly approvals: ApprovalsService,
    private readonly payments: SupplierPaymentsService,
    private readonly payables: PayablesService,
    private readonly cash: CashService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  /** Active operating categories (platform + tenant). Vehicle categories come from /cost-categories. */
  categories() {
    return this.dbs.db
      .select()
      .from(costCategories)
      .where(and(eq(costCategories.kind, 'operating'), eq(costCategories.isActive, true)))
      .orderBy(asc(costCategories.nameEn));
  }

  private branchScope(ctx: TenantContext): SQL | undefined {
    if (ctx.allBranches) return undefined;
    // inArray, not `= ANY(${array}::uuid[])`: Drizzle expands JS arrays in sql`` into a param list.
    return inArray(expenses.branchId, ctx.branchIds.length ? ctx.branchIds : [NO_BRANCH]);
  }

  async create(ctx: TenantContext, input: ExpenseCreateInput) {
    const db = this.dbs.db;
    assertBranchAccess(ctx, input.branchId);
    const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId));
    if (!branch) throw notFound('Branch');

    const [cat] = await db.select().from(costCategories).where(eq(costCategories.id, input.categoryId));
    if (!cat) throw notFound('Expense category');
    if (cat.kind !== 'operating') throw unprocessable('category_not_operating', 'Use an operating expense category; vehicle costs are recorded on the vehicle');
    if (!cat.isActive) throw unprocessable('category_inactive', 'This expense category is inactive');

    if (input.supplierId) {
      const [s] = await db.select({ id: suppliers.id, isActive: suppliers.isActive }).from(suppliers).where(eq(suppliers.id, input.supplierId));
      if (!s) throw notFound('Supplier');
      if (!s.isActive) throw unprocessable('supplier_inactive', 'This supplier is inactive');
    }

    const fx = resolveFx(ctx, input.currency, input.exchangeRate);
    const amount = money(input.amount, input.currency);
    const amountBase = fx.toBase(amount);
    if (d(amountBase).lte(0)) throw unprocessable('invalid_amount', 'The amount is too small to record in the base currency');

    const status = hasPermission(ctx, 'expenses.approve') ? 'posted' : 'pending_approval';
    if (input.payNow && status !== 'posted') {
      throw unprocessable('cannot_pay_unapproved', 'An expense awaiting approval cannot be paid yet');
    }

    const number = await this.numbering.next('expense');
    const [row] = await db
      .insert(expenses)
      .values({
        tenantId: ctx.tenant.id,
        number,
        branchId: input.branchId,
        categoryId: cat.id,
        description: input.description,
        amount,
        currency: input.currency,
        exchangeRate: fx.rate,
        amountBase,
        expenseDate: input.expenseDate,
        supplierId: input.supplierId ?? null,
        status,
        approvedBy: status === 'posted' ? ctx.userId : null,
        approvedAt: status === 'posted' ? new Date() : null,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    const e = row!;
    if (status === 'posted') {
      await this.postEntry(e, cat.code);
    } else {
      await this.approvals.open(ctx, {
        type: 'expense',
        entityType: 'expense',
        entityId: e.id,
        requiredPermission: 'expenses.approve',
        summary: `${number}: ${cat.nameEn} ${amount} ${input.currency}`,
        payload: { categoryCode: cat.code, amountBase, expenseDate: e.expenseDate },
        branchId: e.branchId,
      });
    }
    await this.audit.record({
      action: status === 'posted' ? 'expense.posted' : 'expense.submitted',
      entityType: 'expense',
      entityId: e.id,
      summary: `${number}: ${cat.code} ${amount} ${input.currency}`,
      after: e,
    });
    if (input.payNow) await this.payNow(ctx, e, input.payNow);
    return this.detail(e.id);
  }

  /** Dr 6000 (branch) / Cr 2000 (supplier, may be null for direct purchases). */
  private async postEntry(e: ExpenseRow, categoryCode: string) {
    await this.posting.post({
      sourceType: 'expense',
      sourceId: e.id,
      event: 'expense.posted',
      date: e.expenseDate,
      description: `${e.number}: ${e.description}`,
      branchId: e.branchId,
      lines: [
        { account: ACCOUNTS.OPERATING_EXPENSES, debit: e.amountBase, branchId: e.branchId, memo: categoryCode },
        { account: ACCOUNTS.PAYABLES, credit: e.amountBase, branchId: e.branchId, supplierId: e.supplierId },
      ],
    });
  }

  /** Settles a just-posted expense in full from a base-currency cash/bank account. */
  private async payNow(ctx: TenantContext, e: ExpenseRow, pay: PayNowInput) {
    const acct = await this.cash.lockAccount(ctx, pay.cashAccountId);
    if (acct.currency !== ctx.tenant.baseCurrency) {
      throw unprocessable('pay_now_base_currency', 'Immediate payment requires an account in the company base currency');
    }
    return this.payments.pay(ctx, {
      supplierId: e.supplierId ?? null,
      cashAccountId: acct.id,
      paidAt: e.expenseDate,
      method: pay.method,
      reference: pay.reference ?? null,
      notes: `Paid on recording of ${e.number}`,
      amount: e.amountBase,
      allocations: [{ targetType: 'expense', targetId: e.id, amountBase: e.amountBase }],
    });
  }

  private async lock(id: string): Promise<ExpenseRow> {
    const [e] = await this.dbs.db.select().from(expenses).where(eq(expenses.id, id)).for('update');
    if (!e) throw notFound('Expense');
    return e;
  }

  private async categoryCode(categoryId: string): Promise<string> {
    const [c] = await this.dbs.db.select({ code: costCategories.code }).from(costCategories).where(eq(costCategories.id, categoryId));
    return c?.code ?? 'unknown';
  }

  async approve(ctx: TenantContext, id: string, note?: string | null) {
    const e = await this.lock(id);
    assertBranchAccess(ctx, e.branchId);
    if (e.status !== 'pending_approval') throw conflict('expense_not_pending', 'This expense is not awaiting approval', { status: e.status });
    await this.approvals.assertNotSelfApproval(ctx, { type: 'expense', entityType: 'expense', entityId: id, makers: [e.createdBy] });
    const [after] = await this.dbs.db
      .update(expenses)
      .set({ status: 'posted', approvedBy: ctx.userId, approvedAt: new Date() })
      .where(eq(expenses.id, id))
      .returning();
    await this.postEntry(after!, await this.categoryCode(e.categoryId));
    await this.approvals.resolve(ctx, { type: 'expense', entityType: 'expense', entityId: id, status: 'approved', note });
    await this.audit.record({
      action: 'expense.approved',
      entityType: 'expense',
      entityId: id,
      summary: `${e.number}: ${e.amountBase} ${ctx.tenant.baseCurrency}`,
      before: { status: e.status },
      after: { status: 'posted', amountBase: e.amountBase, note: note ?? null },
    });
    return this.detail(id);
  }

  async reject(ctx: TenantContext, id: string, reason: string) {
    const e = await this.lock(id);
    assertBranchAccess(ctx, e.branchId);
    if (e.status !== 'pending_approval') throw conflict('expense_not_pending', 'This expense is not awaiting approval', { status: e.status });
    await this.dbs.db.update(expenses).set({ status: 'rejected', rejectedReason: reason }).where(eq(expenses.id, id));
    await this.approvals.resolve(ctx, { type: 'expense', entityType: 'expense', entityId: id, status: 'rejected', note: reason });
    await this.audit.record({
      action: 'expense.rejected',
      entityType: 'expense',
      entityId: id,
      summary: e.number,
      before: { status: e.status },
      after: { status: 'rejected', reason },
    });
    return this.detail(id);
  }

  /**
   * Reverses a posted expense with a mirrored ledger entry dated today (or the expense date when
   * that is later). Paid expenses must have their supplier payments voided first, so payables
   * never go negative and the cash book stays the single record of money that left.
   */
  async reverse(ctx: TenantContext, id: string, reason: string) {
    const e = await this.lock(id);
    assertBranchAccess(ctx, e.branchId);
    if (e.status !== 'posted') throw conflict('expense_not_posted', 'Only posted expenses can be reversed', { status: e.status });
    // The row lock above serialises with SupplierPaymentsService.pay (which locks the document).
    const paid = await this.payables.paidBase('expense', id);
    if (d(paid).gt(0)) throw conflict('expense_has_payments', 'Void the supplier payments for this expense before reversing it', { paid });
    await this.dbs.db.update(expenses).set({ status: 'reversed', reversedAt: new Date(), reversalReason: reason }).where(eq(expenses.id, id));
    const today = todayInZone(ctx.tenant.settings.timezone);
    const entryId = await this.posting.reverse(
      { sourceType: 'expense', sourceId: id, event: 'expense.posted' },
      'expense.reversed',
      e.expenseDate > today ? e.expenseDate : today,
      `Reversal ${e.number}: ${reason}`,
    );
    if (!entryId) throw conflict('ledger_entry_missing', 'The ledger entry of this expense could not be found');
    await this.audit.record({
      action: 'expense.reversed',
      entityType: 'expense',
      entityId: id,
      summary: `${e.number}: ${e.amountBase} ${ctx.tenant.baseCurrency}`,
      before: { status: 'posted', amountBase: e.amountBase },
      after: { status: 'reversed', reason },
    });
    return this.detail(id);
  }

  async list(ctx: TenantContext, q: ExpenseListQuery) {
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(expenses.status, q.status));
    if (q.branchId) {
      assertBranchAccess(ctx, q.branchId);
      conds.push(eq(expenses.branchId, q.branchId));
    }
    if (q.categoryId) conds.push(eq(expenses.categoryId, q.categoryId));
    if (q.supplierId) conds.push(eq(expenses.supplierId, q.supplierId));
    if (q.from) conds.push(gte(expenses.expenseDate, q.from));
    if (q.to) conds.push(lte(expenses.expenseDate, q.to));
    const scope = this.branchScope(ctx);
    if (scope) conds.push(scope);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(sql`(${expenses.number} ILIKE ${like} OR ${expenses.description} ILIKE ${like} OR ${suppliers.name} ILIKE ${like})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const order = this.orderBy(q.sort);

    const items = await this.dbs.db
      .select({
        id: expenses.id,
        number: expenses.number,
        status: expenses.status,
        expenseDate: expenses.expenseDate,
        description: expenses.description,
        amount: expenses.amount,
        currency: expenses.currency,
        exchangeRate: expenses.exchangeRate,
        amountBase: expenses.amountBase,
        branchId: expenses.branchId,
        branchName: branches.name,
        categoryId: expenses.categoryId,
        categoryCode: costCategories.code,
        categoryEn: costCategories.nameEn,
        categoryAr: costCategories.nameAr,
        supplierId: expenses.supplierId,
        supplierName: suppliers.name,
        createdAt: expenses.createdAt,
        paidBase: sql<string>`${paidSql}::numeric(18,2)::text`,
        outstandingBase: sql<string | null>`CASE WHEN expenses.status = 'posted' THEN greatest(expenses.amount_base - ${paidSql}, 0)::numeric(18,2)::text END`,
      })
      .from(expenses)
      .innerJoin(costCategories, eq(costCategories.id, expenses.categoryId))
      .innerJoin(branches, eq(branches.id, expenses.branchId))
      .leftJoin(suppliers, eq(suppliers.id, expenses.supplierId))
      .where(where)
      .orderBy(...order)
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [c] = await this.dbs.db
      .select({ n: sql<number>`count(*)::int` })
      .from(expenses)
      .leftJoin(suppliers, eq(suppliers.id, expenses.supplierId))
      .where(where);
    return { items, total: c?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  private orderBy(sort?: string): SQL[] {
    const columns = {
      expenseDate: expenses.expenseDate,
      amountBase: expenses.amountBase,
      number: expenses.number,
      createdAt: expenses.createdAt,
    } satisfies Record<ExpenseSortKey, unknown>;
    if (!sort) return [desc(expenses.expenseDate), desc(expenses.createdAt), desc(expenses.id)];
    const key = sort.replace(/^-/, '');
    if (!(EXPENSE_SORT_KEYS as readonly string[]).includes(key)) {
      throw unprocessable('invalid_sort', `Unknown sort key ${key}`, { allowed: EXPENSE_SORT_KEYS });
    }
    const dir = sort.startsWith('-') ? desc : asc;
    return [dir(columns[key as ExpenseSortKey]), desc(expenses.createdAt), desc(expenses.id)];
  }

  async get(ctx: TenantContext, id: string) {
    const [row] = await this.dbs.db.select({ branchId: expenses.branchId }).from(expenses).where(eq(expenses.id, id));
    if (!row) throw notFound('Expense');
    assertBranchAccess(ctx, row.branchId);
    return this.detail(id);
  }

  /** Full expense view (no access checks — callers have already verified branch scope). */
  private async detail(id: string) {
    const [row] = await this.dbs.db
      .select({
        expense: expenses,
        categoryCode: costCategories.code,
        categoryEn: costCategories.nameEn,
        categoryAr: costCategories.nameAr,
        branchName: branches.name,
        supplierName: suppliers.name,
        createdByName: users.fullName,
        approvedByName: approver.fullName,
      })
      .from(expenses)
      .innerJoin(costCategories, eq(costCategories.id, expenses.categoryId))
      .innerJoin(branches, eq(branches.id, expenses.branchId))
      .leftJoin(suppliers, eq(suppliers.id, expenses.supplierId))
      .leftJoin(users, eq(users.id, expenses.createdBy))
      .leftJoin(approver, eq(approver.id, expenses.approvedBy))
      .where(eq(expenses.id, id));
    if (!row) throw notFound('Expense');
    const e = row.expense;
    const payable = await this.payables.describe('expense', id);
    const payments = await this.payments.forTargets('expense', [id]);
    const ledger = await this.dbs.db
      .select({ id: journalEntries.id, entryNo: journalEntries.entryNo, entryDate: journalEntries.entryDate, event: journalEntries.event })
      .from(journalEntries)
      .where(and(eq(journalEntries.sourceType, 'expense'), eq(journalEntries.sourceId, id)))
      .orderBy(asc(journalEntries.entryNo));
    return {
      ...e,
      categoryCode: row.categoryCode,
      categoryEn: row.categoryEn,
      categoryAr: row.categoryAr,
      branchName: row.branchName,
      supplierName: row.supplierName,
      createdByName: row.createdByName,
      approvedByName: e.status === 'posted' || e.status === 'reversed' ? row.approvedByName : null,
      paidBase: payable.paidBase,
      outstandingBase: e.status === 'posted' ? payable.outstandingBase : null,
      payments,
      journalEntries: ledger,
    };
  }

  /** Posted expenses (reversed and pending excluded) totalled by category and by month. */
  async summary(ctx: TenantContext, q: ExpenseSummaryQuery) {
    const conds: SQL[] = [eq(expenses.status, 'posted')];
    if (q.branchId) {
      assertBranchAccess(ctx, q.branchId);
      conds.push(eq(expenses.branchId, q.branchId));
    }
    if (q.from) conds.push(gte(expenses.expenseDate, q.from));
    if (q.to) conds.push(lte(expenses.expenseDate, q.to));
    const scope = this.branchScope(ctx);
    if (scope) conds.push(scope);
    const where = and(...conds);
    const totalSql = sql<string>`coalesce(sum(${expenses.amountBase}), 0)::numeric(18,2)::text`;
    const countSql = sql<number>`count(*)::int`;

    const byCategory = await this.dbs.db
      .select({
        categoryId: costCategories.id,
        code: costCategories.code,
        nameEn: costCategories.nameEn,
        nameAr: costCategories.nameAr,
        count: countSql,
        totalBase: totalSql,
      })
      .from(expenses)
      .innerJoin(costCategories, eq(costCategories.id, expenses.categoryId))
      .where(where)
      .groupBy(costCategories.id, costCategories.code, costCategories.nameEn, costCategories.nameAr)
      .orderBy(desc(sql`sum(${expenses.amountBase})`), asc(costCategories.code));

    const monthSql = sql<string>`to_char(${expenses.expenseDate}, 'YYYY-MM')`;
    const byMonth = await this.dbs.db
      .select({ month: monthSql, count: countSql, totalBase: totalSql })
      .from(expenses)
      .where(where)
      .groupBy(monthSql)
      .orderBy(monthSql);

    const currency = ctx.tenant.baseCurrency;
    return {
      currency,
      from: q.from ?? null,
      to: q.to ?? null,
      branchId: q.branchId ?? null,
      totalBase: money(sum(byMonth.map((m) => m.totalBase)), currency),
      count: byMonth.reduce((n, m) => n + m.count, 0),
      byCategory,
      byMonth,
    };
  }
}
