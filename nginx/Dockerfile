# ============================================================
# nginx — combined static server for Landing + CRM
#
# Architecture decision: single nginx image serves both SPAs.
# Rationale:
#   - One container vs two (cheaper, simpler ops).
#   - Shared upstream block / security headers / gzip config.
#   - Both SPA dists are build-time artifacts (no runtime deps) —
#     copying both into one image adds negligible size overhead.
#
# Build: this image must be built AFTER apps/web and apps/landing
# builders complete, so Docker Compose uses --build (builds all
# services) or BuildKit can reference the builder stages.
#
# In docker-compose.prod.yml this is handled by building a single
# combined image using multi-stage from both SPA Dockerfiles.
# ============================================================

# ── Landing builder ───────────────────────────────────────────────────────
# Base image: mcr.microsoft.com/playwright:v1.59.1-noble (Debian/glibc), NOT
# node:20-alpine. task-infra-seo-gates: the SEO prerender step below drives
# headless Chromium (via Playwright) to snapshot each landing route into
# static HTML for crawlers. Chromium needs glibc + a long list of system libs
# that Alpine (musl) does not ship, and the official Playwright image bundles
# a browser build matching this exact Playwright version pre-installed — no
# extra `playwright install --with-deps` download at build time. Verified to
# exist: `curl -s https://mcr.microsoft.com/v2/playwright/tags/list`.
# Pinned to v1.59.1 to match the Playwright version already resolved in
# pnpm-lock.yaml (@playwright/test, apps/e2e) — bump both together, see
# .claude/rules/common/version-pins.md. If task-landing-seo-prerender lands
# with a DIFFERENT pinned Playwright version for apps/landing, bump this tag
# to match in the same PR (mismatched browser/library versions can crash).
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS landing-builder

RUN corepack enable && corepack prepare pnpm@7.32.4 --activate

WORKDIR /app

ARG VITE_BUILD_VERSION=
ENV VITE_BUILD_VERSION=$VITE_BUILD_VERSION

# task-vacancies-api (PR #390, follow-up landing form): Cloudflare Turnstile
# site key baked into the landing bundle at build time. Empty is a valid,
# safe default — the form/widget do not exist in the bundle until #390
# merges, so an unset key simply means "no Turnstile widget yet".
ARG VITE_TURNSTILE_SITE_KEY=
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/landing/package.json ./apps/landing/

RUN pnpm install --frozen-lockfile

COPY packages/shared/ ./packages/shared/
COPY apps/landing/ ./apps/landing/
COPY tsconfig.base.json ./

RUN pnpm --filter @crm/shared build
RUN pnpm --filter @crm/landing build

# ── SEO prerender (forward-compatible guard) ───────────────────────────────
# task-landing-seo-prerender (Coder, parallel branch feature/landing-seo-prerender)
# adds a `build:prerender` script to apps/landing/package.json that re-crawls
# the dist above with Playwright and writes static per-route HTML for
# crawlers (SEO). That branch may merge before or after this infra PR — the
# grep guard below makes this step a safe no-op (plain CSR dist from the
# `vite build` above, unchanged) until the script exists, so this Dockerfile
# never breaks regardless of merge order.
#
# PRERENDER_API_ORIGIN points at the LIVE production API. During a deploy the
# OLD containers keep serving traffic until the `docker compose up -d`
# switchover in deploy.yml's deploy job, so hitting the real prod API here for
# route data (e.g. published vacancy slugs) is safe.
ARG PRERENDER_API_ORIGIN=https://cheekycheese.tech
ENV PRERENDER_API_ORIGIN=$PRERENDER_API_ORIGIN

RUN if grep -q '"build:prerender"' apps/landing/package.json; then \
      echo "==> build:prerender script found — running SEO prerender build"; \
      pnpm --filter @crm/landing build:prerender; \
    else \
      echo "::warning::apps/landing/package.json has no build:prerender script yet (task-landing-seo-prerender not merged) — landing dist is CSR-only, no prerendered HTML in this image."; \
    fi

# ── CRM builder ───────────────────────────────────────────────────────────
FROM node:20-alpine AS crm-builder

RUN corepack enable && corepack prepare pnpm@7.32.4 --activate

WORKDIR /app

ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

ARG VITE_BUILD_VERSION=
ENV VITE_BUILD_VERSION=$VITE_BUILD_VERSION

# task-telemetry-web (PR #415) / task-infra-telemetry-web-buildarg (devops
# follow-up): strict opt-IN switch for the CRM telemetry SDK — see
# apps/web/app/lib/telemetry/config.ts `isTelemetryEnabled()`:
#   `import.meta.env['VITE_TELEMETRY'] === 'on'`
# Default-DENY, not default-allow — UNSET (this Dockerfile's own default
# below), empty, or any value other than the exact string `on` (e.g. "true",
# "ON") leaves the SDK a no-op. That is by design: dev (`pnpm dev`) and the
# E2E stack never set this build-arg and must never silently start shipping
# telemetry. deploy.yml passes `VITE_TELEMETRY=on` explicitly for the prod
# nginx image build — that is the ONLY place this should ever be "on". Safe
# either merge order relative to #415: if this image is built while #415
# hasn't merged yet, the telemetry/ module doesn't exist in the bundle and
# this arg is simply unused; once #415 merges, the very next deploy turns
# the SDK on because the arg is already wired here.
ARG VITE_TELEMETRY=
ENV VITE_TELEMETRY=$VITE_TELEMETRY

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/shared/ ./packages/shared/
COPY apps/web/ ./apps/web/
COPY tsconfig.base.json ./

RUN pnpm --filter @crm/shared build
RUN pnpm --filter @crm/web build

# ── Final nginx image ─────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Remove default nginx site.
RUN rm /etc/nginx/conf.d/default.conf

# Copy our nginx configuration.
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/conf.d/    /etc/nginx/conf.d/

# Copy Landing SPA static files.
COPY --from=landing-builder /app/apps/landing/dist /usr/share/nginx/html/landing

# Copy CRM SPA static files.
COPY --from=crm-builder /app/apps/web/dist /usr/share/nginx/html/crm

# Ports: 80 (HTTP), 443 (HTTPS — certs must be mounted at runtime).
EXPOSE 80 443

# Healthcheck via nginx stub_status (or just the default 200 on /).
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
