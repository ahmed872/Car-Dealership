# AutoHub Pro — Deployment

Status: Phase 8 (commercial hardening), written 2026-10-18. Nothing has been deployed to a real host
(EXT-08). Section 10 lists exactly what was and was not verified, and how. Day-2 procedures (upgrades,
backups, restore, incidents) are in `docs/OPERATIONS.md`.

## 1. What gets deployed

```
 browser ──HTTPS──▶ your TLS proxy (Caddy / nginx / load balancer)      ← you provide this
                         │ HTTP, 127.0.0.1:8080
                         ▼
                   web  (nginx 1.28, image autohub-web)                  network: frontend
                     • serves the built SPA (apps/web/dist), SPA fallback to index.html
                     • security headers (CSP with a hash for the one inline script, HSTS, …)
                     • /api/ ──▶ api:3000 (same origin: cookies + CSRF work as in development)
                         ▼
                   api  (Node 22, image autohub-api, user `node`, read-only root FS)
                     • node dist/main.js, port 3000, /api/v1/health/live|ready   networks: frontend + backend
                     • in-process jobs, PDF rendering with Chromium, files on volume `storage` (or S3)
                         ▼ role autohub_app (not superuser, no BYPASSRLS, owns nothing → RLS applies)
                   postgres (16.15, volume `pgdata`, page checksums on)         network: backend (internal)
                   migrate  (one-shot: node dist/db/migrate.js as autohub_owner, then exits)
```

Files: `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/web/nginx.conf`, `.dockerignore`,
`docker-compose.yml`, `infra/db/bootstrap-roles.sql` (role/database bootstrap, unchanged).

## 2. Prerequisites

* A Linux host with Docker Engine and Docker Compose v2.23.1 or later (the compose file uses an inline
  `configs.content` for the database bootstrap). Verified only with Docker 29.8.2 / Compose v5.6.0.
* A DNS name and a TLS certificate, terminated by a reverse proxy in front of the `web` container (§6).
* Build-time network access: the npm registry (pnpm via corepack and packages), Docker Hub (or a
  mirror serving the same digests), and — for PDF support — the Playwright CDN plus the Debian package
  mirrors (§4).
* Off-host storage for backups (§ "Backups" in OPERATIONS.md) and a secrets store for `.env` values,
  above all `APP_ENCRYPTION_KEY`.
* Sizing: not measured. No load test has been run, so the CPU and memory numbers needed are unknown.
  Start with a small VM and watch memory (Chromium renders PDFs inside the API container) and
  PostgreSQL connections.

## 3. Configuration (`.env`)

Compose reads a `.env` file next to `docker-compose.yml` for variable interpolation. It is git-ignored
(`.gitignore` has `.env`, `.env.*`). Create it with `umask 077` and fill in real values. Never commit it.
Required values are written `${VAR:?message}` in the compose file, so `docker compose config` stops
with that message if one is missing (verified for `APP_ENCRYPTION_KEY`).

```dotenv
# ── database bootstrap & connections (URL-safe values: they are embedded in postgres:// URLs)
POSTGRES_PASSWORD=<openssl rand -hex 32>            # superuser; bootstrap + maintenance only
AUTOHUB_DB_NAME=autohub
AUTOHUB_OWNER_DB_PASSWORD=<openssl rand -hex 32>    # autohub_owner: migrations, backups, restore
AUTOHUB_APP_DB_PASSWORD=<openssl rand -hex 32>      # autohub_app: the API
# ── application
APP_ENCRYPTION_KEY=<openssl rand -base64 32>        # 32 bytes, base64. Back it up OUTSIDE the DB backups.
APP_ORIGINS=https://dealer.example.com              # exact browser origin(s), comma-separated
PUBLIC_WEB_URL=https://dealer.example.com           # used in showroom share links
# COOKIE_SECURE=true                                # default; cannot be false with NODE_ENV=production
# ── publishing / proxy
# AUTOHUB_HTTP_BIND=127.0.0.1                       # keep plain HTTP on loopback; TLS proxy in front
# AUTOHUB_HTTP_PORT=8080
# AUTOHUB_REAL_IP_FROM=172.16.0.0/12                # see §6
# ── images (defaults are pinned by version and digest)
# AUTOHUB_API_IMAGE=registry.example.com/autohub-api:<git-sha>
# AUTOHUB_WEB_IMAGE=registry.example.com/autohub-web:<git-sha>
```

