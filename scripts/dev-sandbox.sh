#!/usr/bin/env bash
# Isolated development sandbox: its own database, API and web dev server, so several people (or
# agents) can work in parallel. DEVELOPMENT ONLY — the database is dropped and recreated.
#
#   scripts/dev-sandbox.sh start <letter> <apiPort> <webPort>   e.g. start c 3103 5203
#   scripts/dev-sandbox.sh stop  <letter>
#
# Uses database autohub_test_<letter> (must exist; see infra/db/bootstrap-roles.sql) and prints the
# sign-in details. Logs: /tmp/autohub-sandbox-<letter>/{api,web}.log
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cmd="${1:-}"; x="${2:-}"
[[ "$x" =~ ^[a-z]$ ]] || { echo "usage: $0 start|stop <letter> [apiPort webPort]"; exit 1; }
DIR="/tmp/autohub-sandbox-$x"
mkdir -p "$DIR"

stop() {
  for f in "$DIR"/api.pid "$DIR"/web.pid; do
    if [[ -f "$f" ]]; then
      pkill -P "$(cat "$f")" 2>/dev/null || true
      kill "$(cat "$f")" 2>/dev/null || true
      rm -f "$f"
    fi
  done
  return 0
}

if [[ "$cmd" == "stop" ]]; then stop; echo "sandbox $x stopped"; exit 0; fi
[[ "$cmd" == "start" ]] || { echo "unknown command $cmd"; exit 1; }
API_PORT="${3:?apiPort}"; WEB_PORT="${4:?webPort}"
stop

pg_isready -q || service postgresql start >/dev/null
set -a; . "$ROOT/apps/api/.env"; set +a
export NODE_ENV=development
export PORT="$API_PORT"
export DATABASE_URL="postgres://autohub_app:autohub_app_dev@localhost:5432/autohub_test_$x"
export DATABASE_MIGRATION_URL="postgres://autohub_owner:autohub_owner_dev@localhost:5432/autohub_test_$x"
export APP_ORIGINS="http://localhost:$WEB_PORT"
export PUBLIC_WEB_URL="http://localhost:$WEB_PORT"
export STORAGE_DRIVER=local
export STORAGE_LOCAL_DIR="$DIR/storage"
export JOBS_ENABLED=false
export AUTOHUB_ADMIN_PASSWORD='SandboxPassw0rd!'

cd "$ROOT/apps/api"
node -r @swc-node/register src/db/reset.ts >"$DIR/reset.log" 2>&1
node -r @swc-node/register src/cli.ts create-platform-admin --email admin@sandbox.test --name "Sandbox Admin" >>"$DIR/reset.log" 2>&1
node -r @swc-node/register src/cli.ts provision-tenant "{\"name\":\"Demo Motors $x\",\"slug\":\"demo-$x\",\"market\":\"SA\",\"branchName\":\"Riyadh HQ\",\"planCode\":\"enterprise\",\"owner\":{\"email\":\"owner@demo.test\",\"fullName\":\"Demo Owner\",\"password\":\"SandboxPassw0rd!\"}}" >>"$DIR/reset.log" 2>&1

nohup node -r @swc-node/register src/main.ts >"$DIR/api.log" 2>&1 &
echo $! >"$DIR/api.pid"
for _ in $(seq 1 60); do curl -sf "http://localhost:$API_PORT/api/v1/health/ready" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://localhost:$API_PORT/api/v1/health/ready" >/dev/null || { echo "API failed to start; see $DIR/api.log"; exit 1; }

cd "$ROOT/apps/web"
API_URL="http://localhost:$API_PORT" nohup npx vite --port "$WEB_PORT" --strictPort >"$DIR/web.log" 2>&1 &
echo $! >"$DIR/web.pid"
for _ in $(seq 1 60); do curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 && break; sleep 1; done

cat <<INFO
sandbox $x ready
  web:   http://localhost:$WEB_PORT   (API http://localhost:$API_PORT/api/v1)
  owner: owner@demo.test / SandboxPassw0rd!   (company demo-$x, market SA)
  admin: admin@sandbox.test / SandboxPassw0rd!
  logs:  $DIR/api.log, $DIR/web.log
INFO
