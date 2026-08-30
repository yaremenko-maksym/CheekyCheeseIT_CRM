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

# task-infra-contact-email-env (this infra-PR) / feature/landing-contact-form
# (parallel branch, not yet merged at the time this PR lands): the public
# fallback contact-email address shown on the landing page's contact form.
# Plain build-time CONSTANT (`hr@cheekycheese.tech`), not a secret — baked
# into the bundle at build time, same as VITE_TURNSTILE_SITE_KEY above.
# Empty is a safe default if the parallel branch hasn't merged yet (unused
# by the bundle in that case) — see scripts/devops/contact-email-runbook.md.
# If the landing implementation ends up hardcoding this address directly
# instead of reading a Vite env var, this build-arg is simply unused —
# harmless either way.
ARG VITE_CONTACT_PUBLIC_EMAIL=
ENV VITE_CONTACT_PUBLIC_EMAIL=$VITE_CONTACT_PUBLIC_EMAIL

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

# ── Brotli module builder ──────────────────────────────────────────────────
# task-infra-brotli-static: stock `nginx:1.27-alpine` ships gzip only — no
# brotli support at all (verified: `nginx -V` on this exact base image below
# carries no `--add-module`/`--add-dynamic-module` for brotli, and
# `/usr/lib/nginx/modules/` ships only geoip/image-filter/js/xslt .so files,
# confirmed against a live container of this exact tag). Brotli at its best
# compression ratio (quality 11) beats this project's current gzip -9/-6
# baseline by ~14.4% on a real production CRM bundle (assets/vendor-misc,
# 979 512 raw bytes -> gzip -9 298 860 vs brotli -q11 255 879 — this is the
# EXACT number this Dockerfile's own `static-compress` stage below produces,
# verified by building this image end-to-end and inspecting the resulting
# `.gz`/`.br` files, see this task's PR body for the full table) — matches
# the "another 15-20%" estimate from the task brief.
#
# Built as an OUT-OF-TREE DYNAMIC MODULE (`--with-compat`, already present in
# this exact base image's own configure arguments — verified via `nginx -V`)
# against the nginx SOURCE TARBALL for the EXACT version this base image
# ships (queried via `nginx -v` at build time, not hardcoded — self-adapts if
# the FROM tag above is ever bumped to a new nginx point release without
# anyone remembering to update a second, easily-forgotten version pin here).
# This is the standard, documented way to add brotli to stock nginx without
# forking the base image or trusting an unofficial pre-built nginx+brotli
# image from Docker Hub (supply-chain surface we don't control).
#
# google/ngx_brotli (https://github.com/google/ngx_brotli) is the de-facto
# standard brotli module for nginx (referenced from nginx.org's own
# third-party module list) but has had no code changes since Oct 2023 (repo
# not archived, 43 open issues as of this writing) — pinned to a specific
# commit SHA (not a floating branch) for build reproducibility, same
# pin-a-commit discipline as every other external dependency in this
# Dockerfile. `--recurse-submodules` is NOT used on the initial clone (a
# transient submodule-fetch failure would otherwise fail the whole clone
# atomically with a less obvious error) — `git submodule update --init
# --recursive` runs as a separate, clearer step instead.
FROM nginx:1.27-alpine AS brotli-builder

RUN apk add --no-cache \
      build-base \
      cmake \
      git \
      linux-headers \
      openssl-dev \
      pcre2-dev \
      wget \
      zlib-dev

ARG NGX_BROTLI_COMMIT=a71f9312c2deb28875acc7bacfdd5695a111aa53
WORKDIR /usr/src

RUN git clone https://github.com/google/ngx_brotli.git && \
    cd ngx_brotli && \
    git checkout "$NGX_BROTLI_COMMIT" && \
    git submodule update --init --recursive

# Build the vendored brotli C library (libbrotlienc/libbrotlicommon) first —
# the ngx_brotli module links against these static archives. Only the two
# targets actually needed are built (not brotlidec/the brotli CLI) — this
# project only ever COMPRESSES at the origin, decompression is the
# requesting browser's job.
RUN cd ngx_brotli/deps/brotli && \
    mkdir out && cd out && \
    cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF .. && \
    cmake --build . --target brotlienc brotlicommon --config Release

