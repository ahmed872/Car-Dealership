# AutoHub Pro — Operations runbooks

Status: Phase 8, written 2026-10-18. Covers the single-host Compose deployment in
`docs/DEPLOYMENT.md`. Commands marked **(verified)** were run in the development environment as
written (see the drill log at the end). Everything else is a procedure that has not been exercised yet.

Contents: 1 Deploy / upgrade · 2 Rollback · 3 Backups · 4 Restore · 5 Restore drills · 6 Key and secret
rotation · 7 Incidents · 8 Monitoring · 9 Data-protection requests · 10 Restore drill log

Conventions: run commands from the deployment directory (where `docker-compose.yml` and `.env` live).
`DC` means `docker compose`.

---

## 1. Deploy / upgrade (migrate first, then roll the API)

Migrations are applied by the one-shot `migrate` service (`node dist/db/migrate.js`, owner role).
The API never migrates itself.

1. **Back up first** (§3) and check that the script printed `OK …` and exited 0.
2. Build or pull the new images and pin them by immutable tag in `.env`:
   `AUTOHUB_API_IMAGE=…:<git-sha>` and `AUTOHUB_WEB_IMAGE=…:<git-sha>`. Then run `DC pull` (or `DC build`).
3. Apply migrations while the old API keeps serving:
   `DC run --rm migrate` → prints `Migrations applied`, exit code 0. Stop if it fails: the old version
   is still running and nothing else has changed. Fix the cause before continuing.
4. Roll the API: `DC up -d --no-deps api`, then wait for `DC ps api` to show `(healthy)`. With one API
   container there is a gap of a few seconds; nginx answers 502 meanwhile (observed). nginx resolves
   the API name at request time, so it does not need a restart (verified).
5. Roll the web: `DC up -d --no-deps web`.
6. Check: `curl -fsS https://<host>/api/v1/health/ready`, sign in, open a sale, generate one PDF, and
   on the audit page (Settings → Audit) press verify (`POST /api/v1/audit-logs/verify` → `"ok":true`).
7. **Release data steps** (only the releases listed here). Run them after step 4, so that anything the
   previous release wrote during the rollout is included. They use the API image and its environment
   (app role, `APP_ENCRYPTION_KEY`), are idempotent, and print what they did; keep the output.
   * **Migration `0018_supplier_national_id_security` (D-047)** — encrypt the supplier national IDs
     that older releases stored in plain text:
     `DC run --rm --no-deps api node dist/cli.js encrypt-supplier-ids`
     → one line per company that had values, then
     `Supplier national IDs: <n> companies checked; encrypted <a>, encrypted as typed (not a recognisable ID) <b>, plain text removed only <c>`,
     exit code 0. A second run prints zeros. Options: `--tenant <company uuid>` (one company) and
     `--batch-size <1–10000>` (rows per batch, default 500); each company is one transaction under its
     own RLS context, and one `supplier.national_ids_encrypted` audit entry records the counts. Until
     it has run, old IDs are still shown masked and can be revealed, but the duplicate check does not
     find them. Do not skip it: the next release drops `suppliers.national_id` (KI-030). Backups taken
     before it ran still contain the plain-text IDs (§3).

Plain `DC up -d` does the same in dependency order (postgres → migrate → api → web). Because the old
API is still running while migrations apply, **every migration must be backward compatible with the
previous release** (expand, deploy, then contract in a later release). A migration that drops or
renames something the running version uses causes errors during the rollout window.

## 2. Rollback

* **Application rollback** (no schema change involved, or the schema change is additive): put the
  previous image tags back in `.env` and run `DC up -d --no-deps api web`. Safe only if the old code
  works on the current schema.
* **Migrations are forward-only.** Drizzle keeps applied migrations in `drizzle.__drizzle_migrations`
  and has no down migrations. There is no "migrate down". Never edit or delete an applied migration
  file. A wrong migration is fixed with a new, forward migration.
* **If a migration damaged data**, the only way back is a restore of the pre-upgrade backup (§4) into
  a new database, then switching to it. Everything written after that backup is lost, unless it is
  re-entered. Get a business decision before you do this, and keep the damaged database for analysis.

## 3. Backups

### What must be backed up

| Item | How | Notes |
|---|---|---|
| PostgreSQL database | `scripts/backup.sh` (pg_dump custom format) | Includes the ledger, audit chain, sessions and migration history. |
| File storage | `local` driver: the `storage` volume (tar); `s3`: bucket versioning or replication | **Not in the database dump.** Take it at the same time as the database dump. |
| `APP_ENCRYPTION_KEY` | secrets manager, **separate from the dumps** | Without it, encrypted national IDs and company integration secrets cannot be read (§6). |
| `.env` / compose files | secrets manager / configuration repo | Role passwords, origins, image tags. |

### `scripts/backup.sh` (verified)