The role passwords are applied only when the `pgdata` volume is initialised for the first time. To
change one later: `ALTER ROLE autohub_app PASSWORD '…'` as the superuser, update `.env`, then
`docker compose up -d` (recreates the containers that use it).

### 3.1 Environment reference

API variables (validated at start-up by `apps/api/src/config/env.ts`; an invalid value stops the API
with a list of problems). "Compose" is the value or default `docker-compose.yml` passes.

| Variable | Default (app) | Compose | Notes |
|---|---|---|---|
| `NODE_ENV` | development | `production` | Production disables Swagger (`/api/docs`), forces secure cookies, refuses `OUTBOUND_ALLOW_PRIVATE_HOSTS`. |
| `PORT` | 3000 | 3000 | |
| `DATABASE_URL` | — (required) | `postgres://autohub_app:…@postgres:5432/$AUTOHUB_DB_NAME` | Must be the **app role**. The API refuses to start if the role is superuser, BYPASSRLS or owns a table. |
| `DATABASE_MIGRATION_URL` | — | only on `migrate` | Owner role. Used only by `dist/db/migrate.js`; deliberately **not** given to the API container. |
| `DATABASE_POOL_MAX` | 20 | `${DATABASE_POOL_MAX:-20}` | Connections per API process. Keep the total below PostgreSQL `max_connections` (100 by default). |
| `APP_ORIGINS` | http://localhost:5173 | required | CORS + CSRF Origin allow-list. Must equal the browser origin exactly (scheme, host, port). A login from another origin answers 403 (verified). |
| `PUBLIC_WEB_URL` | http://localhost:5173 | required | Base of public showroom links. |
| `COOKIE_SECURE` | true in production | `${COOKIE_SECURE:-true}` | Secure cookies use the `__Host-` prefix, which needs HTTPS (browsers allow `http://localhost`). |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | 720 / 168 | (override) | |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCKOUT_MINUTES` | 5 / 15 | (override) | |
| `APP_ENCRYPTION_KEY` | — (required) | required | 32 bytes, base64. Encrypts company integration secrets and customer and supplier national IDs (AES-256-GCM) and keys the HMAC used for national-ID lookups. No rotation tool exists — read OPERATIONS.md "Key rotation" first. |
| `STORAGE_DRIVER` | local | `${STORAGE_DRIVER:-local}` | `local` → volume `storage` at `/data/storage`; `s3` → §7. |
| `STORAGE_LOCAL_DIR` | ./storage | `/data/storage` | Set by the image. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | (override) | `S3_BUCKET` is required when `STORAGE_DRIVER=s3`. `S3_ENDPOINT` only for R2/MinIO (must be a URL; do not pass an empty value). |
| `MAX_UPLOAD_MB` | 25 | `${MAX_UPLOAD_MB:-25}` | Keep `AUTOHUB_MAX_BODY_SIZE` (nginx) above it. |
| `CHROMIUM_PATH` | — | set by the image | `/usr/local/bin/autohub-chromium` in the default image; unset in a `CHROMIUM=none` image (PDFs → 503 `pdf_unavailable`). |
| `LOG_LEVEL` | info | `${LOG_LEVEL:-info}` | JSON logs (pino) on stdout, with secrets and national IDs redacted. |
| `JOBS_ENABLED` | true | `${JOBS_ENABLED:-true}` | In-process jobs (reservation expiry, reminders, wish matching), advisory-locked per company. |
| `TRUST_PROXY` | false | `true` (fixed) | The API trusts exactly one hop. In this topology that hop is the `web` nginx, which sets `X-Forwarded-For` itself. |
| `RATE_LIMIT_PER_MIN` / `AUTH_RATE_LIMIT_PER_MIN` | 600 / 10 | same | Per client address, in-process (KI-019). |
| `ALLOW_TENANT_SELF_SIGNUP` | false | `${…:-false}` | |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `AI_PLATFORM_DAILY_LIMIT` | — / claude-opus-5-5 / 50 | (override) | Optional platform AI key. Do **not** pass an empty `ANTHROPIC_API_KEY` (an empty string counts as set). |
| `SHOWROOM_DAILY_INQUIRY_LIMIT` | 200 | (override) | |
| `OUTBOUND_ALLOW_PRIVATE_HOSTS` | false | not set | Development/test only; refused in production. |
| `AUTOHUB_ADMIN_PASSWORD` | — | CLI only | Password for `cli.js create-platform-admin` (§5). |

"(override)" means: not in `docker-compose.yml`, because an empty value would be invalid or would count
as set. Add these in a `docker-compose.override.yml` next to it (Compose merges it automatically):

```yaml
services:
  api:
    environment:
      STORAGE_DRIVER: s3
      S3_BUCKET: autohub-prod-files
      S3_REGION: me-central-1
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?}
```

Compose / container variables:

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `POSTGRES_PASSWORD` | required | postgres | Superuser. |
| `AUTOHUB_DB_NAME` | autohub | postgres, migrate, api | |
| `AUTOHUB_OWNER_DB_PASSWORD` / `AUTOHUB_APP_DB_PASSWORD` | required | bootstrap, migrate, api | Applied at first initialisation only. |
| `AUTOHUB_HTTP_BIND` / `AUTOHUB_HTTP_PORT` | 127.0.0.1 / 8080 | web | Published address. |
| `AUTOHUB_REAL_IP_FROM` | 127.0.0.1/32 (trust nobody) | web | Address/CIDR of the proxy in front whose `X-Forwarded-For` nginx trusts (§6). |
| `AUTOHUB_MAX_BODY_SIZE` | 30m | web | nginx `client_max_body_size`. |
| `AUTOHUB_API_UPSTREAM` / `AUTOHUB_RESOLVER` | http://api:3000 / 127.0.0.11 | web image | Set in the image; nginx resolves the API name at request time. |
| `AUTOHUB_API_IMAGE` / `AUTOHUB_WEB_IMAGE` | autohub-api:local / autohub-web:local | all | Use immutable tags (git SHA) in production. |
| `AUTOHUB_CHROMIUM` | playwright | api build | `none` builds without a browser. |
| `NODE_IMAGE` / `NGINX_IMAGE` / `POSTGRES_IMAGE` | pinned tag@digest | build / postgres | Override only with a mirror of the **same digest**. |

## 4. Building the images

Both Dockerfiles build from the repository root. Base images are pinned by version and digest:
`node:22.23.3-bookworm-slim@sha256:c3de60bf…`, `nginx:1.28.0-bookworm@sha256:552e7481…`,
`postgres:16.15-bookworm@sha256:0ea6700a…`. pnpm comes from corepack at the version in
`package.json` (`packageManager: pnpm@10.28.0`), and every install runs `pnpm install --frozen-lockfile`.

```bash
docker build -f apps/api/Dockerfile -t registry.example.com/autohub-api:$(git rev-parse --short HEAD) .
docker build -f apps/web/Dockerfile -t registry.example.com/autohub-web:$(git rev-parse --short HEAD) .
# or: docker compose build
```

* **API** (`apps/api/Dockerfile`): `build` stage (install with dev tools, `tsc` build of shared and then
  api; the api build copies `src/db/migrations` into `dist`) → `prod-deps` stage (a fresh
  `--frozen-lockfile --prod` install plus the built `dist` folders; pnpm 10's legacy `pnpm deploy`
  re-resolves versions instead of using the lockfile, so it is not used) → runtime as user `node`.
  The application files are owned by root and read-only to that user.
* **Chromium** (`--build-arg CHROMIUM=playwright`, the default) installs the Chromium revision that
  `playwright-core` 1.56.1 pins (the same browser CI renders PDFs with) plus its Debian libraries, and
  sets `CHROMIUM_PATH`. The Arabic fonts are embedded by the app itself (`@fontsource`), so no system
  fonts are needed. `CHROMIUM=none` builds without a browser: every PDF endpoint then answers
  `503 pdf_unavailable` and everything else works.
* **Web** (`apps/web/Dockerfile`): `pnpm --filter @autohub/web build` (type-check, then `vite build`).
  Source maps are deleted unless you pass `--build-arg KEEP_SOURCEMAPS=true`. The sha256 of the inline
  theme script in `index.html` is computed and written into the CSP. The bundle contains no API URL:
  the SPA calls relative `/api/v1/...`, and nginx proxies `/api/` to the API.
* Behind a TLS-intercepting proxy, pass its CA as a build secret (never stored in a layer):
  `docker build --secret id=build_ca,src=/path/proxy-ca.pem …`.

## 5. First run

```bash
umask 077 && $EDITOR .env                     # §3
docker compose config --quiet                 # validates; fails on missing secrets
docker compose build                          # or set AUTOHUB_*_IMAGE to pushed images
docker compose up -d                          # postgres → migrate → api → web
docker compose ps                             # migrate "Exited (0)", the others "(healthy)"
docker compose logs migrate                   # "Migrations applied"

