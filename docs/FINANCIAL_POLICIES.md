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
| 2100 | Customer advances / deposits (dimension: customer, sale) | Liability |
| 2200 | Tax payable | Liability |
| 2300 | Commissions payable | Liability |
| 2400 | Deferred finance income | Liability |
| 3000 | Owner's equity / opening balances | Equity |
| 4000 | Vehicle sales revenue | Revenue |
| 4100 | Finance (installment) income | Revenue |
| 4200 | Other income | Revenue |
| 4300 | Realized foreign-exchange gains / (losses) | Revenue (losses are debits) |
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
| Vehicle removed from stock with remaining cost | 6300 (vehicle) | 1300 (vehicle) | `vehicle` / `vehicle.written_off` (balance to date) + `vehicle.written_off:<date>` per future-dated cost |
| Realized FX on a payment or transfer | 4300 (loss) | 4300 (gain) | Extra line in the payment/transfer entry |
| Customer receipt (deposit or credit) | 1100 (cash account) | 2100 (customer) | `receipt` / `receipt.posted` |
| Customer receipt voided | mirror | | `receipt` / `receipt.posted.reversed` |
| Reservation deposit forfeited on cancel | 2100 (customer) | 4200 (customer, vehicle) | `reservation` / `reservation.forfeited` |
| Customer refund paid | 2100 (customer) | 1100 (cash account) | `refund` / `refund.paid` |

Deposits, receipts and refunds (Phase 4) are documented in §8. Sales, installments, commissions and
daily closing (Phase 5) are documented in §9.

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

### 4.1 Foreign currency (realized FX)
- **Foreign cash and bank accounts are carried at weighted-average base cost.** Money coming in
  adds base value at the transaction rate. Money going out relieves base value in proportion. When
  an account is emptied, all of its remaining base value is relieved. An emptied foreign account
  therefore never keeps a base balance.
- **Foreign-currency payables are carried at their booking rate.** A payment allocation states:
  - `amountBase`: its share of the payment, valued at the payment's own rate. The shares must add
    up exactly to the payment.
  - optionally `amountDoc`: the amount settled in the document's own currency.

  The payable is relieved at its carrying cost. When the final amount is settled, the exact
  remainder is relieved.
- **Every difference is posted to 4300 in the same journal entry:**
  - carrying cost of the cash vs. its value at the transaction rate;
  - allocated value vs. carrying cost of the payable.

  Example: 10,000 USD bought at 3.75 settles a liability booked at 3.75 with no FX, whatever the
  payment-day rate is. Paying a 1,000 USD invoice booked at 3.75 with 3,800 SAR realizes a 50.00
  loss.
- **On the cash book row for an outflow:**
  - `exchange_rate` keeps the rate the user stated;
  - `amount_base` is the carrying cost relieved.
- **Shared invoices in a foreign currency** are converted once, and the base total is split with
  the same weights. The parts always add up to the converted invoice.

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
  up exactly. Remainder cents go to the largest fractions, so the parts always sum to the invoice
  to the cent.
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
* **Cash boxes cannot go negative on any date.** An outflow dated D is accepted only if the
  running balance stays at or above zero on D and on every later date. A back-dated payment
  therefore cannot overdraw a box before it was funded. Bank accounts may go negative (overdraft).
* **Reversals and voids are never dated before the movement they reverse.** They are dated
  max(today, original date).
* **Reversing into or out of a deactivated account is refused.** Reactivate the account first.
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

## 8. Customer money: receipts, deposits, refunds (Phase 4)

* **Customer money is a liability until a sale is recognised.** Every receipt credits 2100
  Customer advances, carrying the customer dimension. It is never posted to revenue (B-002).
* **Receipts.**
  - A receipt goes through `CashService`, so the cash book row and the GL entry are written
    together.
  - It is split in base currency between targets: a reservation deposit, or general customer
    credit. The parts must add up exactly to the receipt (`allocation_mismatch`).
  - Voiding a receipt posts the mirror entry and returns the cash. Voiding is refused if the money
    has already been refunded or forfeited, because that would leave 2100 negative for the
    customer.
* **Deposits and reservations.**
  - A reservation locks the vehicle row, so only one active reservation per vehicle is possible
    (unique index `reservations_vehicle_active_uq`).
  - When a reservation is cancelled:
    - the refundable share (by policy, or overridden with `refunds.approve`) becomes a refund
      request;
    - the rest is forfeited to 4200 with the reason recorded (`reservation.forfeited`, at most once
      per reservation).
  - When a reservation expires, the vehicle is released and the deposit stays as customer credit
    (B-021).