`pg_dump -Fc` of one database as the **owner role**. The script refuses the app role: RLS hides every
row from it. It exports a snapshot and runs pg_dump on it. From the same snapshot it writes a
fingerprint: exact row counts of all tables, per-company ledger totals and trial-balance hash, audit
chain heads, and the result of `audit_verify_chain()` for every company. So a backup also checks the
ledger balance and the audit chain at backup time, and warns if either is broken. It then reads the
whole archive back (`pg_restore -f /dev/null`), writes `<db>_<UTC>.dump`, `.dump.sha256`,
`.fingerprint` and `.manifest` (mode 0600), and applies retention (`BACKUP_RETENTION_DAYS`) only
after a successful backup. Exit code 0 means everything succeeded. The last line of output is the dump path.

In the Compose deployment, PostgreSQL is not published, so run the script in a one-off container on
the internal network. This exact form was verified:

```bash
set -a; . ./.env; set +a
docker compose run --rm --no-deps \
  -v "$PWD/scripts:/scripts:ro" -v /srv/autohub-backups:/backups \
  -e PGHOST=postgres -e PGUSER=autohub_owner -e PGPASSWORD="$AUTOHUB_OWNER_DB_PASSWORD" \
  -e PGDATABASE="${AUTOHUB_DB_NAME:-autohub}" -e BACKUP_DIR=/backups -e BACKUP_RETENTION_DAYS=14 \
  --entrypoint /scripts/backup.sh postgres
```

(It uses the postgres image, which has the matching `pg_dump`. `docker compose run` also mounts the
`pgdata` volume into the one-off container; the script never touches it.)

File storage, at the same time (verified with a test file):

```bash
docker run --rm --network none -v autohub_storage:/data:ro -v /srv/autohub-backups:/out \
  postgres:16.15-bookworm sh -c 'tar -C /data -czf /out/storage_$(date -u +%Y%m%dT%H%M%SZ).tgz .'
```

### Schedule, retention, off-site, encryption (policy — decide with the business and counsel)

* **Schedule:** nightly (for example 02:15 local time via cron or a systemd timer that calls the
  command above), plus before every upgrade (§1). Alert when the job exits non-zero or prints a
  `WARNING` about ledger or audit chain.
* **RPO:** nightly logical dumps lose up to about 24 hours of data. For a smaller RPO, add continuous
  WAL archiving / point-in-time recovery (pgBackRest, WAL-G, or a managed PostgreSQL with PITR). That
  is **not set up or tested**.
* **Retention (suggestion):** 14 days locally (`BACKUP_RETENTION_DAYS=14`); off-site 35 daily and 12
  monthly copies. Retention also limits how long personal data survives an erasure request (§9), so
  put the chosen periods in the privacy notice.
* **Off-site:** copy the `.dump`, `.sha256`, `.fingerprint`, `.manifest` and the storage tar to
  another provider or region with write-once / object-lock if available. Run `sha256sum -c` after the copy.
* **Encryption at rest:** dumps contain personal data **in clear**: customer names, phones and
  e-mails; supplier names and contact details. Customer and supplier national IDs and integration
  secrets are encrypted inside the dump with `APP_ENCRYPTION_KEY` (supplier IDs since D-047, once
  `encrypt-supplier-ids` has run, §1; dumps taken before that hold them in plain text in
  `suppliers.national_id`). Encrypt dumps before they leave the
  host, for example `age -r <recipient> -o x.dump.age x.dump` (an example: no encryption tool was
  exercised here). Keep the decryption key and `APP_ENCRYPTION_KEY` apart from the backups.

## 4. Restore

`scripts/restore.sh` restores **only into a new, empty database** (it refuses a non-empty one) as the
owner role, then proves the result. It checks the `.sha256` first (a corrupted dump is refused) and
restores in one transaction (`--no-owner`; privileges are kept). It then re-applies
`app_apply_privileges()` and `app_apply_tenant_fks()` (both idempotent) and reports if either
changed anything, and runs `ANALYZE`. Finally it checks: app role not superuser/BYPASSRLS and owning
nothing; RLS and a policy on every tenant table; ledger and audit append-only for the app role;
immutability/balance/chain triggers present; every company's ledger balanced; every company's audit
chain verifying. If the backup's `.fingerprint` file is present, the target must match it exactly.
Exit code 0 only if everything passed.

Procedure (Compose; steps 1–2 verified, steps 3–6 not yet exercised):

1. Create the empty target as the superuser, with the same bootstrap as a fresh install. Existing
   roles are left unchanged:
   ```bash
   DC exec -T postgres psql -U postgres -v owner_password="$AUTOHUB_OWNER_DB_PASSWORD" \
     -v app_password="$AUTOHUB_APP_DB_PASSWORD" -v db_name=autohub_restore_20261018 -f /autohub/bootstrap-roles.sql
   ```
2. Restore and verify. It must end with `RESTORE OK`:
   ```bash
   docker compose run --rm --no-deps -v "$PWD/scripts:/scripts:ro" -v /srv/autohub-backups:/backups:ro \
     -e PGHOST=postgres -e PGUSER=autohub_owner -e PGPASSWORD="$AUTOHUB_OWNER_DB_PASSWORD" \
     --entrypoint /scripts/restore.sh postgres /backups/<file>.dump autohub_restore_20261018
   ```
   For a large dump, `--jobs N` restores in parallel. That is not atomic: on failure, drop and recreate
   the target.
