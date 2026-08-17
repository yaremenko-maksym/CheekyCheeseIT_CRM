#!/usr/bin/env bash
# run-landing-e2e-local.sh — item 24 (task-ddl-guard-and-ci-noise, 2026-08-17).
#
# Incident this fixes: apps/landing's `build:prerender` step (headless
# Chromium snapshotting every route) and the `--project=landing` E2E run that
# follows it both call the SAME API instance's apps/api's global
# ThrottlerModule (default 100 req / 60s, shared by IP across every caller —
# see apps/api/src/app.module.ts + apps/api/src/config/env.ts). CI already
# raises this per ci.yml's landing-shard job-level env (THROTTLER_LIMIT=2000,
# THROTTLE_RELAXED=true) — see the "Throttler:" comment there. Locally, a
# developer who hand-runs `build:prerender` then `playwright test
# --project=landing` (the sequence apps/e2e/playwright.config.ts's own
# comment documents) boots the API with NO such override, so the default
# limit is live. The window can fill up (prerender.mjs's own pacing keeps
# ITS OWN requests under budget 60, but that plus the E2E run's own requests
# for the same fixture set realistically clears 130 requests within the
# window — measured 2026-08-17 against a scratch instance: 130 requests
# against THROTTLER_LIMIT unset -> 100 succeed, 30 get 429; the SAME 130
# against THROTTLER_LIMIT=2000 -> 0 get 429). A 429 on the SPA's own
# `fetchVacancies()` call resolves to `[]` (graceful client-side fallback,
# apps/landing/app/lib/api.ts) — a spec reading `vacancies[0].slug` off that
# then throws on `undefined`, which reads as a rendering bug and is not one.
# Prod incident precedent (different trigger, SAME root cause): 27–31.07.
#
# This script is the "local recipe" fix (AC5(a) — not a code change under
# apps/**, which is out of DevOps zone): it runs the exact CI sequence with
# the SAME throttler override CI already carries, end to end, against a
# SCRATCH database — never the developer's live `crm_db` (see the DATABASE_URL
# / REDIS_URL requirement below; this script refuses to run against the
# docker-compose default database unless ALLOW_DEFAULT_DB=1 is set).
#
# Usage:
#   DATABASE_URL=postgresql://crm_user:password@localhost:5544/crm_db_scratch \
#   REDIS_URL=redis://localhost:6389 \
#     scripts/devops/run-landing-e2e-local.sh
#
# Required env:
#   DATABASE_URL, REDIS_URL — MUST point at scratch instances (see above).
#
# Optional env:
#   API_PORT               (default 3001 — apps/landing's preview proxy default)
#   SKIP_BUILD=1            skip `pnpm build` (reuse an existing build)
#   THROTTLER_LIMIT         (default 2000 — same value CI uses; raise further
#                            if your fixture set/spec additions still 429)
#
# apps/landing/vite.config.ts hardcodes `server.port`/`preview.port` to 3002
# (not env-overridable — that file is Coder/Designer zone, out of DevOps
# reach) — this script does not attempt to change that.
set -u
# Job control ON: gives each `&` background job below its OWN process group
# (PGID = the job's PID), so `kill -- -$PID` in cleanup() below can kill the
# WHOLE tree (`pnpm --filter @crm/landing start` forks a `vite preview` child
# that does not exit when only the pnpm wrapper PID is killed — verified
# 2026-08-17: killing just the captured PID left `vite.js preview` running,
# reparented to PID 1, still bound to :3002). Without this, a script that
# exits mid-way (a failing E2E run, Ctrl-C, ...) leaks a dev server exactly
# like the zombie-devserver incidents scripts/devops/dev-ttl.sh exists for.
set -m

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ -z "${DATABASE_URL:-}" ] || [ -z "${REDIS_URL:-}" ]; then
  echo "run-landing-e2e-local: DATABASE_URL and REDIS_URL are required (scratch instances — see this script's header)." >&2
  exit 64
fi

