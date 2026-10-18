#!/usr/bin/env bash
# AutoHub Pro — restore a backup made by scripts/backup.sh into a NEW, EMPTY database, then prove
# the result is usable and safe: privileges re-applied, RLS on every tenant table, app role still
# unprivileged, ledger balanced per tenant, audit hash chain verifying per tenant, and (when the
# backup's .fingerprint file is present) row counts / ledger / audit identical to the backup.
#
#   scripts/restore.sh [--jobs N] [--skip-checksum] <file.dump> <target-db>
#
# It never restores over existing data: the target must contain no tables. Create the target first,
# as a superuser, with the same bootstrap as a fresh install (creates roles if missing, the database
# owned by autohub_owner, and CONNECT for autohub_app):
#   psql -v owner_password=… -v app_password=… -v db_name=<target-db> -f infra/db/bootstrap-roles.sql
#
# Connection: libpq variables PGHOST, PGPORT, PGUSER = the OWNER role (autohub_owner; the same role
# name as in the source cluster), password via ~/.pgpass or PGPASSWORD. Roles are cluster-wide and
# are NOT inside the dump; autohub_app must already exist in the target cluster.
#   APP_ROLE   the application role name (default autohub_app)
#
#   --jobs N         parallel restore (faster for large dumps; not a single transaction, so on failure
#                    drop and recreate the target database before retrying)
#   --skip-checksum  restore even without a .sha256 file next to the dump (not recommended)
#
# Exit code 0 only if the restore AND every check passed.
set -Eeuo pipefail
umask 077