# Platform administrator (password from the environment, not the command line):
read -rs AUTOHUB_ADMIN_PASSWORD && export AUTOHUB_ADMIN_PASSWORD
docker compose run --rm --no-deps -e AUTOHUB_ADMIN_PASSWORD api \
  node dist/cli.js create-platform-admin --email admin@example.com --name "Platform Admin"
unset AUTOHUB_ADMIN_PASSWORD

# First company: either sign in as the platform admin at https://<host>/platform, or use the CLI
# (zProvisionTenant: market EG|SA|AE, slug [a-z0-9-], password ≥ 10 chars with a letter and a digit):
docker compose run --rm --no-deps api node dist/cli.js provision-tenant \
  '{"name":"Example Motors","slug":"example-motors","market":"SA","branchName":"Riyadh HQ","planCode":"professional","owner":{"email":"owner@example.com","fullName":"Owner Name","password":"<strong password>"}}'
```

The `provision-tenant` JSON contains the owner's initial password, and it ends up in your shell
history. Prefer the `/platform` page, or clear the history entry and make the owner change the
password at first sign-in. `create-platform-admin` also promotes an existing user.

Then take the first backup and run a restore drill (OPERATIONS.md) before real data goes in.

## 6. TLS, reverse proxy and client addresses

The `web` container speaks plain HTTP on `127.0.0.1:8080`. Put a TLS-terminating proxy in front of it,
for example Caddy on the host (an **unverified example**):

```
dealer.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

