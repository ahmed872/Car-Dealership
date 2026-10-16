# Execution Status

**Current phase:** Phase 2 — Vehicles & Inventory (in progress)
**Last completed task:** Phase 1 — Foundation (verified: build, typecheck, lint, 37 unit + 29 integration tests)
**Exact next task:** Phase 2 schema (vehicles, makes/models, features, files, media, documents, inspections, status history, transfers, stock counts) + migration

| Phase | Status |
|---|---|
| 0 Discovery & Architecture | Complete |
| 1 Foundation | Complete |
| 2 Vehicles & Inventory | In progress |
| 3 Acquisitions & Cost Engine | Not started |
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

## Local environment notes (for resumption)
- PostgreSQL 16 local cluster: `service postgresql start`.
- Roles/DBs bootstrapped with `infra/db/bootstrap-roles.sql` (dev passwords in `apps/api/.env`, not committed).
- Dev reset: `cd apps/api && set -a && . ./.env && set +a && node -r @swc-node/register src/db/reset.ts`.
- Platform admin (dev DB): admin@autohub.local / see session notes; tenant `elite-motors` owner owner@elite.test.

## External credentials required
See docs/KNOWN_ISSUES.md (EXT-01 … EXT-08).
