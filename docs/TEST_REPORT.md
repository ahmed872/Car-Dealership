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

### Phase 3: review fixes (2026-10-16)
| Command | Result |
|---|---|
| `pnpm --filter @autohub/shared test` | 2 files, **37 passed** |
| `cd apps/api && npx tsc --noEmit -p tsconfig.json` | clean |
| `npx eslint apps/api/src apps/api/test packages/shared/src` | clean |
| `cd apps/api && npx vitest run` (fresh `autohub_test`, migrations 0000–0006) | **16 files, 174 passed** |

New specs:
- `vehicle-costs` (22 tests), `supplier-payments` (16), `cash-accounts` (10): core coverage.
- `review-ledger` (19): the adversarial ledger review.

Each of the 13 defects the reviewers found was first reproduced by a failing test, then fixed:
- 10 from R1;
- 3 from T, one of which duplicated an R1 finding.

The four tests that encoded the old, defective semantics were updated to assert the corrected
behaviour:
- realized FX on carrying cost;
- the rounding lock;
- withdrawal of a pending purchase when it is edited;
- the date included in the details of an overdraft refusal.

Not yet done: the concurrency review (R2) and the authorization review (R3). Both stopped on a
usage limit and will be re-run.

### Phase 4 backend + Phase 3 review round 2 (2026-10-17)
| Command | Result |
|---|---|
| Phase 4 worktree: `npx vitest run` (apps/api, autohub_test_b) | 22 files, **211 passed** |
| main after merge + fixes: `npx vitest run` (apps/api, autohub_test_a) | 24 files: 263 passed, 1 failed. The failure was a test whose custom role relied on the old AP permission; after updating the role, that spec passes 16/16 → **264/264** |
| `review-concurrency.spec.ts` before fixes | 26 passed / 4 failed (3 deadlocks, 1 stale approval) |
| `review-concurrency.spec.ts` after fixes | **30/30** |
| `review-authz.spec.ts` before / after fixes | 14 passed, 9 failed / **23/23** |
| `packages/shared`: `npx vitest run` | **42 passed** (adds wish matcher tests) |
| `eslint src test`, `tsc --noEmit` (api, shared, web) | clean |

Not yet verified in a browser: the Phase 3 and Phase 4 web pages, which are not built yet.

### Phase 5 backend (2026-10-17)
| Command | Result |
|---|---|
| `npx vitest run test/sales.spec.ts` (apps/api, autohub_test_c), first run | 11 passed, 5 failed: 3 test-setup mistakes (audit table name, approvals response shape, missing Idempotency-Key on closings); 1 real defect (a settled plan reported its waived interest as outstanding); 1 policy conflict (revenue recognition cannot change once a company has transactions, so the test now uses a fresh company) |
| After fixes, plus `reopen` returning 200 and sale refunds carrying the sale dimension | **16/16** |
| Review of the void paths found that voiding a post-recognition payment after a cancel would re-open the receivable. Fixed (`credit_voided:<receipt>`) and covered by a new check; the fix went in before the check, so the check was never seen failing | **16/16** |
| Added the installment-sale return scenario | **17/17** |
| Full API suite, `npx vitest run` (apps/api, autohub_test_c) | 25 files, **281 passed** |
| `packages/shared`: `npx vitest run` | **46 passed** (adds early-settlement allocation tests) |
| `eslint src test` (api), `eslint src` (shared), `tsc --noEmit` (api, web) | clean |

PDF review: invoices and delivery notes rendered by the spec were opened and inspected as images.
- The first render was correct (Arabic RTL, amounts, VAT line, disclaimer). A second render came
  out blank apart from the company name: Chromium printed before the embedded fonts were
  decoded. The renderer now loads every font face and waits for the font set before printing.
  Three renders in a row were complete, and the spec now asserts that four embedded font
  subsets are present (the blank PDF had one).
- Fixed during review:
  - The title said "فاتورة ضريبية" (tax invoice), which over-claims for a non-certified document;
    it now says "فاتورة بيع" / "Sales invoice".
  - The payment method is translated.
  - The delivery note shows the odometer reading taken at handover.
- After these fixes: `sales.spec.ts` **17/17**.

