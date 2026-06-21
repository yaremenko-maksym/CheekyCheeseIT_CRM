# ============================================================
# Stage 1: builder
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
# Stage 2: runtime
# Minimal image — only the compiled dist + prod node_modules.
# ============================================================
FROM node:20-alpine AS runtime

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

EXPOSE 3001

# Health endpoint: GET /api/health (or liveness via the NestJS shutdown hooks).
# Used by docker-compose.prod.yml healthcheck.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "dist/main"]
