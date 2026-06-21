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
FROM node:20-alpine AS landing-builder

RUN corepack enable && corepack prepare pnpm@7.32.4 --activate

WORKDIR /app

ARG VITE_BUILD_VERSION=
ENV VITE_BUILD_VERSION=$VITE_BUILD_VERSION

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/landing/package.json ./apps/landing/

RUN pnpm install --frozen-lockfile

COPY packages/shared/ ./packages/shared/
COPY apps/landing/ ./apps/landing/
COPY tsconfig.base.json ./

RUN pnpm --filter @crm/shared build
RUN pnpm --filter @crm/landing build

# ── CRM builder ───────────────────────────────────────────────────────────
FROM node:20-alpine AS crm-builder

RUN corepack enable && corepack prepare pnpm@7.32.4 --activate

WORKDIR /app

ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

ARG VITE_BUILD_VERSION=
ENV VITE_BUILD_VERSION=$VITE_BUILD_VERSION

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
  CMD wget -qO- http://localhost/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
