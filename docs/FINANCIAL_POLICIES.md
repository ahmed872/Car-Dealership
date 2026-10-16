# Financial Policies & Posting Rules

This document is the reference for how AutoHub Pro records money. It covers every journal entry the
system posts, the sub-ledgers that must reconcile to the general ledger (GL), and the rules that
stop money from being lost, duplicated, or misstated. Each rule here is enforced in code, and the
integration tests in `apps/api/test/*.spec.ts` check that.

> AutoHub Pro keeps management accounts. It is **not** certified tax or e-invoicing software
> (ZATCA, FTA or ETA). Statutory filings need a certified integration; see `KNOWN_ISSUES.md`.

## 1. Principles

1. **Decimal money only.** Amounts are `NUMERIC(18,2)` in PostgreSQL and `Decimal` strings in
   TypeScript, rounded to 2 decimals using the tenant's rounding mode (`half_up` by default).
   Exchange rates are `NUMERIC(18,8)`.
2. **Double entry.** Every financial event writes exactly one balanced journal entry. Balance is
   checked twice:
   - in the application, which gives a clear error;
   - by a deferred database trigger at COMMIT.
3. **Immutability.** Journal lines are never updated or deleted, and the same holds for cash-book
   rows and payment allocations (enforced by triggers and revoked grants). A correction is a
   *reversal*, meaning a mirrored entry linked to the original. Posted amounts on vehicle costs and
   expenses are frozen by a trigger.
4. **Exactly once.** `(tenant, source_type, source_id, event)` is unique on journal entries.
   - Retrying a request with the same `Idempotency-Key` replays the first response.
   - Re-posting a business event fails with `already_posted`.
5. **One transaction.** A business operation, its GL entry, its cash-book rows, and its audit-log
   record commit together or not at all.
6. **Base currency.** Every company has one base currency (EGP, SAR or AED by market).
   - A foreign-currency document stores its original amount, its currency, the rate (base units
     per 1 foreign unit), and its base amount.
   - The GL is kept in base currency only.
   - When the document currency is the base currency, the rate must be exactly 1.

## 2. Chart of accounts (system accounts)

| Code | Account | Type |
|---|---|---|
| 1100 | Cash & bank (dimension: cash account) | Asset |
| 1200 | Accounts receivable (dimension: customer, sale) | Asset |
| 1300 | Vehicle inventory (dimension: vehicle) | Asset |
| 1400 | Commission advances | Asset |
| 2000 | Accounts payable (dimension: supplier) | Liability |
| 2100 | Customer advances / deposits (dimension: customer) | Liability |
| 2200 | Tax payable | Liability |
| 2300 | Commissions payable | Liability |
| 2400 | Deferred finance income | Liability |
| 3000 | Owner's equity / opening balances | Equity |
| 4000 | Vehicle sales revenue | Revenue |
| 4100 | Finance (installment) income | Revenue |
| 4200 | Other income | Revenue |
| 5000 | Cost of vehicles sold (COGS) | Expense |
| 6000 | Operating expenses (dimension: branch) | Expense |
| 6100 | Commission expense | Expense |
| 6200 | Cash over / short | Expense |
| 6300 | Inventory adjustments / write-offs | Expense |

## 3. Posting rules (Phase 3)

| Event | Debit | Credit | Source / event key |
|---|---|---|---|
| Cash account opening balance | 1100 (account) | 3000 | `cash_account` / `cash_account.opening_balance` |
| Acquisition approved | 1300 (vehicle) | 2000 (supplier) | `vehicle_cost` / `cost.posted` (purchase cost row; source = acquisition) |
| Vehicle cost posted, before sale | 1300 (vehicle) | 2000 (supplier, or none for direct purchase) | `vehicle_cost` / `cost.posted` |
| Vehicle cost posted after sale was recognised | 5000 (vehicle) | 2000 | `vehicle_cost` / `cost.posted` (`post_sale = true`) |
| Vehicle cost reversed | mirror of the original | | `vehicle_cost` / `cost.reversed` |
| Operating expense posted | 6000 (branch) | 2000 (supplier or none) | `expense` / `expense.posted` |
| Operating expense reversed | mirror | | `expense` / `expense.reversed` |
| Supplier payment | 2000 (supplier) | 1100 (cash account) | `supplier_payment` / `supplier_payment.posted` |
| Supplier payment voided | mirror | | `supplier_payment` / `supplier_payment.posted.reversed` |
| Transfer between own accounts | 1100 (to) | 1100 (from) | `cash_transfer` / `cash_transfer.posted` |
| Vehicle removed from stock with remaining cost | 6300 (vehicle) | 1300 (vehicle) | `vehicle` / `vehicle.written_off` |