3. Switch the application: `DC stop api web`. Then as the superuser:
   `ALTER DATABASE autohub RENAME TO autohub_before_restore; ALTER DATABASE autohub_restore_20261018 RENAME TO autohub;`
   Then `DC up -d` (migrate applies any migrations newer than the dump; the API starts).
   Alternatively set `AUTOHUB_DB_NAME` in `.env` and run `DC up -d`.
4. Restore the file storage from the same point in time (untar into the `storage` volume, owner uid 1000).
5. Use the **same `APP_ENCRYPTION_KEY`** as when the data was written.
6. Check `/api/v1/health/ready`, sign in, verify the audit chain, and compare the totals the business
   knows (cash balances, open sales). Restored sessions are still valid. After a security incident,
   force everyone to sign in again: `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;`
   as the owner (not exercised).

Roles live in the cluster, not in the dump: a new cluster needs `infra/db/bootstrap-roles.sql`
before the restore. Restore as the role named `autohub_owner`, because the dump's default privileges
reference it. pg_restore loads data as the table owner, which RLS does not filter, because RLS is
enabled but not *forced* (see the note in §10). If FORCE ROW LEVEL SECURITY is ever turned on, both
backup and restore must run as a superuser or a BYPASSRLS role.

## 5. Restore drills

`scripts/restore-drill.sh [--reset-target] <source-db> <target-db>` takes a fresh backup of the source
(full fingerprint, including a content hash of every table), restores it into the target with
`restore.sh`, and then compares the two. Checks: schema and security metadata identical (RLS flags,
92 policies, app-role privileges on every table/sequence/function, triggers, indexes, constraints,
extensions, default ACLs). Then, connected **as the app role**, it checks that RLS is active for that
role on every RLS table, that it sees 0 rows without company context, and exactly its own company's
rows with it. Further checks as the app role: no rows of other companies, the audit chain verifies,
UPDATE/DELETE on ledger/audit and reads of `audit_chain_heads` are refused, and inserts without
context or for another company are rejected by RLS. `--reset-target` empties the target first, and
is allowed only for names ending in `restore_drill` / `_drill`. The source is only read.

Cadence: monthly on the latest production backup, restored on a separate host or cluster (never next
to production data). Also after every release with a migration, and after any change to the backup
scripts. Record each run in §10 and keep `drill-report.txt`.

## 6. Key and secret rotation

### `APP_ENCRYPTION_KEY` — there is NO rotation tool

What it protects (`apps/api/src/common/crypto.ts`):

