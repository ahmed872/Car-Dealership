# Execution Status

**Current phase:** Phase 7 backend complete (showroom, integrations, insights) after an adversarial security review; Phase 7 web and the remaining Phase 3/4 web pages in progress; then Phase 8.
**Last completed tasks (2026-10-18):**
- Phase 5 and Phase 6 web pages committed (4536abf, 938c135); list-filter race fixed (21f3eb4).
- CI repaired: it never installed Chromium, so the PDF tests failed from Phase 5 on (1cc027f);
  run on 21f3eb4 is green.
- Phase 7 backend: public showroom with allow-listed fields, listings with publish rules and QR,
  inquiries into customers/leads with triage, integration settings with encrypted secrets, VIN
  decoder, AI descriptions as reviewed suggestions, messaging adapters delivered after commit,
  price guidance and aging recommendations (D-035..D-037).
- Security review fixes: SSRF guard with connect-time address checks and no redirects; no network
  calls inside business transactions; inquiry intake bounded (repeat attachment, daily cap,
  acknowledgements off by default, inactive/ambiguous matches go to triage); only general photos
  public; WebP metadata scrubbed; branch-scoped comparables; platform AI quota.
- Database privileges: earlier migrations had re-granted revoked UPDATE/DELETE rights; all
  restrictions now live in `app_apply_privileges()` (D-038) with a test that pins them.

**In progress (background agents; partial work is saved on disk):**
- Phase 3/4 web workflow `wf_c6e05060-0fb` (script `phase3-4-web-wf_5d942e13-d19.js`, resumable):
  cash/expenses/accounting, customers/leads/notifications, appointments/reservations/receivables,
  wishes/employees.

**Exact next tasks:**
1. Phase 7 web: public showroom pages, listing tab on Vehicle 360, integrations settings, inquiry
   triage list, price guidance and aging recommendations.
2. Review and commit each finished Phase 3/4 web feature; web integration pass (task list in
   EXECUTION_PLAN / KNOWN_ISSUES: module import cycle, phone display, API gaps).
3. Phase 8: hardening (KI-001, KI-005, KI-021), permission matrix, isolation sweep, Playwright
   E2E (AR/EN/mobile), backup and restore drill, performance smoke, Docker/compose, runbooks,
   readiness report; then the final audit and report.

| Phase | Status |
|---|---|
| 0 Discovery & Architecture | Complete |
| 1 Foundation | Complete |
| 2 Vehicles & Inventory | Complete |
| 3 Acquisitions & Cost Engine | Backend complete; 3 adversarial reviews fixed; web pages in progress |
| 4 CRM & Operations | Backend complete & tested (merged); web pages in progress |
| 5 Sales & Financial | Complete (backend + web) |
| 6 Dashboard & Reports | Complete (backend + web) |
| 7 Showroom & Integrations | Backend complete & reviewed; web pages next |
| 8 Hardening | Not started |

## Phase 1 — delivered
- pnpm workspace: `packages/shared`, `apps/api`, `apps/web`, `e2e`.
- DB: migrations `0000_foundation`, `0001_foundation_security` (RLS on all tenant tables, audit hash chain
  trigger, immutable + balanced ledger triggers, gapless numbering function, narrow SECURITY DEFINER helpers).
- API: sessions (hashed tokens, idle+absolute expiry), CSRF (session-bound token + Origin check), argon2id,
  lockout, rate limits, RBAC guard (deny-by-default), per-request tenant transaction, idempotency interceptor,
  provisioning, users/roles/branches/company settings, audit list/verify, health endpoints, OpenAPI at /api/docs.
- Web: design system (light/dark, RTL/LTR), login, company selection, account, platform admin, settings pages.
- CI workflow `.github/workflows/ci.yml` (not yet observed running on GitHub).

## Phase 2 — delivered
- Migrations 0002/0003: vehicles + catalog (global/tenant RLS), history tables (append-only grants),
  media/documents, inspections (completed = immutable via trigger), transfers, stock counts, trigram search;
  seeded 39 makes / 164 models / 53 features / default inspection template.
- API: Vehicle CRUD (optimistic locking, market-aware VIN rules), lifecycle transitions through one locked entry
  point, pricing with floor permission + history, odometer readings with correction rule, features, media
  (sniffed types, GPS/XMP scrub, primary/public/order), documents (sensitive filtering), inspections (template
  snapshot, required items, completion), transfers (in-transit blocking, destination receipt), stock counts
  (scan/submit/reconcile with write-off), catalog, permission-checked file downloads.
- Web: vehicle grid/table list with filters, sectioned form, Vehicle 360 page with tabs and action modals,
  inspection page with interactive SVG body diagram (colour + letter codes), transfers, stock counts.

## Phase 3 — delivered so far
- Migrations 0004/0005:
  - tables: suppliers, cost categories (25 seeded), acquisitions, vehicle costs, cash accounts, cash
    transactions (append-only), supplier payments with allocations (append-only), expenses, work
    orders and items, approval requests;
  - RLS on all of them;
  - DELETE revoked on financial documents;
  - posted-amount guard triggers.
- FinanceModule (global):
  - CashService: cash book and GL together; transfers and transfer reversal; closed-day hook.
  - CashAccountsService: opening balance against equity (3000).
  - PayablesService.
  - SupplierPaymentsService: exact allocation, no overpayment, void.
  - ApprovalsService: inbox, exact counts, maker-checker guard.
- PurchasingModule:
  - suppliers 360, duplicate check, GL statement;
  - acquisitions: draft → submit → approve/reject → cancel, with pay-on-approval;
  - cost engine: approve, reject, reverse, shared-cost allocation, costs posted after a sale go to
    COGS, summary with expected profit;
  - open payables, and aging reconciled to GL 2000.
