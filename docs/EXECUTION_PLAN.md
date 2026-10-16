# AutoHub Pro — Execution Plan

Phases are engineering checkpoints, executed in order. A phase is complete only when its acceptance
criteria are backed by evidence: passing tests, a successful build, and verified behaviour. Status
tracking lives in `docs/EXECUTION_STATUS.md`.

Priority when trade-offs are needed: (1) data integrity and financial correctness, (2) security and
tenant isolation, (3) end-to-end workflows, (4) functional UI/API, (5) automated tests,
(6) reports and integrations, (7) visual polish.

---

## Phase 0 — Discovery & Architecture
Tasks: audit the repo and environment; choose the architecture; write ARCHITECTURE, DECISIONS,
PLAN, TRACEABILITY, STATUS, TEST_REPORT, and KNOWN_ISSUES.
Acceptance: all docs exist; risks and open business decisions are listed.

## Phase 1 — Foundation
Tasks
1. pnpm workspace, TS configs, ESLint, Prettier, shared package.
2. NestJS app: config validation (zod env schema), structured logging with redaction, error
   envelope, health endpoints (`/health/live`, `/health/ready`).
3. DB: Drizzle schema for tenancy and auth tables; migrator; roles `autohub_owner`/`autohub_app`;
   RLS helper functions and policies; audit hash-chain trigger; number sequences; idempotency keys.
4. Auth: login, logout, me, switch tenant, change password; sessions; lockout; rate limits; CSRF.
5. RBAC: permission catalog, system role templates, guards, branch scope helper.
6. Tenant provisioning (platform admin): tenant + branch + owner + roles + settings + chart of
   accounts + subscription.
7. Users & roles management API.
8. Web: Vite/React/Tailwind design system, i18n (ar RTL / en LTR), dark/light theme, app shell,
   login, users/roles/branches/settings pages.
9. Tests: unit (shared), integration (auth, RBAC, RLS isolation, audit chain), CI workflow.

Acceptance
- Migrations create the DB from scratch on a clean database.
- Login/logout/CSRF/lockout are covered by integration tests.
- Cross-tenant reads and writes are denied at the API **and** DB (RLS) layers, proven by tests.
- The audit chain verifies, and tampering is detected in a test.
- `pnpm build` succeeds for all packages; lint and typecheck pass.

## Phase 2 — Vehicle & Inventory
Tasks: makes/models catalog; vehicles CRUD with market-aware validation; VIN validation; features
catalog and links; files upload/download with permissions; vehicle media (order, primary) and
documents (expiry, sensitive); odometer readings; inspection templates and inspections (items,
panels, media, immutable after completion, history); lifecycle state machine and status history;
search, filters, sorting, pagination; price history; branch transfers; stock counts and
reconciliation; aging.
Web: vehicle list (grid/table), vehicle form, Vehicle 360 with tabs, interactive SVG body diagram,
inspection form, media gallery, documents, transfers, stock count screens.
Acceptance: state machine unit tests; integration tests for transitions (illegal ones rejected),
sensitive document access denied without permission, cross-tenant file access denied, transfer
blocks reservation while in transit.

## Phase 3 — Acquisitions & Cost Engine
Tasks: suppliers; acquisitions (draft → pending approval → approved → cancelled) with GL posting;
supplier payments and payables; cost categories; vehicle costs (pending/posted/reversed), shared
cost allocation, FX; work orders with items → posted costs (unique source); pricing (asking, floor,
target margin) with permission-controlled floor changes and history; profitability and cost
breakdown; GL posting engine with chart of accounts; trial balance.
Acceptance: cost total = sum of posted costs = GL inventory balance for the vehicle; duplicate
posting rejected; reversal flow tested; FX rounding tested.

## Phase 4 — CRM & Operations
Tasks: customers (individual/company, dedupe search), interactions, pipeline stages, leads with
stage history and lost reasons, wishes and matching notifications (deduplicated), appointments and
test drives, reservations with deposit (idempotent), expiry and cancellation with refund policy,
notifications inbox, employees (users) and commission policies (versioned).
Acceptance: two concurrent reservations of one vehicle → exactly one succeeds (test); deposit retry
with the same key creates one payment; wish matching creates one notification per (wish, vehicle).

## Phase 5 — Sales & Financial Workflows
Tasks: sales draft → approval → confirm → deliver → cancel/return; sale items with snapshots;
discounts and approvals; trade-ins; tax calculation; documents (contract, invoice, receipt,
delivery note) with gapless numbering and immutable snapshots; PDF AR/EN; payments, receipts,
refunds; cash accounts, transfers, daily closing and over/short; operating expenses; installment
plans (flat/reducing/zero) with allocation and early settlement; commissions earn/approve/pay/
reverse; revenue recognition and COGS postings.
Acceptance: full workflow integration test with GL balanced and sub-ledgers reconciled; double
sale prevented; repeated payment request creates one payment; installment schedule sums exactly;
cancellation and return reverse correctly.

