import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, money, pk, tenantId, ts, updatedAt } from './_columns';
import { cashAccounts } from './purchasing';
import { customers, leads, reservations } from './crm';
import { branches, tenants } from './tenancy';
import { vehicles } from './vehicles';

export const SALE_STATUSES = ['draft', 'pending_approval', 'approved', 'confirmed', 'delivered', 'cancelled', 'returned'] as const;
export const SALE_PAYMENT_TYPES = ['cash', 'installments', 'external_finance'] as const;
/** Statuses in which a sale holds its vehicle (one at a time per vehicle). */
export const SALE_HOLDING_STATUSES = ['draft', 'pending_approval', 'approved', 'confirmed', 'delivered'] as const;

/**
 * A vehicle sale (one vehicle per sale, base currency; D-027). Prices and tax are frozen at
 * confirmation; the vehicle, customer and pricing snapshots make documents reproducible.
 */
export const sales = pgTable(
  'sales',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    leadId: uuid('lead_id').references(() => leads.id),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    salespersonId: uuid('salesperson_id').notNull(),
    status: text('status').notNull().default('draft'),
    paymentType: text('payment_type').notNull().default('cash'),
    saleDate: date('sale_date', { mode: 'string' }).notNull(),
    /** Vehicle status before the sale took it (available | reserved), restored on draft cancel. */
    vehiclePriorStatus: text('vehicle_prior_status').notNull(),
    // ── Pricing (base currency) ──
    askingPrice: money('asking_price'),
    floorPrice: money('floor_price'),
    agreedPrice: money('agreed_price').notNull(),
    discountAmount: money('discount_amount').notNull().default('0'),
    discountPct: numeric('discount_pct', { precision: 9, scale: 4 }).notNull().default('0'),
    taxMode: text('tax_mode').notNull(),
    taxRatePct: numeric('tax_rate_pct', { precision: 7, scale: 4 }).notNull(),
    pricesIncludeTax: boolean('prices_include_tax').notNull(),
    netAmount: money('net_amount').notNull(),
    taxAmount: money('tax_amount').notNull(),
    grossAmount: money('gross_amount').notNull(),
    /** Amount the customer pays before delivery (cash + trade-in + deposit); installment sales only. */
    downPayment: money('down_payment'),
    /** Gross − down payment for installment sales; financed by the dealer's plan. */
    financedAmount: money('financed_amount'),
    /** Installment terms chosen on the draft; the plan and its frozen schedule are created at confirmation. */
    installmentTerms: jsonb('installment_terms'),
    tradeInCredit: money('trade_in_credit').notNull().default('0'),
    /** Reservation deposit moved to this sale at confirmation. */
    depositTransferred: money('deposit_transferred').notNull().default('0'),
    externalFinance: jsonb('external_finance'),
    // ── Approval of the price (B-011) ──
    approvalPermission: text('approval_permission'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    // ── Snapshots & recognition ──
    vehicleSnapshot: jsonb('vehicle_snapshot').notNull(),
    customerSnapshot: jsonb('customer_snapshot').notNull(),
    costAtConfirmation: money('cost_at_confirmation'),
    cogsAmount: money('cogs_amount'),
    recognizedAt: ts('recognized_at'),
    recognitionDate: date('recognition_date', { mode: 'string' }),
    confirmedAt: ts('confirmed_at'),
    confirmedBy: uuid('confirmed_by'),
    deliveredAt: ts('delivered_at'),
    deliveredBy: uuid('delivered_by'),
    deliveryOverrideReason: text('delivery_override_reason'),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: uuid('cancelled_by'),
    cancelReason: text('cancel_reason'),
    returnedAt: ts('returned_at'),
    returnedBy: uuid('returned_by'),
    returnReason: text('return_reason'),
    notes: text('notes'),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sales_number_uq').on(t.tenantId, t.number),
    // Exactly one live sale per vehicle: prevents double sales even under concurrency.
    uniqueIndex('sales_vehicle_active_uq')
      .on(t.tenantId, t.vehicleId)
      .where(sql`status IN ('draft', 'pending_approval', 'approved', 'confirmed', 'delivered')`),
    index('sales_customer_idx').on(t.tenantId, t.customerId),
    index('sales_status_idx').on(t.tenantId, t.status, t.saleDate),
    index('sales_salesperson_idx').on(t.tenantId, t.salespersonId),
    check('sales_status_chk', inList('status', SALE_STATUSES)),
    check('sales_payment_type_chk', inList('payment_type', SALE_PAYMENT_TYPES)),
    check(
      'sales_amounts_chk',
      sql`agreed_price > 0 AND net_amount >= 0 AND tax_amount >= 0 AND gross_amount = net_amount + tax_amount AND trade_in_credit >= 0 AND deposit_transferred >= 0`,
    ),
    check(
      'sales_installments_chk',
      sql`(payment_type = 'installments') = (financed_amount IS NOT NULL AND down_payment IS NOT NULL) AND (financed_amount IS NULL OR (financed_amount > 0 AND down_payment >= 0 AND down_payment + financed_amount = gross_amount))`,
    ),
  ],
);