### Phase 6 backend (2026-10-17)
| Command | Result |
|---|---|
| `npx vitest run test/reports.spec.ts` (apps/api, autohub_test_k), first run | 0 run: the shared sale fixture failed in setup because the installment sale was priced below the vehicle's floor, so it needed approval. The test data was fixed |
| Second run | **10/10** |
| Full API suite, `npx vitest run` (autohub_test_k) | 26 files, **291 passed** |
| `packages/shared`: `npx vitest run` | **46 passed** |
| `eslint src test` (api), `eslint src` (shared), `tsc --noEmit` | clean |

Export review: sales (AR and EN) and receivables (AR) PDFs were rendered and inspected.
- First render: the 19-column sales table ran off the page, the filter line was garbled in RTL,
  and amounts had no thousands separators.
- Fixed: smaller type for wide reports, localised filter labels with isolated LTR dates, grouped
  amounts, and a currency note.
- Re-rendered and inspected: complete and readable.
- The spec checks:
  - the CSV BOM, the Arabic header and formula neutralisation;
  - the XLSX right-to-left sheet and its totals;
  - that the PDF embeds its fonts;
  - that exports omit cost columns without `vehicles.view_cost`;
  - the audit rows.


### Phase 7 backend: showroom, integrations, insights (2026-10-17/18)
| Command | Result |
|---|---|
| `npx vitest run test/showroom.spec.ts` (apps/api, autohub_test_m), first run | DI error: `PublicShowroomService` needed `FilesService` (missing `VehiclesModule` import). Fixed |
| Second run | 7/9: system-created customers were assigned to the system user (`assignee_not_member`) and the rate limiter carried across tests. Fixed (customers created by the system start unassigned; the spec resets the per-client throttle) |
| Third run | **9/9** |
| Full API suite (autohub_test_m) | 27 files, **300 passed** |
| Adversarial security review (read-only agent) | 12 findings: 2 high (migrations re-granting revoked privileges; webhook SSRF through redirects, mapped IPv6 and DNS), 1 medium-high (network calls under the company write lock), 4 medium/low-medium, 4 low, 1 info. All addressed in code except a CAPTCHA (KI-018) and erasure of inquiry personal data (KI-021) |
| After the fixes: `test/outbound-http.spec.ts`, `test/db-privileges.spec.ts`, `test/showroom.spec.ts` | 3 + 2 + 13 passed (one first-run failure: `outboundPost` threw synchronously instead of rejecting; made async) |
| Full API suite after the fixes (autohub_test_m) | 29 files, **309 passed** |
| `packages/shared`: `npx vitest run` | **46 passed** |
| `eslint` (api src+test, shared src), `tsc --noEmit` (api) | clean |

What the new tests cover:
- Public showroom: only published, listable vehicles; no VIN, floor price, cost, stock number or
  internal ids in any public response; hidden prices; reserved/sold visibility; other companies'
  slugs; private and recategorised photos never served; QR codes; plan gating.
- Inquiries: customer and unassigned lead created; repeat attached (no new records); deactivated
  customer's number queued for triage with the same answer; daily cap; honeypot, consent, rate
  limit; acknowledgements only when enabled, delivered after commit, signed, failing gateway
  recorded, redirects not followed.
- Integrations: secrets encrypted and never returned or audited; VIN decoding success, invalid,
  disabled and timeout (503); AI suggestions from a local Claude stub (never the live API),
  template fallback on refusal, 500 and garbage, nothing saved until staff accept.
- SSRF guard in strict mode: address classes (including IPv4-mapped, NAT64, 6to4, Teredo), https,
  credentials, and the connect-time check refusing `localhost`.
- Database privileges of the application role after all migrations.
- Price guidance: thin data, sufficient data, branch-limited user sees no other-branch sales,
  individual sales hidden without `sales.read`; aging recommendations.
Not tested: the AI platform-key daily quota (needs a platform key in the test environment) and
any real third-party provider (none is called from tests).

