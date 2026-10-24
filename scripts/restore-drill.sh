#!/usr/bin/env bash
# AutoHub Pro — restore drill. Proves a backup can be restored: dumps SOURCE with scripts/backup.sh
# (full fingerprint from the same snapshot as the dump), restores it into the empty TARGET with
# scripts/restore.sh, then verifies:
#   (a) every table's row count AND content hash equal the source snapshot
#   (b) per-tenant general ledger balanced and identical (entries, lines, debit, credit, trial balance)
#   (c) the audit hash chain verifies for every tenant (audit_verify_chain(), the API's own verifier),
#       both as the owner and as the application role
#   (d) schema + security metadata identical to the source: RLS flags, policies, app-role privileges on
#       every table/sequence/function, triggers, indexes, constraints, extensions, default ACLs;
#       the app role is not SUPERUSER/BYPASSRLS, owns nothing, and RLS is ACTIVE for it (default deny
#       without tenant context, only its own tenant's rows with context, cross-tenant writes rejected,
#       ledger/audit UPDATE/DELETE refused).
#
#   scripts/restore-drill.sh [--reset-target] <source-db> <target-db>
#
# Connection: PGHOST, PGPORT, PGUSER = owner role (autohub_owner), PGPASSWORD or ~/.pgpass.
#   APP_ROLE         application role (default autohub_app)
#   APP_PGPASSWORD   its password (or put it in ~/.pgpass) — the app-role checks connect as it
#   DRILL_DIR        where the dump, fingerprints and report go (default ./backups/drill-<UTC ts>)
#   --reset-target   empty the target first (drops its public and drizzle schemas). Only allowed when
#                    the target name ends in "restore_drill" or "_drill". Never point it at real data.
#
# The source is only READ (pg_dump + read-only queries). Exit code 0 only if every check passed.
# The full report is written to $DRILL_DIR/drill-report.txt.
set -Eeuo pipefail
umask 077

