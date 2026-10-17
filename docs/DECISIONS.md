# Architectural & Business Decisions

Each entry: context → decision → consequences. Reversible technical choices were made autonomously.
Business assumptions that need Product Owner confirmation are marked **[PO-CONFIRM]** and isolated
in tenant settings wherever possible.

## Technical

### D-001 Modular monolith, pnpm workspace
Greenfield repo; the expected load is a few dozen concurrent staff per tenant. One NestJS API, one
React SPA, and one shared package. No microservices, Redis, or queues. Module boundaries keep a
later extraction possible.

### D-002 NestJS 11 + TypeScript 5.9 (not TS 7 / Nest 12)
NestJS DI depends on `emitDecoratorMetadata`. TypeScript 7 (the native port) and NestJS 12 are very
recent, and their decorator and tooling compatibility was not verifiable here. Pinned to proven
versions; upgrading is a separate, testable task.

### D-003 PostgreSQL 16 + Drizzle ORM + node-postgres
Drizzle is pure TypeScript (no binary engine downloads, which the sandbox proxy may block), maps
`numeric` to string (safe for Decimal), and supports `FOR UPDATE`, partial indexes, and CHECK
constraints. The TS schema is the source of truth for tables. RLS policies, triggers, grants, and
functions live in hand-written SQL migrations applied by the same migrator.

### D-004 Text columns + CHECK constraints instead of PG enums
Lifecycle/status sets evolve; `ALTER TYPE … ADD VALUE` cannot run inside a transaction and values
cannot be removed. TS unions give compile-time safety; CHECK constraints give DB-level safety.

### D-005 Per-request transaction (Unit of Work) via AsyncLocalStorage
Every API request runs inside one DB transaction with transaction-local tenant context. Mutations
are atomic by construction, including the GL posting and audit log of each request. Long-running
handlers (PDF rendering, uploads) opt out with `@NoTransaction()` and open short transactions
explicitly.

### D-006 Server-side sessions in PostgreSQL (not JWT)
Logout and permission changes must take effect immediately. Sessions are revocable rows. Cookie
auth requires CSRF protection, so we use a double-submit token plus an Origin check.

### D-007 Argon2id via @node-rs/argon2
OWASP's first recommendation. Prebuilt binaries ship through the npm registry.

### D-008 Zod schemas shared between web and API
One source of validation truth. The server always validates; the client validates for UX only.
OpenAPI is generated from the same schemas (`nestjs-zod`).

### D-009 Double-entry general ledger in v1
Financial correctness is the top priority. A ledger turns "are inventory, cash and sales
consistent?" into a mechanical check: control accounts must equal sub-ledgers. It is enforced by a
deferred balance trigger, immutable rows, and unique posting keys. This is a dealership operations
ledger, **not** a replacement for a statutory accounting package (no fixed assets, payroll,
statutory tax returns, or year-end closing).

### D-010 PDF via headless Chromium (HTML templates)
Correct Arabic shaping, bidi, and RTL layout are hard in pure-JS PDF libraries. HTML → Chromium PDF
renders Arabic correctly, using bundled fonts (IBM Plex Sans Arabic). The cost is a Chromium
dependency in the API image. When Chromium is unavailable, the API returns the printable HTML and
says so explicitly; it never returns a silent failure.

### D-011 File storage abstraction
A `StorageDriver` interface. The `local` driver serves development and tests; the `s3` driver
serves production (S3-compatible: AWS, Cloudflare R2, MinIO). Private files are only served through
authenticated, permission-checked endpoints.

### D-012 In-process scheduler with advisory lock
Reminders and expiry jobs run inside the API process. `pg_try_advisory_lock` ensures one runner
across replicas, which avoids adding a queue system.

### D-013 Playwright 1.56.1 pinned
It matches the pre-installed Chromium build 1194, so no browser download is needed.

### D-014 Vehicle status keys fixed, labels customizable
Business rules (no double sale, delivery conditions) depend on fixed state semantics. Tenants can
rename labels and choose whether inspection is mandatory before listing.

