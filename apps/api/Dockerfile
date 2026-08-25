# ============================================================
# Stage 1: typst
# Fetches the Typst CLI binary (résumé PDF rendering — invoked as a
# child process by the render service, NEVER as an in-process library:
# a parser blocking the Node event loop is exactly how PR #497 froze
# the API for 30s). This stage only ships the verified binary; the
# render service itself is a separate, later change.
#
# Why a raw release download instead of a package manager:
#   - Typst has no apk/apt package — Alpine/Debian repos don't carry it.
#   - The upstream project also publishes an official Docker image
#     (ghcr.io/typst/typst), but pulling only a single verified binary
#     out of the release tarball keeps this Dockerfile self-contained
#     (one registry dependency — GitHub Releases — instead of two:
#     GitHub Releases AND ghcr.io/typst namespace availability/policy).
#
# TYPST_VERSION is an EXACT pin (never "latest"): résumé PDFs are
# hash-verified/signed documents elsewhere in this codebase, and a
# floating Typst build can silently change glyph shaping/layout
# between builds, which breaks that determinism.
#
# TYPST_SHA256_* below are the SHA-256 digests GitHub itself computed
# for these exact release assets (Releases API `assets[].digest`,
# `GET /repos/typst/typst/releases/tags/v0.15.1`, captured 2026-08-08).
# Typst does not publish its own signed checksums.txt (verified against
# typst/typst .github/workflows/release.yml — the release job uploads
# raw archives with no `gh release upload checksums.txt` step and no
# cosign/sigstore signing). TLS only proves the download came from
# github.com; `sha256sum -c` below is what proves the bytes match what
# was uploaded to the v0.15.1 release — pulling an executable into a
# prod image with no verification of either kind is not acceptable
# (task requirement). Bumping TYPST_VERSION means bumping BOTH shas
# below, taken from the new release's Releases API response.
FROM node:20-alpine AS typst
ARG TYPST_VERSION=0.15.1
ARG TARGETARCH
WORKDIR /typst
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) \
      TYPST_TARGET=x86_64-unknown-linux-musl; \
      TYPST_SHA256=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c ;; \
    arm64) \
      TYPST_TARGET=aarch64-unknown-linux-musl; \
      TYPST_SHA256=5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee ;; \
    *) \
      echo "typst stage: unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
  esac; \
  ARCHIVE="typst-${TYPST_TARGET}.tar.xz"; \
  wget -q -O "$ARCHIVE" "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${ARCHIVE}"; \
  echo "${TYPST_SHA256}  ${ARCHIVE}" | sha256sum -c -; \
  tar -xJf "$ARCHIVE" "typst-${TYPST_TARGET}/typst"; \
  mv "typst-${TYPST_TARGET}/typst" /usr/local/bin/typst; \
  chmod 755 /usr/local/bin/typst; \
  rm -rf "$ARCHIVE" "typst-${TYPST_TARGET}"; \
  /usr/local/bin/typst --version

# ============================================================
# Stage 2: builder
# Installs all workspace deps, builds @crm/shared then @crm/api.
# Turbo dependency order: shared must compile before api (^build).
# ============================================================
FROM node:20-alpine AS builder

# Install pnpm at the exact pin used in the project (packageManager field).
RUN corepack enable && corepack prepare pnpm@7.32.4 --activate

WORKDIR /app

# Copy workspace manifests first for layer-cache efficiency.
# pnpm needs all package.json files to resolve the workspace graph.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install all workspace deps (frozen lockfile — no implicit upgrades in CI/Docker).
RUN pnpm install --frozen-lockfile

# Copy source AFTER install so source changes don't bust the dependency layer.
COPY packages/shared/ ./packages/shared/
COPY apps/api/ ./apps/api/
COPY tsconfig.base.json ./

# Build @crm/shared first (api depends on it via workspace:*).
RUN pnpm --filter @crm/shared build

# Build @crm/api (nest build → dist/).
RUN pnpm --filter @crm/api build

# Prune to production deps only (removes devDependencies).
# --prod creates node_modules with only runtime deps for the copied workspace.
RUN pnpm --filter @crm/api --prod deploy /app/prod-deploy

# ============================================================
# Stage 3: runtime
# Minimal image — only the compiled dist + prod node_modules.
# ============================================================
FROM node:20-alpine AS runtime

# backlog 113 — build fingerprint for GET /api/health (see
# apps/api/src/config/env.ts's GIT_COMMIT/BUILD_TIME doc + health.controller.ts
# for the full chain). Deliberately set HERE, in the runtime stage, not the
# builder stage above: these are plain `ENV`, not compiled into anything (the
# API is not bundled the way apps/web's Vite build is — VITE_BUILD_VERSION
# there needs the builder stage because Vite bakes it into the JS at compile
# time), so there is no reason to invalidate the builder stage's Docker layer
# cache — which DOES change every build, since the tag/timestamp differ every
# run — for a value nothing before this line reads. No default on either ARG:
# an empty/unset value flows through as an unset ENV, and apps/api's own env.ts
# leaves both `undefined` rather than substituting a fake default — see that
# file's doc for why a fabricated build identity would be worse than an
# honest "unknown" (the whole point of this backlog item).
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
ARG BUILD_TIME=
ENV BUILD_TIME=$BUILD_TIME

# Security: don't run the API as root.
# node user (uid 1000) is built into the node:20-alpine image.
USER node

WORKDIR /app

# Copy pruned production deployment from builder.
COPY --from=builder --chown=node:node /app/prod-deploy ./

# Copy compiled API dist.
COPY --from=builder --chown=node:node /app/apps/api/dist ./dist

# Copy compiled shared package dist (runtime dep via workspace:*).
# After pnpm deploy --prod, @crm/shared is in node_modules; its dist is
# resolved from there. We don't need an extra copy.

# Typst CLI — checksum-verified in the `typst` build stage above.
# Invoked as a child process (never in-process) by the résumé PDF
# render service. Our Cyrillic-capable fonts (Roboto-Regular/Bold,
# already copied above via ./dist/assets/fonts through nest-cli's
# asset globs) are visible to it at ./dist/assets/fonts — the render
# service points `typst compile --font-path` there.
COPY --from=typst --chown=node:node /usr/local/bin/typst /usr/local/bin/typst

EXPOSE 3001

# Health endpoint: GET /api/health (or liveness via the NestJS shutdown hooks).
# Used by docker-compose.prod.yml healthcheck.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

CMD ["node", "dist/main"]