* AES-256-GCM ciphertexts (`v1.<iv>.<tag>.<ct>`): `customers.national_id_enc` and
  `suppliers.national_id_enc` (national ID / passport) and `integration_settings.secret_encrypted`
  (each company's integration secrets, such as its AI key and webhook signing secret).
* An HMAC key **derived from it** (`hmacHex`): `customers.national_id_hash` (exact search and the
  unique "same national ID" check per company), `suppliers.national_id_hash` (supplier duplicate
  check) and `showroom_inquiries.client_hash`.

The ciphertext format has no key id, and the app reads exactly one key. Changing the key therefore
makes every stored national ID unreadable (decryption fails), makes company integrations fail until
their secrets are re-entered, and silently breaks national-ID search and duplicate detection, because
new hashes no longer match the stored ones. **Do not change the key on a live system.**
A safe rotation needs an application change (recommended): a key id in the ciphertext prefix, a
`APP_ENCRYPTION_KEY_PREVIOUS` used only for decryption, and a CLI command that re-encrypts
the `national_id_enc` columns and `secret_encrypted` and recomputes the HMAC columns in batches. Until that
exists, if the key is suspected compromised:

1. Treat it as a breach of the encrypted fields only if the database (or a backup) was also exposed,
   and assess with counsel.
2. Ask companies to rotate the third-party secrets they stored (AI keys, webhook secrets) at the
   provider. That makes the old encrypted copies worthless.
3. Plan the re-encryption with engineering. Do not improvise SQL on production.

Losing the key is equally serious: back it up in a secrets manager, separately from the dumps.

### Other secrets

* **Database role passwords:** `ALTER ROLE autohub_app PASSWORD '…'` (or `autohub_owner`) as the
  superuser, update `.env`, then `DC up -d` (recreates migrate/api with the new URL). During the
  window, the API's new connections fail until it restarts.
* **Session cookies** use random tokens stored as SHA-256 hashes. No server key is involved; revoking
  sessions is `UPDATE sessions SET revoked_at = now()`.
* **`AUTOHUB_ADMIN_PASSWORD`** is read only by the CLI. Do not keep it in `.env`.

## 7. Incidents

| Symptom | Likely cause | Check / act |
|---|---|---|
| `/api/v1/health/ready` → 503 `not_ready`; api container unhealthy | PostgreSQL down or unreachable, or schema not migrated | `DC ps`, `DC logs --tail=100 postgres`, disk space (`df -h`, volume `pgdata`). After a PostgreSQL restart the API recovered by itself (`/ready` 503, then 200 about 2 s later, observed). If `migrate` failed, the API never starts: `DC logs migrate`. |
| nginx 502 on `/api/` | API container down or restarting | `DC ps api`, `DC logs --tail=200 api`. Start-up aborts on invalid configuration ("Invalid environment configuration: …") or an unsafe DB role ("DATABASE_URL role is unsafe…"). |
| PDFs fail with 503 `pdf_unavailable` | Chromium missing or unable to start (`CHROMIUM_PATH` unset, image built with `CHROMIUM=none`, missing libraries, memory) | API log line `chromium launch failed: …` (observed with a `CHROMIUM=none` image: "PDF rendering is not configured (CHROMIUM_PATH)"). Everything else keeps working. |
| A PDF fails with 503 `pdf_unavailable` after working before, then works again | Chromium crashed or was killed (for example for memory). The API drops the dead browser and starts a new one on the next render (D-045); no restart is needed (verified in `test/pdf-renderer.spec.ts` by killing it) | API log lines `chromium disconnected; the next render starts a new browser`, `chromium was gone (…); relaunching` or `chromium exited during a render`. If they repeat, check memory (`docker stats`, kernel OOM messages) and `PDF_MAX_CONCURRENT`. |
| Uploads fail | `local`: volume full or not writable; `s3`: credentials, bucket or endpoint | API logs; `docker system df -v`; nginx answers 413 above `AUTOHUB_MAX_BODY_SIZE`. |
| Many 429 responses | Rate limits per client address; behind an unconfigured proxy all users share one address | Set `AUTOHUB_REAL_IP_FROM` (DEPLOYMENT §6); check `remote_addr` in the web logs. |
| Writes of one company slow or timing out while others are fine | The per-company write lock (D-025, KI-006) is held by a long transaction | Query in §8. The pool's `statement_timeout` is 30 s. |
| Audit chain verify `ok: false` | Tampering by someone with database owner or superuser rights, or a faulty manual intervention | **Security incident.** Do not modify rows. Preserve the database and logs. Compare with the `audit_head` / `audit_verify` lines in the `.fingerprint` files of earlier backups to bound the time window. |
| Ledger unbalanced in a backup fingerprint | Should be impossible (deferred balance trigger) | Treat as an incident; do not post corrections before engineering has analysed it. |

## 8. Monitoring

* **Health:** `GET /api/v1/health/live` (process up) and `GET /api/v1/health/ready` (database up and
  migrated) on the API, and `GET /healthz` on nginx (no API dependency). All three are used by the
  container health checks. Monitor `/api/v1/health/ready` from outside, through the TLS proxy.
* **Logs:** API = pino JSON (`reqId`, method, URL, status, latency; secrets and national IDs
  redacted). nginx = JSON with `request_id`, `remote_addr`, `status`, `duration_s`, `upstream_s`. The
  same id is sent to the API as `X-Request-Id`, appears in the API log and in audit-log metadata,
  which links an audit entry back to the HTTP request. Docker rotates container logs (20 MB × 5).
  Ship them elsewhere for longer retention.
* **Alert on:** `/ready` failing; 5xx rate; `pdf_unavailable` occurrences; bursts of 401/403/429 on
  `/api/v1/auth/login`; the backup job exiting non-zero or printing `WARNING`; disk usage of `pgdata`,
  `storage` and the backup directory; PostgreSQL connections near `max_connections`
  (`DATABASE_POOL_MAX` × API processes plus maintenance).
* **Integrity, daily, read-only:** `scripts/backup.sh fingerprint` (run as the owner, like the backup)
  prints `audit_verify … ok=t|f` and `ledger … balanced=t|f` for every company. Alert on any `ok=f`
  or `balanced=f`.
* **Per-company write lock (KI-006, D-025):** every write transaction of a company first takes
  `pg_advisory_xact_lock(7001, hashtext(tenant_id))`, so writes of one company are serialised. To see
  who holds and who waits (verified to show a holder and a waiter):
  ```sql
  SELECT a.pid, a.datname, l.granted, now() - a.xact_start AS in_transaction_for, a.wait_event_type, a.wait_event, left(a.query, 80)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' AND l.classid = 7001 AND l.objsubid = 2
  ORDER BY l.granted DESC, a.xact_start;
  ```
  Waiters that persist, or holders older than a few seconds, point to a slow write request. GET
  requests (lists, reports, exports, PDF downloads) never take this lock (`common/interceptors.ts`),
  so look at the holder's POST/PUT/PATCH flow in the API log (same time, same company). Track the
  waiter count as a metric.
* **Rate limits** are per API process and per client address (KI-019); behind a proxy,
  `AUTOHUB_REAL_IP_FROM` must be right, or every user shares one budget.

## 9. Data-protection requests (KSA PDPL, UAE PDPL, Egypt Law 151/2020)

There is **no erasure or retention tooling yet** — see `docs/KNOWN_ISSUES.md` **KI-021**.
`showroom_inquiries`, `message_log` and `audit_logs` are append-only: the app role cannot update or
delete them, and triggers block even the owner. Customers, sales and other business documents cannot
be deleted by the app role either; they are cancelled or voided. The audit log redacts national IDs,
but it keeps names and changed values. Therefore:

* Log every request (who, what, date, deadline) outside the application.
* Access/export requests: there is no per-person export. Use the record screens and the report
  exports (`GET /api/v1/reports/:key/export`) and assemble the answer by hand.
* Erasure/correction: corrections go through the normal edit screens. Erasure of append-only data
  needs the SECURITY DEFINER redaction function planned in KI-021, reviewed with counsel. **Do not
  disable triggers or edit rows by hand as superuser**: it breaks the audit hash chain (detected by
  the verifier) and the ledger guarantees.
* Backups keep the data until they expire under the retention policy (§3). Say so in the privacy notice.

---

## 10. Restore drill log

### 2026-10-18 — first drill (development environment)

**Environment:** local PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), pg_dump 16.15. Source
`autohub_test_q`, target `autohub_restore_drill` (empty, owner `autohub_owner`), owner role
`autohub_owner`, app role `autohub_app`. Schema: 15 migrations (`0000_foundation` … `0014_work_order_version`).