## Phase 6 — Dashboard & Reporting
Tasks: KPI endpoint (period, branch); inventory valuation and aging; vehicle profitability; sales
by employee/branch/source; lead conversion; cash flow; P&L and trial balance from the GL;
receivables and installment aging; drill-down links; CSV/XLSX/PDF exports with column-level
permission filtering.
Acceptance: report numbers match the GL and transactional sources in tests; exports omit cost and
profit columns for users without `costs.view`.

## Phase 7 — Digital Showroom & Integrations
Tasks: vehicle listings (separate public content), publish/unpublish policy, public API and pages
(list, filter, detail), QR code, share links, WhatsApp deep links, inquiry and test-drive request
forms (rate limited) → leads; integration settings (encrypted secrets); adapters for VIN decode
(NHTSA vPIC), AI text (Anthropic; template fallback), messaging (log-only dev adapter), OCR
(interface only); price guidance from the tenant's own sales history (labelled as an estimate);
aging recommendations; subscription plans and limits.
Acceptance: public endpoints never expose cost, profit, internal notes, or unpublished/sold
vehicles (tests); adapter failures and timeouts do not break core flows (tests).

## Phase 8 — Commercial Hardening
Tasks: security review (OWASP checklist), permission matrix test, tenant isolation sweep across all
endpoints, E2E Playwright journey (AR + EN, mobile viewport), backup and **restore test** into a
fresh DB, performance smoke test (seeded volume), Dockerfiles and compose, CI, deployment and
operations runbooks, commercial readiness report.
Acceptance: all suites green or failures documented; restore verified by row counts + GL balance +
audit chain; final report delivered.

---

# Requirements Traceability Matrix

| Req (brief §) | Requirement | Module(s) | Evidence (tests) |
|---|---|---|---|
| §4A | Vehicle core data, VIN, market fields | vehicles | shared/vin.test, api/vehicles.spec |
| §4B | Configurable inspection, panels, SVG diagram, history | inspections, web/VehicleDiagram | api/inspections.spec |
| §4C | Media, documents, expiry, sensitive access | files, vehicles | api/files.spec |
| §4D | Searchable features | features | api/vehicles.spec (filter by feature) |
| §5 | Lifecycle, transitions, history, transfers, stock count, aging | vehicles, inventory | shared/lifecycle.test, api/inventory.spec |
| §6 | Acquisitions, approvals, payables, cancellation | acquisitions, suppliers | api/acquisitions.spec |
| §7 | Cost engine, pricing, floors, discounts, Decimal | costs, pricing, ledger | shared/money.test, api/costs.spec |
| §8 | Sales cycle, snapshots, numbering, PDF, delivery, cancel/return | sales, documents | api/sales.spec |
| §9 | Installments, allocation, early settlement | installments | shared/installments.test, api/installments.spec |
| §10 | CRM, pipeline, interactions, wishes, matching | crm | api/crm.spec |
| §11 | RBAC, roles, branch scope, commissions | auth, rbac, commissions | api/rbac.spec, shared/commission.test |
| §12 | Cash, banks, transfers, closing, ledger | cash, ledger | api/cash.spec, api/ledger.spec |
| §13 | Work orders → costs, no duplicates | work-orders | api/work-orders.spec |
| §14 | Trade-in separate asset, no double counting | sales/trade-ins | api/sales.spec (trade-in) |
| §15 | Dashboard, reports, drill-down, exports | reports | api/reports.spec |
| §16 | Public showroom, QR, WhatsApp, hide internals | showroom | api/showroom.spec, e2e |
| §17 | Integration adapters, AI with guardrails | integrations | api/integrations.spec |
| §18 | AR/EN, RTL, markets, currencies, timezones | web i18n, settings | e2e rtl, shared/markets.test |
| §19 | Multi-tenancy, RLS, subscriptions, limits | tenancy | api/isolation.spec |
| §20 | Security controls | auth, files, audit | api/auth.spec, api/audit.spec |
| §21 | Design system, dark mode, responsive, a11y | web | e2e, manual review |
| §22–23 | Schema, REST, OpenAPI, idempotency | db, api | migration test, api/idempotency.spec |
| §24 | Tests | all | TEST_REPORT.md |
| §25 | Backup/restore, CI, Docker, health | infra | backup restore drill log |
