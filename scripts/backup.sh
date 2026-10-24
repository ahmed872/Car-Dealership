#!/usr/bin/env bash
# AutoHub Pro — logical backup of ONE database: pg_dump custom format + checksum + manifest + a data
# fingerprint taken from the SAME snapshot as the dump (so a restore can be compared against it).
#
#   scripts/backup.sh                 take a backup of $PGDATABASE (default command)
#   scripts/backup.sh fingerprint     print the data fingerprint of $PGDATABASE (used by restore.sh)
#
# Connection — standard libpq variables, never a URL on the command line:
#   PGHOST, PGPORT, PGDATABASE (e.g. autohub), PGUSER = the OWNER role (autohub_owner) or a superuser,
#   password via ~/.pgpass / PGPASSFILE (preferred) or PGPASSWORD. The app role (autohub_app) cannot
#   take a backup: RLS hides every row from it, and this script refuses to run as it.
#
# Settings:
#   BACKUP_DIR              output directory (default ./backups, git-ignored)
#   BACKUP_RETENTION_DAYS   after a SUCCESSFUL backup, delete this database's dumps older than N days
#                           (unset or 0 = keep everything)
#   BACKUP_FINGERPRINT      counts (default) | full (adds a content hash of every table) | none
#   BACKUP_LOCK_WAIT        how long pg_dump waits for table locks (default 120s)
#
# Output (mode 0600), where <base> = <db>_<UTC yyyymmddTHHMMSSZ>:
#   <base>.dump          pg_dump -Fc archive        <base>.dump.sha256   sha256sum line (relative name)
#   <base>.fingerprint   row counts, per-tenant ledger totals, audit chain results (same snapshot)
#   <base>.manifest      versions, sizes, timestamps
# The last line printed on stdout is the path of the .dump file. Exit code 0 only if everything,
# including a full read-back of the archive, succeeded.
set -Eeuo pipefail
umask 077

log() { printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

PSQL=(psql -X -q -At -w -v ON_ERROR_STOP=1)

: "${PGDATABASE:?set PGDATABASE (and PGHOST/PGPORT/PGUSER) — see the header of this script}"

# ── Data fingerprint ───────────────────────────────────────────────────────────────────────────
# Deterministic text: one line per fact, sorted. Runs with row_security=off, so a role that RLS
# would filter gets an ERROR instead of silently-low counts. $1 = exported snapshot id (optional),
# $2 = mode (counts|full).
fingerprint() {
  local snapshot="${1:-}" mode="${2:-counts}"
  local args=(-v "full=$([[ "$mode" == full ]] && echo true || echo false)")
  [[ -n "$snapshot" ]] && args+=(-v "snapshot=$snapshot")
  {
    echo "# fingerprint mode=$mode"
    "${PSQL[@]}" "${args[@]}" <<'SQL' | grep -E '^(rows|seq|ledger|ledger_total|audit_head|audit_verify|content) ' | LC_ALL=C sort
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot}
SET TRANSACTION SNAPSHOT :'snapshot';
\endif
SET LOCAL row_security = off;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = 0;
SET LOCAL extra_float_digits = 3;

-- (a) exact row count of every table (application schema + migration history)
SELECT format('SELECT %L || '' '' || count(*) FROM %I.%I', 'rows ' || schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY schemaname, tablename
\gexec

SELECT 'seq ' || schemaname || '.' || sequencename || ' last_value=' || coalesce(last_value::text, '-')
FROM pg_sequences WHERE schemaname IN ('public', 'drizzle') ORDER BY schemaname, sequencename;

-- (b) general ledger per tenant: totals, balance, unbalanced entries, trial-balance hash
WITH per_line AS (
  SELECT tenant_id, count(*) AS n, coalesce(sum(debit), 0) AS d, coalesce(sum(credit), 0) AS c
  FROM journal_lines GROUP BY tenant_id
), per_entry AS (
  SELECT tenant_id, count(*) AS n FROM journal_entries GROUP BY tenant_id
), unbalanced AS (
  SELECT e.tenant_id, count(*) AS n
  FROM journal_entries e
  LEFT JOIN (SELECT entry_id, sum(debit) AS d, sum(credit) AS c, count(*) AS k FROM journal_lines GROUP BY entry_id) l
         ON l.entry_id = e.id
  WHERE l.entry_id IS NULL OR l.d <> l.c OR l.k < 2
  GROUP BY e.tenant_id
), tb AS (
  SELECT tenant_id, md5(string_agg(account_code || ':' || d || ':' || c, ',' ORDER BY account_code COLLATE "C")) AS h
  FROM (SELECT tenant_id, account_code, sum(debit) AS d, sum(credit) AS c FROM journal_lines GROUP BY 1, 2) a
  GROUP BY tenant_id
)
SELECT format('ledger %s entries=%s lines=%s debit=%s credit=%s balanced=%s unbalanced_entries=%s trial_balance_md5=%s',
              t.id, coalesce(pe.n, 0), coalesce(pl.n, 0), coalesce(pl.d, 0), coalesce(pl.c, 0),
              coalesce(pl.d, 0) = coalesce(pl.c, 0), coalesce(u.n, 0), coalesce(tb.h, '-'))
FROM tenants t
LEFT JOIN per_line pl ON pl.tenant_id = t.id
LEFT JOIN per_entry pe ON pe.tenant_id = t.id
LEFT JOIN unbalanced u ON u.tenant_id = t.id
LEFT JOIN tb ON tb.tenant_id = t.id
ORDER BY t.id;

SELECT format('ledger_total lines=%s debit=%s credit=%s balanced=%s',
              count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0), coalesce(sum(debit), 0) = coalesce(sum(credit), 0))
FROM journal_lines;

-- (c) audit hash chain: stored heads + the API's own verifier (audit_verify_chain) per tenant
SELECT format('audit_head %s last_seq=%s last_hash=%s', tenant_id, last_seq, last_hash)
FROM audit_chain_heads ORDER BY tenant_id;

SELECT format('SELECT set_config(''app.tenant_id'', %L, true) IS NULL', id),
       format('SELECT format(''audit_verify %%s ok=%%s checked=%%s first_bad_seq=%%s reason=%%s'', %L, ok, checked, coalesce(first_bad_seq::text, ''-''), coalesce(reason, ''-'')) FROM audit_verify_chain()', id)
FROM tenants ORDER BY id
\gexec

-- optional: order-independent content hash of every table (two 60-bit sums of per-row md5)
\if :full
SELECT format('SELECT %L || '' rows='' || count(*) || '' h1='' || coalesce(sum((''x'' || substr(md5(t::text), 1, 15))::bit(60)::bigint::numeric), 0) || '' h2='' || coalesce(sum((''x'' || substr(md5(t::text), 16, 15))::bit(60)::bigint::numeric), 0) FROM %I.%I t',
              'content ' || schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname IN ('public', 'drizzle') ORDER BY schemaname, tablename
\gexec
\endif
COMMIT;
SQL
  }
}

# Refuses roles that RLS would filter (the app role): they would back up empty tables.
assert_backup_role() {
  local ok
  ok=$("${PSQL[@]}" -c "SELECT r.rolsuper OR r.rolbypassrls OR NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity
        AND (c.relforcerowsecurity OR NOT pg_has_role(current_user, c.relowner, 'USAGE')))
    FROM pg_roles r WHERE r.rolname = current_user") || die "cannot connect to database '$PGDATABASE'"
  [[ "$ok" == "t" ]] || die "role '$(id_role)' is subject to RLS on some tables (is this the app role?). Back up as the owner role (autohub_owner) or a superuser."
}
id_role() { "${PSQL[@]}" -c 'SELECT current_user' 2>/dev/null || echo "${PGUSER:-?}"; }

cmd="${1:-backup}"
case "$cmd" in
  fingerprint)
    assert_backup_role
    fingerprint "" "${BACKUP_FINGERPRINT:-counts}"
    exit 0
    ;;
  backup) ;;
  -h | --help) sed -n '2,28p' "$0"; exit 0 ;;
  *) die "unknown command '$cmd' (use: backup | fingerprint)" ;;
esac

for bin in psql pg_dump pg_restore sha256sum flock; do
  command -v "$bin" >/dev/null || die "$bin not found in PATH"
done

BACKUP_DIR="${BACKUP_DIR:-./backups}"
FP_MODE="${BACKUP_FINGERPRINT:-counts}"
[[ "$FP_MODE" =~ ^(counts|full|none)$ ]] || die "BACKUP_FINGERPRINT must be counts, full or none"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

# One backup at a time per directory.
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || die "another backup is running in $BACKUP_DIR"

assert_backup_role