* **Refunds.** A refund goes requested → approved (by another user, B-022) → paid. Payment posts
  Dr 2100 / Cr 1100 through `CashService`. Refunds are always paid in the base currency. They are
  checked three times against what is still refundable (request, approval, payment), with the
  source locked each time.
* **Customer advance balance.**
  - The balance is read from the GL (2100 by customer); it is never stored.
  - Deposit receipts, forfeits and refunds keep it consistent by construction.
  - `assertLedgerIntegrity` in the tests checks that the GL balances after every test.

## 9. Sales, installments, commissions and cash closing (Phase 5)

| Event | Debit | Credit | Source / event key |
|---|---|---|---|
| Payment for a sale before recognition | 1100 | 2100 (customer, sale) | `receipt` / `receipt.posted` |
| Payment for a sale after recognition | 1100 | 1200 (customer, sale) | `receipt` / `receipt.posted` |
| Trade-in received at confirmation | 1300 (trade-in vehicle) | 2100 (customer, sale) | `vehicle_cost` / `cost.posted` (source `trade_in`) |
| Revenue recognised | 1200 gross + interest + fees | 4000 net, 2200 tax, 2400 interest + fees | `sale` / `sale.recognized` |
| Cost of sale | 5000 (vehicle, sale) | 1300 (vehicle) | `sale` / `sale.cogs` |
| Held money applied | 2100 (customer, sale) | 1200 (customer, sale) | `sale` / `sale.credit_applied` |
| Installment collected | 1100; 2400 (interest + fees covered) | 1200; 4100 | `receipt` / `receipt.posted` |
| Interest waived on early settlement | 2400 | 1200 | `installment_plan` / `plan.settlement_waiver` |
| Plan unwound (cancel/return) | 1200 collected; 4100 income released | 2100 collected; 2400 income released | `installment_plan` / `plan.unwound` |
| Held money returned to credit (cancel/return) | 1200 | 2100 | `sale` / `sale.credit_unapplied` |
| Recognition / COGS reversed | mirror | | `sale` / `sale.recognized.reversed`, `sale.cogs.reversed` |
| Pre-recognition payment voided after recognition | 1200 | 2100 | `sale` / `credit_unapplied:<receipt>` (plus the receipt's mirror) |
| Post-recognition payment voided after cancel/return | 2100 | 1200 | `sale` / `credit_voided:<receipt>` (plus the receipt's mirror) |
| Refund of sale credit | 2100 (customer, sale) | 1100 | `refund` / `refund.paid` |
| Commission earned | 6100 | 2300 (employee) | `commission` / `commission.earned` |
| Commission paid | 2300 | 1100 | `commission` / `commission.paid` |
| Unpaid commission reversed | mirror | | `commission` / `commission.earned.reversed` |
| Paid commission clawed back | 1400 (employee) | 6100 | `commission` / `commission.clawback` |
| Cash over at closing | 1100 | 6200 | `cash_closing` / `cash_closing.difference` |
| Cash short at closing | 6200 | 1100 | `cash_closing` / `cash_closing.difference` |

* **Sale money (D-028).** The sale accepts payments up to what is due before delivery. Delivery
  needs a live invoice and, unless overridden with `sales.deliver_with_balance` and a reason, the
  full price paid (cash), the down payment paid (installments), or the provider's approval plus
  the customer's share (external finance). Per sale, after delivery: 2100 = 0, and 1200 = what is
  still owed (zero for a fully paid cash sale).
* **Recognition** posts revenue net of tax, tax payable and deferred finance income in one entry,
  then COGS at the vehicle's full 1300 balance, then applies the held money. The vehicle cost is
  locked at recognition: later costs go to 5000 (`post_sale`).
* **Installments (D-029).** Collection only on active plans; allocation oldest-first in the
  configured component order; 2400 → 4100 on the interest and fees each payment covers.
  Settlement waivers are explicit entries. A plan's outstanding balance is zero once settled
  (the remainder is waived interest) or cancelled.
* **Cancellation and return** leave, per sale: 1200 = 0, 2400 = 0, 4100 = 0, 4000 = 0, 2200 = 0,
  5000 = 0 (for the COGS of that sale), the vehicle's 1300 back at its cost, and 2100 = everything
  the customer paid, refundable through the refund workflow.
* **Commissions (D-030)** use the cost at confirmation; earned, approved by another user, paid
  from a base-currency account; reversed or clawed back on cancel/return.
* **Cash closing (D-032)** posts any difference to 6200 dated on the closed day and then locks that
  day and all earlier days for the account.

