# Execution Status

**Current phase:** Phase 3 — Acquisitions & Cost Engine (backend integrated and green; verification + web in progress)
**Last completed task:**
- Phase 3 review fixes (realized FX, date-safe cash, maker-checker on edits, tenant-safe references).
- 16 API test files, 174 tests passing. Pushed.

**Interrupted by usage limits (resume these):**
- Phase 3 reviews R2 (concurrency) and R3 (authz) still need to run.
- Phase 3 web pages need building (W1–W4 produced nothing).
- Phase 4 module agents left partial files in the `phase4-wip` worktree: customers and leads services.

**Exact next task:**
1. Run the R2 and R3 reviews. Use a lean setup: 2 agents, and fix the findings myself.
2. Build the Phase 3 web pages, using fewer and larger agents.
3. Rebase `phase4-wip` onto main and renumber its migrations to 0007/0008, because main now has 0006.
4. Finish the Phase 4 modules, then build Phase 4 web.

| Phase | Status |
|---|---|
| 0 Discovery & Architecture | Complete |
| 1 Foundation | Complete |
| 2 Vehicles & Inventory | Complete |
| 3 Acquisitions & Cost Engine | Backend complete & tested; web + adversarial review in progress |
| 4 CRM & Operations | Not started |
| 5 Sales & Financial | Not started |
| 6 Dashboard & Reports | Not started |
| 7 Showroom & Integrations | Not started |
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

## Local environment notes (for resumption)
- PostgreSQL 16 local cluster: `service postgresql start`.
- Roles/DBs bootstrapped with `infra/db/bootstrap-roles.sql` (dev passwords in `apps/api/.env`, not committed).
- Dev reset: `cd apps/api && set -a && . ./.env && set +a && node -r @swc-node/register src/db/reset.ts`.
- Platform admin (dev DB): admin@autohub.local / see session notes; tenant `elite-motors` owner owner@elite.test.

## External credentials required
See docs/KNOWN_ISSUES.md (EXT-01 … EXT-08).
