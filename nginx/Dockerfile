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

# task-infra-locale-edge: njs module used ONLY for Accept-Language
# best-match parsing (see the `load_module` comment in nginx.conf). The
# module .so itself already ships in this base image — only our script
# needs copying.
COPY nginx/njs/       /etc/nginx/njs/

# Copy Landing SPA static files.
COPY --from=landing-builder /app/apps/landing/dist /usr/share/nginx/html/landing

# Copy CRM SPA static files.
COPY --from=crm-builder /app/apps/web/dist /usr/share/nginx/html/crm

# ── task-infra-locale-edge: search-engine verification / IndexNow files ───
# Four OPTIONAL build-args, each independently no-op when unset (mirrors the
# established VITE_TURNSTILE_SITE_KEY / GOOGLE_INDEXING_SA_* pattern already
# used elsewhere in this Dockerfile / deploy.yml — see
# docs/runbooks/deployment.md "Google Indexing API" for the precedent).
# Deliberately NOT hardcoded in the repo: these are low-sensitivity but
# still per-environment/rotatable values (IndexNow key regeneration, a new
# Bing/Yandex webmaster property) — a GH secret + rebuild is the same
# rotation cost as any of the other optional secrets above, without baking
# a value into version control that would need a code change to rotate.
#
# SECURITY (security-review round 1, PR #423, HIGH-2 — fixed here): the
# PREVIOUS version of this step interpolated these values directly into
# GENERATED nginx `location { return 200 "..."; }` DIRECTIVES — a value
# containing `"`, `;`, `{`, or a newline could break out of the intended
# string literal and inject arbitrary nginx config (PoC in the PR: a
# crafted YANDEX_VERIFICATION_CONTENT added a `location /pwn { alias /etc/;
# autoindex on; }` block that served the container's `/etc/passwd` over
# HTTP — verified against `nginx -t` passing AND a live container). Fixed
# with TWO independent layers:
#   1. Content values are written to plain STATIC FILES under the landing
#      dist root (below), served by the SAME SPA-fallback `location /` /
#      try_files mechanism that already serves robots.txt/sitemap.xml (see
#      the comment at the top of nginx/conf.d/landing.conf) — file BYTES
#      are never interpolated into nginx config GRAMMAR at all anymore, so
#      no value here can inject a directive regardless of its content.
#   2. Filename/key/id values (which DO become part of a file PATH, so a
#      `/` or `..` could still attempt path traversal) are validated
#      against a strict `[A-Za-z0-9._-]` allow-list BEFORE use — anything
#      else FAILS THE BUILD LOUDLY (`docker build` exits non-zero) rather
#      than silently writing somewhere unintended.
# `RUN nginx -t` near the end of this stage is a THIRD, independent layer:
# any config mistake (this class or otherwise) fails the BUILD, not a
# later deploy — see that step's comment for why this specific fix (a
# straight `nginx -t` against the real nginx.conf) needed a small
# build-time-only upstream substitution to work without a live `api`
# container to resolve.
#
# AC B6 (IndexNow key file @ /{key}.txt) + B7 (Bing/Yandex verification
# files) — see scripts/devops/locale-routing-runbook.md "Bing + Yandex
# Webmaster verification" for the owner's setup steps.
ARG INDEXNOW_KEY=
ARG BING_SITE_VERIFICATION_ID=
ARG YANDEX_VERIFICATION_FILENAME=
ARG YANDEX_VERIFICATION_CONTENT=

