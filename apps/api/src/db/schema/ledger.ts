import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, money, pk, tenantId } from './_columns';
import { tenants } from './tenancy';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    code: text('code').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar').notNull(),
    type: text('type').notNull(),
    isSystem: boolean('is_system').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ledger_accounts_tenant_code_uq').on(t.tenantId, t.code),
    check('ledger_accounts_type_chk', inList('type', ACCOUNT_TYPES)),
  ],
);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    entryNo: bigint('entry_no', { mode: 'number' }).notNull(),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    event: text('event').notNull(),
    description: text('description').notNull(),
    branchId: uuid('branch_id'),
    reversalOfId: uuid('reversal_of_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('journal_entries_tenant_no_uq').on(t.tenantId, t.entryNo),
    // Prevents posting the same business event twice.
    uniqueIndex('journal_entries_source_event_uq').on(t.tenantId, t.sourceType, t.sourceId, t.event),
    index('journal_entries_date_idx').on(t.tenantId, t.entryDate),
    foreignKey({ columns: [t.reversalOfId], foreignColumns: [t.id], name: 'journal_entries_reversal_fk' }),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: pk(),
    tenantId: tenantId().references(() => tenants.id),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    lineNo: integer('line_no').notNull(),
    accountCode: text('account_code').notNull(),
    debit: money('debit').notNull().default('0'),
    credit: money('credit').notNull().default('0'),
    branchId: uuid('branch_id'),
    vehicleId: uuid('vehicle_id'),
    customerId: uuid('customer_id'),
    supplierId: uuid('supplier_id'),
    cashAccountId: uuid('cash_account_id'),
    saleId: uuid('sale_id'),
    userId: uuid('user_id'),
    memo: text('memo'),
  },
  (t) => [
    uniqueIndex('journal_lines_entry_line_uq').on(t.entryId, t.lineNo),
    index('journal_lines_account_idx').on(t.tenantId, t.accountCode),
    index('journal_lines_vehicle_idx').on(t.tenantId, t.vehicleId),
    index('journal_lines_customer_idx').on(t.tenantId, t.customerId),
    index('journal_lines_supplier_idx').on(t.tenantId, t.supplierId),
    index('journal_lines_cash_idx').on(t.tenantId, t.cashAccountId),
    index('journal_lines_sale_idx').on(t.tenantId, t.saleId),
    foreignKey({
      columns: [t.tenantId, t.accountCode],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.code],
      name: 'journal_lines_account_fk',
    }),
    check('journal_lines_amounts_chk', sql`debit >= 0 AND credit >= 0 AND ((debit = 0) <> (credit = 0))`),
  ],
);
