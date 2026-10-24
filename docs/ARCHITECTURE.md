# AutoHub Pro — Architecture

Status: living document. Last updated during Phase 0 (greenfield repository).

## 1. Phase 0 audit summary

| Item | Finding |
|---|---|
| Repository | Empty (no commits, no files) on branch `claude/fervent-johnson-39su60`. Greenfield build. |
| Runtime | Node.js 22.22, pnpm 10.28, npm 10.9 |
| Database | PostgreSQL 16.15 installed locally (cluster `16/main`), started for development/testing |
| Browser | Chromium 141 (Playwright build 1194) at `/opt/pw-browsers` → Playwright pinned to 1.56.1 |
| Docker | CLI present, daemon not running in the sandbox |
| Fonts | No Arabic system fonts → Arabic fonts are bundled from npm (`@fontsource`) for UI and PDFs |
| Network | npm registry reachable; most other hosts go through a policy proxy (external APIs may be blocked) |

Because nothing existed, there was no prior architecture to preserve. The stack below follows the
preferred defaults in the product brief, with the reasons recorded in `docs/DECISIONS.md`.

## 2. System overview

```
┌──────────────────────────┐        ┌─────────────────────────────────────────┐
│ apps/web (React SPA)     │  HTTPS │ apps/api (NestJS, REST /api/v1, OpenAPI)│
│ • Admin app  (/app/*)    │───────▶│ • Guards: session → tenant → permission │
│ • Public showroom (/s/*) │ cookie │ • Per-request DB transaction (ALS)      │
└──────────────────────────┘ + CSRF │ • Domain modules (vehicles, sales, …)   │
                                    │ • Posting engine (double-entry GL)      │
                                    │ • Storage driver (local / S3)           │
                                    │ • Integration adapters (VIN, AI, msg)   │
                                    │ • In-process job runner (advisory lock) │
                                    └──────────────┬──────────────────────────┘
                                                   │ role autohub_app (no BYPASSRLS)
                                    ┌──────────────▼──────────────────────────┐
                                    │ PostgreSQL 16                            │
                                    │ • Row-Level Security on every tenant tbl │
                                    │ • CHECK / UNIQUE / partial indexes       │
                                    │ • Immutable ledger + audit hash chain    │
                                    └──────────────────────────────────────────┘
```

A modular monolith. No microservices, Redis, or event streaming: a single dealership group
generates modest load, and PostgreSQL transactions give the consistency the financial workflows
need. Module boundaries inside the API keep a later split possible.

## 3. Repository layout

```
apps/api          NestJS API: src/modules/<domain>, src/db (Drizzle schema + SQL migrations)
apps/web          React + Vite + Tailwind SPA: admin app and public showroom
packages/shared   Zod schemas, permission catalog, enums, Decimal money utilities,
                  finance calculators (installments, VAT, commissions, pricing),
                  vehicle lifecycle state machine, VIN validation
e2e               Playwright end-to-end tests
infra             Dockerfiles, docker-compose, backup/restore scripts
docs              Plan, status, decisions, test report, known issues, runbooks
```

The finance calculators live in `packages/shared` so they can be unit-tested in isolation and used
by the UI for previews. The server always recomputes; the client is never trusted for money.

## 4. Multi-tenancy and isolation

* Every tenant-owned table has `tenant_id uuid not null` and RLS enabled:
  `USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())`.
  RLS is not FORCED: it binds the application role (which is not the owner); the owner role used
  by migrations, operations and tests' owner pool is deliberately not subject to it.
* References between a company's records are guarded by the database as well (D-039): composite
  `(tenant_id, id)` foreign keys between tenant tables, and a trigger for references to shared
  catalogs, so even an RLS-exempt connection cannot link one company's record to another's.
* `app_current_tenant()` reads `current_setting('app.tenant_id', true)`; when it is unset the
  function returns NULL and every policy denies. Default-deny.
* The API connects as `autohub_app`: not a superuser, not the table owner, no `BYPASSRLS`.
  Migrations run as the owner role.
* The tenant id comes from the server-side session (active membership), never from the client.
  Each request runs inside one transaction that calls `set_config('app.tenant_id', …, true)`
  (transaction-local, so pooled connections cannot leak context).
* Global tables without tenant data (`users`, `sessions`, `subscription_plans`) are not
  tenant-scoped. Catalog tables (`vehicle_makes`, `features`, `cost_categories`) allow
  `tenant_id IS NULL` rows (platform catalog) plus tenant rows.
