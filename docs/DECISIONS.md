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
