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

# Danger check — MATCH ON DATABASE NAME, NOT HOST SPELLING (review round 2,
# HIGH-1, 2026-08-17). The original version matched the literal substring
# "localhost:5432" — `...@127.0.0.1:5432/crm_db` (a completely ordinary way
# to write "this machine", and how docker-compose's own port mapping is
# reached from a lot of tooling) sailed straight through. Worse: this
# machine actually runs TWO live Postgres servers on port 5432 at once
# (homebrew AND the docker-compose one), and BOTH of them have a database
# literally named `crm_db` — so no amount of enumerating host spellings
# (localhost / 127.0.0.1 / ::1 / [::1] / a container name / a bare hostname
# with no port, meaning the driver default 5432) would have been a complete
# fix; the host is not actually a useful signal here. What every one of
# those routes has in common is the DATABASE NAME, which is what `db:push` +
# `db:seed` below actually write against — so that's what this now checks:
# the URL's path component (query string stripped), regardless of how the
# host before it is spelled or whether a port is even present.
#
# This is a deliberately ASYMMETRIC check: matching on name alone is enough
# to call a URL DANGEROUS (any reachable server with a database literally
# named `crm_db` is treated as live/production-adjacent, full stop), but is
# NOT proof that any other name is safe (`crm_qa` exists on both of this
# machine's servers too, and may be a shared, currently-in-use QA database —
# this check does not vouch for it, it only refuses the one name every
# default in this repo — docker-compose.yml's POSTGRES_DB, .env.example's
# DATABASE_URL — actually spells out).
#
# REVIEW ROUND 3 (four peripheral cases raised against db_name_from_url()
# beyond the round-2 form matrix, 2026-08-17) — resolved one by one, not
# batched, because only one is a real bypass:
#
#   CLOSED — percent-encoding. `crm%5Fdb` is the SAME database as `crm_db`
#   to libpq (URI percent-decoding is part of the connection-string spec),
#   but is a different byte string to a literal `=` compare — this one
#   actually reaches the live `crm_db` while walking past the check
#   unmatched. Fixed below: percent-decode before comparing.
#
#   CLOSED — a dangling trailing space. Same fix closes it (trimmed
#   after decoding, same function, same test).
#
#   NOT A BYPASS, left unmatched on purpose — UPPERCASE (`CRM_DB`). Postgres
#   identifiers are case-sensitive unless double-quoted; an unquoted or
#   quoted-uppercase `CRM_DB` is a DIFFERENT database object from `crm_db`
#   in the same server (`CREATE DATABASE "CRM_DB"` does not touch `crm_db`).
#   Connecting to it does not reach the live database this check exists to
#   protect, so case-folding the comparison would only produce FALSE BLOCKs
#   on a legitimately different, unrelated database that happens to share
#   letters. Comparison stays case-sensitive.
#
#   NOT A BYPASS, left unmatched on purpose — a MISSING database name
#   (`postgresql://crm_user:password@host:port` with no path segment at
#   all, or a bare trailing `/`). Per the connection-string spec, an absent
#   dbname defaults to the CONNECTING USER's name (`crm_user` in every
#   DATABASE_URL this repo's tooling generates) — not `crm_db`. A URL
#   shaped this way does not reach the live database either; treating an
#   empty parsed name as dangerous would be scope creep with no real target
#   to protect against, and (worse) would silently start matching "unknown"
#   the same as "known-dangerous", eroding the specific claim this check
#   makes. Left unmatched.
db_name_from_url() {
  local url="$1"
  local no_query="${url%%\?*}"
  local raw="${no_query##*/}"
  # Percent-decode: `%XX` -> the byte it encodes (`%5F` -> `_`). Standard
  # bash idiom — replace `%` with the `\x` prefix printf's `%b` understands,
  # then let `%b` do the hex-escape interpretation.
  local decoded
  decoded="$(printf '%b' "${raw//%/\\x}")"
  # Trim surrounding whitespace (a dangling trailing space is the other
  # round-3 case this same fix closes).
  decoded="${decoded#"${decoded%%[![:space:]]*}"}"
  decoded="${decoded%"${decoded##*[![:space:]]}"}"
  printf '%s' "$decoded"
}

DB_NAME="$(db_name_from_url "$DATABASE_URL")"
if [ "$DB_NAME" = "crm_db" ] && [ "${ALLOW_DEFAULT_DB:-}" != "1" ]; then
  echo "run-landing-e2e-local: DATABASE_URL's database name is 'crm_db' — the live/default one" >&2
  echo "(docker-compose.yml POSTGRES_DB, .env.example DATABASE_URL). Host spelling does not matter:" >&2
  echo "this machine has a 'crm_db' database on BOTH its Postgres servers on :5432 (homebrew AND docker)." >&2
  echo "This script runs db:push + db:seed + a landing fixture seed against it — never point it at your live dev DB." >&2
  echo "Point DATABASE_URL at a scratch database (any other name), or set ALLOW_DEFAULT_DB=1 to override (not recommended)." >&2
  exit 64
fi

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

# FRONTEND_URL / CORS_ORIGINS below deliberately DIVERGE from ci.yml's
# landing-shard job-level env (http://localhost:3000 there — the apps/web CRM
# origin). This script never starts apps/web; the only browser origin that
# ever calls the API in this run is apps/landing's preview server on :3002
# (hardcoded — see apps/landing/vite.config.ts). Review round 2, LOW-1:
# functionally inert either way (the E2E browser reaches the API through
# apps/landing's own /api proxy — VITE_PROXY_API_TARGET below — not a direct
# cross-origin fetch, so CORS never actually engages on this path), but
# :3002 is the value that is actually true for what THIS script starts.
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
