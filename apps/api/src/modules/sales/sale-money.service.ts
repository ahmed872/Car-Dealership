import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { d, todayInZone } from '@autohub/shared';
import { TenantContext } from '../../common/context';
import { conflict, notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { journalEntries, journalLines, sales, vehicles } from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { ReceiptsService } from '../finance/receipts.service';
import { RefundsService } from '../finance/refunds.service';
import { ACCOUNTS } from '../ledger/chart';
import { PostingLine, PostingService } from '../ledger/posting.service';
import { CommissionsService } from './commissions.service';
import { InstallmentsService } from './installments.service';

export type SaleRow = typeof sales.$inferSelect;

const LIVE = ['draft', 'pending_approval', 'approved', 'confirmed', 'delivered'];

/**
 * The money side of a sale (D-028). Everything the customer gives for a sale — receipts, trade-in
 * value, a converted reservation deposit — is held in 2100 (customer advances, sale dimension)
 * until the sale is recognised. Recognition books revenue, tax, deferred finance income and COGS,
 * then applies the held money to the receivable. After recognition new receipts credit 1200
 * directly. Cancellation or return unwinds all of it, leaving the money as refundable credit.
 */
@Injectable()
export class SaleMoneyService {
  constructor(
    private readonly dbs: DbService,
    private readonly posting: PostingService,
    private readonly receipts: ReceiptsService,
    private readonly refunds: RefundsService,
    private readonly installments: InstallmentsService,
    private readonly commissions: CommissionsService,
    private readonly audit: AuditService,
  ) {
    ReceiptsService.register('sale', {
      describe: async (saleId, lock) => {
        const s = await this.find(saleId, lock);
        const outstanding = d(this.dueUpfront(s)).minus(await this.held(s));
        return {
          customerId: s.customerId,
          branchId: s.branchId,
          label: s.number,
          acceptsPayment: LIVE.includes(s.status),
          outstandingBase: (outstanding.isNegative() ? d(0) : outstanding).toFixed(2),
        };
      },
      creditLines: async (saleId, amountBase, customerId) => {
        const s = await this.find(saleId, false);
        // Recognised: the receivable is reduced directly; otherwise it is held as an advance.
        return [
          this.isRecognized(s)
            ? { account: ACCOUNTS.RECEIVABLES, credit: amountBase, customerId, saleId, memo: 'sale payment' }
            : { account: ACCOUNTS.CUSTOMER_ADVANCES, credit: amountBase, customerId, saleId, memo: 'sale payment' },
        ];
      },
      afterReceived: async (ctx, saleId) => {
        const s = await this.find(saleId, true);
        await this.commissions.checkEarned(ctx, s, await this.fullyPaid(s));
      },
      beforeVoid: async (ctx, saleId, amountBase, receiptId) => {
        const s = await this.find(saleId, true);
        if (['cancelled', 'returned'].includes(s.status)) {
          const refundable = await this.refundableBase(s);
          if (d(refundable).lt(amountBase)) throw conflict('receipt_refunded', 'Part of this payment was already refunded; reverse the refund first');
          // A payment received after recognition credited the receivable, and the unwind turned it
          // into customer credit. The void reverses the receivable credit, so move it back first:
          // the money then leaves customer credit and the receivable stays at zero.
          const onReceivable = await this.receiptCreditOn(receiptId, ACCOUNTS.RECEIVABLES, saleId);
          if (d(onReceivable).gt(0)) {
            await this.posting.post({
              sourceType: 'sale',
              sourceId: s.id,
              event: `credit_voided:${receiptId}`,
              date: todayInZone(ctx.tenant.settings.timezone),
              description: `${s.number}: payment voided after the sale was closed`,
              branchId: s.branchId,
              lines: [
                { account: ACCOUNTS.CUSTOMER_ADVANCES, debit: onReceivable, customerId: s.customerId, saleId: s.id },
                { account: ACCOUNTS.RECEIVABLES, credit: onReceivable, customerId: s.customerId, saleId: s.id },
              ],
            });
          }
          return;
        }
        if (!this.isRecognized(s)) return;
        // A payment received before recognition was applied to the receivable at recognition:
        // voiding it must re-open that receivable (the void itself only reverses the advance).
        const heldAsAdvance = await this.receiptCreditOn(receiptId, ACCOUNTS.CUSTOMER_ADVANCES, saleId);
        if (d(heldAsAdvance).gt(0)) {
          await this.posting.post({
            sourceType: 'sale',
            sourceId: s.id,
            event: `credit_unapplied:${receiptId}`,
            date: todayInZone(ctx.tenant.settings.timezone),
            description: `${s.number}: payment voided, receivable re-opened`,
            branchId: s.branchId,
            lines: [
              { account: ACCOUNTS.RECEIVABLES, debit: amountBase, customerId: s.customerId, saleId: s.id },
              { account: ACCOUNTS.CUSTOMER_ADVANCES, credit: amountBase, customerId: s.customerId, saleId: s.id },
            ],
          });
        }
      },
    });
    RefundsService.register('sale', {
      describe: async (saleId, lock) => {
        const s = await this.find(saleId, lock);
        return { customerId: s.customerId, branchId: s.branchId, label: s.number, refundableBase: await this.refundableBase(s) };
      },
    });
  }

  async find(id: string, lock = false): Promise<SaleRow> {
    const q = this.dbs.db.select().from(sales).where(eq(sales.id, id));
    const [s] = lock ? await q.for('update') : await q;
    if (!s) throw notFound('Sale');
    return s;
  }

  isRecognized(s: SaleRow): boolean {
    return !!s.recognizedAt && LIVE.includes(s.status);
  }

  /** What the customer pays before delivery: everything (cash / finance) or the down payment. */
  dueUpfront(s: SaleRow): string {
    return s.paymentType === 'installments' ? s.downPayment! : s.grossAmount;
  }

  /** Money held for the sale: posted receipts + trade-in credit + converted deposit. */
  async held(s: SaleRow): Promise<string> {
    return d(await this.receipts.receivedBase('sale', s.id)).plus(s.tradeInCredit).plus(s.depositTransferred).toFixed(2);
  }

  async fullyPaid(s: SaleRow): Promise<boolean> {
    if (s.paymentType === 'installments') {
      const plan = await this.installments.forSale(s.id);
      return !!plan && (await this.installments.saleFullyPaid(s, plan.status));
    }
    return d(await this.held(s)).gte(s.grossAmount);
  }

  /** Credit refundable on a closed (cancelled/returned) sale; nothing while it is live. */
  async refundableBase(s: SaleRow): Promise<string> {
    if (!['cancelled', 'returned'].includes(s.status)) return '0.00';
    const plan = await this.installments.forSale(s.id);
    const collected = plan ? (await this.installments.collected(plan.id)).total : '0';
    const v = d(await this.held(s)).plus(collected).minus(await this.refunds.committedBase('sale', s.id));
    return (v.isNegative() ? d(0) : v).toFixed(2);
  }

  /** Credit posted to `account` for `saleId` by a receipt's GL entry. */
  private async receiptCreditOn(receiptId: string, account: string, saleId: string): Promise<string> {
    const [r] = await this.dbs.db
      .select({ v: sql<string>`coalesce(sum(${journalLines.credit}), 0)::numeric(18,2)::text` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(journalEntries.sourceType, 'receipt'),
          eq(journalEntries.sourceId, receiptId),
          eq(journalEntries.event, 'receipt.posted'),
          eq(journalLines.accountCode, account),
          eq(journalLines.saleId, saleId),
        ),
      );
    return r?.v ?? '0.00';
  }

  // ── Recognition ───────────────────────────────────────────────────────────────────────

  /**
   * Revenue recognition (on delivery by default, B-001):
   *   Dr 1200 gross (+ financed interest & fees) / Cr 4000 net / Cr 2200 tax / Cr 2400 interest & fees
   *   Dr 5000 / Cr 1300 the vehicle's capitalised cost (COGS), then the cost is locked
   *   Dr 2100 / Cr 1200 the money held so far (applied to the receivable)
   */
  async recognize(ctx: TenantContext, s: SaleRow): Promise<SaleRow> {
    if (s.recognizedAt) return s;
    const date = todayInZone(ctx.tenant.settings.timezone);
    const plan = s.paymentType === 'installments' ? await this.installments.forSale(s.id, true) : null;
    const finance = plan ? d(plan.interestTotal).plus(plan.feesTotal) : d(0);
    const lines: PostingLine[] = [
      { account: ACCOUNTS.RECEIVABLES, debit: d(s.grossAmount).plus(finance).toFixed(2), customerId: s.customerId, saleId: s.id },
      { account: ACCOUNTS.SALES_REVENUE, credit: s.netAmount, customerId: s.customerId, vehicleId: s.vehicleId, saleId: s.id },
    ];
    if (d(s.taxAmount).gt(0)) lines.push({ account: ACCOUNTS.TAX_PAYABLE, credit: s.taxAmount, saleId: s.id });
    if (finance.gt(0)) lines.push({ account: ACCOUNTS.DEFERRED_FINANCE_INCOME, credit: finance.toFixed(2), saleId: s.id });
    await this.posting.post({ sourceType: 'sale', sourceId: s.id, event: 'sale.recognized', date, description: `Sale ${s.number}`, branchId: s.branchId, lines });

    const cogs = d(await this.posting.balance(ACCOUNTS.INVENTORY, { vehicleId: s.vehicleId }));
    if (cogs.isNegative()) throw conflict('negative_inventory', 'The vehicle carries a negative inventory balance; review its costs before delivery');
    if (cogs.gt(0)) {
      await this.posting.post({
        sourceType: 'sale',
        sourceId: s.id,
        event: 'sale.cogs',
        date,
        description: `Cost of sale ${s.number}`,
        branchId: s.branchId,
        lines: [
          { account: ACCOUNTS.COGS, debit: cogs.toFixed(2), vehicleId: s.vehicleId, saleId: s.id },
          { account: ACCOUNTS.INVENTORY, credit: cogs.toFixed(2), vehicleId: s.vehicleId },
        ],
      });
    }
    // Costs posted from now on are costs of the sale (5000), not inventory.
    await this.dbs.db.update(vehicles).set({ costLockedAt: new Date() }).where(eq(vehicles.id, s.vehicleId));

    const held = d(await this.held(s));
    if (held.gt(0)) {
      await this.posting.post({
        sourceType: 'sale',
        sourceId: s.id,
        event: 'sale.credit_applied',
        date,
        description: `${s.number}: payments applied to the receivable`,
        branchId: s.branchId,
        lines: [
          { account: ACCOUNTS.CUSTOMER_ADVANCES, debit: held.toFixed(2), customerId: s.customerId, saleId: s.id },
          { account: ACCOUNTS.RECEIVABLES, credit: held.toFixed(2), customerId: s.customerId, saleId: s.id },
        ],
      });
    }
    const [after] = await this.dbs.db
      .update(sales)
      .set({ recognizedAt: new Date(), recognitionDate: date, cogsAmount: cogs.toFixed(2), updatedAt: new Date() })
      .where(eq(sales.id, s.id))
      .returning();
    if (plan) await this.installments.activate(ctx, plan);
    await this.audit.record({
      action: 'sale.recognized',
      entityType: 'sale',
      entityId: s.id,
      summary: s.number,
      after: { date, net: s.netAmount, tax: s.taxAmount, financeIncomeDeferred: finance.toFixed(2), cogs: cogs.toFixed(2), applied: held.toFixed(2) },
    });
    return after!;
  }

  /**
   * Undoes recognition for a cancellation/return: installments collected become credit, the money
   * applied to the receivable goes back to 2100, revenue/tax/deferred income and COGS are
   * reversed and the vehicle's cost is unlocked. Afterwards the sale's receivable is zero and
   * every amount the customer gave is refundable credit.
   */
  async unwind(ctx: TenantContext, s: SaleRow, reason: string): Promise<void> {
    if (!s.recognizedAt) return;
    const date = todayInZone(ctx.tenant.settings.timezone);
    const plan = await this.installments.forSale(s.id, true);
    if (plan && plan.status !== 'cancelled') await this.installments.unwind(ctx, plan, s, date);
    const held = d(await this.held(s));
    if (held.gt(0)) {
      await this.posting.post({
        sourceType: 'sale',
        sourceId: s.id,
        event: 'sale.credit_unapplied',
        date,
        description: `${s.number}: payments returned to customer credit`,
        branchId: s.branchId,
        lines: [
          { account: ACCOUNTS.RECEIVABLES, debit: held.toFixed(2), customerId: s.customerId, saleId: s.id },
          { account: ACCOUNTS.CUSTOMER_ADVANCES, credit: held.toFixed(2), customerId: s.customerId, saleId: s.id },
        ],
      });
    }
    await this.posting.reverse({ sourceType: 'sale', sourceId: s.id, event: 'sale.recognized' }, 'sale.recognized.reversed', date, `Reversal: ${reason}`.slice(0, 500));
    if (s.cogsAmount && d(s.cogsAmount).gt(0)) {
      await this.posting.reverse({ sourceType: 'sale', sourceId: s.id, event: 'sale.cogs' }, 'sale.cogs.reversed', date, `Reversal: ${reason}`.slice(0, 500));
    }
    await this.dbs.db.update(vehicles).set({ costLockedAt: null }).where(eq(vehicles.id, s.vehicleId));
    await this.audit.record({ action: 'sale.unwound', entityType: 'sale', entityId: s.id, summary: s.number, after: { reason, creditReturned: held.toFixed(2) } });
  }

  /** AR balance of the sale in the GL (for detail views and tests). */
  receivableBalance(saleId: string): Promise<string> {
    return this.posting.balance(ACCOUNTS.RECEIVABLES, { saleId });
  }
}