### Phase 8 hardening, part 1 (2026-10-18)
| Command | Result |
|---|---|
| Migrations 0000–0014 on an empty database (autohub_test_r) | applied; 95 composite tenant keys and 11 catalog triggers created |
| `test/tenant-integrity.spec.ts` | **4/4**: through the owner role (which bypasses RLS) the database refuses moving a vehicle to another company's branch, a wish of company B pointing at company A's customer, a customer moved to another company's branch, and a vehicle using another company's private make; global and own catalog rows are accepted; every tenant FK has its guard; re-applying is a no-op |
| `test/work-orders.spec.ts` (with the new stale-approval case) | **9/9** |
| `test/route-policies.spec.ts`, first run | 2 failures: the expected public list was wrong (logout/csrf need a session; `POST /platform/signup` is public but refused unless `ALLOW_TENANT_SELF_SIGNUP`, covered in auth.spec). List corrected after checking the handler |
| Second run | **4/4**: every route has an access policy, every permission named exists, only 10 reviewed routes are public, platform routes are platform-admin only. `docs/PERMISSION_MATRIX.md` generated (267 routes) |
| Full API suite (autohub_test_r) | 31 files, **318 passed** |

Spot check of routes whose policy is `authenticated` (checks inside the service): payables
(supplier_payments.create or suppliers.read + payments.read), sale approve/reject (the sale's
approval permission), sale cancel (sales.cancel / sales.cancel_confirmed), commissions (own unless
commissions.read), employee profile (own unless users.read) — all enforce their rule.

### Phase 8 hardening, part 2: isolation sweep and performance smoke (2026-10-18)
| Command | Result |
|---|---|
| `test/isolation-sweep.spec.ts`, first run | failed only because `/cash/transfers/:transferId` was not mapped to a record (transfers live in the cash book, not a table); mapping added |
| Run with 8 record types unseeded (random ids) | passed, but coverage was too weak to keep: seeded refunds (via a cancelled reservation with a deposit), appointments, stock counts, expenses, supplier payments and a listing |
| Final run | **1/1**: 38 single-record GET routes; 35 called by company B with a real company-A id, every one refused (403/404); company A's owner reads all 35 (200). Installment plans and commissions use a random id here; their cross-company refusal is tested with real records in `sales.spec.ts` |
| `test/route-policies.spec.ts` after moving `listRoutes()` into fixtures | **4/4** |

Performance smoke (`PERF_SMOKE=1 npx vitest run test/perf-smoke.spec.ts`, opt-in, not part of CI):
one company seeded through the real API — 1,500 customers, 1,000 leads, 250 vehicles bought and
made available, 120 sold and delivered — in 136 s. Timed in-process (supertest, no network, local
PostgreSQL 16, 4 CPUs); 15 runs per list route, 10 for the dashboard, 5 per report, 3 for the export.

| Route | p50 ms | p95 ms |
|---|---|---|
| `GET /vehicles` (page 1) | 13 | 20 |
| `GET /vehicles?q=Camry&status=available` | 14 | 18 |
| `GET /customers` (page 1) | 16 | 22 |
| `GET /customers?q=…` | 16 | 20 |
| `GET /leads` (page 1) | 22 | 32 |
| `GET /sales` (page 1) | 16 | 21 |
| `GET /approvals` | 11 | 15 |
| `GET /notifications` | 10 | 14 |
| `GET /dashboard` | 19 | 28 |
| `GET /reports/inventory` | 15 | 21 |
| `GET /reports/sales` | 21 | 35 |
| `GET /reports/receivables` | 17 | 21 |
| `GET /reports/cash-flow` | 14 | 16 |
| `GET /ledger/trial-balance` | 16 | 17 |
| `GET /reports/sales/export?format=xlsx` | 51 | 111 |

These are smoke numbers for one busy showroom on one machine, not a load test: no concurrency,
no network, no browser rendering. Load testing at production volumes remains open (KI-023).