/** A customer's vehicle taken in part exchange: capitalised at the agreed value (Dr 1300 / Cr 2100). */
export const tradeIns = pgTable(
  'trade_ins',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    agreedValue: money('agreed_value').notNull(),
    /** Vehicle details used to create the stock vehicle at confirmation. */
    vehicleInput: jsonb('vehicle_input').notNull(),
    vehicleId: uuid('vehicle_id').references(() => vehicles.id),
    costId: uuid('cost_id'),
    status: text('status').notNull().default('pending'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('trade_ins_sale_idx').on(t.tenantId, t.saleId),
    check('trade_ins_status_chk', inList('status', ['pending', 'received', 'cancelled'])),
    check('trade_ins_value_chk', sql`agreed_value > 0`),
  ],
);

export const INSTALLMENT_PLAN_STATUSES = ['scheduled', 'active', 'settled', 'completed', 'cancelled'] as const;

/** In-house installment plan; the schedule is frozen at confirmation (B-005). */
export const installmentPlans = pgTable(
  'installment_plans',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    method: text('method').notNull(),
    annualRatePct: numeric('annual_rate_pct', { precision: 9, scale: 4 }).notNull(),
    periodicRatePct: numeric('periodic_rate_pct', { precision: 12, scale: 8 }).notNull(),
    count: integer('count').notNull(),
    frequencyMonths: integer('frequency_months').notNull(),
    firstDueDate: date('first_due_date', { mode: 'string' }).notNull(),
    principal: money('principal').notNull(),
    interestTotal: money('interest_total').notNull(),
    feesTotal: money('fees_total').notNull(),
    totalAmount: money('total_amount').notNull(),
    allocationOrder: jsonb('allocation_order').notNull(),
    futureInterestPolicy: text('future_interest_policy').notNull(),
    status: text('status').notNull().default('scheduled'),
    activatedAt: ts('activated_at'),
    settledAt: ts('settled_at'),
    waivedInterest: money('waived_interest').notNull().default('0'),
    cancelledAt: ts('cancelled_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('installment_plans_sale_uq').on(t.tenantId, t.saleId),
    index('installment_plans_status_idx').on(t.tenantId, t.status),
    check('installment_plans_status_chk', inList('status', INSTALLMENT_PLAN_STATUSES)),
    check('installment_plans_total_chk', sql`total_amount = principal + interest_total + fees_total AND principal > 0 AND count > 0`),
  ],
);

/** One scheduled installment (immutable amounts; paid amounts are derived from allocations). */
export const installments = pgTable(
  'installments',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    planId: uuid('plan_id')
      .notNull()
      .references(() => installmentPlans.id),
    seq: integer('seq').notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    principalDue: money('principal_due').notNull(),
    interestDue: money('interest_due').notNull(),
    feesDue: money('fees_due').notNull(),
    totalDue: money('total_due').notNull(),
  },
  (t) => [
    uniqueIndex('installments_plan_seq_uq').on(t.planId, t.seq),
    index('installments_due_idx').on(t.tenantId, t.dueDate),
    check('installments_total_chk', sql`total_due = principal_due + interest_due + fees_due`),
  ],
);