### D-015 Cash book + GL written by one service
Every money movement goes through `CashService.move/reverse/transfer`. It writes the append-only
cash-book row and the balanced 1100 journal entry in the same transaction, so the cash book can
never drift from the ledger. Modules never insert `cash_transactions` directly.

### D-016 Payables by document allocation (no free-floating supplier balance)
Supplier payments are allocated to specific approved documents (acquisition, vehicle cost,
expense). Outstanding = document total − allocations of non-voided payments. This gives exact
per-document paid status, aging by due date, and prevents overpayment, at the cost of not
supporting unallocated advances to suppliers in v1. Supplier advances are a known gap (KNOWN_ISSUES).

### D-017 Approval inbox table
Each module owns its own status machine; `approval_requests` mirrors what is pending (type,
entity, required permission, branch) so approvers have a single inbox filtered by their permissions.
A partial unique index allows one pending request per (entity, type).

### D-018 Phase 3 delivers expenses and cash transfers early
The schema for operating expenses, cash accounts and transfers was needed for supplier payments, so
these features ship in Phase 3 instead of Phase 5. Daily cash closing remains in Phase 5
(the `CashService.closedDateChecker` hook is already enforced on every movement).

### D-019 Realized FX with weighted-average carrying cost
Foreign cash accounts are carried at weighted-average base cost. Foreign payables are carried at
their booking rate. Payments and transfers post the difference to 4300 in the same entry. The
alternative, periodic revaluation of open foreign balances (unrealized FX), is not implemented in
v1 (KNOWN_ISSUES).

### D-020 Maker identity from the audit trail
Maker-checker counts as makers the creator, the submitter, and every user who edited a purchase.
Editors are read from the immutable audit log (`acquisition.created` / `.updated` / `.submitted`).
Editing a purchase that is awaiting approval withdraws it to draft, so the approver never sees a
stale amount.

### D-021 Pipeline stages: platform defaults with copy-on-write
The default sales pipeline (new → reserved, won, lost) is shared platform data. When a company
renames, re-weights or deactivates a default stage, a company-owned copy with the same code is
created and that company's leads are moved to it, so other companies keep the defaults. Stage
history keeps pointing at the stage that was current at the time.

### D-022 Shared calendar, private details
Everyone with access to a branch sees its whole appointment calendar, so salespeople and vehicles
are not double-booked. Details (customer, notes, licence) are shown only to the assignee, the
creator, people who can see the customer, and users who may read all customers. Everyone else sees
a busy block. Filtering by customer or lead only matches bookings the caller may open. Vehicle
double-booking for test drives is refused by a database exclusion constraint. Staff double-booking
is checked under a per-user advisory lock.

### D-023 Wish matching is exact and explainable
Wishes match only vehicles on sale (`available`), using one pure function shared by the API and
the UI (`wishMismatches`). Missing vehicle data (no asking price, no colour) never counts as a
match. Each (wish, vehicle) pair is recorded once, so its notification is sent once. A dismissed
pair never comes back.

### D-024 Commission policies are versioned and never retroactive
A policy version's rule is never edited. A change creates a new version starting today or later,
strictly after the previous version's start, and the previous version ends the day before.
Version changes of one policy are serialised by an advisory lock. Earned commissions (Phase 5)
will store the version id and a snapshot of the rule.

### D-025 One writer per company at a time
Every write transaction of a company takes a per-company advisory lock (`pg_advisory_xact_lock(7001,
hashtext(tenant))`) as its first lock. Reads never take it. Before this, writes already funnelled
through company-wide rows (the audit hash-chain head, the journal and document counters), but they
locked them mid-flow and in different orders. The concurrency review reproduced deadlocks between
pay-now flows, supplier payments, transfers and cost allocations. Locking first, in one order,
makes deadlocks between a company's writes impossible; concurrent requests wait instead of failing.
The cost is no write parallelism inside one company, which is acceptable at dealership volumes.
Commit-time journal numbering was tried and rejected: it does not cover the audit chain, and two
commit-time locks would need their own ordering.

