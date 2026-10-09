#!/usr/bin/env bash
# Real Chrome -> local CRM -> private R2 -> CRM playback pilot.
# Uses an isolated local database and the dedicated Meeting Recorder R2 credentials.
set -euo pipefail
set -m

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXTENSION_REPO="${MEETING_RECORDER_EXTENSION_REPO:-$REPO_ROOT/../chrome-recording-transcription-extension}"
SCRATCH_DB="crm_meeting_recorder_r0"
DATABASE_URL="postgresql://crm_user:password@127.0.0.1:5432/$SCRATCH_DB"
REDIS_URL="redis://127.0.0.1:6379"
API_PORT="${R0_API_PORT:-3011}"
CRM_PUBLIC_ORIGIN="${R0_CRM_PUBLIC_ORIGIN:-https://127.0.0.1:3443}"
MEDIA_BUCKET="${MEETING_RECORDER_MEDIA_S3_BUCKET:-crm-meeting-recorder-media-staging}"
MEDIA_ENDPOINT="${MEETING_RECORDER_MEDIA_S3_ENDPOINT:-}"
MEDIA_ACCESS_KEY="${MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID:-}"
MEDIA_SECRET_KEY="${MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY:-}"

if [ -z "$MEDIA_ENDPOINT" ] || [ -z "$MEDIA_ACCESS_KEY" ] || [ -z "$MEDIA_SECRET_KEY" ]; then
  echo "run-meeting-recorder-r0-pilot: dedicated R2 credentials are required." >&2
  echo "Set MEETING_RECORDER_MEDIA_S3_ENDPOINT, MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID," >&2
  echo "and MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY. Do not reuse CRM document credentials." >&2
  exit 64
fi
if [ ! -d "$EXTENSION_REPO" ]; then
  echo "run-meeting-recorder-r0-pilot: extension repo not found at $EXTENSION_REPO" >&2
  exit 64
fi

if [ -n "${R0_R2_UPLOAD_ORIGIN:-}" ]; then
  R2_UPLOAD_ORIGIN="$R0_R2_UPLOAD_ORIGIN"
else
  R2_UPLOAD_ORIGIN="$(node -e '
const bucket = process.argv[1];
const endpoint = new URL(process.argv[2]);
if (endpoint.protocol !== "https:") throw new Error("R2 endpoint must be HTTPS");
endpoint.hostname = bucket + "." + endpoint.hostname;
console.log(endpoint.origin);
' "$MEDIA_BUCKET" "$MEDIA_ENDPOINT")"
fi
node -e 'new URL(process.argv[1])' "$R2_UPLOAD_ORIGIN"

cd "$REPO_ROOT"
docker compose up -d postgres redis >/dev/null

if ! docker compose exec -T postgres psql -U crm_user -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$SCRATCH_DB'" | grep -qx 1; then
  docker compose exec -T postgres createdb -U crm_user "$SCRATCH_DB"
fi

echo "==> Preparing scratch CRM database: $SCRATCH_DB"
DATABASE_URL="$DATABASE_URL" pnpm --filter @crm/api db:push
DATABASE_URL="$DATABASE_URL" pnpm --filter @crm/api db:seed

API_LOG="${TMPDIR:-/tmp}/meeting-recorder-r0-api.log"
cleanup() {
  if [ -n "${API_PID:-}" ]; then
    kill -s TERM -- "-$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> Starting isolated CRM API on :$API_PORT"
env \
  NODE_ENV=development \
  DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  API_PORT="$API_PORT" \
  FRONTEND_URL="$CRM_PUBLIC_ORIGIN" \
  MEETING_RECORDER_MEDIA_S3_ENDPOINT="$MEDIA_ENDPOINT" \
  MEETING_RECORDER_MEDIA_S3_FORCE_PATH_STYLE=false \
  MEETING_RECORDER_MEDIA_S3_REGION=auto \
  MEETING_RECORDER_MEDIA_S3_BUCKET="$MEDIA_BUCKET" \
  MEETING_RECORDER_MEDIA_S3_USE_SSE=false \
  MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID="$MEDIA_ACCESS_KEY" \
  MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY="$MEDIA_SECRET_KEY" \
  scripts/devops/dev-ttl.sh --ttl 1800 -- pnpm --filter @crm/api dev >"$API_LOG" 2>&1 &
API_PID=$!

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "run-meeting-recorder-r0-pilot: CRM API exited during startup; log: $API_LOG" >&2
    tail -80 "$API_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then
  echo "run-meeting-recorder-r0-pilot: CRM API did not become healthy; log: $API_LOG" >&2
  tail -80 "$API_LOG" >&2 || true
  exit 1
fi

echo "==> Building extension and running the real-R2 Chrome pilot"
(
  cd "$EXTENSION_REPO"
  npm run build:e2e:mock
  R0_CRM_UPSTREAM="http://127.0.0.1:$API_PORT" \
    R0_CRM_PUBLIC_ORIGIN="$CRM_PUBLIC_ORIGIN" \
    R0_R2_UPLOAD_ORIGIN="$R2_UPLOAD_ORIGIN" \
    npx playwright test tests/e2e/crm-media-r0.spec.ts --config=playwright.config.ts
)
