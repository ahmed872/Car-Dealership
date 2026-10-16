# Execution Status

**Current phase:** Phase 3 — Acquisitions & Cost Engine (in progress)
**Last completed task:** Phase 2 — Vehicles & Inventory (API + web; 37 unit + 44 API tests green)
**Exact next task:** Phase 3 schema: suppliers, acquisitions, cost categories, vehicle costs, work orders, supplier payments, cash accounts/transactions (needed for payments), approval requests

| Phase | Status |
|---|---|
| 0 Discovery & Architecture | Complete |
| 1 Foundation | Complete |
| 2 Vehicles & Inventory | Complete |
| 3 Acquisitions & Cost Engine | In progress |
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

## Local environment notes (for resumption)
- PostgreSQL 16 local cluster: `service postgresql start`.
- Roles/DBs bootstrapped with `infra/db/bootstrap-roles.sql` (dev passwords in `apps/api/.env`, not committed).
- Dev reset: `cd apps/api && set -a && . ./.env && set +a && node -r @swc-node/register src/db/reset.ts`.
- Platform admin (dev DB): admin@autohub.local / see session notes; tenant `elite-motors` owner owner@elite.test.

## External credentials required
See docs/KNOWN_ISSUES.md (EXT-01 … EXT-08).