# `--with-compat` (already part of this base image's own build, verified via
# `nginx -V`) is what makes an out-of-tree dynamic module ABI-compatible
# without needing to replicate every one of the base image's other configure
# flags — only `--add-dynamic-module` is needed on top.
#
# task-infra-brotli-static (design decision, see PR body): only the STATIC
# module (`ngx_http_brotli_static_module.so`, serves pre-existing `<file>.br`
# siblings — mirrors nginx's own built-in `gzip_static`, already compiled
# into this base image per `--with-http_gzip_static_module` in `nginx -V`)
# is built AND loaded at runtime. The FILTER module (on-the-fly
# per-request compression, `ngx_http_brotli_filter_module.so`) is
# deliberately built here (`make modules` builds both from one invocation,
# free) but NEVER loaded — measured locally (see PR body): brotli fast
# enough for synchronous per-request use (quality ~4-6) is NO BETTER than
# this project's existing gzip, sometimes WORSE (q4: 304 548 bytes vs gzip's
# 299 235 on the same file) — the ~14.5% win only exists at quality 11,
# which took 1.13s of CPU for a single ~1 MB file in a local benchmark, wildly
# unacceptable to spend synchronously on every uncached request. Static
# assets in THIS project's dist output are 100% build-time artifacts with
# content-hashed, immutable filenames (`Cache-Control: public, immutable`,
# see nginx/conf.d/crm.conf and landing.conf) — pre-compressing once at
# `docker build` time and serving the byte-identical result on every request
# thereafter is strictly better than the filter module on every axis (best
# compression ratio available AND zero added per-request CPU) with no
# downside for this project's specific asset-serving shape.
RUN set -eu; \
    NGINX_VERSION="$(nginx -v 2>&1 | sed -E 's#^nginx version: nginx/([0-9.]+)$#\1#')"; \
    echo "==> Building ngx_brotli (static module only) against nginx $NGINX_VERSION"; \
    wget -q "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz"; \
    tar -xzf "nginx-${NGINX_VERSION}.tar.gz"; \
    cd "nginx-${NGINX_VERSION}"; \
    ./configure --with-compat --add-dynamic-module=../ngx_brotli; \
    make modules

RUN mkdir -p /out && \
    cp /usr/src/nginx-*/objs/ngx_http_brotli_static_module.so /out/

# ── Static asset pre-compression (gzip -9 + brotli -q11) ───────────────────
# task-infra-brotli-static: runs against the FINAL dist output of both SPA
# builders — after the landing SEO-prerender step above (so prerendered
# locale HTML pages get compressed too, not just the CSR shell) and after the
# CRM build. Deliberately a SEPARATE small stage (not `RUN apk add brotli
# gzip` inside the `runtime` stage below) so the compression CLI tools
# themselves never end up as installed packages in the image that actually
# faces the internet.
#
# Extensions chosen to match this project's existing `gzip_types` in
# nginx.conf (text/plain, text/css, text/javascript, application/javascript,
# application/json, application/xml, image/svg+xml) PLUS `.html` — nginx's
# gzip module always implicitly compresses `text/html` regardless of
# `gzip_types` (documented nginx behaviour: "the text/html value is always
# compressed" — verified live in this task's PR body: prod already gzips
# index.html today even though `text/html` never appears in nginx.conf's
# `gzip_types` list). `font/woff`/`font/woff2` are DELIBERATELY excluded —
# WOFF2 is already brotli-compressed internally at the font-container format
# level (WOFF is zlib-compressed); recompressing either wastes build time for
# ~0% (occasionally negative) additional gain. Binary image formats
# (png/ico/jpg/jpeg/webp/gif — SVG excepted, it is plain XML text and IS
# covered by `-name '*.svg'` above) are excluded for the same reason
# (already-compressed formats) — this mirrors nginx.conf's existing
# `gzip_types` list omitting them today.
#
# `-k`/`--keep` on both tools: writes the `.br`/`.gz` sibling ALONGSIDE the
# original, uncompressed file — required, since `brotli_static`/`gzip_static`
# below fall back to serving the original file byte-for-byte whenever no
# precompressed sibling exists (e.g. a client that sends neither `br` nor
# `gzip` in `Accept-Encoding`, or the rare static file not in one of the
# extensions this loop covers — the small IndexNow-key/Bing/Yandex
# verification files written directly into the landing dist by the `runtime`
# stage below, AFTER this copy, are one such case, and remain served
# uncompressed exactly as before this change — they are tiny, well under any
# compression `min_length` threshold, no behaviour change).
FROM alpine:3.21 AS static-compress

