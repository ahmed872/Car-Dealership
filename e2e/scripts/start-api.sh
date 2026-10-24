#!/usr/bin/env bash
# API for the browser tests: resets the e2e database, provisions the test company, then runs the
# API in the foreground (Playwright's webServer owns the process and stops it after the run).
#
# Playwright starts its webServers BEFORE globalSetup, so the reset lives here: by the time the
# health check answers, the database is fresh and the owner can sign in. The steps are the ones
# scripts/dev-sandbox.sh uses (reset → create-platform-admin → provision-tenant → main.ts).
#
# Required env (set by e2e/playwright.config.ts): DATABASE_URL, DATABASE_MIGRATION_URL, PORT,
# APP_ORIGINS, PUBLIC_WEB_URL, APP_ENCRYPTION_KEY, STORAGE_LOCAL_DIR, AUTOHUB_ADMIN_PASSWORD,
# E2E_ADMIN_EMAIL, E2E_TENANT_JSON.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${DATABASE_MIGRATION_URL:?}" "${E2E_ADMIN_EMAIL:?}" "${E2E_TENANT_JSON:?}" "${STORAGE_LOCAL_DIR:?}"

rm -rf "$STORAGE_LOCAL_DIR"
mkdir -p "$STORAGE_LOCAL_DIR"

cd "$ROOT/apps/api"
node -r @swc-node/register src/db/reset.ts
node -r @swc-node/register src/cli.ts create-platform-admin --email "$E2E_ADMIN_EMAIL" --name "E2E Admin"
node -r @swc-node/register src/cli.ts provision-tenant "$E2E_TENANT_JSON"
exec node -r @swc-node/register src/main.ts
