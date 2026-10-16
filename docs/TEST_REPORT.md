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