**Source data:** the API integration suite run against the source at 11:39 UTC:
`TEST_DATABASE_URL=…/autohub_test_q TEST_DATABASE_MIGRATION_URL=…/autohub_test_q npx vitest run
test/sales.spec.ts test/reports.spec.ts test/purchasing-core.spec.ts` → "Test Files 3 passed (3),
Tests 28 passed (28)". The suite resets the schema, migrates and leaves its data: 6 companies, 76
tables, 3,799 rows. Non-empty tables (row counts from the backup fingerprint):
drizzle.__drizzle_migrations 15, acquisitions 23, approval_requests 26, audit_chain_heads 6,
audit_logs 548, branches 7, cash_accounts 6, cash_day_closings 2, cash_transactions 40,
commission_policies 1, commissions 1, cost_categories 25, customers 22, employee_profiles 1,
features 53, idempotency_keys 125, inspection_items 1254, inspection_panels 286,
inspection_templates 1, installment_allocations 13, installment_plans 4, installments 37,
journal_entries 122, journal_lines 270, lead_stage_history 2, leads 1, ledger_accounts 114,
membership_branches 1, memberships 23, notifications 1, number_sequences 31, odometer_readings 47,
pipeline_stages 8, receipt_allocations 26, receipts 26, refunds 1, reservations 1, roles 52,
sale_documents 30, sales 20, sessions 29, subscription_plans 3, supplier_payment_allocations 2,
supplier_payments 2, suppliers 4, tenant_subscriptions 6, tenants 6, trade_ins 1, users 30,
vehicle_costs 26, vehicle_inspections 22, vehicle_makes 39, vehicle_models 164,
vehicle_price_history 44, vehicle_status_history 125, vehicles 24.
Empty in the source (restored as empty tables only, so their data path was **not** exercised):
appointments, attachments, customer_interactions, customer_wishes, expenses, files, inspection_media,
integration_settings, message_log, showroom_inquiries, stock_count_lines, stock_counts,
vehicle_documents, vehicle_feature_links, vehicle_listings, vehicle_media, vehicle_transfers,
wish_matches, work_order_items, work_orders.

**Command:**

```bash
PGHOST=localhost PGPORT=5432 PGUSER=autohub_owner PGPASSWORD=… APP_PGPASSWORD=… DRILL_DIR=<dir> \
  scripts/restore-drill.sh --reset-target autohub_test_q autohub_restore_drill      # exit code 0
```

**Output** (`drill-report.txt`, verbatim, final run at 11:49 UTC with the final script versions):