### Phase 8 part 3 — security fixes, FX band, error messages (2026-10-24)
| Command | Result |
|---|---|
| `security-review.spec.ts` against the code before the fixes (sources stashed) | 13 of 14 failed (the 14th guards new behaviour) — the spec reproduces F1–F5, F7–F11 |
| Full API suite, security fixes merged with the branch (DB r) | 33 files, **333 passed**, 2 skipped (perf smoke, opt-in) |
| Full API suite, security + F6 FX band (DB s) | 34 files, **345 passed**, 2 skipped |
| Same, after bounding percentages to 0–100 (e92cb7d) | 34 files, **345 passed**, 2 skipped |
| `pnpm --filter @autohub/shared test` | **49 passed** |
| `apps/web: vitest run src/i18n/` (every API error code has ar+en text) | **5 passed**; deleting two codes from en.ts made it fail naming both with file:line |
| `tsc --noEmit` api + web, eslint on changed files, `vite build` | clean |
| Chromium, company settings (sandbox from the fx-band worktree) | reference rates saved, reloaded and cleared (map replaced whole); tolerance 150 → 422 with the field marked; VAT 150% → 422 (was accepted before e92cb7d); AR/EN desktop and 390px without horizontal scroll |
| Chromium, appointments/reservations/receipts/refunds (agent sandbox h) | booking, test drive start/finish, reschedule/cancel/no-show, reservation with deposit, extend, cancel with refund preview, receipt split and void, refund request/approve/pay; both maker-checker refusals shown; no page or console errors besides the deliberate 4xx |

Failures found and fixed: 150% VAT accepted (no bound on jsonb settings); a partial settings PATCH
reset that section's other values; Arabic rate labels reordered by the bidi algorithm.

### Phase 8 part 4 — E2E suite, supplier ID encryption, PDF recovery (2026-10-24)
| Command | Result |
|---|---|
| `pnpm --filter @autohub/e2e test` (Playwright 1.56.1, Chromium, real API + production web build; projects ar-desktop, en-desktop, mobile-ar 390px; one worker) — agent runs | 45 passed ×4 (3.6–3.8 min), 0 flaky, 0 skipped |
| Same, independent orchestrator run on the E2E branch | **45 passed** (3.9 min) |
| Same, after merging task 18 and adding `company-switch.spec.ts` | **48 passed** (3.7 min) |
| `company-switch.spec.ts` with the SelectCompanyPage fix reverted | 3 failed (the app kept showing the previous company) — the spec guards the fix |
| Sign-out spec with the auth.tsx fix reverted (agent) | failed: stayed on `/app` after signing out |
| `supplier-sensitive.spec.ts` / `pdf-renderer.spec.ts` | 9 / 5 passed; 2 PDF tests fail on the previous renderer, the reveal test fails without the permission check |
| `db-reset-guard.spec.ts` | 4 passed |
| Full API suite, merged head (DB o) | 37 files, **363 passed**, 2 skipped (perf smoke, opt-in) |
| `tsc --noEmit` api, web, e2e; web vitest (5) | clean / passed |
| `cli.js encrypt-supplier-ids` by hand (DB r) | 1st run encrypted the legacy rows and cleared plaintext; 2nd run changed nothing |

E2E coverage: sign-in/out (AR/EN), lockout without revealing the account, deep-link return,
language/direction switch and no horizontal scroll at 390px on 8 pages, maker-checker acquisition
approval, cash transfer and reversal, cash sale to delivery, the full vehicle journey (purchase →
cost → listing → reservation deposit → installment sale → collection) with GL 1100/1300/2100 checks
in the database, dashboard/report figures and a real xlsx export, menu and route denials for a
sales rep and a cash-only role, cross-company 404s, and company invitation + switching. Not yet
covered in the browser: wishes, employees/commission policies, refunds, appointment workflows.
The CI `e2e` job is defined in `.github/workflows/ci.yml` but has not yet been observed running on
GitHub.

### Phase 8 part 5 — web integration pass (2026-10-24)
| Command | Result |
|---|---|
| New/extended specs: `members` 5, `leads` + `sales` 25, `showroom` 15, `reservations` + `sales` 25, `route-policies` 4 (agent) | all passed |
| Full API suite, integration pass merged with the branch head (DB n) | 38 files, **372 passed**, 2 skipped (perf smoke, opt-in) |
| `pnpm --filter @autohub/e2e test`, same head | **48 passed** (3.7 min) |
| `tsc --noEmit` api/web/e2e, web vitest, `vite build`, permission matrix regenerated (unchanged after merge) | clean / 5 passed / built / consistent |
| Chromium (agent sandbox j, a "Team lead" role without users.read) | pickers list the right staff per branch and permission; sale approvals decided from the inbox; QR download `listing-STK-…-qr.png`; WhatsApp text in the viewer's language; receipts/refunds search; FX rate prefilled (3.75) with the band; AR/EN and 390px without page overflow, no console errors |