reset=0
[[ "${1:-}" == "--reset-target" ]] && { reset=1; shift; }
[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && { sed -n '2,27p' "$0"; exit 0; }
[[ $# -eq 2 ]] || { echo "usage: $0 [--reset-target] <source-db> <target-db>" >&2; exit 2; }
SRC="$1"
DST="$2"
[[ "$SRC" != "$DST" ]] || { echo "source and target must differ" >&2; exit 2; }
APP_ROLE="${APP_ROLE:-autohub_app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DRILL_DIR="${DRILL_DIR:-./backups/drill-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$DRILL_DIR"
DRILL_DIR="$(cd "$DRILL_DIR" && pwd)"
REPORT="$DRILL_DIR/drill-report.txt"
exec > >(tee -a "$REPORT") 2>&1

PSQL=(psql -X -q -At -w -v ON_ERROR_STOP=1)
owner_q() { "${PSQL[@]}" -d "$1" -v "app_role=$APP_ROLE" <<<"$2"; }
# The owner's PGPASSWORD must not be reused for the app role: empty → libpq falls back to ~/.pgpass.
app_q() { PGUSER="$APP_ROLE" PGPASSWORD="${APP_PGPASSWORD:-}" "${PSQL[@]}" -d "$DST" <<<"$1"; }

failures=0
check() {
  if [[ "$2" == "$3" ]]; then printf 'PASS  %-50s %s\n' "$1" "$3"; else
    printf 'FAIL  %-50s expected %s, got %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

echo "══ AutoHub Pro restore drill — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "   source=$SRC target=$DST host=${PGHOST:-socket}:${PGPORT:-5432} owner_role=${PGUSER:-$(id -un)} app_role=$APP_ROLE"
echo "   server $(owner_q "$SRC" 'SHOW server_version'), $(pg_dump --version), dir=$DRILL_DIR"

if [[ $reset -eq 1 ]]; then
  [[ "$DST" =~ (restore_drill|_drill)$ ]] || { echo "--reset-target refused: '$DST' does not end in restore_drill/_drill"; exit 2; }
  echo "── resetting target $DST (drop schemas public, drizzle)"
  owner_q "$DST" 'SET client_min_messages = warning; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC;' >/dev/null
fi

# ── Schema + security metadata (owner view). Everything that must survive a restore. ──────────
secmeta() {
  owner_q "$1" "
SELECT format('relation %s.%s kind=%s rls=%s force_rls=%s owner_is_app=%s app=%s', n.nspname, c.relname, c.relkind,
       c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) = :'app_role',
       CASE WHEN c.relkind = 'S' THEN concat_ws('/',
              CASE WHEN has_sequence_privilege(:'app_role', c.oid, 'USAGE') THEN 'USAGE' END,
              CASE WHEN has_sequence_privilege(:'app_role', c.oid, 'SELECT') THEN 'SELECT' END,
              CASE WHEN has_sequence_privilege(:'app_role', c.oid, 'UPDATE') THEN 'UPDATE' END)
            ELSE concat_ws('/',
              CASE WHEN has_table_privilege(:'app_role', c.oid, 'SELECT') THEN 'SELECT' END,
              CASE WHEN has_table_privilege(:'app_role', c.oid, 'INSERT') THEN 'INSERT' END,
              CASE WHEN has_table_privilege(:'app_role', c.oid, 'UPDATE') THEN 'UPDATE' END,
              CASE WHEN has_table_privilege(:'app_role', c.oid, 'DELETE') THEN 'DELETE' END,
              CASE WHEN has_table_privilege(:'app_role', c.oid, 'TRUNCATE') THEN 'TRUNCATE' END,
              CASE WHEN has_table_privilege(:'app_role', c.oid, 'REFERENCES') THEN 'REFERENCES' END,
              CASE WHEN has_table_privilege(:'app_role', c.oid, 'TRIGGER') THEN 'TRIGGER' END) END)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e');
SELECT format('policy %s.%s %s permissive=%s roles=%s cmd=%s using=%s check=%s', schemaname, tablename, policyname,
       permissive, roles, cmd, qual, with_check) FROM pg_policies WHERE schemaname = 'public';
SELECT format('function %s(%s) secdef=%s app_execute=%s', p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef,
       has_function_privilege(:'app_role', p.oid, 'EXECUTE'))
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
SELECT format('trigger %s %s enabled=%s def=%s', tgrelid::regclass, tgname, tgenabled, pg_get_triggerdef(oid))
FROM pg_trigger WHERE NOT tgisinternal;
SELECT format('index %s', pg_get_indexdef(i.indexrelid)) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
WHERE c.relnamespace IN ('public'::regnamespace, 'drizzle'::regnamespace);
SELECT format('constraint %s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) FROM pg_constraint
WHERE connamespace IN ('public'::regnamespace, 'drizzle'::regnamespace) AND conrelid <> 0;
SELECT format('schema %s app_usage=%s app_create=%s', nspname, has_schema_privilege(:'app_role', oid, 'USAGE'),
       has_schema_privilege(:'app_role', oid, 'CREATE')) FROM pg_namespace WHERE nspname IN ('public', 'drizzle');
SELECT format('extension %s %s', extname, extversion) FROM pg_extension;
SELECT format('default_acl %s %s %s', pg_get_userbyid(defaclrole), defaclobjtype, defaclacl) FROM pg_default_acl;
SELECT format('role %s super=%s bypassrls=%s createdb=%s createrole=%s', rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole)
FROM pg_roles WHERE rolname = :'app_role';
" | LC_ALL=C sort
}

echo "── 1/4 source metadata"
secmeta "$SRC" >"$DRILL_DIR/source.secmeta"
echo "   $(wc -l <"$DRILL_DIR/source.secmeta") metadata lines ($(grep -c '^relation ' "$DRILL_DIR/source.secmeta") relations, $(grep -c '^policy ' "$DRILL_DIR/source.secmeta") policies, $(grep -c '^function ' "$DRILL_DIR/source.secmeta") functions, $(grep -c '^trigger ' "$DRILL_DIR/source.secmeta") triggers)"

echo "── 2/4 backup of $SRC"
dump="$(PGDATABASE="$SRC" BACKUP_DIR="$DRILL_DIR" BACKUP_FINGERPRINT=full "$HERE/backup.sh" | tail -n1)"
[[ -f "$dump" ]] || { echo "FAIL  backup did not produce a dump"; exit 1; }
sed 's/^/   /' "${dump%.dump}.manifest"

echo "── 3/4 restore into $DST (scripts/restore.sh — includes (a) counts+content, (b) ledger, (c) audit vs the backup snapshot)"
if "$HERE/restore.sh" "$dump" "$DST"; then check "restore.sh (all its checks)" ok ok; else check "restore.sh (all its checks)" ok failed; fi

echo "── 4/4 drill checks on $DST"
fp="${dump%.dump}.fingerprint"
echo "   source snapshot: $(grep -c '^rows ' "$fp") tables, $(grep '^rows ' "$fp" | awk '{s+=$3} END {print s+0}') rows, $(grep -c '^ledger [0-9a-f]' "$fp") tenants"
grep -E '^(ledger|ledger_total|audit_verify) ' "$fp" | sed 's/^/   source /'

# (d) metadata identical
secmeta "$DST" >"$DRILL_DIR/target.secmeta"
if diff -u "$DRILL_DIR/source.secmeta" "$DRILL_DIR/target.secmeta" >"$DRILL_DIR/secmeta.diff"; then
  check "(d) schema+security metadata identical" "$(wc -l <"$DRILL_DIR/source.secmeta") lines" "$(wc -l <"$DRILL_DIR/target.secmeta") lines"
else
  check "(d) schema+security metadata identical" identical "different (see secmeta.diff)"
  sed 's/^/      /' "$DRILL_DIR/secmeta.diff" | head -n 40
fi
check "(d) tenant tables with RLS disabled (target)" 0 "$(owner_q "$DST" "SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname NOT IN ('sessions') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)")"
echo "   global tables without RLS (by design, ARCHITECTURE §4): $(owner_q "$DST" "SELECT string_agg(relname, ', ' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity")"
echo "   note: FORCE ROW LEVEL SECURITY is off on $(owner_q "$DST" "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity AND NOT relforcerowsecurity") RLS tables in source and target alike — by design the OWNER role (migrations, backups) bypasses RLS; the app role does not (checked below)."

# App role: connect exactly like the API does.
if ! app_q 'SELECT 1' >/dev/null 2>"$DRILL_DIR/app-connect.err"; then
  check "(d) app role can connect to target" yes "no: $(head -n1 "$DRILL_DIR/app-connect.err")"
else
  check "(d) app role can connect to target" yes yes
  check "(d) app role super/bypassrls/owned tables (assertSafeRole)" "f/f/0" "$(app_q "SELECT r.rolsuper::text::char || '/' || r.rolbypassrls::text::char || '/' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) FROM pg_roles r WHERE r.rolname = current_user")"
  check "(d) RLS tables where RLS is NOT active for app role" 0 "$(app_q "SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity AND NOT row_security_active(c.oid)")"
  echo "   for comparison, RLS active for the owner role on $(owner_q "$DST" "SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity AND row_security_active(c.oid)") tables (expected 0: owner bypasses, not forced)"
  check "(d) rows visible to app role with NO tenant context" 0 "$(app_q "SELECT (SELECT count(*) FROM tenants) + (SELECT count(*) FROM journal_lines) + (SELECT count(*) FROM audit_logs) + (SELECT count(*) FROM customers) + (SELECT count(*) FROM sales) + (SELECT count(*) FROM cash_transactions)")"

  tenants=$(owner_q "$DST" 'SET row_security = off; SELECT id FROM tenants ORDER BY id')
  vis_cols="journal_lines journal_entries audit_logs sales vehicles customers cash_transactions receipts"
  expected="" actual_sql=""
  for t in $tenants; do
    [[ "$t" =~ ^[0-9a-f-]{36}$ ]] || { echo "unexpected tenant id $t"; exit 1; }
    counts="" own=""
    for tbl in $vis_cols; do
      counts+=" || ' $tbl=' || (SELECT count(*) FROM $tbl)"
      own+=" || ' $tbl=' || (SELECT count(*) FROM $tbl WHERE tenant_id = '$t')"
    done
    expected+="SELECT 'visible $t' $own;"$'\n'
    actual_sql+="BEGIN; SELECT set_config('app.tenant_id', '$t', true) IS NULL;"$'\n'
    actual_sql+="SELECT 'visible $t' $counts;"$'\n'
    actual_sql+="SELECT 'foreign_rows $t ' || ((SELECT count(*) FROM journal_lines WHERE tenant_id <> '$t') + (SELECT count(*) FROM audit_logs WHERE tenant_id <> '$t') + (SELECT count(*) FROM sales WHERE tenant_id <> '$t') + (SELECT count(*) FROM tenants WHERE id <> '$t'));"$'\n'
    actual_sql+="SELECT format('app_audit_verify %s ok=%s checked=%s reason=%s', '$t', ok, checked, coalesce(reason, '-')) FROM audit_verify_chain();"$'\n'
    actual_sql+="ROLLBACK;"$'\n'
  done
  ntenants=$(wc -w <<<"$tenants")
  owner_q "$DST" "SET row_security = off; $expected" | LC_ALL=C sort >"$DRILL_DIR/visible.expected"
  app_q "$actual_sql" | grep -E '^(visible|foreign_rows|app_audit_verify) ' | LC_ALL=C sort >"$DRILL_DIR/visible.actual"
  check "(d) per-tenant rows visible to app role = owner counts" identical "$(diff -q "$DRILL_DIR/visible.expected" <(grep '^visible ' "$DRILL_DIR/visible.actual") >/dev/null && echo identical || echo different)"
  check "(d) other tenants' rows visible to app role" 0 "$(grep '^foreign_rows ' "$DRILL_DIR/visible.actual" | awk '{s+=$3} END {print s+0}')"
  check "(c) audit chain verifies as app role (tenants)" "$ntenants/$ntenants" "$(grep -c '^app_audit_verify .* ok=t' "$DRILL_DIR/visible.actual" || true)/$ntenants"
  sed 's/^/   /' "$DRILL_DIR/visible.actual"

  # Writes the app role must NOT be able to make (each in a rolled-back transaction).
  expect_denied() { # name, expected error fragment, sql
    local out
    if out=$(app_q "BEGIN; $3; ROLLBACK;" 2>&1); then check "(d) $1" "denied" "ALLOWED"
    elif grep -q "$2" <<<"$out"; then check "(d) $1" denied denied
    else check "(d) $1" "denied ($2)" "$(head -n1 <<<"$out")"; fi
  }
  t1=$(sed -n 1p <<<"$tenants")
  t2=$(sed -n 2p <<<"$tenants")
  expect_denied "app UPDATE journal_lines refused" "permission denied" "UPDATE journal_lines SET memo = memo WHERE false"
  expect_denied "app DELETE journal_entries refused" "permission denied" "DELETE FROM journal_entries WHERE false"
  expect_denied "app DELETE audit_logs refused" "permission denied" "DELETE FROM audit_logs WHERE false"
  expect_denied "app UPDATE cash_transactions refused" "permission denied" "UPDATE cash_transactions SET tenant_id = tenant_id WHERE false"
  expect_denied "app read audit_chain_heads refused" "permission denied" "SELECT count(*) FROM audit_chain_heads"
  expect_denied "app insert without tenant context refused" "row-level security" "INSERT INTO number_sequences (tenant_id, key, next_value) VALUES ('$t1', 'restore_drill_probe', 1)"
  if [[ -n "$t2" ]]; then
    expect_denied "app cross-tenant insert refused (RLS WITH CHECK)" "row-level security" "SELECT set_config('app.tenant_id', '$t1', true); INSERT INTO number_sequences (tenant_id, key, next_value) VALUES ('$t2', 'restore_drill_probe', 1)"
  fi
fi

echo "══ $( [[ $failures -eq 0 ]] && echo "DRILL PASSED" || echo "DRILL FAILED ($failures failed check(s))" ) — report: $REPORT"
[[ $failures -eq 0 ]]