* `APP_ORIGINS` and `PUBLIC_WEB_URL` must be the `https://` origin users type. Session cookies are
  `Secure` with the `__Host-` prefix, so the site only works over HTTPS (plus `http://localhost`).
* Client addresses (rate limits, audit-log IP, lockouts): the API runs with `TRUST_PROXY=true` and
  trusts exactly one hop, the nginx in `web`. nginx **sets** `X-Forwarded-For` to `$remote_addr` (it
  does not append), so a client cannot spoof its address. Verified: a request with
  `X-Forwarded-For: 6.6.6.6` was logged with the real peer address.
* Behind your proxy, `$remote_addr` would otherwise be the proxy, and every visitor would share one
  address. Set `AUTOHUB_REAL_IP_FROM` to the address range the proxy's connections arrive from, so
  nginx takes the client from the proxy's `X-Forwarded-For`. In the test, connections to the published
  port arrived from the Docker network gateway (`172.19.0.1`), and with
  `AUTOHUB_REAL_IP_FROM=172.16.0.0/12` a forwarded client address (`203.0.113.7`) became nginx's
  `remote_addr`. Use the narrowest range that matches your setup, and check `remote_addr` in the
  `web` logs after go-live. Keep `AUTOHUB_HTTP_BIND=127.0.0.1`, so only the local proxy can reach that port.