```text
══ AutoHub Pro restore drill — 2026-10-18T11:49:34Z
   source=autohub_test_q target=autohub_restore_drill host=localhost:5432 owner_role=autohub_owner app_role=autohub_app
   server 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), dir=/tmp/claude-0/-home-user-Car-Dealership/6fa1c7d4-a94b-5e23-92fd-607c59fed322/scratchpad/drill/final
── resetting target autohub_restore_drill (drop schemas public, drizzle)
── 1/4 source metadata
   955 metadata lines (77 relations, 92 policies, 29 functions, 41 triggers)
── 2/4 backup of autohub_test_q
[backup 11:49:35] database=autohub_test_q role=autohub_owner snapshot=0000000F-0000006A-1
[backup 11:49:35] fingerprint (full)…
[backup 11:49:35] pg_dump → autohub_test_q_20261018T114935Z.dump
[backup 11:49:36] OK autohub_test_q_20261018T114935Z.dump (696215 bytes, sha256 05262dfa39894f20…)
   created_at_utc=2026-10-18T11:49:36Z
   database=autohub_test_q
   host=localhost:5432
   role=autohub_owner
   server_version=16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
   pg_dump_version=pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
   snapshot=0000000F-0000006A-1
   format=custom
   size_bytes=696215
   sha256=05262dfa39894f20b51e7c41e785116b7ce5838e61bac11d63646b9a66a144f9
   fingerprint=full
   migrations_applied=15
   tenants=6
── 3/4 restore into autohub_restore_drill (scripts/restore.sh — includes (a) counts+content, (b) ledger, (c) audit vs the backup snapshot)
[restore 11:49:36] checksum OK
[restore 11:49:36] target=autohub_restore_drill role=autohub_owner app_role=autohub_app jobs=1
[restore 11:49:38] pg_restore finished in 2s
── restore checks: autohub_restore_drill (autohub_test_q_20261018T114935Z.dump)
PASS  privileges intact (app_apply_privileges no-op) yes
PASS  tenant reference guards intact (no-op)         95 composite FKs, 11 catalog triggers
PASS  app role superuser/bypassrls                   f/f
PASS  tables owned by app role                       0
PASS  app role CONNECT on database                   t
PASS  tenant tables without RLS enabled+policy       0
PASS  app role UPDATE/DELETE/TRUNCATE on ledger+audit 0
PASS  app role access to audit_chain_heads           0
PASS  immutability/chain/balance triggers enabled    7
PASS  tenants with unbalanced ledger                 0
PASS  unbalanced journal entries                     0
PASS  ledger total debit = credit                    t
PASS  tenants whose audit chain fails                0
      tenants=6 audit_rows_verified=548 ledger_total lines=270 debit=7803833.33 credit=7803833.33 balanced=t
PASS  matches backup fingerprint (full)              identical
      compared 76 tables, 6 tenant ledgers, 6 audit chains, 76 table content hashes
RESTORE OK: autohub_restore_drill is restored and every check passed.
PASS  restore.sh (all its checks)                        ok
── 4/4 drill checks on autohub_restore_drill
   source snapshot: 76 tables, 3799 rows, 6 tenants
   source audit_verify 2a2408c3-b790-4a9d-a320-abc8a38b5c1d ok=t checked=2 first_bad_seq=- reason=-
   source audit_verify 5e8d8d75-418e-4702-a566-1fba5ec4ad68 ok=t checked=40 first_bad_seq=- reason=-
   source audit_verify 6fcba86e-615b-4949-bd68-458fc52851a7 ok=t checked=18 first_bad_seq=- reason=-
   source audit_verify b4a5afb5-f769-4a93-b206-13ebe9082f86 ok=t checked=401 first_bad_seq=- reason=-
   source audit_verify b8cd72a1-b0db-42c8-9f34-80f7540168bf ok=t checked=5 first_bad_seq=- reason=-
   source audit_verify c646d399-31b4-4440-86eb-a2b0f8faf323 ok=t checked=82 first_bad_seq=- reason=-
   source ledger 2a2408c3-b790-4a9d-a320-abc8a38b5c1d entries=0 lines=0 debit=0 credit=0 balanced=t unbalanced_entries=0 trial_balance_md5=-
   source ledger 5e8d8d75-418e-4702-a566-1fba5ec4ad68 entries=13 lines=28 debit=615000.00 credit=615000.00 balanced=t unbalanced_entries=0 trial_balance_md5=623f89ff59ecbeedacb367876ccb12e0
   source ledger 6fcba86e-615b-4949-bd68-458fc52851a7 entries=8 lines=16 debit=364500.00 credit=364500.00 balanced=t unbalanced_entries=0 trial_balance_md5=18397a22c20ce1e87e81cce3c88e0d73
   source ledger b4a5afb5-f769-4a93-b206-13ebe9082f86 entries=87 lines=195 debit=5948093.33 credit=5948093.33 balanced=t unbalanced_entries=0 trial_balance_md5=44344b0fbc8022a971b90846df9718e6
   source ledger b8cd72a1-b0db-42c8-9f34-80f7540168bf entries=1 lines=2 debit=100.00 credit=100.00 balanced=t unbalanced_entries=0 trial_balance_md5=26b7284aaedcfe5d261e275a054805f7
   source ledger c646d399-31b4-4440-86eb-a2b0f8faf323 entries=13 lines=29 debit=876140.00 credit=876140.00 balanced=t unbalanced_entries=0 trial_balance_md5=5aeb1b3d297913a3968a7eeab58f1aa5
   source ledger_total lines=270 debit=7803833.33 credit=7803833.33 balanced=t
PASS  (d) schema+security metadata identical             955 lines
PASS  (d) tenant tables with RLS disabled (target)       0
   global tables without RLS (by design, ARCHITECTURE §4): sessions, subscription_plans, users
   note: FORCE ROW LEVEL SECURITY is off on 72 RLS tables in source and target alike — by design the OWNER role (migrations, backups) bypasses RLS; the app role does not (checked below).
PASS  (d) app role can connect to target                 yes
PASS  (d) app role super/bypassrls/owned tables (assertSafeRole) f/f/0
PASS  (d) RLS tables where RLS is NOT active for app role 0
   for comparison, RLS active for the owner role on 0 tables (expected 0: owner bypasses, not forced)
PASS  (d) rows visible to app role with NO tenant context 0
PASS  (d) per-tenant rows visible to app role = owner counts identical
PASS  (d) other tenants' rows visible to app role        0
PASS  (c) audit chain verifies as app role (tenants)     6/6
   app_audit_verify 2a2408c3-b790-4a9d-a320-abc8a38b5c1d ok=t checked=2 reason=-
   app_audit_verify 5e8d8d75-418e-4702-a566-1fba5ec4ad68 ok=t checked=40 reason=-
   app_audit_verify 6fcba86e-615b-4949-bd68-458fc52851a7 ok=t checked=18 reason=-
   app_audit_verify b4a5afb5-f769-4a93-b206-13ebe9082f86 ok=t checked=401 reason=-
   app_audit_verify b8cd72a1-b0db-42c8-9f34-80f7540168bf ok=t checked=5 reason=-
   app_audit_verify c646d399-31b4-4440-86eb-a2b0f8faf323 ok=t checked=82 reason=-
   foreign_rows 2a2408c3-b790-4a9d-a320-abc8a38b5c1d 0
   foreign_rows 5e8d8d75-418e-4702-a566-1fba5ec4ad68 0
   foreign_rows 6fcba86e-615b-4949-bd68-458fc52851a7 0
   foreign_rows b4a5afb5-f769-4a93-b206-13ebe9082f86 0
   foreign_rows b8cd72a1-b0db-42c8-9f34-80f7540168bf 0
   foreign_rows c646d399-31b4-4440-86eb-a2b0f8faf323 0
   visible 2a2408c3-b790-4a9d-a320-abc8a38b5c1d journal_lines=0 journal_entries=0 audit_logs=2 sales=0 vehicles=0 customers=0 cash_transactions=0 receipts=0
   visible 5e8d8d75-418e-4702-a566-1fba5ec4ad68 journal_lines=28 journal_entries=13 audit_logs=40 sales=2 vehicles=1 customers=1 cash_transactions=5 receipts=2
   visible 6fcba86e-615b-4949-bd68-458fc52851a7 journal_lines=16 journal_entries=8 audit_logs=18 sales=0 vehicles=1 customers=0 cash_transactions=4 receipts=0
   visible b4a5afb5-f769-4a93-b206-13ebe9082f86 journal_lines=195 journal_entries=87 audit_logs=401 sales=16 vehicles=19 customers=18 cash_transactions=27 receipts=22
   visible b8cd72a1-b0db-42c8-9f34-80f7540168bf journal_lines=2 journal_entries=1 audit_logs=5 sales=0 vehicles=0 customers=1 cash_transactions=1 receipts=0
   visible c646d399-31b4-4440-86eb-a2b0f8faf323 journal_lines=29 journal_entries=13 audit_logs=82 sales=2 vehicles=3 customers=2 cash_transactions=3 receipts=2
PASS  (d) app UPDATE journal_lines refused               denied
PASS  (d) app DELETE journal_entries refused             denied
PASS  (d) app DELETE audit_logs refused                  denied
PASS  (d) app UPDATE cash_transactions refused           denied
PASS  (d) app read audit_chain_heads refused             denied
PASS  (d) app insert without tenant context refused      denied
PASS  (d) app cross-tenant insert refused (RLS WITH CHECK) denied
══ DRILL PASSED — report: /tmp/claude-0/-home-user-Car-Dealership/6fa1c7d4-a94b-5e23-92fd-607c59fed322/scratchpad/drill/final/drill-report.txt
```