### D-026 Accounts-payable data is purchasing data
Open payables, AP aging, supplier balances and supplier payments show purchase prices, so they need
`suppliers.read` + `payments.read` (or `supplier_payments.create` for the payment form). The sales
side's `payments.read` alone is not enough.

### D-027 One vehicle per sale, priced in the base currency
A sale sells exactly one vehicle (a unique index allows one live sale per vehicle). Prices, tax,
installments and commissions are in the company's base currency; receipts may come from
foreign-currency accounts and are converted at the receipt's rate. Price, discount and tax are
recomputed and frozen at confirmation (a trigger refuses later changes to the terms), so a
margin-scheme tax uses the cost at confirmation.

### D-028 Sale money is held until recognition, then applied
Everything the customer gives for a sale (receipts allocated to the sale, the agreed value of a
trade-in, a converted reservation deposit) is credited to 2100 with the customer and sale
dimensions. Recognition (on delivery by default, B-001) posts in one transaction:
Dr 1200 gross + deferred finance charges / Cr 4000 net / Cr 2200 tax / Cr 2400 interest and fees;
Dr 5000 / Cr 1300 the vehicle's whole capitalised cost (the cost is then locked); and
Dr 2100 / Cr 1200 the money held so far. Receipts after recognition credit 1200 directly. The
sale accepts at most what is due before delivery (the whole price, or the down payment of an
installment sale), so after recognition the money applied equals the money held. Cancelling a
confirmed sale or returning a delivered one reverses all of it, and the money becomes refundable
customer credit on the sale (refunds use maker-checker, B-022). Voids re-route through the same
dimensions so the receivable and the credit never drift apart.

### D-029 Installment plans: frozen schedule, oldest-first allocation, explicit waivers
The schedule (flat, reducing-balance or zero-interest, from the shared calculator) is built and
frozen at confirmation and becomes collectable only at recognition (B-003). A payment is allocated
oldest installment first, in the company's component order (fees, interest, principal by
default); the interest and fees it covers move from 2400 to 4100. Early settlement takes a quote
total the cashier saw (refused with 409 if it changed) and a future-interest policy
(company default per method, overridable with `installments.settle`). Waived interest is posted
explicitly (Dr 2400 / Cr 1200). No late fees (B-004). Overdue and due-soon reminders notify the
salesperson exactly once per installment state.

### D-030 Commissions: expected at confirmation, earned by rule, paid through the cash book
A commission is computed from the salesperson's policy version on the sale date and stored with
a snapshot of the rule, using the vehicle cost at confirmation. It is earned (Dr 6100 / Cr 2300)
once the sale is recognised and, per the rule, delivered or fully paid (B-006). Approval needs a
different user than the earner. Payment goes through `CashService` from a base-currency account.
If the sale is cancelled or returned, an unpaid commission is reversed and a paid one becomes a
clawback receivable from the employee (Dr 1400 / Cr 6100).

### D-031 Sale documents are immutable snapshots with gapless numbers
Contract, invoice, delivery note and credit note each take a gapless number per type and year and
store a complete snapshot (company, customer, vehicle, prices, tax, trade-ins, payments,
schedule). The PDF is always rendered from the snapshot, never from live data, by headless
Chromium with embedded IBM Plex Sans Arabic fonts and no network access. At most one live
document per type and sale. Documents can be voided only while the sale is confirmed; after
delivery corrections are returns, which issue a credit note referencing the invoice. Documents
carry a notice that they are not certified e-invoices (EXT-01).

### D-032 Daily cash closing locks the day and every day before it
Closing a cash account for a day compares the counted balance with the cash book on that day. A
difference is posted to 6200 (over: Dr 1100 / Cr 6200; short: Dr 6200 / Cr 1100) through the
cash book, dated on the closed day, and needs `cash.adjust`. After closing, no movement can be
dated on or before that day for the account (enforced in `CashService` for moves, reversals and
transfers). Closings run forward only; only the latest closing can be reopened, with
`cash.reopen` and a reason. Differences on foreign-currency accounts must be corrected with a
transfer before closing.