RUN apk add --no-cache brotli gzip

COPY --from=landing-builder /app/apps/landing/dist /work/landing
COPY --from=crm-builder     /app/apps/web/dist     /work/crm

RUN set -eu; \
    for root in /work/landing /work/crm; do \
      find "$root" -type f \( \
        -name '*.js' -o -name '*.css' -o -name '*.html' -o \
        -name '*.svg' -o -name '*.xml' -o -name '*.json' -o -name '*.txt' \
      \) -exec sh -c ' \
        for f do \
          gzip -9 -k -f "$f"; \
          brotli -q 11 -k -f "$f"; \
        done \
      ' sh {} +; \
    done; \
    echo "==> Pre-compressed static assets (gzip -9 + brotli -q11) under /work/landing and /work/crm"

# ── Final nginx image ─────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Remove default nginx site.
RUN rm /etc/nginx/conf.d/default.conf

# Copy our nginx configuration.
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/conf.d/    /etc/nginx/conf.d/
# security review (PR #437 follow-up, HIGH-1): the origin-IP gate's
# ENFORCEMENT snippet lives OUTSIDE conf.d/ on purpose — see its own header
# comment for why (an `if{}` block placed under conf.d/ gets swept into
# nginx.conf's wildcard http-level include too, where `if` is invalid, and
# nginx refuses to start).
COPY nginx/snippets/   /etc/nginx/snippets/

# security review (PR #437 follow-up, MED-2): generates
# nginx/conf.d/cloudflare-real-ip-from.conf (set_real_ip_from, replacing 4
# hand-duplicated blocks) AND nginx/conf.d/origin-gate-geo.conf (the origin
# gate's allow-list, keyed on $realip_remote_addr) from the ONE canonical
# nginx/cloudflare-ips.txt — see that file's header comment and
# scripts/devops/generate-cloudflare-nginx-snippets.sh's own comment for
# the full rationale (this used to be FIVE independently-hand-typed
# copies). Runs BEFORE the build-time `nginx -t` gate near the end of this
# stage, so a generation bug fails the BUILD, not a later deploy.
COPY nginx/cloudflare-ips.txt /etc/nginx/cloudflare-ips.txt
COPY scripts/devops/generate-cloudflare-nginx-snippets.sh /tmp/generate-cloudflare-nginx-snippets.sh
RUN sh /tmp/generate-cloudflare-nginx-snippets.sh /etc/nginx/cloudflare-ips.txt /etc/nginx/conf.d && \
    rm /tmp/generate-cloudflare-nginx-snippets.sh

# security review (PR #439 follow-up, MED-1, 2026-07-31): runtime-discovered
# origin-gate trust entry — see nginx/docker-entrypoint.d/25-origin-gate-
# runtime-trust.sh's header comment and generate-cloudflare-nginx-snippets.sh's
# RUNTIME_TRUSTED_INCLUDE comment for the full rationale (docker-compose.prod.
# yml's pinned frontend/backend subnet can silently fail to apply on a deploy
# that reuses a pre-existing network; this closes that gap independent of
# whether the pin took effect). Placeholder created here (empty, comment-only
# — matches no address) so the build-time `nginx -t` gate below has a valid,
# already-existing file to `include` from origin-gate-geo.conf's geo block
# before the entrypoint script has ever run; the entrypoint OVERWRITES this
# file at every container start with whatever gateway is actually in use.
RUN { \
      echo '# GENERATED build-time placeholder — do NOT edit by hand.'; \
      echo '# Overwritten at container startup by nginx/docker-entrypoint.d/'; \
      echo '# 25-origin-gate-runtime-trust.sh. Empty here (matches no address) is'; \
      echo '# correct at build time — see that script'"'"'s header comment.'; \
    } >/etc/nginx/origin-gate-runtime-trusted.conf

