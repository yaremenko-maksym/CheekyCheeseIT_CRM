# Deployment Runbook — CheekyCheeseIT CRM

## Overview

Production stack = 4 Docker services behind a single nginx reverse-proxy:

| Service    | Image                       | Exposes        | Domain(s)                                 |
| ---------- | --------------------------- | -------------- | ----------------------------------------- |
| `postgres` | postgres:16-alpine          | internal only  | —                                         |
| `redis`    | redis:7-alpine              | internal only  | —                                         |
| `api`      | Built from apps/api         | internal :3001 | `*/api/*` on both domains                 |
| `nginx`    | Built from nginx/Dockerfile | 80, 443        | cheekycheese.tech + app.cheekycheese.tech |

Cookie auth is same-origin: CRM (`app.cheekycheese.tech/api/...`) hits nginx `/api/` → api:3001.
No cross-domain CORS dance needed.

---

## Prerequisites

- Docker Engine 24+ with Compose plugin v2.
- `pnpm@7.32.4` is installed **inside** each builder image — no local pnpm required.
- A `.env.production` file (copy from `.env.production.example`, fill secrets).

---

## 1. Prepare environment

```bash
cp .env.production.example .env.production
```

Edit `.env.production` — fill every `[REQUIRED]` field:

| Variable                | Notes                                                     |
| ----------------------- | --------------------------------------------------------- |
| `DATABASE_URL`          | `postgresql://crm_user:<pw>@postgres:5432/crm_db`         |
| `POSTGRES_PASSWORD`     | Must match password in `DATABASE_URL`                     |
| `REDIS_URL`             | `redis://redis:6379`                                      |
| `GOOGLE_CLIENT_ID`      | From Google Cloud Console → OAuth 2.0 Client              |
| `GOOGLE_CLIENT_SECRET`  | Same console                                              |
| `GOOGLE_CALLBACK_URL`   | `https://app.cheekycheese.tech/api/auth/google/callback`  |
| `JWT_SECRET`            | `openssl rand -base64 32`                                 |
| `SESSION_SECRET`        | `openssl rand -base64 32`                                 |
| `CREDENTIALS_ENC_KEY`   | `openssl rand -base64 32` (must be exactly 32 bytes)      |
| `FRONTEND_URL`          | `https://app.cheekycheese.tech`                           |
| `CORS_ORIGINS`          | `https://app.cheekycheese.tech,https://cheekycheese.tech` |
| `TRUST_PROXY`           | `true` (behind nginx)                                     |
| `AWS_ACCESS_KEY_ID`     | IAM key with S3 access                                    |
| `AWS_SECRET_ACCESS_KEY` | IAM secret                                                |
| `S3_BUCKET`             | `crm-documents-prod`                                      |
| `S3_REGION`             | `eu-central-1`                                            |

---

## 2. Google OAuth callback registration

In **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs**:

- Authorized JavaScript origins: `https://app.cheekycheese.tech`
- Authorized redirect URIs: `https://app.cheekycheese.tech/api/auth/google/callback`

The callback URI must match `GOOGLE_CALLBACK_URL` in `.env.production` exactly.

---

## 3. Build and start (local verification)

```bash
# Validate compose config (no build, checks YAML + env interpolation):
docker compose -f docker-compose.prod.yml config

# Build all images (first run: ~10-15 min, pulls base images + pnpm install):
docker compose -f docker-compose.prod.yml build

# Start the stack:
docker compose -f docker-compose.prod.yml up -d

# Verify all services are healthy:
docker compose -f docker-compose.prod.yml ps
```

Expected output — all services `(healthy)` or `Up`:

```
NAME       STATUS                   PORTS
postgres   Up (healthy)             —
redis      Up (healthy)             —
api        Up (healthy)             —
nginx      Up (healthy)             0.0.0.0:80->80, 0.0.0.0:443->443
```

---

## 4. Database migrations

After first `up -d`, run Drizzle migrations:

```bash
# Open a shell in the api container:
docker compose -f docker-compose.prod.yml exec api sh

# Inside the container:
node -e "require('./dist/database/seed')"
# OR run via drizzle-kit (if kit is in prod deps):
# npx drizzle-kit push
```

> Drizzle `db:push` is run outside Docker by default. With prod, run against
> `DATABASE_URL=postgresql://crm_user:<pw>@localhost:5432/crm_db` (postgres port
> must be temporarily exposed for this). See `apps/api/drizzle.config.ts`.

---

## 5. TLS / HTTPS

TLS is **not yet configured** (hosting provider not selected). The nginx config
has commented-out `listen 443 ssl` blocks in `nginx/conf.d/landing.conf` and
`nginx/conf.d/crm.conf`.

To enable TLS when the server is provisioned:

### Option A — Let's Encrypt (certbot)

```bash
# On the host (not in Docker):
certbot certonly --standalone -d cheekycheese.tech -d www.cheekycheese.tech
certbot certonly --standalone -d app.cheekycheese.tech
```

Mount cert dirs in `docker-compose.prod.yml` nginx `volumes:` (commented block is ready).

### Option B — Cloudflare-issued certificate

Download origin certs from Cloudflare dashboard → place at the paths in the
commented nginx blocks.

After placing certs, uncomment the `443` server blocks in `nginx/conf.d/*.conf`
and also uncomment the HSTS header in `nginx/conf.d/security-headers.conf`.

```bash
docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

---

## 6. Self-hosted S3 (MinIO) — optional

If you are not using AWS S3, start the stack with the `selfhosted-s3` profile:

```bash
docker compose -f docker-compose.prod.yml --profile selfhosted-s3 up -d
```

Set in `.env.production`:

```
S3_ENDPOINT=http://minio:9000
S3_FORCE_PATH_STYLE=true
S3_USE_SSE=false
AWS_ACCESS_KEY_ID=<your-minio-root-user>
AWS_SECRET_ACCESS_KEY=<your-minio-root-password>
```

> MinIO does NOT support SSE-S3 (AES-256). Keep `S3_USE_SSE=false`.

---

## 7. Useful commands

```bash
# Tail API logs:
docker compose -f docker-compose.prod.yml logs -f api

# Tail nginx access log:
docker compose -f docker-compose.prod.yml logs -f nginx

# Restart only the API (e.g. after env change):
docker compose -f docker-compose.prod.yml restart api

# Stop the stack:
docker compose -f docker-compose.prod.yml down

# Stop and remove volumes (DESTRUCTIVE — deletes all data):
docker compose -f docker-compose.prod.yml down -v
```

---

## 8. Notes

- `VITE_API_URL` is baked into the CRM SPA bundle at **build time** (not runtime).
  If you change it, rebuild the nginx image: `docker compose -f docker-compose.prod.yml build nginx`.
- `VITE_BUILD_VERSION` (optional): pass the git SHA as a build arg for PWA cache busting.
  Example in deploy script: `VITE_BUILD_VERSION=$(git rev-parse --short HEAD) docker compose -f docker-compose.prod.yml build`.
- Hosting provider: **not yet selected**. Runbook will be updated with VPS/cloud
  provider-specific instructions once decided.