/** How a receipt was split over installments (append-only; voided receipts are ignored). */
export const installmentAllocations = pgTable(
  'installment_allocations',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    receiptId: uuid('receipt_id').notNull(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => installmentPlans.id),
    installmentId: uuid('installment_id')
      .notNull()
      .references(() => installments.id),
    principal: money('principal').notNull(),
    interest: money('interest').notNull(),
    fees: money('fees').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('installment_allocations_plan_idx').on(t.tenantId, t.planId),
    index('installment_allocations_receipt_idx').on(t.tenantId, t.receiptId),
    check('installment_allocations_amounts_chk', sql`principal >= 0 AND interest >= 0 AND fees >= 0 AND principal + interest + fees > 0`),
  ],
);

export const COMMISSION_STATUSES = ['expected', 'earned', 'approved', 'paid', 'reversed', 'clawback'] as const;

/** A salesperson's commission on a sale, with the policy version and rule snapshot (B-006). */
export const commissions = pgTable(
  'commissions',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id),
    userId: uuid('user_id').notNull(),
    policyId: uuid('policy_id').notNull(),
    ruleSnapshot: jsonb('rule_snapshot').notNull(),
    earnOn: text('earn_on').notNull(),
    baseAmount: money('base_amount').notNull(),
    amount: money('amount').notNull(),
    explanation: text('explanation'),
    status: text('status').notNull().default('expected'),
    earnedAt: ts('earned_at'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    paidAt: ts('paid_at'),
    paidFromAccountId: uuid('paid_from_account_id').references(() => cashAccounts.id),
    reversedAt: ts('reversed_at'),
    reverseReason: text('reverse_reason'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('commissions_sale_user_uq').on(t.tenantId, t.saleId, t.userId),
    index('commissions_user_idx').on(t.tenantId, t.userId, t.status),
    check('commissions_status_chk', inList('status', COMMISSION_STATUSES)),
    check('commissions_amount_chk', sql`amount >= 0`),
  ],
);

export const SALE_DOCUMENT_TYPES = ['contract', 'invoice', 'delivery_note', 'credit_note'] as const;

/** Issued sale documents: gapless numbers per type and an immutable snapshot of what was issued. */
export const saleDocuments = pgTable(
  'sale_documents',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id),
    type: text('type').notNull(),
    number: text('number').notNull(),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    snapshot: jsonb('snapshot').notNull(),
    status: text('status').notNull().default('issued'),
    issuedBy: uuid('issued_by'),
    issuedAt: createdAt(),
    voidedBy: uuid('voided_by'),
    voidedAt: ts('voided_at'),
    voidReason: text('void_reason'),
  },
  (t) => [
    uniqueIndex('sale_documents_number_uq').on(t.tenantId, t.type, t.number),
    // One live document of each type per sale (a voided one can be re-issued).
    uniqueIndex('sale_documents_live_uq').on(t.tenantId, t.saleId, t.type).where(sql`status = 'issued'`),
    check('sale_documents_type_chk', inList('type', SALE_DOCUMENT_TYPES)),
    check('sale_documents_status_chk', inList('status', ['issued', 'voided'])),
  ],
);

/** Daily cash closing per account (D-032): counted vs expected, over/short posted to 6200. */
export const cashDayClosings = pgTable(
  'cash_day_closings',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    cashAccountId: uuid('cash_account_id')
      .notNull()
      .references(() => cashAccounts.id),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    expectedBalance: money('expected_balance').notNull(),
    countedBalance: money('counted_balance').notNull(),
    difference: money('difference').notNull(),
    status: text('status').notNull().default('closed'),
    notes: text('notes'),
    closedBy: uuid('closed_by'),
    closedAt: createdAt(),
    reopenedBy: uuid('reopened_by'),
    reopenedAt: ts('reopened_at'),
    reopenReason: text('reopen_reason'),
  },
  (t) => [
    uniqueIndex('cash_day_closings_live_uq').on(t.tenantId, t.cashAccountId, t.businessDate).where(sql`status = 'closed'`),
    index('cash_day_closings_account_idx').on(t.tenantId, t.cashAccountId, t.businessDate),
    check('cash_day_closings_status_chk', inList('status', ['closed', 'reopened'])),
    check('cash_day_closings_diff_chk', sql`difference = counted_balance - expected_balance`),
  ],
);