# security review (PR #439 follow-up, MED-1): sourced automatically by this
# base image's own /docker-entrypoint.sh (nginx:1.27-alpine ships it, along
# with 4 of its own numbered scripts already — verified against this exact
# base image) — no ENTRYPOINT/CMD change needed in this Dockerfile. Must be
# executable for the base entrypoint to pick it up (see that mechanism's own
# `[ -x "$f" ]` check).
COPY nginx/docker-entrypoint.d/ /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/25-origin-gate-runtime-trust.sh

# security review (PR #437 follow-up, MED-2 "soft-launch" ask): ORIGIN_GATE_MODE
# — the SINGLE source of truth for whether the origin-IP gate
# (nginx/snippets/origin-gate.conf) actually blocks (`enforce`) or only logs
# (`observe`, default — see nginx/conf.d/origin-gate-mode.conf's header
# comment for the full rationale). SAME pattern/placement/validation style
# as ARG CRM_CSP_MODE directly below — not re-exposed as ENV (baked into
# nginx/conf.d/origin-gate-mode.conf at build time); deploy.yml threads the
# value in from ONE `env: ORIGIN_GATE_MODE:` entry, the one place a flip
# actually happens.
ARG ORIGIN_GATE_MODE=observe

# nginx/conf.d/origin-gate-mode.conf carries exactly one occurrence of the
# `__ORIGIN_GATE_MODE__` placeholder — substituted here with the validated
# ARG value. Fails the BUILD loudly (not a silent fallback) on an
# unrecognised value or a missing placeholder — same two failure classes as
# the CRM_CSP_MODE step below, same rationale (a silent regression to the
# WRONG mode is exactly the class of bug a security-hardening feature must
# never ship with).
RUN set -eu; \
    case "$ORIGIN_GATE_MODE" in \
      observe|enforce) ;; \
      *) echo "ERROR: ORIGIN_GATE_MODE must be exactly 'observe' or 'enforce', got: '$ORIGIN_GATE_MODE'. See nginx/conf.d/origin-gate-mode.conf's header comment." >&2; exit 1 ;; \
    esac; \
    if ! grep -q '__ORIGIN_GATE_MODE__' /etc/nginx/conf.d/origin-gate-mode.conf; then \
      echo "ERROR: __ORIGIN_GATE_MODE__ placeholder not found in nginx/conf.d/origin-gate-mode.conf — the ORIGIN_GATE_MODE build-arg wiring is broken (file refactored without updating this step?)." >&2; \
      exit 1; \
    fi; \
    sed -i "s/__ORIGIN_GATE_MODE__/$ORIGIN_GATE_MODE/" /etc/nginx/conf.d/origin-gate-mode.conf; \
    echo "==> Origin gate mode baked in: $ORIGIN_GATE_MODE"