Summary: (a) 76/76 tables have equal row counts **and** equal content hashes; (b) 6/6 company ledgers
are identical to the source (entries, lines, debit, credit, trial-balance hash), every one balanced;
the total is 270 lines, debit 7,803,833.33 = credit 7,803,833.33; (c) the audit chain verifies for
6/6 companies (548 rows), both as the owner and as the app role; (d) 955 lines of schema/security
metadata are identical, RLS is active for the app role on all 72 RLS tables, and every write the app
role must not make was refused.

**Negative controls** (11:41 UTC, same source data; each proves a check can fail):

| # | Fault injected | Observed |
|---|---|---|
| N1 | One byte flipped in a copy of the dump | `checksum mismatch — the dump is corrupt or was altered`, exit 1 |
| N2 | Restore into the non-empty target | `target database 'autohub_restore_drill' is not empty (77 relations)`, exit 1 |
| N3 | Dump without `.sha256` | `no checksum file …`, exit 1 |
| N4 | Fingerprint edited (`rows public.journal_lines 271`, real 270) | `FAIL matches backup fingerprint (full)` with the diff `-271 / +270`, exit 1 |
| N5 | As superuser on the restored target, triggers bypassed (`session_replication_role = replica`): one audit row's summary edited, one 1.00 debit line added | `audit_verify 5e8d8d75… ok=f checked=10 first_bad_seq=10 reason=hash_mismatch`; `ledger c646d399… debit=876141.00 credit=876140.00 balanced=f unbalanced_entries=1`; `ledger_total … balanced=f` |
| N6 | Dump whose ACLs grant the app role UPDATE, DELETE on `journal_lines` | `FAIL privileges intact (app_apply_privileges no-op) … no — corrected` (`journal_lines:S/I/U/D` → `S/I`), exit 1; afterwards `has_table_privilege` UPDATE, DELETE = false, false |