## Business assumptions

### B-001 Revenue recognition default = on delivery **[PO-CONFIRM]**
Conservative default: control transfers at delivery. Tenant setting `revenueRecognition` can be
`on_delivery` (default) or `on_confirmation`. Until recognition, customer receipts are
liabilities (advances).

### B-002 Deposits are liabilities, never revenue
A deposit is held in 2100. If a reservation is cancelled with a non-refundable or partially
refundable policy, the forfeited part moves to 4200 Other income, only through an explicit cancel
action that records the reason.

### B-003 Installment collection starts after revenue recognition
The down payment is an ordinary sale payment. Installment-plan payments are accepted only after the
sale is recognized, which keeps finance-income accounting unambiguous. Finance charges post to
Deferred Finance Income at recognition and are released to Finance Income as payments are
allocated to interest.

### B-004 No automatic late fees
Late fees and penalties are disabled (`lateFeePolicy = none`). Regulation differs between EG, SA,
and AE, and some contracts are Sharia-compliant (Murabaha), where penalties are restricted. Overdue
status and reminders still work.

### B-005 Installment calculation methods
Implemented: `flat` (simple add-on rate), `reducing_balance` (amortized annuity), and
`zero_interest` (fixed markup or none). The method and rate are stored per plan, with a frozen
schedule. Rounding: each installment is rounded to the currency minor unit and the last installment
absorbs the difference, so the schedule sum equals the contractual total exactly.

### B-006 Commission accrual
The policy chooses `earn_on = delivery | full_payment` (default `full_payment`). A commission is
`expected` at sale confirmation and `earned` when the trigger occurs. If the sale is cancelled or
returned, it is `reversed`; a paid commission creates a clawback balance (1400) instead of deleting
history. The policy snapshot is stored on each commission row.

### B-007 Sales commission is a selling expense, not vehicle cost
Broker/agent commissions on **purchase** are vehicle costs (category `commission`). Salesperson
commissions on **sale** are expenses (6100). Reports show both gross profit (price − vehicle cost)
and net contribution (gross profit − sales commission).

### B-008 Operating expenses are not allocated to vehicles automatically
General expenses (rent, salaries, utilities) stay in 6000 and appear in the P&L only. An explicit
allocation to vehicles is possible through the shared-cost allocation tool, which records a
documented method (equal / by purchase price / manual).

### B-009 Tax handling (not certified compliance) **[PO-CONFIRM]**
Tenant tax settings: `taxMode = none | standard | margin`, plus `taxRate` and
`pricesIncludeTax`. Market defaults: EG 14% standard, SA 15% standard, AE 5% standard, all
configurable. The margin scheme computes tax on (price − vehicle cost) when positive. **No claim of
ZATCA (KSA), FTA (UAE), or ETA (Egypt) e-invoicing compliance**; those need certified integrations
(see KNOWN_ISSUES).

### B-010 Inventory valuation = specific identification
Each vehicle is a unique, serialized item, so its cost is the sum of its own posted costs. FIFO or
weighted average do not apply to serialized vehicles. Recorded as tenant setting
`inventoryValuation = specific_identification` (the only supported value).

### B-011 Discount authority
Each role has `maxDiscountPct`, measured against the asking price. A sale below the vehicle's
approved floor price (`min_price`), or a discount above the role limit, sets the sale to
`pending_approval`. A user with `sales.approve_discount` (or `sales.approve_below_floor` for floor
breaches) must approve it, and the decision is recorded in `approval_requests`.

### B-012 Delivery conditions
Delivery requires: sale confirmed; invoice issued; and either fully paid, an active installment
plan, or external finance marked approved. A user with `sales.deliver_with_balance` may override
with a mandatory reason, which is audited.

