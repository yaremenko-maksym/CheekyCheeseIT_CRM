# ============================================================
# Landing SPA builder
#
# Architecture decision: same as apps/web/Dockerfile — builder stage only.
# The nginx/Dockerfile COPYs --from=landing-builder dist/ to serve the landing
# page under cheekycheese.tech.
#
# No VITE_API_URL: the landing is a public static page with no direct API
# calls. If it ever needs API access, same-origin /api proxy on cheekycheese.tech
# will handle it transparently (nginx is already configured for it).
# ============================================================
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@7.32.4 --activate

WORKDIR /app

# Optional: set a deterministic build version for cache busting.
ARG VITE_BUILD_VERSION=
ENV VITE_BUILD_VERSION=$VITE_BUILD_VERSION

# Workspace manifests first (layer-cache dependency install).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/landing/package.json ./apps/landing/

RUN pnpm install --frozen-lockfile

COPY packages/shared/ ./packages/shared/
COPY apps/landing/ ./apps/landing/
COPY tsconfig.base.json ./

# Build @crm/shared (landing may import shared types for forms/validation).
RUN pnpm --filter @crm/shared build

# Build Landing SPA — outputs to apps/landing/dist/.
RUN pnpm --filter @crm/landing build