log() { printf '[restore %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

jobs=1
skip_checksum=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jobs) jobs="${2:?--jobs needs a number}"; shift 2 ;;
    --skip-checksum) skip_checksum=1; shift ;;
    -h | --help) sed -n '2,26p' "$0"; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[[ $# -eq 2 ]] || die "usage: $0 [--jobs N] [--skip-checksum] <file.dump> <target-db>"
dump="$1"
target="$2"
APP_ROLE="${APP_ROLE:-autohub_app}"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || die "--jobs must be a positive integer"
[[ -f "$dump" ]] || die "dump not found: $dump"
for bin in psql pg_restore sha256sum; do command -v "$bin" >/dev/null || die "$bin not found in PATH"; done

HERE="$(cd "$(dirname "$0")" && pwd)"
dump="$(cd "$(dirname "$dump")" && pwd)/$(basename "$dump")"
base="${dump%.dump}"
PSQL=(psql -X -q -At -w -v ON_ERROR_STOP=1 -d "$target")
q() { "${PSQL[@]}" -v "app_role=$APP_ROLE" <<<"$1"; } # SQL on stdin so :'app_role' is interpolated

failures=0
check() { # check <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf 'PASS  %-46s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-46s expected %s, got %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

# ── 1. Integrity of the file ───────────────────────────────────────────────────────────────────
if [[ -f "$dump.sha256" ]]; then
  (cd "$(dirname "$dump")" && sha256sum --quiet -c "$(basename "$dump").sha256") || die "checksum mismatch — the dump is corrupt or was altered"
  log "checksum OK"
elif [[ $skip_checksum -eq 1 ]]; then
  log "WARNING: no $(basename "$dump").sha256 — integrity NOT verified (--skip-checksum)"
else
  die "no checksum file $(basename "$dump").sha256 next to the dump (use --skip-checksum to override)"
fi

# ── 2. Preconditions on the target ─────────────────────────────────────────────────────────────
q 'SELECT 1' >/dev/null || die "cannot connect to target database '$target' (create it first — see the header)"
me="$(q 'SELECT current_user')"
[[ "$me" != "$APP_ROLE" ]] || die "do not restore as the application role; connect as the owner role"
is_owner="$(q "SELECT r.rolsuper OR pg_has_role(current_user, d.datdba, 'USAGE') FROM pg_roles r, pg_database d WHERE r.rolname = current_user AND d.datname = current_database()")"
[[ "$is_owner" == t ]] || die "role $me does not own database $target"
nrel="$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')")"
[[ "$nrel" == 0 ]] || die "target database '$target' is not empty ($nrel relations). Restore only into a new, empty database."
app="$(q "SELECT rolsuper::text || ',' || rolbypassrls::text FROM pg_roles WHERE rolname = :'app_role'")"
[[ -n "$app" ]] || die "role $APP_ROLE does not exist in this cluster (run infra/db/bootstrap-roles.sql first)"
[[ "$app" == "false,false" ]] || die "role $APP_ROLE is SUPERUSER or BYPASSRLS — tenant isolation would not hold"
log "target=$target role=$me app_role=$APP_ROLE jobs=$jobs"

# ── 3. Restore ─────────────────────────────────────────────────────────────────────────────────
# --no-owner: objects end up owned by the restoring (owner) role, whatever the source called it.
# Privileges (GRANT/REVOKE for the app role) ARE restored; app_apply_privileges() re-asserts them.
restore_args=(-w --exit-on-error --no-owner --dbname="$target")
if [[ "$jobs" -gt 1 ]]; then restore_args+=(--jobs="$jobs"); else restore_args+=(--single-transaction); fi
started=$(date +%s)
pg_restore "${restore_args[@]}" "$dump" || die "pg_restore failed (target left as the failed transaction rolled back$([[ $jobs -gt 1 ]] && echo ' — PARALLEL restore is NOT atomic: drop and recreate the target'))"
log "pg_restore finished in $(($(date +%s) - started))s"

# ── 4. Re-apply privilege restrictions; detect if the dump's ACLs differed ─────────────────────
privs_sql="SELECT string_agg(c.relname || ':' || concat_ws('/',
    CASE WHEN has_table_privilege(:'app_role', c.oid, 'SELECT') THEN 'S' END,
    CASE WHEN has_table_privilege(:'app_role', c.oid, 'INSERT') THEN 'I' END,
    CASE WHEN has_table_privilege(:'app_role', c.oid, 'UPDATE') THEN 'U' END,
    CASE WHEN has_table_privilege(:'app_role', c.oid, 'DELETE') THEN 'D' END,
    CASE WHEN has_table_privilege(:'app_role', c.oid, 'TRUNCATE') THEN 'T' END), ' ' ORDER BY c.relname)
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')"
before="$(q "$privs_sql")"
q 'SELECT app_apply_privileges()' >/dev/null || die "app_apply_privileges() failed"
after="$(q "$privs_sql")"
# Cross-tenant reference guards (migration 0013, D-039): composite (tenant_id, x) foreign keys "*_tfk"
# and catalog triggers "*_tenant_ref". app_apply_tenant_fks() is idempotent; it must add nothing.
guards_sql="SELECT (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype = 'f' AND conname LIKE '%\\_tfk' ESCAPE '\\')
  || ' composite FKs, ' || (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\\_tenant\\_ref' ESCAPE '\\') || ' catalog triggers'"
has_fks_fn="$(q "SELECT to_regprocedure('app_apply_tenant_fks()') IS NOT NULL")"
if [[ "$has_fks_fn" == t ]]; then
  guards_before="$(q "$guards_sql")"
  q 'SELECT app_apply_tenant_fks()' >/dev/null || die "app_apply_tenant_fks() failed"
  guards_after="$(q "$guards_sql")"
fi
# pg_restore does not carry planner statistics; analyze the application schemas only.
q "SELECT format('ANALYZE %I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname IN ('public', 'drizzle')
\\gexec" >/dev/null

echo "── restore checks: $target ($(basename "$dump"))"
if [[ "$before" == "$after" ]]; then
  check "privileges intact (app_apply_privileges no-op)" yes yes
else
  check "privileges intact (app_apply_privileges no-op)" yes "no — corrected"
  diff <(tr ' ' '\n' <<<"$before") <(tr ' ' '\n' <<<"$after") | sed 's/^/      /' || true
fi
if [[ "$has_fks_fn" == t ]]; then
  check "tenant reference guards intact (no-op)" "$guards_before" "$guards_after"
else
  echo "      (dump predates migration 0013: no app_apply_tenant_fks() — tenant reference guards not checked)"
fi

# ── 5. Safety and integrity checks ─────────────────────────────────────────────────────────────
check "app role superuser/bypassrls" "f/f" "$(q "SELECT rolsuper::text::char || '/' || rolbypassrls::text::char FROM pg_roles WHERE rolname = :'app_role'")"
check "tables owned by app role" 0 "$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = :'app_role'")"
check "app role CONNECT on database" t "$(q "SELECT has_database_privilege(:'app_role', current_database(), 'CONNECT')")"
# `sessions` is global by design (ARCHITECTURE §4): it is read by token before any tenant context exists;
# its nullable tenant_id is only the session's active company.
check "tenant tables without RLS enabled+policy" 0 "$(q "SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
  AND c.relname NOT IN ('sessions')
  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))")"