Sales, deposits, receipts, refunds, installments, commissions and daily closing rules are added in
Phases 4–5 and documented in §6.

## 4. Payables and supplier payments

* **Payable documents.** Three kinds of document can be paid:
  - an **approved acquisition** (its purchase price);
  - a **posted vehicle cost** that does not come from an acquisition;
  - a **posted operating expense**.

  Draft, pending, rejected and reversed documents cannot be paid (`not_payable`).
* **Allocation.**
  - A supplier payment is allocated, in base currency, to one or more payable documents.
  - The allocations must add up *exactly* to the payment's base amount (`allocation_mismatch`).
  - No document can be allocated more than its outstanding balance (`overpayment`). The document
    row is locked `FOR UPDATE`, so two concurrent payments cannot both pass the check.
  - The supplier on the payment must equal the supplier on every document. A payment with no
    supplier pays "direct purchases" that have no supplier.
* **Void.** Voiding a payment does three things:
  - posts the mirrored entry;
  - returns the cash to the account;
  - makes the documents payable again, because allocations of voided payments are ignored.

  Allocations themselves are never deleted.
* **Paid documents are protected.** A cost or expense that has non-voided payments cannot be
  reversed, and an acquisition with payments cannot be cancelled (`*_has_payments`). The payment
  must be voided first, so the supplier's balance never silently changes.

## 5. Vehicle cost engine

* **What a vehicle cost is.** A vehicle's cost is the sum of its **posted** `vehicle_costs` rows,
  in base currency (specific identification, B-010). This always equals the vehicle's GL 1300
  balance while the vehicle is unsold. The reconciliation report checks that.
* **Approval.** Costs recorded by users without `costs.approve` stay `pending_approval`. They
  appear in the approval inbox and post only when approved.
* **Purchase price.** The purchase price can be recorded only by approving the acquisition. It can
  be reversed only by cancelling the acquisition (`reverse_via_acquisition`).
* **Costs after the sale.** Once a sale is recognised (`vehicles.cost_locked_at` is set):
  - new costs require `costs.post_after_sale` and go to COGS (5000), not inventory;
  - pre-sale costs can no longer be reversed (`cost_locked`).
* **Shared costs.** A shared invoice (for example, transport of several cars) is split by
  `allocateProportionally`: equally, by posted purchase price, or by manual amounts that must add
  up exactly. The last vehicle absorbs the rounding remainder, so the parts always sum to the
  invoice to the cent.
* **Work orders.** An approved work-order item becomes exactly one posted cost. The unique index on
  `(source_type, source_id)` prevents double posting.
* **Cancelling a purchase.** Cancelling an approved, unpaid acquisition does two things:
  - reverses the purchase cost;
  - removes the vehicle from stock, writing any remaining capitalised cost off to 6300.

  This is only allowed while the vehicle is unsold and not in transit.

## 6. Cash book

* **Single path.** Every movement in or out of a cash box or bank account goes through
  `CashService`. It writes:
  - an append-only `cash_transactions` row (amount in the account currency, plus the base amount);
  - the GL entry on 1100, carrying the cash-account dimension.

  Balances are derived from the cash book; they are never stored.
* **Cash boxes cannot go negative** (`insufficient_cash`). Bank accounts may go negative
  (overdraft) and are flagged in reports.
* **Transfers between accounts.** A transfer is one GL entry with two cash rows. A cross-currency
  transfer carries the same base amount on both legs; the destination's implied rate absorbs
  rounding.
* **Daily closing (Phase 5).** Once a day is closed for an account, no movement can be dated on
  that day (`cash_day_closed`), until a user with `cash.reopen` reopens it with a reason.

## 7. Reconciliations (must always be zero)

1. **Cash.** Cash book (sum of base amounts per account) = GL 1100 per cash account.
2. **Inventory.** Posted non-post-sale vehicle costs = GL 1300 per unsold vehicle.
3. **Payables.** The sum of outstanding payable documents = GL 2000 (credit balance).
4. **Trial balance.** Total debits = total credits for any period.

`GET /ledger/reconciliation` reports differences and lists each mismatching item.
