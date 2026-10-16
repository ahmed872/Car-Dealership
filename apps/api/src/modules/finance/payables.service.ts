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
  totalBase: string;
  paidBase: string;
  outstandingBase: string;
}

/**
 * Accounts payable view per source document. Totals come from the posted document; paid amounts
 * from allocations of non-voided supplier payments.
 */
@Injectable()
export class PayablesService {
  constructor(private readonly dbs: DbService) {}

  async paidBase(targetType: PayableType, targetId: string): Promise<string> {
    const [row] = await this.dbs.db
      .select({ paid: sql<string>`coalesce(sum(${supplierPaymentAllocations.amountBase}), 0)::numeric(18,2)::text` })
      .from(supplierPaymentAllocations)
      .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.paymentId))
      .where(
        and(
          eq(supplierPaymentAllocations.targetType, targetType),
          eq(supplierPaymentAllocations.targetId, targetId),
          eq(supplierPayments.status, 'posted'),
        ),
      );
    return row?.paid ?? '0.00';
  }

  /**
   * Describes (and optionally locks) a payable document. Locking serialises concurrent payments
   * against the same document so it can never be overpaid.
   */
  async describe(targetType: PayableType, targetId: string, lock = false): Promise<PayableInfo> {
    const db = this.dbs.db;
    let info: Omit<PayableInfo, 'paidBase' | 'outstandingBase'>;
    if (targetType === 'acquisition') {
      const q = db.select().from(acquisitions).where(eq(acquisitions.id, targetId));
      const [a] = lock ? await q.for('update') : await q;
      if (!a) throw notFound('Acquisition');
      info = {
        targetType,
        targetId,
        supplierId: a.supplierId,
        branchId: a.branchId,
        label: a.number,
        payable: a.status === 'approved',
        totalBase: a.status === 'approved' ? a.purchasePriceBase : '0.00',
      };
    } else if (targetType === 'vehicle_cost') {
      const q = db.select().from(vehicleCosts).where(eq(vehicleCosts.id, targetId));
      const [c] = lock ? await q.for('update') : await q;
      if (!c) throw notFound('Vehicle cost');
      const [v] = await db.select({ branchId: vehicles.branchId }).from(vehicles).where(eq(vehicles.id, c.vehicleId));
      // Purchase costs are settled against the acquisition document; trade-in costs credit the
      // customer (2100), not a supplier payable, so neither can be paid as a vehicle cost.
      const payable = c.status === 'posted' && c.sourceType !== 'acquisition' && c.sourceType !== 'trade_in';
      info = { targetType, targetId, supplierId: c.supplierId, branchId: v?.branchId ?? null, label: c.description, payable, totalBase: payable ? c.amountBase : '0.00' };
    } else {
      const q = db.select().from(expenses).where(eq(expenses.id, targetId));
      const [e] = lock ? await q.for('update') : await q;
      if (!e) throw notFound('Expense');
      info = {
        targetType,
        targetId,
        supplierId: e.supplierId,
        branchId: e.branchId,
        label: e.number,
        payable: e.status === 'posted',
        totalBase: e.status === 'posted' ? e.amountBase : '0.00',
      };
    }
    const paidBase = await this.paidBase(targetType, targetId);
    const outstanding = d(info.totalBase).minus(paidBase);
    return { ...info, paidBase, outstandingBase: (outstanding.isNegative() ? d(0) : outstanding).toFixed(2) };
  }
}