check "app role UPDATE/DELETE/TRUNCATE on ledger+audit" 0 "$(q "SELECT count(*) FROM unnest(ARRAY['journal_entries', 'journal_lines', 'audit_logs', 'cash_transactions']) t,
  unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) p WHERE has_table_privilege(:'app_role', 'public.' || t, p)")"
check "app role access to audit_chain_heads" 0 "$(q "SELECT count(*) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p WHERE has_table_privilege(:'app_role', 'public.audit_chain_heads', p)")"
check "immutability/chain/balance triggers enabled" 7 "$(q "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgname IN
  ('audit_logs_chain', 'audit_logs_immutable', 'journal_entries_immutable', 'journal_lines_immutable', 'journal_lines_balanced', 'journal_entries_balanced', 'audit_logs_no_truncate')")"

fp="$(mktemp)"
trap 'rm -f "$fp"' EXIT
mode=counts
[[ -f "$base.fingerprint" ]] && mode="$(sed -n 's/^# fingerprint mode=//p' "$base.fingerprint" | head -n1)"
PGDATABASE="$target" BACKUP_FINGERPRINT="${mode:-counts}" "$HERE/backup.sh" fingerprint >"$fp" || die "fingerprint of the target failed"
check "tenants with unbalanced ledger" 0 "$(grep -c '^ledger [0-9a-f-]* .*balanced=f' "$fp" || true)"
check "unbalanced journal entries" 0 "$(sed -n 's/^ledger [0-9a-f-]* .*unbalanced_entries=\([0-9]*\).*/\1/p' "$fp" | awk '{s+=$1} END {print s+0}')"
check "ledger total debit = credit" t "$(sed -n 's/^ledger_total .*balanced=\([tf]\).*/\1/p' "$fp")"
check "tenants whose audit chain fails" 0 "$(grep -c '^audit_verify .* ok=f' "$fp" || true)"
echo "      tenants=$(grep -c '^ledger [0-9a-f]' "$fp" || true) audit_rows_verified=$(sed -n 's/^audit_verify .* checked=\([0-9]*\).*/\1/p' "$fp" | awk '{s+=$1} END {print s+0}') $(grep '^ledger_total' "$fp")"

if [[ -f "$base.fingerprint" ]]; then
  if diff -u "$base.fingerprint" "$fp" >"$fp.diff"; then
    check "matches backup fingerprint ($mode)" identical identical
    echo "      compared $(grep -c '^rows ' "$fp") tables, $(grep -c '^ledger [0-9a-f]' "$fp") tenant ledgers, $(grep -c '^audit_verify ' "$fp") audit chains$([[ $mode == full ]] && echo ", $(grep -c '^content ' "$fp") table content hashes")"
  else
    check "matches backup fingerprint ($mode)" identical different
    sed 's/^/      /' "$fp.diff" | head -n 60
  fi
  rm -f "$fp.diff"
else
  echo "      (no $(basename "$base").fingerprint next to the dump — skipped the comparison with the backup)"
fi

if [[ $failures -eq 0 ]]; then
  echo "RESTORE OK: $target is restored and every check passed."
else
  echo "RESTORE FINISHED WITH $failures FAILED CHECK(S) — do not point the API at $target until resolved."
  exit 1
fi