- ExpensesModule: post, approve, reject, reverse, pay-now, summaries.
- WorkOrdersModule: approved items become posted costs, exactly once.
- AccountingModule:
  - transfers and reversal, cash book;
  - chart, trial balance, journal, account statement;
  - income statement and balance sheet;
  - reconciliation of cash vs 1100, inventory vs 1300, AP vs 2000.
- B-016 decided conservatively: the creator or submitter cannot approve their own purchase, work
  order, pending cost or pending expense.
- Cross-cutting fixes:
  - idempotent replays of 200 POSTs keep status 200;
  - branch filters use `inArray`;
  - the `patchOf()` helper replaces zod `.partial()`, which wiped the VIN, reset `isSensitive`
    and reactivated branches on PATCH;
  - document numbers use the tenant's timezone year.

## Phase 4 — delivered (backend)
- Migrations 0007/0008:
  - 15 CRM tables, all with RLS;
  - append-only stage history and receipt allocations;
  - receipt and refund amount guards;
  - a btree_gist exclusion constraint that blocks double-booked test drives;
  - the default 8-stage pipeline;
  - the system user for scheduled jobs.
- Finance: ReceiptsService (customer money goes to 2100 through CashService; void is refused once
  the money was used) and RefundsService (request → approve by another user → pay).
- Reservations: the vehicle is locked; deposits are receipts. Cancel per policy forfeits to 4200
  with a reason. Expiry releases the vehicle and keeps the deposit as customer credit (B-021).
  Jobs send reminders and handle expiry.
- Customers:
  - phone normalisation including Arabic digits;
  - national ID encrypted plus a keyed hash, revealed only with permission and audited;
  - duplicate rules (B-023) and rep visibility;
  - 360 view and interaction timeline.
- Leads: LD numbering, a configurable pipeline (copy-on-write defaults, D-021), board,
  follow-ups, an exactly-once reminder job, won/lost/reopen, and assignment by managers.
- Appointments: a shared calendar with private details (D-022), staff and vehicle clash checks,
  test-drive start/finish with licence and odometer checks, timeline entries, reminders.
- Wishes: a pure shared matcher (D-023), a matching job, exactly-once notifications, explain,
  dismiss and for-vehicle.
- Employees and versioned commission policies, never retroactive (D-024); preview uses the shared
  calculator.
- Jobs: advisory-locked per-tenant runner; Notifications: deduplicated inbox.

## Phase 3 review round 2 — fixed (2026-10-17)
- **Concurrency (D-025).** Write transactions of a company now take one advisory lock first. This
  removes the deadlocks between pay-now flows, supplier payments, transfers, allocations and
  opposite-order payments. Acquisition approve takes the reviewed `version` (409 when the
  purchase changed).
- **Authorization.**
  - Accounts-payable reads need `suppliers.read` + `payments.read`, so sales roles no longer see
    purchase prices or AP aging.
  - Voids check the branch of each document.
  - Only all-branch users manage company-level cash accounts. An empty PATCH is a no-op, not a 500.
  - Supplier identity (national ID, tax number) is hidden without `suppliers.read`.
- **Maker-checker.**
  - One maker rule, from the audit trail, covers acquisitions and work orders (item editors are
    makers).
  - The inbox `canDecide` uses that same rule.
  - Vehicle-bound requests follow the vehicle's current branch.

## Phase 5 — delivered (backend)
- Migrations 0009/0010:
  - sales, trade-ins, installment plans/installments/allocations, commissions, sale documents and
    cash day closings, all with RLS;
  - DELETE revoked; installments and allocations immutable;
  - guards that freeze sale terms once confirmed, freeze documents, and protect closings;
  - one live sale per vehicle, one live document per type and sale, one live closing per day.
- Sales: pricing against asking/floor and the seller's discount limit, approval inbox with
  maker-checker, confirmation (frozen terms, trade-ins into stock, deposit transfer, plan,
  expected commission, lead won), delivery rules (B-012), cancellation and returns that unwind
  everything (D-028).
- Installments (D-029): frozen schedule, oldest-first allocation with 2400 → 4100 release, quote
  and early settlement with waiver, reminders job.
- Commissions (D-030), documents and PDFs (D-031), daily cash closing (D-032).
- Spec: `test/sales.spec.ts` (17 scenarios), ledger integrity checked after every test.

## Phase 6 — delivered (backend)
- `GET /dashboard`: inventory, sales (with a 6-month trend), leads, today's appointments, cash,
  receivables and approvals blocks, each behind its permission and the user's branch scope.
- `GET /reports/{inventory,sales,leads,cash-flow,receivables}` return a shared `ReportResult`
  (columns with types, rows, totals, summary, ledger reconciliation, drill-down kind).
- `GET /reports/:key/export?format=csv|xlsx|pdf&locale=ar|en`, with the same filters and
  column policy.
- `PdfService` moved to its own module (PdfModule), used by sale documents and report exports.
- Spec: `test/reports.spec.ts` (10 scenarios).

## Local environment notes (for resumption)
- PostgreSQL 16 local cluster: `service postgresql start`.
- Roles/DBs bootstrapped with `infra/db/bootstrap-roles.sql` (dev passwords in `apps/api/.env`, not committed).
- Dev reset: `cd apps/api && set -a && . ./.env && set +a && node -r @swc-node/register src/db/reset.ts`.
- Platform admin (dev DB): admin@autohub.local / see session notes; tenant `elite-motors` owner owner@elite.test.

## External credentials required
See docs/KNOWN_ISSUES.md (EXT-01 … EXT-08).
