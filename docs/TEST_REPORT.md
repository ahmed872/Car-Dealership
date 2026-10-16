# Test Report

All entries record commands that were actually executed in this environment, with their real
results. Nothing here is projected.

## Environment
- Node 22.22.0, pnpm 10.28.0, PostgreSQL 16.15 (local), Chromium 141 (Playwright 1.56.1)

## Runs
(Appended per phase.)

### Phase 1 — Foundation (2026-10-16)
| Command | Result |
|---|---|
| `pnpm --filter @autohub/shared test` | 2 files, **37 passed** |
| `pnpm --filter @autohub/api test` (real PostgreSQL 16, fresh schema via migrations) | 3 files, **29 passed** |
| `pnpm lint` | clean |
| `pnpm typecheck` | clean (shared, api, web) |
| `pnpm build` | shared, api (tsc + migrations copy), web (vite) all succeed |
| `node dist/db/migrate.js && node dist/main.js` | compiled API migrates and serves `/health/ready` |
| Manual psql as `autohub_app` | cross-tenant read → 0 rows; insert without context → RLS violation; unbalanced journal → rejected at COMMIT; UPDATE audit_logs → permission denied |
| Playwright screenshots (Chromium 141) | login AR/mobile, dashboard AR, settings AR, roles AR, users EN, audit EN rendered correctly |

Failures found and fixed during Phase 1:
- `/auth/me` returned 500: nested transaction with a different tenant context → membership listing now reuses the request transaction.
- Audit `requestId` was empty: request id now assigned in our own middleware before pino-http.
- Login rate limit hit by tests → limits configurable (`RATE_LIMIT_PER_MIN`, `AUTH_RATE_LIMIT_PER_MIN`).
- Reducing-balance expected interest in a unit test was a hand estimate (6618.55); independent Python Decimal check gave 6618.53 → test corrected (code was right).
- Generated migration created an FK before its unique key → switched to a table-level UNIQUE constraint.
- Language toggle had an aria-label hiding its visible text (WCAG label-in-name) → replaced with `title`.
- Root `pnpm build` filter matched nothing → fixed to `pnpm -r run build`.

### Phase 2 — Vehicles & Inventory (2026-10-16)
| Command | Result |
|---|---|
| `pnpm --filter @autohub/api test` | 5 files, **44 passed** (adds vehicles.spec: 12 integration tests; sniff.spec: 3 unit tests) |
| `pnpm --filter @autohub/shared test` | **37 passed** |
| `pnpm lint`, `pnpm typecheck`, `vite build` | clean |
| Playwright screenshots | vehicle grid/table (AR), Vehicle 360, photo upload via UI, inspection with SVG diagram, form, mobile list — no console errors |

Covered behaviours: VIN rules (US check digit enforced, GCC warning, non-standard chassis), duplicate VIN in stock (409),
system-only states rejected for manual changes, listing requires price + completed inspection, inspection required items,
API + DB-level immutability of completed inspections, pricing permissions and history, rep field-level visibility,
optimistic locking, MIME sniffing (415 on fake JPEG), sensitive document number/file hidden (403 download),
cross-tenant file 404, transfer in-transit blocking and destination-branch receipt, branch-scoped visibility,
stock count scan/submit/reconcile with write-off permission, search by VIN fragment / Arabic model name / feature / fuel / year.

Fixed during Phase 2: test fixtures (XMP segment length; expected transition reason for `incoming → reserved`);
money strings in Arabic now use Unicode isolates instead of forced LTR (verified by measuring glyph positions).

### Phase 3: backend integration (2026-10-16)
Commands were run in this environment on the integrated tree, against a fresh test database
migrated through 0005.

| Command | Result |
|---|---|
| `pnpm --filter @autohub/shared run build` | success |
| `cd apps/api && npx tsc --noEmit -p tsconfig.json` | clean |
| `npx eslint apps/api/src apps/api/test packages/shared/src` | clean |
| `cd apps/api && npx vitest run` | **12 files, 107 passed** |

New specs:
- `purchasing-core`
- `acquisitions`
- `suppliers-payables`
- `expenses`
- `work-orders`
- `accounting`
- `maker-checker`

Every money spec checks books integrity with `assertLedgerIntegrity`: trial balance; cash book vs
GL 1100 per account; AP sub-ledger vs GL 2000 per supplier; inventory vs GL 1300 per vehicle.
Earlier, the parallel builders ran their specs on isolated databases (`autohub_test_a`…`e`). Their
results were then re-verified together on `autohub_test`.