# task-csp-reports-and-flip (Part B, security review round 2 LOW fix):
# CRM_CSP_MODE — the SINGLE source of truth for whether CRM's CSP ships as
# Content-Security-Policy-Report-Only (observe, default) or
# Content-Security-Policy (enforcing). Deliberately a build ARG, not a
# runtime ENV read by nginx itself — nginx has no built-in mechanism to read
# OS environment variables inside a `map` directive, and every mode-flip in
# this project already goes through a reviewed PR anyway (see
# scripts/devops/csp-report-only-rollout-runbook.md §4), so "rebuild via a
# one-line deploy.yml change" is the right cost, not a limitation. NOT
# re-exposed as ENV: nothing at container runtime reads it — the value is
# baked into /etc/nginx/conf.d/csp-map.conf below, once, at build time.
# deploy.yml threads this in from ONE `env: CRM_CSP_MODE:` entry at the top
# of that workflow (see its build-args list) — that is the ONE place a flip
# actually happens; this Dockerfile's default is only for local/manual
# `docker build`/`docker compose build` (docker-compose.prod.yml does not
# pass build-args at all for the nginx service — see that file's comment —
# so this default is what a manual `docker compose -f docker-compose.prod.yml
# build` gets too).
ARG CRM_CSP_MODE=report-only

# nginx/conf.d/csp-map.conf carries exactly one occurrence of the
# `__CRM_CSP_MODE__` placeholder (inside the `map $server_name $csp_mode`
# block) — substituted here with the validated ARG value. Fails the BUILD
# loudly (not a silent fallback to the default) on:
#   1. an unrecognised CRM_CSP_MODE value — the only two behaviours nginx's
#      $csp_mode-derived maps understand are the literal strings
#      "report-only" and "enforcing" (csp-map.conf's `map $csp_mode ...`
#      blocks); anything else would silently resolve to BOTH $csp_enforcing
#      and $csp_report_only being "" (neither header sent — a silent
#      regression to zero CSP on CRM, exactly the class of bug this whole
#      task exists to prevent recurring).
#   2. the placeholder itself going missing (e.g. a future refactor of
#      csp-map.conf renames/removes it without updating this step) — sed
#      would otherwise silently no-op and ship whatever mode was baked in
#      the LAST time this line worked, not a build failure.
RUN set -eu; \
    case "$CRM_CSP_MODE" in \
      report-only|enforcing) ;; \
      *) echo "ERROR: CRM_CSP_MODE must be exactly 'report-only' or 'enforcing', got: '$CRM_CSP_MODE'. See nginx/conf.d/csp-map.conf's 'Report-Only rollout switch' comment." >&2; exit 1 ;; \
    esac; \
    if ! grep -q '__CRM_CSP_MODE__' /etc/nginx/conf.d/csp-map.conf; then \
      echo "ERROR: __CRM_CSP_MODE__ placeholder not found in nginx/conf.d/csp-map.conf — the CRM_CSP_MODE build-arg wiring is broken (file refactored without updating this step?)." >&2; \
      exit 1; \
    fi; \
    sed -i "s/__CRM_CSP_MODE__/$CRM_CSP_MODE/" /etc/nginx/conf.d/csp-map.conf; \
    echo "==> CRM CSP mode baked in: $CRM_CSP_MODE"

# task-infra-locale-edge: njs module used ONLY for Accept-Language
# best-match parsing (see the `load_module` comment in nginx.conf). The
# module .so itself already ships in this base image — only our script
# needs copying.
COPY nginx/njs/       /etc/nginx/njs/

# Copy Landing SPA static files.
# task-infra-brotli-static: sourced from `static-compress` (gzip -9 +
# brotli -q11 pre-compressed siblings alongside every original file), NOT
# `landing-builder` directly — see that stage's header comment.
COPY --from=static-compress /work/landing /usr/share/nginx/html/landing

# Copy CRM SPA static files.
# task-infra-brotli-static: sourced from `static-compress` — see above.
COPY --from=static-compress /work/crm /usr/share/nginx/html/crm