case "$DATABASE_URL" in
  *"/crm_db"*localhost:5432* | *localhost:5432*"/crm_db"*)
    if [ "${ALLOW_DEFAULT_DB:-}" != "1" ]; then
      echo "run-landing-e2e-local: DATABASE_URL looks like the docker-compose DEFAULT (crm_db on :5432)." >&2
      echo "This script runs db:push + db:seed + a landing fixture seed against it — never point it at your live dev DB." >&2
      echo "Point DATABASE_URL at a scratch postgres instance, or set ALLOW_DEFAULT_DB=1 to override (not recommended)." >&2
      exit 64
    fi
    ;;
esac

API_PORT="${API_PORT:-3001}"
THROTTLER_LIMIT="${THROTTLER_LIMIT:-2000}"

PIDS=()
cleanup() {
  local pid
  for pid in "${PIDS[@]+"${PIDS[@]}"}"; do
    # Negative PID = kill the whole process group (see the `set -m` comment
    # above) — falls back to a plain PID kill if the group kill is refused.
    kill -9 -- "-$pid" >/dev/null 2>&1 || kill -9 "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> Building shared, api, landing"
  pnpm --filter @crm/shared --filter @crm/api --filter @crm/landing build || exit 1
fi

echo "==> db:push + db:seed (scratch DB — $DATABASE_URL)"
pnpm --filter @crm/api db:push || exit 1
pnpm --filter @crm/api db:seed || exit 1

echo "==> Starting API on :$API_PORT (THROTTLER_LIMIT=$THROTTLER_LIMIT, THROTTLE_RELAXED=true — same as ci.yml's landing shard)"
DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  API_PORT="$API_PORT" \
  NODE_ENV="${NODE_ENV:-development}" \
  THROTTLER_LIMIT="$THROTTLER_LIMIT" \
  THROTTLE_RELAXED=true \
  JWT_SECRET="${JWT_SECRET:-local-e2e-jwt-secret-32-chars-minimum-x}" \
  SESSION_SECRET="${SESSION_SECRET:-local-e2e-session-secret-32-chars-x}" \
  GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-test-client-id}" \
  GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-test-client-secret}" \
  GOOGLE_CALLBACK_URL="${GOOGLE_CALLBACK_URL:-http://localhost:$API_PORT/api/auth/google/callback}" \
  FRONTEND_URL="${FRONTEND_URL:-http://localhost:3002}" \
  CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3002}" \
  S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}" \
  S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}" \
  S3_REGION="${S3_REGION:-us-east-1}" \
  S3_BUCKET="${S3_BUCKET:-crm-documents}" \
  S3_USE_SSE="${S3_USE_SSE:-false}" \
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-minioadmin}" \
  AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-minioadmin}" \
  node --enable-source-maps apps/api/dist/main >/tmp/run-landing-e2e-local-api.log 2>&1 &
API_PID=$!
PIDS+=("$API_PID")

echo "==> Waiting for API health"
i=0
until curl -sf "http://localhost:$API_PORT/api/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "run-landing-e2e-local: API never became healthy — see /tmp/run-landing-e2e-local-api.log" >&2
    exit 1
  fi
  sleep 1
done

echo "==> Seeding landing vacancy fixtures"
SEED_LANDING_API_BASE="http://localhost:$API_PORT" pnpm --filter @crm/e2e seed:landing || exit 1

echo "==> Building landing (prerender) against the local API"
PRERENDER_API_ORIGIN="http://localhost:$API_PORT" pnpm --filter @crm/landing build:prerender || exit 1

echo "==> Starting landing preview on :3002"
VITE_PROXY_API_TARGET="http://localhost:$API_PORT" pnpm --filter @crm/landing start >/tmp/run-landing-e2e-local-preview.log 2>&1 &
PREVIEW_PID=$!
PIDS+=("$PREVIEW_PID")

echo "==> Waiting for landing preview"
i=0
until curl -sf http://localhost:3002 >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "run-landing-e2e-local: landing preview never became ready — see /tmp/run-landing-e2e-local-preview.log" >&2
    exit 1
  fi
  sleep 1
done

echo "==> Running E2E landing project"
pnpm --filter @crm/e2e exec playwright test --project=landing "$@"
RC=$?

exit "$RC"