* Cross-tenant operations (job runner listing tenants, public showroom slug lookup) use narrow
  `SECURITY DEFINER` functions that return ids only.
* Branch scoping (users limited to some branches) is enforced in the service layer with a shared
  helper, and covered by tests.

## 5. Request pipeline

1. `SessionGuard` — reads the `ah_sid` cookie, loads the session (hashed token), checks expiry and
   revocation, loads the active membership, role permissions, and branch scope.
2. `CsrfGuard` — state-changing methods require the `X-CSRF-Token` header to match the `ah_csrf`
   cookie (double submit), plus an Origin allow-list check.
3. `PermissionGuard` — `@RequirePermissions('sales.confirm')` metadata, checked on the server.
4. `TenantTransactionInterceptor` — opens the transaction, sets `app.tenant_id` and `app.user_id`,
   stores the transaction in AsyncLocalStorage, and commits or rolls back. The whole mutation is
   atomic.
5. `IdempotencyService` — financial POSTs require `Idempotency-Key`; the key row is inserted in the
   same transaction, so a retried or concurrent duplicate returns the stored response.
6. Zod validation pipe — shared schemas validate every body and query on the server.
7. Exception filter — maps domain errors to a stable error envelope
   `{ error: { code, message, details } }`; no stack traces leak in production.

## 6. Financial model

* Amounts are `numeric(18,2)`, exchange rates `numeric(18,8)`, and percentages `numeric(9,4)`.
  All arithmetic uses `decimal.js` through `packages/shared/money`. JS floating point is never used
  for money, and the API transports amounts as strings.
* Each tenant has a base currency (EGP / SAR / AED). A foreign-currency transaction stores the
  currency, the rate, the rate date, and the base amount.
* **Double-entry general ledger** (`journal_entries`, `journal_lines`). Each financial event posts a
  balanced entry in the same DB transaction as the business change.
  * A deferred constraint trigger rejects any unbalanced entry at commit.
  * A unique `(tenant_id, source_type, source_id, event)` index blocks double posting.
  * Ledger rows cannot be updated or deleted (trigger); corrections are reversal entries.
  * Lines carry dimensions (vehicle, customer, supplier, cash account, sale, branch) so sub-ledgers
    reconcile to control accounts.
* Revenue recognition is a tenant setting (`on_delivery`, the conservative default, or
  `on_confirmation`). Before recognition, customer money is a liability (customer advances).
  Deposits are never revenue.
* The cash book (`cash_transactions`) is append-only; balances are derived, never stored as
  editable fields. Daily closing compares the book balance with the counted balance and posts any
  difference as an approved over/short adjustment.

System chart of accounts (seeded per tenant):

| Code | Account | Type |
|---|---|---|
| 1100 | Cash & bank (dimension: cash account) | Asset |
| 1200 | Accounts receivable – customers | Asset |
| 1300 | Vehicle inventory (dimension: vehicle) | Asset |
| 1400 | Commission advances / clawbacks | Asset |
| 2000 | Supplier payables | Liability |
| 2100 | Customer deposits & advances | Liability |
| 2200 | Output tax payable | Liability |
| 2300 | Commissions payable | Liability |
| 2400 | Deferred finance income | Liability |
| 3000 | Owner equity / opening balances | Equity |
| 4000 | Vehicle sales revenue | Income |
| 4100 | Finance income (installments) | Income |
| 4200 | Other income (forfeited deposits) | Income |
| 5000 | Cost of vehicles sold | Expense |
| 6000 | Operating expenses | Expense |
| 6100 | Sales commissions | Expense |
| 6200 | Cash over / short | Expense |
| 6300 | Inventory adjustments & write-offs | Expense |

Posting rules are listed in `docs/FINANCIAL_POLICIES.md` (written in Phase 3).

## 7. Vehicle lifecycle

```
incoming ─┬─▶ awaiting_inspection ─▶ in_inspection ─┬─▶ in_preparation ─┐
          │                                          ├─▶ ready ◀────────┤
          └─────────────────────────────────────────▶└─▶ available ◀────┘
available ──(reservation)──▶ reserved ──(sale)──▶ sale_pending ──(confirm)──▶ sold ──(delivery)──▶ delivered
available ──(sale)──▶ sale_pending          reserved ──(cancel/expire)──▶ available
sale_pending ──(draft cancelled)──▶ available | reserved      sold ──(cancel before delivery)──▶ available
delivered ──(return)──▶ returned ──▶ awaiting_inspection | in_preparation | available
any pre-sale state ──▶ removed (with reason & permission)
```