# task-infra-brotli-static: the out-of-tree brotli STATIC module (serves the
# pre-compressed `.br` siblings the `static-compress` stage just wrote —
# mirrors nginx's own built-in `gzip_static`, already compiled into this base
# image) — see `brotli-builder`'s header comment for why only the static
# module (not the on-the-fly filter module) is shipped. `/usr/lib/nginx/
# modules/` is the REAL target of the `/etc/nginx/modules` symlink this base
# image ships (verified: `ls -la /etc/nginx/modules` on this exact tag) —
# copying here, not to the symlink path, so `load_module modules/...` in
# nginx.conf below (relative, same pattern as the already-present
# `ngx_http_js_module.so` load) resolves correctly regardless of which path
# is used to reach it.
COPY --from=brotli-builder /out/ngx_http_brotli_static_module.so /usr/lib/nginx/modules/

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
#
# MED-5 (security audit 2026-07-27, nginx/conf.d/default-server.conf): that
# file's `listen 443 ssl default_server;` block needs the SAME cert-strip
# treatment, but carries the extra `default_server` parameter — widened the
# `listen 443 ssl;` match below to `listen 443 ssl.*;` (POSIX BRE `.*`,
# works identically under GNU sed here and BSD sed in a local dry-run) so
# it still catches this line regardless of what follows `ssl`. Dropping
# `default_server` in the build-time-only copy is harmless: `nginx -t` only
# needs valid syntax, not the default_server semantics.
RUN set -eu; \
    mkdir -p /tmp/nginx-build-test/conf.d && \
    sed 's/server api:3001;/server 127.0.0.1:1;/' /etc/nginx/nginx.conf \
      | sed 's#include /etc/nginx/conf\.d/\*\.conf;#include /tmp/nginx-build-test/conf.d/*.conf;#' \
      > /tmp/nginx-build-test/nginx.conf; \
    for f in /etc/nginx/conf.d/*.conf; do \
      sed -e '/ssl_certificate/d' -e 's/listen 443 ssl.*;/listen 8443;/' -e '/http2 on;/d' \
        "$f" > "/tmp/nginx-build-test/conf.d/$(basename "$f")"; \
    done; \
    nginx -t -c /tmp/nginx-build-test/nginx.conf; \
    rm -rf /tmp/nginx-build-test

# security review (PR #615 round 3, LOW): manifest-readable build fingerprint
# for this image, same shape as apps/api/Dockerfile's own GIT_COMMIT ARG/ENV
# (see that file's comment for the full "why runtime stage, why plain ENV"
# reasoning — identical here). Deliberately the LAST instruction before
# EXPOSE/HEALTHCHECK/CMD, not placed up near FROM the way apps/api's is: an
# ARG/ENV pair invalidates the Docker layer cache for every instruction AFTER
# it, and GIT_COMMIT changes on every deploy build by construction — placed
# early in THIS stage (unlike apps/api's, which has almost nothing left to
# cache after it) it would have defeated GHA layer caching (`cache-from`/
# `cache-to: scope=nginx` in deploy.yml) for the entire config-baking +
# static-file-copy sequence above, every single build, for a value nothing
# above this line reads. Before this, the nginx image carried NO
# manifest-readable fingerprint at all — VITE_BUILD_VERSION only ever lives
# in the crm-builder stage's Vite build env (baked into the JS bundle, never
# a Docker image ENV), so `docker buildx imagetools inspect` could never see
# it; deploy.yml's "Verify rollback image fingerprint" step checked the API
# image only for exactly this reason, until this round made the check on
# both images possible. No default on ARG, matching apps/api's own choice —
# an unset value flows through as an unset ENV rather than a fabricated one.
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT

# Ports: 80 (HTTP), 443 (HTTPS — certs must be mounted at runtime).
EXPOSE 80 443

# Healthcheck via nginx stub_status (or just the default 200 on /).
#
# MED-5 (security audit 2026-07-27): explicit Host header, matching a real
# vhost. Verified live (local Docker test) that a bare `wget
# http://127.0.0.1/...` (Host defaults to "127.0.0.1") now hits
# nginx/conf.d/default-server.conf's catch-all and gets `444` (connection
# closed, no response) — wget treats that as a failure, so this
# HEALTHCHECK would otherwise mark the container unhealthy the moment this
# PR ships. docker-compose.prod.yml defines its OWN `healthcheck:` (with
# the same fix) that overrides this one when running via compose — this
# line only matters for a bare `docker run`/local test, but keeping BOTH
# correct avoids the same trap resurfacing there.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --header="Host: app.cheekycheese.tech" http://127.0.0.1/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
