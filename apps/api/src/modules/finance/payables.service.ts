import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { d } from '@autohub/shared';
import { notFound } from '../../common/errors';
import { DbService } from '../../db/db.service';
import { acquisitions, expenses, supplierPaymentAllocations, supplierPayments, vehicleCosts, vehicles } from '../../db/schema';

export type PayableType = 'acquisition' | 'vehicle_cost' | 'expense';

export interface PayableInfo {
  targetType: PayableType;
  targetId: string;
  supplierId: string | null;
  branchId: string | null;
  label: string;
  /** Only approved/posted documents can be paid. */
  payable: boolean;
  /** Document currency and amounts (equal to the base figures for base-currency documents). */
  currency: string;
  totalDoc: string;
  paidDoc: string;
  outstandingDoc: string;
  /** Carrying amounts in base currency: what the payable was booked at and what has been relieved. */
  totalBase: string;
  paidBase: string;
  outstandingBase: string;
}

const nonNeg = (v: ReturnType<typeof d>) => (v.isNegative() ? d(0) : v).toFixed(2);

/**
 * Accounts payable view per source document. Totals come from the posted document; paid amounts
 * from allocations of non-voided supplier payments. `amount_base` on an allocation is the carrying
 * base relieved from the payable; `amount_doc` the document-currency amount settled.
 */
@Injectable()
export class PayablesService {
  constructor(private readonly dbs: DbService) {}

  async paidBase(targetType: PayableType, targetId: string): Promise<string> {
    return (await this.paid(targetType, targetId)).base;
  }

  private async paid(targetType: PayableType, targetId: string): Promise<{ base: string; doc: string; baseWithoutDoc: string }> {
    const [row] = await this.dbs.db
      .select({
        base: sql<string>`coalesce(sum(${supplierPaymentAllocations.amountBase}), 0)::numeric(18,2)::text`,
        doc: sql<string>`coalesce(sum(${supplierPaymentAllocations.amountDoc}), 0)::numeric(18,2)::text`,
        baseWithoutDoc: sql<string>`coalesce(sum(${supplierPaymentAllocations.amountBase}) FILTER (WHERE ${supplierPaymentAllocations.amountDoc} IS NULL), 0)::numeric(18,2)::text`,
      })
      .from(supplierPaymentAllocations)
      .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.paymentId))
      .where(
        and(
          eq(supplierPaymentAllocations.targetType, targetType),
          eq(supplierPaymentAllocations.targetId, targetId),
          eq(supplierPayments.status, 'posted'),
        ),
      );
    return { base: row?.base ?? '0.00', doc: row?.doc ?? '0.00', baseWithoutDoc: row?.baseWithoutDoc ?? '0.00' };
  }

  /**
   * Describes (and optionally locks) a payable document. Locking serialises concurrent payments
   * against the same document so it can never be overpaid.
   */
  async describe(targetType: PayableType, targetId: string, lock = false): Promise<PayableInfo> {
    const db = this.dbs.db;
    let info: { supplierId: string | null; branchId: string | null; label: string; payable: boolean; currency: string; amountDoc: string; amountBase: string };
    if (targetType === 'acquisition') {
      const q = db.select().from(acquisitions).where(eq(acquisitions.id, targetId));
      const [a] = lock ? await q.for('update') : await q;
      if (!a) throw notFound('Acquisition');
      info = { supplierId: a.supplierId, branchId: a.branchId, label: a.number, payable: a.status === 'approved', currency: a.currency, amountDoc: a.purchasePrice, amountBase: a.purchasePriceBase };
    } else if (targetType === 'vehicle_cost') {
      const q = db.select().from(vehicleCosts).where(eq(vehicleCosts.id, targetId));
      const [c] = lock ? await q.for('update') : await q;
      if (!c) throw notFound('Vehicle cost');
      const [v] = await db.select({ branchId: vehicles.branchId }).from(vehicles).where(eq(vehicles.id, c.vehicleId));
      // Purchase costs are settled against the acquisition document; trade-in costs credit the
      // customer (2100), not a supplier payable, so neither can be paid as a vehicle cost.
      const payable = c.status === 'posted' && c.sourceType !== 'acquisition' && c.sourceType !== 'trade_in';
      info = { supplierId: c.supplierId, branchId: v?.branchId ?? null, label: c.description, payable, currency: c.currency, amountDoc: c.amount, amountBase: c.amountBase };
    } else {
      const q = db.select().from(expenses).where(eq(expenses.id, targetId));
      const [e] = lock ? await q.for('update') : await q;
      if (!e) throw notFound('Expense');
      info = { supplierId: e.supplierId, branchId: e.branchId, label: e.number, payable: e.status === 'posted', currency: e.currency, amountDoc: e.amount, amountBase: e.amountBase };
    }
    const paid = await this.paid(targetType, targetId);
    const totalBase = info.payable ? info.amountBase : '0.00';
    const totalDoc = info.payable ? info.amountDoc : '0.00';
    // Allocations made before document-currency tracking carry no amount_doc: convert their
    // carrying base at the document's own rate (no FX difference was possible then).
    const legacyDoc = d(info.amountBase).isZero() ? d(0) : d(paid.baseWithoutDoc).times(info.amountDoc).dividedBy(info.amountBase).toDecimalPlaces(2);
    const paidDoc = d(paid.doc).plus(legacyDoc).toFixed(2);
    return {
      targetType,
      targetId,
      supplierId: info.supplierId,
      branchId: info.branchId,
      label: info.label,
      payable: info.payable,
      currency: info.currency,
      totalDoc,
      paidDoc,
      outstandingDoc: nonNeg(d(totalDoc).minus(paidDoc)),
      totalBase,
      paidBase: paid.base,
      outstandingBase: nonNeg(d(totalBase).minus(paid.base)),
    };
  }
}