* HSTS: nginx sends `Strict-Transport-Security: max-age=31536000` on SPA responses (browsers ignore it
  over plain HTTP); the API's helmet sends its own on API responses. Add `includeSubDomains` or preload
  at the proxy only when every subdomain is HTTPS.
* `frame-ancestors 'none'` / `X-Frame-Options: DENY`: the app cannot be embedded in an iframe,
  including the public showroom. Relax the CSP in `apps/web/nginx.conf` deliberately if a dealer needs that.

## 7. File storage

* **local** (default): named volume `storage` mounted at `/data/storage` (owner `node`). Files are
  stored under `tenants/<tenantId>/<yyyy>/<mm>/<uuid>.<ext>`. **Database backups do not include
  these files.** Back the volume up separately (OPERATIONS.md); verified: an upload through nginx was
  written there and downloaded back byte-identical.
* **s3**: `STORAGE_DRIVER=s3` plus the S3 variables (override file, §3.1). Works with AWS S3, R2 or
  MinIO (`S3_ENDPOINT` switches to path-style). Objects are written with `ServerSideEncryption: AES256`.
  Without access keys, the AWS SDK default credential chain is used. **Not exercised anywhere yet**
  (EXT-07): test upload, download and delete against the real bucket before go-live, and enable
  versioning or a backup on the bucket.
* Upload limit: the API's `MAX_UPLOAD_MB` (default 25) applies, and nginx's `AUTOHUB_MAX_BODY_SIZE`
  (default 30m) must stay above it.

## 8. Without Compose (managed PostgreSQL, Kubernetes, …)

The same pieces apply:

1. Run `infra/db/bootstrap-roles.sql` once as an administrator. It creates `autohub_owner`, an
   `autohub_app` that is **not** superuser or BYPASSRLS and owns nothing, and the database owned by
   `autohub_owner`. On managed services, check that the owner role can create the trusted extensions
   `pg_trgm` and `btree_gist` (migrations 0003 and 0008).
2. Run `node dist/db/migrate.js` from the API image as a one-shot job with only
   `DATABASE_MIGRATION_URL` (owner role).
   After an upgrade, run the release's data steps (OPERATIONS.md §1, step 7) once the new API is up, as
   one-shot jobs from the API image with the API's environment, e.g. for migration 0018:
   `node dist/cli.js encrypt-supplier-ids`.
3. Run the API image with `DATABASE_URL` set to the app role, behind a proxy that sets
   `X-Forwarded-For` and is the only hop the API trusts (`TRUST_PROXY=true`).
4. Serve the web image, or `apps/web/dist` with an equivalent of `apps/web/nginx.conf`, on the same
   origin as `/api/`.
5. With several API replicas: rate limits are per process (KI-019), and the local storage driver
   needs a shared volume (use S3). Jobs are advisory-locked per company, so all replicas can run them.

## 9. Security notes for operators

* The API container drops all capabilities, sets `no-new-privileges`, and runs with a read-only root
  filesystem plus a tmpfs `/tmp`. Verified: writing to `/app` fails and `/tmp` is writable.
  PostgreSQL is only on the internal `backend` network, which has no outbound route.
* Secrets reach the containers as environment variables (visible to anyone allowed to run
  `docker inspect` on the host). Restrict Docker access, or move to Docker secrets / a secrets manager.
* Logs: API logs are pino JSON. nginx logs JSON with `request_id`, which it also sends to the API as
  `X-Request-Id`. The API uses it as its request id and stores it in audit-log metadata (verified), so
  one id ties together the proxy log, the API log and the audit entry. Both logs contain client IP
  addresses (personal data): keep the json-file rotation (20 MB × 5 per container) or ship the logs
  to a store with a retention policy.

## 10. What was verified, and what was not (2026-10-18)

Environment: a development container (Ubuntu 24.04, Docker 29.8.2, Compose v5.6.0, buildx 0.37.1).
Docker Hub answered `429 Too Many Requests`, so the pinned base images were pulled from the
`mirror.gcr.io` mirror with the **same digests** (`--build-arg NODE_IMAGE=mirror.gcr.io/library/node:…@sha256:…`).