### B-013 Cancellation rules
* Draft or pending sales: cancel freely (`sales.cancel`); the vehicle returns to its prior state.
* Confirmed, not delivered: needs `sales.cancel_confirmed`, a reason, and no unresolved
  installment payments. Customer money stays as customer credit until a refund is recorded.
* Delivered: handled as a **return**, which needs `sales.return`. It reverses revenue and COGS, the
  vehicle enters `returned`, and refunds are separate approved transactions.

### B-014 Markets
Egypt (EGP, Africa/Cairo), Saudi Arabia (SAR, Asia/Riyadh), and UAE (AED, Asia/Dubai) ship as
market profiles that provide defaults (currency, tax, plate format hints, phone prefix, required
fields). All values can be overridden per tenant.

### B-015 VIN validation by market
VIN is optional (some old or local vehicles lack a 17-character VIN). When provided, the structure
(17 characters, no I/O/Q) is validated. The ISO 3779 check digit is enforced only for
North-American-spec vehicles (where it is mandatory); for others a mismatch is only a warning.

### B-016 Acquisition approval and maker-checker (decided: conservative)
Recording a purchase creates the vehicle as `incoming` right away, so preparation can start. Its
cost is capitalised and becomes payable only when a user with `acquisitions.approve` approves it.
Approval can settle the purchase immediately from a base-currency cash or bank account.
**Maker-checker is enforced on the server.** This applies to every flow that has an approval request:
- acquisitions;
- work orders;
- pending vehicle costs;
- pending expenses.

For each of these:
- The document's creator, and the user who submitted it, cannot approve it, even when they hold
  the approval permission. The API returns 403 `self_approval_forbidden`.
- The approval inbox shows such items with `canDecide = false`.
- Costs and expenses entered by a user who already holds `costs.approve` or `expenses.approve`
  post directly, as before. No approval request exists for them.

As a result, a company needs at least two users with approval rights to approve purchases. Relaxing
this, for example for single-owner dealerships, requires explicit Product Owner approval. It would
be added as an audited tenant setting.

### B-017 Cancelling a purchase
A purchase can be cancelled while the vehicle is unsold and not in transit, and only after any
supplier payments are voided. Cancelling reverses the purchase price and removes the vehicle from
stock; other capitalised costs (transport, repairs) are written off to inventory adjustments
because they were genuinely incurred.

### B-018 Cost approval threshold
v1 uses permission-based approval: users with `costs.approve` / `expenses.approve` post directly;
others create pending items. Amount-based thresholds per role are a future enhancement.

### B-019 Cash box overdraft
Cash boxes cannot go negative (physical cash). Bank accounts may be overdrawn (overdraft facilities
are common) — reports flag negative bank balances.

### B-020 Opening balances
A cash/bank opening balance is posted against owner's equity (3000) and requires
`ledger.post_manual`. Opening inventory for vehicles already in stock is entered as acquisitions
(source "other") so each vehicle carries its own cost.

### B-021 An expired reservation keeps the deposit as customer credit
When a reservation expires, the vehicle is released but the deposit is **not** forfeited
automatically. It stays in 2100 as the customer's credit (an advance). It can be refunded through
the refund workflow, or used on a later sale. Forfeiting income is always an explicit, reasoned
cancel action (B-002), never a side effect of a timer.

### B-022 Refunds need a second person
A refund request is approved by a user with `refunds.approve` who is not the requester (same rule
as B-016). Approval re-checks how much is still refundable, and payment re-checks it again under a
lock, because receipt voids or other refunds may have reduced it. Cancelling a reservation with a
refund more generous than its policy (`full`), or forfeiting a refundable deposit (`none`), needs
`refunds.approve`.

### B-023 Customer privacy defaults
National IDs are stored encrypted (AES-GCM) with a keyed hash for duplicate detection. Only the
last four digits are shown. Revealing the full ID needs `customers.view_sensitive` and is audited.
Sales reps see only the customers and leads assigned to them or created by them. Duplicate checks
never reveal a hidden customer's name (initials only). A national-ID duplicate can never be
forced. A phone duplicate can be forced (family members share phones) by users with
`customers.manage`.