**The real API on the restored data** (11:44 UTC, on a restore of the same source data made by the
drill run just before; the final run above then reset and re-restored the target). The API image
`autohub-api:local` (built with `CHROMIUM=none`) ran against `autohub_restore_drill` as `autohub_app`:

* `GET /api/v1/health/live` → 200 `{"status":"ok"}`; `GET /api/v1/health/ready` → 200
  `{"status":"ok","database":"up"}`; start-up role check passed.
* Login as a restored company owner → 200. `POST /api/v1/audit-logs/verify` →
  `{"ok":true,"checked":402,"firstBadSeq":null,"reason":null}`: the 401 restored rows plus the
  login's new entry, so the chain trigger continued the restored chain correctly.
* `GET /api/v1/ledger/trial-balance` → 200, `periodDebit` = `periodCredit` = 5948093.33, equal to the
  drill's ledger figure for that company (b4a5afb5…).
* `GET /api/v1/sale-documents/<id>/pdf` → 503 `pdf_unavailable` (expected: no Chromium in that image).

**Compose topology** (11:46 UTC, throwaway Compose stack, not the shared databases): `backup.sh` in
a one-off container → `autohub_20261018T114652Z.dump` (449,928 bytes) plus sha256, fingerprint and
manifest. `restore.sh` into a new database `autohub_restore_check` (created with
`bootstrap-roles.sql`) → every check PASS (95 composite FKs, 11 catalog triggers; 76 tables match
the fingerprint) and `RESTORE OK`.

**Earlier runs the same day:** before the container restarted, the same procedure passed at 06:43 UTC
on a source populated with the schema of the time (migrations 0000–0012: 76 tables, 3,797 rows,
6 companies, 821 metadata lines). The first attempt at 06:41 failed one check: `sessions` has a
`tenant_id` column but no RLS. That is by design (ARCHITECTURE §4: sessions are read by token before
any company context exists), so the scripts now exempt `sessions` explicitly and list the global tables.

**Note on FORCE ROW LEVEL SECURITY.** RLS is enabled on every company table but not *forced*
(`relforcerowsecurity = false` on all 72 RLS tables, in the source and after restore). This is the
intended design: the API's role `autohub_app` is not the table owner, so RLS always applies to it.
The drill checks this directly: `row_security_active()` is true for the app role on every RLS table,
and it sees 0 rows without context. The owner role used by migrations and backups bypasses RLS, and
the backup and restore rely on that. `docs/ARCHITECTURE.md` §4 describes RLS as "enabled **and
forced**", which does not match the migrations.

**Not covered by this drill:** file-storage restore (only the tar backup of the volume was tested),
a restore onto a different host or cluster (same cluster here, so roles already existed), a
production-sized dump (timing unknown), the 20 tables that were empty in the source, and switching
the running deployment over to a restored database (§4 steps 3–6).

### 2026-10-24 — second drill (schema through 0018_supplier_national_id_security, 19 migrations)

**Same environment and roles as the first drill; target `autohub_restore_drill` (`--reset-target`).**

1. **Source `autohub_test_t`** (data left by the Playwright browser suite: 7 companies, 76 tables,
   3,175 rows, including showroom listings, reservations, installment sales, receipts, refunds,
   appointments and cash transfers made through the UI) → **DRILL PASSED, 31/31 checks**: identical
   row counts and content hashes for all 76 tables, ledger balanced for every company and equal to
   the source, audit chain verifies for 7/7 companies as owner and as the app role, schema/security
   metadata identical (957 lines), RLS active for the app role, ledger/audit/cash UPDATE/DELETE refused.
2. **Source `autohub_test_q`** (data left by the whole API suite, 372 tests: 111 companies, 19,763
   rows) → restore identical to the source (full fingerprint, 76 table content hashes, 111 ledgers,
   ledger debit = credit = 19,548,393.36), 28 checks passed, **2 failed by design**: one company's
   audit chain fails with `hash_mismatch` at seq 1 **in the source as well** — `audit-ledger.spec.ts`
   tampers with it on purpose (trigger disabled by a superuser) to prove the verifier detects it.
   The restore faithfully kept the tampered row, and the verifier flagged it after restore too.

Reports: `scratchpad/drill-3/drill-report.txt` and `scratchpad/drill-2/drill-report.txt` (not kept in
the repository; the commands above reproduce them).