ts="$(date -u +%Y%m%dT%H%M%SZ)"
base="$BACKUP_DIR/${PGDATABASE}_${ts}"
dump="$base.dump"
tmp="$dump.partial"
work="$(mktemp -d)"
snap_pid=""

cleanup() {
  local rc=$?
  { exec 7>&-; } 2>/dev/null || true
  if [[ -n "$snap_pid" ]]; then kill "$snap_pid" 2>/dev/null || true; fi
  rm -rf "$work"
  rm -f "$tmp"
  if [[ $rc -ne 0 ]]; then
    rm -f "$dump" "$dump.sha256" "$base.fingerprint" "$base.manifest"
    log "FAILED (exit $rc) — no backup was kept"
  fi
}
trap cleanup EXIT

# Export a snapshot from a session kept open until pg_dump is done, so the fingerprint and the
# dump describe exactly the same committed state even while the API keeps writing.
mkfifo "$work/in"
"${PSQL[@]}" <"$work/in" >"$work/out" 2>"$work/err" &
snap_pid=$!
exec 7>"$work/in"
printf '%s\n' 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' 'SELECT pg_export_snapshot();' >&7
for _ in $(seq 1 100); do
  [[ -s "$work/out" ]] && break
  kill -0 "$snap_pid" 2>/dev/null || die "snapshot session failed: $(cat "$work/err")"
  sleep 0.1
done
snapshot="$(head -n1 "$work/out")"
[[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "could not export a snapshot: $(cat "$work/err")"
log "database=$PGDATABASE role=$(id_role) snapshot=$snapshot"

if [[ "$FP_MODE" != none ]]; then
  log "fingerprint ($FP_MODE)…"
  fingerprint "$snapshot" "$FP_MODE" >"$base.fingerprint"
  if grep -qE '^ledger .* balanced=false|unbalanced_entries=[1-9]' "$base.fingerprint"; then
    log "WARNING: the SOURCE ledger is not balanced — see $base.fingerprint (backing up anyway)"
  fi
  if grep -q '^audit_verify .* ok=false' "$base.fingerprint"; then
    log "WARNING: the SOURCE audit chain does not verify — see $base.fingerprint (backing up anyway)"
  fi
fi

log "pg_dump → $(basename "$dump")"
pg_dump -w --format=custom --snapshot="$snapshot" --lock-wait-timeout="${BACKUP_LOCK_WAIT:-120s}" --file="$tmp"

printf '%s\n' 'COMMIT;' '\q' >&7
exec 7>&-
wait "$snap_pid" 2>/dev/null || true
snap_pid=""

# Read the whole archive back (decompresses every data block) before trusting it.
pg_restore --file=/dev/null "$tmp" || die "archive read-back failed"
mv "$tmp" "$dump"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$dump")" >"$(basename "$dump").sha256")

{
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "database=$PGDATABASE"
  echo "host=${PGHOST:-local socket}:${PGPORT:-5432}"
  echo "role=$(id_role)"
  echo "server_version=$("${PSQL[@]}" -c 'SHOW server_version')"
  echo "pg_dump_version=$(pg_dump --version)"
  echo "snapshot=$snapshot"
  echo "format=custom"
  echo "size_bytes=$(stat -c %s "$dump")"
  echo "sha256=$(cut -d' ' -f1 "$dump.sha256")"
  echo "fingerprint=$FP_MODE"
  echo "migrations_applied=$("${PSQL[@]}" -c 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null || echo unknown)"
  echo "tenants=$("${PSQL[@]}" -c 'SET row_security = off; SELECT count(*) FROM tenants' 2>/dev/null | tail -n1 || echo unknown)"
} >"$base.manifest"

if [[ -n "${BACKUP_RETENTION_DAYS:-}" && "${BACKUP_RETENTION_DAYS}" != 0 ]]; then
  [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS must be a whole number of days"
  while IFS= read -r old; do
    [[ "$old" == "$dump" ]] && continue
    ob="${old%.dump}"
    rm -f "$old" "$old.sha256" "$ob.fingerprint" "$ob.manifest"
    log "retention: removed $(basename "$old")"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${PGDATABASE}_*.dump" -mtime "+$BACKUP_RETENTION_DAYS")
fi

log "OK $(basename "$dump") ($(stat -c %s "$dump") bytes, sha256 $(cut -c1-16 "$dump.sha256")…)"
echo "$dump"
