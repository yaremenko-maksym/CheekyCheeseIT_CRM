# ============================================================
# CRM SPA builder
#
# Architecture decision: this Dockerfile only produces the build artifact
# (dist/). The static files are served by the shared nginx image (see
# nginx/Dockerfile) which COPYs --from=crm-builder at build time.
# This avoids running a per-SPA nginx container and keeps the reverse-proxy
# topology in a single place.
#
# VITE_API_URL must be set at BUILD time (Vite bakes env vars into the JS
# bundle). The default is /api so all API calls go same-origin through nginx.
# Override via --build-arg VITE_API_URL=... only if your deployment differs.
# ============================================================
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@7.32.4 --activate

WORKDIR /app

# Build arg baked into the Vite bundle at compile time.
# Default /api = same-origin nginx proxy (cookie-auth works without cross-origin).
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

# Optional: set a deterministic build version (e.g. git SHA) for cache busting.
ARG VITE_BUILD_VERSION=
ENV VITE_BUILD_VERSION=$VITE_BUILD_VERSION

# Workspace manifests first (layer-cache dependency install).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/shared/ ./packages/shared/
COPY apps/web/ ./apps/web/
COPY tsconfig.base.json ./

# Build @crm/shared first (web imports from workspace:*).
RUN pnpm --filter @crm/shared build

# Build CRM SPA — outputs to apps/web/dist/.
RUN pnpm --filter @crm/web build