RUN set -eu; \
    # Allow-list guard: fails the build (not silently sanitises) on any
    # character outside [A-Za-z0-9._-] — applied to every value that
    # becomes part of a FILE PATH under the served static root. Content-only
    # values (YANDEX_VERIFICATION_CONTENT, the text Yandex tells the owner
    # to paste — commonly HTML with quotes) are deliberately NOT charset-
    # restricted: they only ever become file BYTES now (see the big comment
    # above), never config grammar, so restricting their charset would just
    # be extra friction with no security benefit. \
    check_path_safe() { \
      case "$1" in \
        '') return 0 ;; \
        *[!A-Za-z0-9._-]*) \
          echo "ERROR: $2 contains characters outside [A-Za-z0-9._-] — refusing to use it as a file name/path segment (build-arg injection guard, see nginx/Dockerfile HIGH-2 comment)." >&2; \
          exit 1 ;; \
      esac; \
    }; \
    # security-review round 2 (PR #423, LOW-4): the allow-list above stops
    # config-injection/path-traversal, but a value like
    # INDEXNOW_KEY=robots or YANDEX_VERIFICATION_FILENAME=index.html would
    # still pass it cleanly and then SILENTLY OVERWRITE a real, already-
    # built landing asset (robots.txt / the homepage itself) — the
    # landing-builder COPY above already populated $LANDING_ROOT with the
    # real site by this point, so any pre-existing file at the target path
    # is a genuine site asset, never a leftover from a previous run of this
    # same step. Fails the build loudly instead, same style as
    # check_path_safe. \
    check_no_collision() { \
      if [ -e "$1" ]; then \
        echo "ERROR: $2 target path '$1' already exists in the landing dist — refusing to overwrite an existing site asset (collision guard, see nginx/Dockerfile LOW-4 comment)." >&2; \
        exit 1; \
      fi; \
    }; \
    check_path_safe "$INDEXNOW_KEY" INDEXNOW_KEY; \
    check_path_safe "$BING_SITE_VERIFICATION_ID" BING_SITE_VERIFICATION_ID; \
    check_path_safe "$YANDEX_VERIFICATION_FILENAME" YANDEX_VERIFICATION_FILENAME; \
    LANDING_ROOT=/usr/share/nginx/html/landing; \
    if [ -n "$INDEXNOW_KEY" ]; then \
      check_no_collision "$LANDING_ROOT/$INDEXNOW_KEY.txt" INDEXNOW_KEY; \
      printf '%s' "$INDEXNOW_KEY" > "$LANDING_ROOT/$INDEXNOW_KEY.txt"; \
      echo "==> IndexNow key file written (/$INDEXNOW_KEY.txt)"; \
    else \
      echo "::warning::INDEXNOW_KEY build-arg not set — IndexNow key file not written (no-op). See scripts/devops/locale-routing-runbook.md."; \
    fi; \
    if [ -n "$BING_SITE_VERIFICATION_ID" ]; then \
      check_no_collision "$LANDING_ROOT/BingSiteAuth.xml" BING_SITE_VERIFICATION_ID; \
      printf '<?xml version="1.0"?><users><user>%s</user></users>' "$BING_SITE_VERIFICATION_ID" > "$LANDING_ROOT/BingSiteAuth.xml"; \
      echo "==> Bing site-verification file written (/BingSiteAuth.xml)"; \
    else \
      echo "::warning::BING_SITE_VERIFICATION_ID build-arg not set — Bing verification file not written (no-op). See scripts/devops/locale-routing-runbook.md."; \
    fi; \
    if [ -n "$YANDEX_VERIFICATION_FILENAME" ] && [ -n "$YANDEX_VERIFICATION_CONTENT" ]; then \
      check_no_collision "$LANDING_ROOT/$YANDEX_VERIFICATION_FILENAME" YANDEX_VERIFICATION_FILENAME; \
      printf '%s' "$YANDEX_VERIFICATION_CONTENT" > "$LANDING_ROOT/$YANDEX_VERIFICATION_FILENAME"; \
      echo "==> Yandex verification file written (/$YANDEX_VERIFICATION_FILENAME)"; \
    else \
      echo "::warning::YANDEX_VERIFICATION_FILENAME / YANDEX_VERIFICATION_CONTENT build-args not set — Yandex verification file not written (no-op). See scripts/devops/locale-routing-runbook.md."; \
    fi

# ── task-infra-locale-edge (HIGH-2, layer 3): fail the BUILD on any broken
# nginx config, not a later deploy ──────────────────────────────────────
# `nginx -t` against the REAL nginx.conf fails outright at build time
# because `upstream api_upstream { server api:3001; }` cannot resolve the
# `api` hostname — there is no `api` container/DNS during `docker build`
# (verified: this is a bare DNS-resolution failure, not a syntax check;
# nginx resolves static, non-`resolver`-based upstream hostnames at
# config-load time). Since `-t` only validates SYNTAX (it never actually
# connects to any upstream), substituting a literal, always-valid
# `127.0.0.1:1` for that one line is sufficient to test everything else —
# including every file this stage has touched (nginx.conf, all of conf.d/,
# the njs module/script) — with zero loss of coverage for the injection
# class this exists to catch. This substitution is BUILD-TIME ONLY (temp
# files, removed immediately after); the real /etc/nginx/nginx.conf and
# /etc/nginx/conf.d/ shipped in the image are untouched.
#
# SECOND substitution needed for the same reason: `ssl_certificate` /
# `ssl_certificate_key` in landing.conf / crm.conf point at
# /etc/nginx/certs/*.crt|key — real files mounted into the container at
# RUNTIME by docker-compose.prod.yml (`volumes: - /etc/nginx/certs:...:ro`),
# never baked into this image, so they genuinely do not exist yet at build
# time either. `nginx -t` fails to LOAD (not just parse) a `listen 443 ssl`
# block without a real, valid certificate on disk — no version of `-t`
# skips that check. Stripping the `ssl_certificate*`/`http2 on;` lines and
# `listen 443 ssl;` -> `listen 8443;` from a build-time-only COPY of
# conf.d/ (not the shipped one) sidesteps needing to fabricate a throwaway
# cert (which would mean either generating one with a tool this base image
# doesn't ship — no openssl in nginx:1.27-alpine, verified — or committing
# a dummy private key to the repo, which is exactly the kind of thing
# secret-scanners flag regardless of it being genuinely inert). This still
# tests every directive this PR's injection-guard cares about (the
# `location`/`map`/njs syntax coming from build-args and everything else in
# conf.d) — only the boilerplate TLS directives themselves are skipped, and
# those are unrelated to and unchanged by this PR.
RUN set -eu; \
    mkdir -p /tmp/nginx-build-test/conf.d && \
    sed 's/server api:3001;/server 127.0.0.1:1;/' /etc/nginx/nginx.conf \
      | sed 's#include /etc/nginx/conf\.d/\*\.conf;#include /tmp/nginx-build-test/conf.d/*.conf;#' \
      > /tmp/nginx-build-test/nginx.conf; \
    for f in /etc/nginx/conf.d/*.conf; do \
      sed -e '/ssl_certificate/d' -e 's/listen 443 ssl;/listen 8443;/' -e '/http2 on;/d' \
        "$f" > "/tmp/nginx-build-test/conf.d/$(basename "$f")"; \
    done; \
    nginx -t -c /tmp/nginx-build-test/nginx.conf; \
    rm -rf /tmp/nginx-build-test

# Ports: 80 (HTTP), 443 (HTTPS — certs must be mounted at runtime).
EXPOSE 80 443

# Healthcheck via nginx stub_status (or just the default 200 on /).
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
