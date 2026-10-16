import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  ACQUISITION_SOURCES,
  ACQUISITION_STATUSES,
  COST_STATUSES,
  PAYMENT_METHODS,
  SUPPLIER_TYPES,
  WORK_ORDER_STATUSES,
  WORK_ORDER_TYPES,
} from '@autohub/shared';
import { createdAt, inList, money, pk, rate, tenantId, ts, updatedAt } from './_columns';
import { branches, tenants } from './tenancy';
import { vehicles } from './vehicles';

export const COST_SOURCES = ['acquisition', 'manual', 'work_order_item', 'allocation', 'trade_in'] as const;
export const CASH_DIRECTIONS = ['in', 'out'] as const;

export const suppliers = pgTable(
  'suppliers',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    type: text('type').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    taxNumber: text('tax_number'),
    nationalId: text('national_id'),
    address: text('address'),
    city: text('city'),
    notes: text('notes'),
    customerId: uuid('customer_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('suppliers_tenant_name_idx').on(t.tenantId, t.name), check('suppliers_type_chk', inList('type', SUPPLIER_TYPES))],
);

export const costCategories = pgTable(
  'cost_categories',
  {
    id: pk(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    /** vehicle = capitalised into vehicle cost; operating = P&L expense. */
    kind: text('kind').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('cost_categories_code_uq').on(sql`coalesce(${t.tenantId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.code),
    check('cost_categories_kind_chk', inList('kind', ['vehicle', 'operating'])),
  ],
);

export const acquisitions = pgTable(
  'acquisitions',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    sourceType: text('source_type').notNull(),
    purchaseDate: date('purchase_date', { mode: 'string' }).notNull(),
    purchasePrice: money('purchase_price').notNull(),
    currency: text('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    purchasePriceBase: money('purchase_price_base').notNull(),
    paymentMethod: text('payment_method'),
    dueDate: date('due_date', { mode: 'string' }),
    ownershipTransferStatus: text('ownership_transfer_status').notNull().default('pending'),
    status: text('status').notNull().default('draft'),
    notes: text('notes'),
    tradeInId: uuid('trade_in_id'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('acquisitions_number_uq').on(t.tenantId, t.number),
    // One live acquisition per vehicle; a cancelled one may be followed by a new purchase record.
    uniqueIndex('acquisitions_vehicle_live_uq').on(t.vehicleId).where(sql`status <> 'cancelled'`),
    index('acquisitions_supplier_idx').on(t.tenantId, t.supplierId),
    check('acquisitions_status_chk', inList('status', ACQUISITION_STATUSES)),
    check('acquisitions_source_chk', inList('source_type', ACQUISITION_SOURCES)),
    check('acquisitions_amounts_chk', sql`purchase_price > 0 AND purchase_price_base > 0 AND exchange_rate > 0`),
    check('acquisitions_transfer_chk', inList('ownership_transfer_status', ['pending', 'in_progress', 'completed'])),
  ],
);

export const vehicleCosts = pgTable(
  'vehicle_costs',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => costCategories.id),
    description: text('description').notNull(),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    amountBase: money('amount_base').notNull(),
    costDate: date('cost_date', { mode: 'string' }).notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    status: text('status').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    batchId: uuid('batch_id'),
    allocationMethod: text('allocation_method'),
    /** Posted after the sale was recognised → charged to COGS instead of inventory. */
    postSale: boolean('post_sale').notNull().default(false),
    reversedAt: ts('reversed_at'),
    reversalReason: text('reversal_reason'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    rejectedReason: text('rejected_reason'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('vehicle_costs_vehicle_idx').on(t.tenantId, t.vehicleId),
    // A source document (acquisition, work-order line) can only create one cost.
    uniqueIndex('vehicle_costs_source_uq').on(t.tenantId, t.sourceType, t.sourceId).where(sql`source_id IS NOT NULL AND status <> 'rejected'`),
    check('vehicle_costs_status_chk', inList('status', COST_STATUSES)),
    check('vehicle_costs_source_chk', inList('source_type', COST_SOURCES)),
    check('vehicle_costs_amount_chk', sql`amount > 0 AND amount_base > 0 AND exchange_rate > 0`),
  ],
);

export const cashAccounts = pgTable(
  'cash_accounts',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    branchId: uuid('branch_id').references(() => branches.id),
    type: text('type').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    bankName: text('bank_name'),
    accountNumber: text('account_number'),
    iban: text('iban'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('cash_accounts_name_uq').on(t.tenantId, t.name), check('cash_accounts_type_chk', inList('type', ['cashbox', 'bank']))],
);

/** Cash book (sub-ledger of GL 1100). Append-only; corrections are reversal rows. */
export const cashTransactions = pgTable(
  'cash_transactions',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    cashAccountId: uuid('cash_account_id')
      .notNull()
      .references(() => cashAccounts.id),
    direction: text('direction').notNull(),
    amount: money('amount').notNull(),
    amountBase: money('amount_base').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    kind: text('kind').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    reference: text('reference'),
    description: text('description').notNull(),
    reversalOfId: uuid('reversal_of_id'),
    journalEntryId: uuid('journal_entry_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('cash_transactions_account_idx').on(t.tenantId, t.cashAccountId, t.businessDate),
    index('cash_transactions_source_idx').on(t.tenantId, t.sourceType, t.sourceId),
    uniqueIndex('cash_transactions_reversal_uq').on(t.reversalOfId).where(sql`reversal_of_id IS NOT NULL`),
    check('cash_transactions_direction_chk', inList('direction', CASH_DIRECTIONS)),
    check('cash_transactions_amount_chk', sql`amount > 0 AND amount_base > 0`),
  ],
);

export const supplierPayments = pgTable(
  'supplier_payments',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    cashAccountId: uuid('cash_account_id')
      .notNull()
      .references(() => cashAccounts.id),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    amountBase: money('amount_base').notNull(),
    paidAt: date('paid_at', { mode: 'string' }).notNull(),
    method: text('method').notNull(),
    reference: text('reference'),
    notes: text('notes'),
    status: text('status').notNull().default('posted'),
    voidedAt: ts('voided_at'),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('supplier_payments_number_uq').on(t.tenantId, t.number),
    index('supplier_payments_supplier_idx').on(t.tenantId, t.supplierId),
    check('supplier_payments_status_chk', inList('status', ['posted', 'voided'])),
    check('supplier_payments_amount_chk', sql`amount > 0 AND amount_base > 0`),
    check('supplier_payments_method_chk', inList('method', PAYMENT_METHODS)),
  ],
);

export const supplierPaymentAllocations = pgTable(
  'supplier_payment_allocations',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => supplierPayments.id),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    amountBase: money('amount_base').notNull(),
  },
  (t) => [
    index('supplier_payment_alloc_target_idx').on(t.tenantId, t.targetType, t.targetId),
    check('supplier_payment_alloc_type_chk', inList('target_type', ['acquisition', 'vehicle_cost', 'expense'])),
    check('supplier_payment_alloc_amount_chk', sql`amount_base > 0`),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => costCategories.id),
    description: text('description').notNull(),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    amountBase: money('amount_base').notNull(),
    expenseDate: date('expense_date', { mode: 'string' }).notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    status: text('status').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    rejectedReason: text('rejected_reason'),
    reversedAt: ts('reversed_at'),
    reversalReason: text('reversal_reason'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('expenses_number_uq').on(t.tenantId, t.number),
    index('expenses_date_idx').on(t.tenantId, t.expenseDate),
    check('expenses_status_chk', inList('status', COST_STATUSES)),
    check('expenses_amount_chk', sql`amount > 0 AND amount_base > 0 AND exchange_rate > 0`),
  ],
);


export const workOrders = pgTable(
  'work_orders',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    number: text('number').notNull(),
    vehicleId: uuid('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    type: text('type').notNull(),
    priority: text('priority').notNull().default('normal'),
    title: text('title').notNull(),
    description: text('description'),
    assignedUserId: uuid('assigned_user_id'),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    status: text('status').notNull().default('open'),
    estimatedCost: money('estimated_cost'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('work_orders_number_uq').on(t.tenantId, t.number),
    index('work_orders_vehicle_idx').on(t.tenantId, t.vehicleId),
    check('work_orders_status_chk', inList('status', WORK_ORDER_STATUSES)),
    check('work_orders_type_chk', inList('type', WORK_ORDER_TYPES)),
    check('work_orders_priority_chk', inList('priority', ['low', 'normal', 'high', 'urgent'])),
  ],
);

export const workOrderItems = pgTable(
  'work_order_items',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrders.id),
    kind: text('kind').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
    unitCost: money('unit_cost').notNull(),
    total: money('total').notNull(),
    hours: numeric('hours', { precision: 8, scale: 2 }),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => costCategories.id),
    costId: uuid('cost_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('work_order_items_wo_idx').on(t.workOrderId),
    check('work_order_items_kind_chk', inList('kind', ['part', 'labor', 'service', 'other'])),
    check('work_order_items_amount_chk', sql`quantity > 0 AND unit_cost >= 0 AND total >= 0`),
  ],
);

export const APPROVAL_TYPES = [
  'acquisition',
  'vehicle_cost',
  'expense',
  'work_order',
  'sale_discount',
  'sale_below_floor',
  'refund',
  'cash_adjustment',
] as const;

/** Approval inbox: each module keeps its own status; this table lists what awaits a decision. */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    type: text('type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    requiredPermission: text('required_permission').notNull(),
    status: text('status').notNull().default('pending'),
    summary: text('summary').notNull(),
    payload: jsonb('payload'),
    requestedBy: uuid('requested_by'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    branchId: uuid('branch_id'),
  },
  (t) => [
    index('approval_requests_status_idx').on(t.tenantId, t.status),
    uniqueIndex('approval_requests_pending_uq').on(t.tenantId, t.entityType, t.entityId, t.type).where(sql`status = 'pending'`),
    check('approval_requests_status_chk', inList('status', ['pending', 'approved', 'rejected', 'cancelled'])),
    check('approval_requests_type_chk', inList('type', APPROVAL_TYPES)),
  ],
);
