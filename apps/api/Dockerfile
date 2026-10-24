# syntax=docker/dockerfile:1.7
# AutoHub Pro API image. Build from the REPOSITORY ROOT (the workspace and lockfile live there):
#
#   docker build -f apps/api/Dockerfile -t autohub-api:<version> .
#
# Run:      node dist/main.js            (default CMD; port 3000; health: /api/v1/health/live|ready)
# Migrate:  node dist/db/migrate.js      (one-shot; needs ONLY DATABASE_MIGRATION_URL = owner role)
# CLI:      node dist/cli.js create-platform-admin | provision-tenant   (see docs/DEPLOYMENT.md)
#
# Build args:
#   NODE_IMAGE  base image, pinned by version AND digest (override only to use a registry mirror of
#               the SAME digest, e.g. mirror.gcr.io/library/node:22.23.3-bookworm-slim@sha256:…)
#   CHROMIUM    playwright (default): the Chromium revision that playwright-core 1.56.1 pins — the one
#               CI renders PDFs with — plus its Debian runtime libraries; needs network access to the
#               Playwright CDN and the Debian mirrors at build time.
#               none: no browser; PDF endpoints then answer 503 pdf_unavailable (everything else works).
# Optional build secret for TLS-intercepting corporate proxies (never stored in a layer):
#   --secret id=build_ca,src=/path/to/proxy-ca.pem
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG CHROMIUM=playwright

# ── build: install with the lockfile (incl. dev tools), compile shared → api ───────────────────────
FROM ${NODE_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm PATH=/pnpm:$PATH npm_config_store_dir=/pnpm/store
WORKDIR /repo
# Manifests first so the dependency layer is cached until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
# corepack installs exactly the pnpm version from "packageManager" in package.json.
RUN --mount=type=secret,id=build_ca,required=false \
    --mount=type=cache,id=autohub-pnpm-store,target=/pnpm/store \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && corepack enable && corepack install \
 && pnpm install --frozen-lockfile --filter "@autohub/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
# tsc build; the api build script also copies src/db/migrations → dist/db/migrations.
RUN pnpm --filter @autohub/shared build \
 && pnpm --filter @autohub/api build \
 && test -f apps/api/dist/main.js && test -f apps/api/dist/db/migrate.js && test -f apps/api/dist/db/migrations/meta/_journal.json

# ── prod-deps: production-only node_modules, installed from the SAME lockfile, plus the built code ──
# (pnpm 10's legacy `pnpm deploy` re-resolves versions instead of using the lockfile, so it is not used.)
FROM ${NODE_IMAGE} AS prod-deps
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm PATH=/pnpm:$PATH npm_config_store_dir=/pnpm/store
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN --mount=type=secret,id=build_ca,required=false \
    --mount=type=cache,id=autohub-pnpm-store,target=/pnpm/store \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && corepack enable && corepack install \
 && pnpm install --frozen-lockfile --prod --filter "@autohub/api..."
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
RUN test -f apps/api/dist/main.js && test -f apps/api/node_modules/@autohub/shared/dist/index.js \
 && test ! -e apps/api/node_modules/typescript && test ! -e apps/api/node_modules/vitest

# ── runtime ─────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_LOCAL_DIR=/data/storage
# Application files are owned by root and read-only for the runtime user.
COPY --from=prod-deps /app /app
WORKDIR /app/apps/api
RUN mkdir -p /data/storage && chown node:node /data/storage

FROM runtime-base AS chromium-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && node node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
 && chrome="$(find /ms-playwright -path '*/chromium-*/chrome-linux*/chrome' -type f | head -n1)" \
 && test -x "$chrome" && ln -s "$chrome" /usr/local/bin/autohub-chromium \
 && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/local/bin/autohub-chromium

FROM runtime-base AS chromium-none
# No browser: PDF endpoints answer 503 pdf_unavailable; everything else works.
RUN echo "image built WITHOUT Chromium (CHROMIUM=none)"

FROM chromium-${CHROMIUM} AS runtime
USER node
EXPOSE 3000
# /ready also checks the database connection and that migrations ran.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