Verified by running it:

* `docker build` of `autohub-api` with `CHROMIUM=none` (568 MB) and of `autohub-web` (283 MB) both
  succeeded. The API image runs as `uid=1000(node)`, `/app` is not writable, and `dist/db/migrations`
  holds the 15 migrations.
* `docker compose config` validates, and fails as intended when `APP_ENCRYPTION_KEY` is missing.
* `docker compose up -d` (about 22 s): postgres healthy → `migrate` "Migrations applied", exit 0 →
  api healthy → web healthy. Roles `autohub_owner` and `autohub_app` were not superuser, BYPASSRLS or
  CREATEDB; 15 rows in `drizzle.__drizzle_migrations`; `data_checksums = on`; the API's start-up role
  check passed.
* Through nginx: `/healthz`, `/api/v1/health/live`, `/api/v1/health/ready` → 200; `/`,
  `/app/vehicles`, `/showroom/x` → 200 HTML (SPA fallback); a missing `/assets/*.js` and `/.env` → 404;
  assets `Cache-Control: public, max-age=31536000, immutable` and gzip; `index.html` `no-cache`; no `.map`
  files served. The SPA headers (CSP with the inline-script hash, nosniff, DENY, HSTS, COOP/CORP,
  Permissions-Policy) are set, and API responses carry only the API's own helmet headers.
* Real Chromium (Playwright build 1194, run on the host) loaded `/login` through nginx, rendered it
  RTL, signed in with the real form and reached `/app` (dashboard rendered). No CSP violations; the
  only console error was the expected 401 from `/api/v1/auth/me` before sign-in.
* First run: `cli.js create-platform-admin` and `cli.js provision-tenant` succeeded. Login through
  nginx returned 200 with `__Host-ah_sid` / `__Host-ah_csrf` Secure cookies, and a login with a
  foreign `Origin` was refused (403). `POST /api/v1/audit-logs/verify` → `{"ok":true}`.
  `X-Forwarded-For` spoofing was ignored, `AUTOHUB_REAL_IP_FROM` behaved as described in §6, and the
  audit-log `requestId` equals nginx's `request_id`.
* Upload: a vehicle photo was uploaded through nginx, stored in the `storage` volume, and downloaded
  byte-identical.
* Resilience: after the API container was recreated with a new IP, nginx answered 502 while it was
  down and 200 afterwards **without restarting nginx**. After a PostgreSQL restart `/ready` answered
  503, then 200 within about 2 s. `down` + `up` with volumes kept: database initialisation skipped,
  migrate no-op, data kept. After a Docker daemon restart the containers came back by their restart
  policy.
* `scripts/backup.sh` and `scripts/restore.sh` ran inside the Compose topology (one-off container on
  the internal network; see OPERATIONS.md), and the restore passed every check. A `tar` of the
  `storage` volume worked.
* The API image (CHROMIUM=none) against a restored backup: details in OPERATIONS.md, "Restore drill log".

**Not verified:**

* **The default API image (`CHROMIUM=playwright`) has never been built.** In this environment
  `deb.debian.org` and the Playwright CDN are blocked: the build fails at `apt-get` ("Could not resolve
  'deb.debian.org'") before Chromium is downloaded. So in-container PDF rendering (Chromium launch
  under the read-only root FS, with `init: true`, as uid 1000), the image size with Chromium, and the
  apt dependency list are untested. Build it once with normal network access, then request a sale
  document PDF (`GET /api/v1/sale-documents/<id>/pdf`) and a report export before go-live.
  Without Chromium, the PDF endpoint answers `503 pdf_unavailable` (verified).
* Builds straight from Docker Hub (only the digest-identical mirror was used), a real domain and TLS,
  the Caddy example, S3 storage, outbound integrations from the container (webhooks, AI, VIN
  decoding), multi-replica setups, and performance or sizing.
* Long-running behaviour: log rotation, disk growth, jobs over days.