`reserved`, `sale_pending`, `sold`, `delivered`, and `returned` are **system-only** states: only
the reservation, sale, delivery, and return workflows can set them, under a row lock on the vehicle.
The manual status endpoint rejects those targets. Every change writes `vehicle_status_history`.
Tenants can rename status labels; the state keys and transition rules stay fixed.

## 8. Entity-relationship overview (textual ERD)

```
tenants 1─* branches
tenants 1─* memberships *─1 users            memberships *─1 roles (tenant roles, permissions text[])
memberships 1─* membership_branches *─1 branches
users 1─* sessions
tenants 1─1 tenant_settings ; tenants 1─* tenant_subscriptions *─1 subscription_plans

vehicle_makes 1─* vehicle_models                (tenant_id NULL = platform catalog)
vehicles *─1 branches ; vehicles *─1 vehicle_makes/models ; vehicles *─0..1 acquisitions
vehicles 1─* vehicle_status_history ; 1─* vehicle_price_history ; 1─* odometer_readings
vehicles 1─* vehicle_feature_links *─1 features
vehicles 1─* vehicle_media *─1 files ; vehicles 1─* vehicle_documents *─1 files
vehicles 1─* vehicle_inspections 1─* inspection_items / inspection_panels / inspection_media
vehicles 1─0..1 vehicle_listings (public showroom data, separate from internal data)
vehicles 1─* vehicle_transfers ; stock_counts 1─* stock_count_lines *─1 vehicles

suppliers 1─* acquisitions 1─1 vehicles ; acquisitions 0..1─1 trade_ins
vehicles 1─* vehicle_costs *─1 cost_categories ; vehicle_costs *─0..1 suppliers
work_orders *─1 vehicles ; work_orders 1─* work_order_items ─▶ vehicle_costs (unique source)
supplier_payments *─1 suppliers ─▶ (acquisition | vehicle_cost | expense)

customers 1─* customer_interactions ; customers 1─* leads *─1 pipeline_stages
customers 1─* vehicle_wishes ; appointments *─1 customers/vehicles ; test_drives *─1 appointments
reservations *─1 vehicles/customers (partial unique: one active per vehicle)
sales *─1 customers/branches/users ; sales 1─* sale_items *─1 vehicles
sales 0..1─1 installment_plans 1─* installments
sales 1─* trade_ins ; sales 1─* commissions *─1 commission_policies (snapshot stored)
payments *─1 customers ─▶ (sale | reservation | installment plan) ; payments 1─* installment_allocations
refunds *─1 payments/reservations/sales
issued_documents (contract/invoice/receipt/delivery note; immutable JSON snapshot + number)
cash_accounts 1─* cash_transactions ; cash_accounts 1─* cash_closings ; cash_transfers
expenses *─1 cost_categories ; journal_entries 1─* journal_lines (ledger)
notifications 1─* notification_deliveries ; audit_logs (hash-chained per tenant)
files ; attachments (entity_type, entity_id → files) ; number_sequences ; idempotency_keys
integration_settings ; approval_requests
```

Detailed column definitions live in `apps/api/src/db/schema/*.ts` and the SQL migrations.

## 9. Security model (summary)

* Argon2id password hashing (`@node-rs/argon2`), lockout after repeated failures, IP rate limits on
  auth endpoints.
* Server-side sessions: random 256-bit token, stored as a SHA-256 hash, httpOnly + SameSite=Lax +
  Secure (prod) cookie, idle and absolute expiry, logout revokes the session.
* CSRF: double-submit token plus an Origin check on every state-changing request.
* RBAC on the server (`PermissionGuard`) plus RLS at the database layer.
* IDOR protection: every lookup runs under RLS and checks branch scope; ids are UUIDs.
* Files: MIME sniffing and an extension allow-list, size limits, tenant-prefixed storage keys, no
  public permanent URLs for private files, and a separate permission for sensitive documents.
* Audit log: append-only, SHA-256 hash chain per tenant, verification endpoint. This detects
  tampering by anyone without database-owner rights. It does not prevent a DB superuser from
  rewriting the chain; see `docs/SECURITY.md`.
* Secrets come only from environment variables. Integration secrets and customer and supplier
  national IDs are encrypted at rest with AES-256-GCM using `APP_ENCRYPTION_KEY` (B-023, D-047).
* Logs are structured JSON with redaction of authorization, cookie, password, token, and national
  id fields.
