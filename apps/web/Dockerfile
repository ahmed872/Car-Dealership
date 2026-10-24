# syntax=docker/dockerfile:1.7
# AutoHub Pro web image: the Vite build of apps/web served by nginx (SPA fallback, security headers,
# /api/ proxied to the API service — see apps/web/nginx.conf). Build from the REPOSITORY ROOT:
#
#   docker build -f apps/web/Dockerfile -t autohub-web:<version> .
#
# The SPA calls the API with relative /api/v1 URLs, so no API URL is baked into the bundle; nginx
# forwards /api/ to AUTOHUB_API_UPSTREAM (default http://api:3000) on the same origin.
#
# Build args:
#   NODE_IMAGE, NGINX_IMAGE  pinned by version AND digest (override only with a mirror of the same digest)
#   KEEP_SOURCEMAPS          false (default) removes *.map files so the source is not published
# Optional build secret for TLS-intercepting corporate proxies: --secret id=build_ca,src=/path/ca.pem
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG NGINX_IMAGE=nginx:1.28.0-bookworm@sha256:552e7481ca93ffccd046aa658dbbed22caefbc09c66fa7cd247cbb90b8a5c609

FROM ${NODE_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm PATH=/pnpm:$PATH npm_config_store_dir=/pnpm/store
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN --mount=type=secret,id=build_ca,required=false \
    --mount=type=cache,id=autohub-pnpm-store,target=/pnpm/store \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && corepack enable && corepack install \
 && pnpm install --frozen-lockfile --filter "@autohub/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG KEEP_SOURCEMAPS=false
# `build` type-checks (tsc --noEmit) and then runs vite build → apps/web/dist.
RUN pnpm --filter @autohub/web build \
 && test -f apps/web/dist/index.html \
 && if [ "$KEEP_SOURCEMAPS" != "true" ]; then find apps/web/dist -name '*.map' -delete; fi
# CSP: allow exactly the inline script(s) of index.html by sha256 hash, then fill the nginx template.
RUN node -e ' \
      const html = require("fs").readFileSync("apps/web/dist/index.html", "utf8"); \
      const q = String.fromCharCode(39), re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; \
      let m, out = []; \
      while ((m = re.exec(html))) out.push(q + "sha256-" + require("crypto").createHash("sha256").update(m[1], "utf8").digest("base64") + q); \
      process.stdout.write(out.join(" "));' > /tmp/csp-hashes \
 && sed "s|__CSP_SCRIPT_HASHES__|$(cat /tmp/csp-hashes)|" apps/web/nginx.conf > /tmp/default.conf.template \
 && ! grep -q '__CSP_SCRIPT_HASHES__' /tmp/default.conf.template \
 && echo "CSP script hashes: $(cat /tmp/csp-hashes)"

FROM ${NGINX_IMAGE} AS runtime
# The image entrypoint renders /etc/nginx/templates/*.template into /etc/nginx/conf.d at start-up,
# substituting only AUTOHUB_* variables (nginx's own $variables are left alone).
ENV NGINX_ENVSUBST_FILTER=^AUTOHUB_ \
    AUTOHUB_API_UPSTREAM=http://api:3000 \
    AUTOHUB_RESOLVER=127.0.0.11 \
    AUTOHUB_MAX_BODY_SIZE=30m \
    AUTOHUB_REAL_IP_FROM=127.0.0.1/32
RUN rm -f /etc/nginx/conf.d/default.conf
COPY --from=build /tmp/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8080/healthz"]
