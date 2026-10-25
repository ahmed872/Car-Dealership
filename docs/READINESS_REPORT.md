# AutoHub Pro — Commercial Readiness Report

Date: 2026-10-25 · Branch `claude/fervent-johnson-39su60` · Assessed head: `95e4a3e` plus documentation.

This report states what has been built and verified, what has not, and what must happen before a
first paying dealership uses the system. Every result quoted here was produced by a command that was
actually run (see `docs/TEST_REPORT.md`); nothing is projected.

## 1. Verdict

**Ready for a controlled pilot** (one or a few friendly dealerships, on a staging-grade deployment
operated by us) once the go-live checklist in §5 is done.
**Not yet ready for general availability.** The blockers are external, not code: no production
deployment exists, no certified e-invoicing, no messaging provider, no load test at production
volume. None of the open code issues is P0 or P1.

## 2. What is built

| Area | Scope (summary) |
|---|---|
| Platform | Multi-company SaaS, PostgreSQL row-level security on every tenant table plus composite tenant foreign keys (D-039); branch scope enforced in services; deny-by-default permissions on every route (`docs/PERMISSION_MATRIX.md`); company invitations; sessions with CSRF, lockout, rate limits; audit log with a verifiable hash chain. |
| Vehicles & inventory | VIN rules per market, lifecycle state machine, inspections with an SVG body diagram, media and documents (sensitive access), transfers, stock counts, aging advice. |
| Purchasing & costs | Acquisitions with maker-checker approval, suppliers (encrypted national IDs), vehicle costs and shared-cost allocation, work orders, payables, supplier payments. |
| Sales & finance | Sales with price floors and discount approvals, documents (contract, invoice, credit note — commercial, not certified), deliveries, cancellations/returns, trade-ins, installment plans, receipts, refunds (maker-checker), reservations and deposits (liabilities, never revenue), cash and bank accounts, transfers with FX bounded by company reference rates, cash closing, expenses, double-entry ledger with reversals only, financial reports. |
| CRM | Customers (encrypted national IDs, duplicate detection), leads pipeline, follow-ups, appointments and test drives, customer car wishes and matching, commissions with versioned policies. |
| Dashboard & reports | KPIs with drill-down, reports matching the ledger, Excel/CSV/PDF exports (cost and profit hidden without permission). |
| Showroom | Public listings, QR codes, WhatsApp share, inquiries with spam limits; integration adapters (log-only messaging, signed webhook, AI text with template fallback). |
| Privacy | Erasure of showroom-visitor personal data on request and optional retention (D-053); national IDs encrypted, masked, revealed only with permission and audited. |
| Web | React app in Arabic (RTL, default) and English (LTR), usable at 390px; every API error has an Arabic and English message (enforced by a test). |
| Operations | Docker images, compose stack, backup/restore scripts with a verifying drill, runbooks (`DEPLOYMENT.md`, `OPERATIONS.md`), CI workflow with an E2E job. |

## 3. Verification evidence (latest runs)

| Check | Result |
|---|---|
| API integration suite (real PostgreSQL 16, 40 spec files) | **389 passed**, 2 skipped (opt-in perf smoke) |
| Browser E2E suite (Playwright, 15 specs × Arabic desktop / English desktop / Arabic 390px) | **69 passed**, 0 flaky, in four separate runs across the last merges |
| Shared domain unit tests / web unit tests | 49 / 8 passed |
| Type checks (shared, api, web, e2e), lint on changed files, production web build | clean |
| Restore drill on the current schema (21 migrations) | **31/31 checks passed**: identical row counts and content hashes, ledger balanced, audit chain verified, RLS active for the app role |
| Tenant isolation sweep (every single-record GET with a foreign id) | no leaks |
| Security reviews | first review: 11 findings (F1–F11), all fixed with regression tests; final audit: 5 findings + 1 doc mismatch (A1–A6), all fixed with regression tests that fail on the old code |
| Performance smoke (in-process, one busy company) | every read route p95 ≤ 35 ms; not a load test (KI-023) |

## 4. Known gaps that matter commercially

External dependencies (need an account, keys or a legal decision — `docs/KNOWN_ISSUES.md` EXT-01…08):
- **E-invoicing (ZATCA / FTA / ETA) is not implemented.** Invoices are commercial documents and say
  so. KSA customers in particular will need this before using the invoices for tax.
- **No WhatsApp/SMS/email provider** — messages are logged, or sent through a company's own webhook.
- **No subscription payment gateway**, **no OCR**, **no market-price or traffic-fines data**.
- **Object storage (S3/R2)** driver exists but was tested only with local storage.
- **No production deployment has been performed** (hosting, domain, TLS, monitoring).

Open P2 issues (none P0/P1): unrealised FX revaluation (KI-002), supplier advances (KI-003),
per-company write serialisation (KI-006), trade-in and credit handling after cancellations (KI-007,
KI-008), no CAPTCHA on public inquiries (KI-018), no load test (KI-023), encryption key cannot be
rotated (KI-024), supplier IDs written before the upgrade stay plain until the backfill command runs
(KI-030), erasure limited to non-customer data (KI-034).

## 5. Go-live checklist for a pilot

1. Provision staging/production (`docs/DEPLOYMENT.md`): PostgreSQL 16 with backups, object storage,
   TLS, `TRUST_PROXY` behind a proxy, secrets (`APP_ENCRYPTION_KEY` generated once and stored safely —
   it cannot be rotated yet, KI-024).
2. Run migrations, then `node dist/cli.js encrypt-supplier-ids` (OPERATIONS §1 step 7).
3. Keep the CI workflow green on GitHub. It has run there: run 46 on `0945b60` passed both jobs
   (lint, typecheck, unit and API integration tests, build, and the browser E2E suite).
4. Run a load test against staging (k6 or similar) at the pilot's expected volume; size the database
   and the PDF renderer from it (KI-023).
5. Do a first restore drill on the real environment (`scripts/restore-drill.sh`) and schedule it.
6. Have counsel review the privacy notice, retention defaults and the erasure procedure (D-053,
   OPERATIONS §9), and the commercial (non-certified) invoice wording for each market.
7. Decide e-invoicing scope per market before onboarding KSA/UAE/Egypt companies that need it.
8. Configure each pilot company: branches, roles, FX reference rates, tax settings, document
   legal names; train staff with the Arabic user guide (`docs/user-guide/`).

## 6. Business decisions still to confirm

The defaults marked **[PO-CONFIRM]** in `docs/DECISIONS.md` (for example revenue recognition on
delivery, B-001) were chosen conservatively and should be confirmed with the first customers.
