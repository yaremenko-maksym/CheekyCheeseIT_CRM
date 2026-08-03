#!/usr/bin/env bash
#
# check-backup-freshness.sh — verify a recent PG backup object exists in R2/S3.
#
# task-infra-prod-backup-safety-net (2026-08-03): the owner found on the LIVE
# VPS that none of the three prerequisites for automated backups existed —
# no /etc/crm-backup.env, no crontab entry, and (before this same PR's
# copy-compose change) not even scripts/devops/pg-backup.sh itself had ever
# been copied to the server. Prod had been running with ZERO backups since
# the very first deploy, and nothing in the pipeline ever noticed. This
# script closes the "nobody would know" half of that gap: it is run after
# every `Deploy` (see the `deploy` job in .github/workflows/deploy.yml) and
# checks whether the backups bucket received a fresh object recently. The
# alert itself is NOT reimplemented here — the caller feeds this script's
# pass/fail into scripts/devops/post-merge-alert.sh (KIND=backup), the exact
# same open/comment/close mechanic already built for a red `Deploy` /
# red post-merge CI. See that script's header for the shared state model.
#
# This script only OBSERVES (`aws s3api list-objects-v2`, read-only) — it
# never writes or deletes anything in the bucket, unlike pg-backup.sh itself
# (whose retention-prune DOES delete old objects).
#
# Required env (unless FAKE_MODE=1 — see below):
#   S3_BUCKET               bucket holding the backup objects (e.g. crm-backups)
#   AWS_ACCESS_KEY_ID        \
#   AWS_SECRET_ACCESS_KEY     } R2/S3 credentials — same scope as pg-backup.sh
#   S3_REGION                / (R2: "auto"; AWS S3: e.g. "eu-central-1")
# Optional env:
#   S3_ENDPOINT              R2 endpoint URL; omit for AWS S3's default endpoint
#   BACKUP_PREFIX            object-key prefix to look under (default: backups/,
#                            matches pg-backup.sh's own upload path)
#   MAX_AGE_HOURS            staleness threshold in hours (default: 24)
#   FAKE_MODE                1 → skip the real `aws` call entirely and use
#                            FAKE_LATEST_TIMESTAMP instead — TEST-ONLY, lets
#                            the pass/fail branches be proven locally without
#                            real credentials or network access. NEVER set
#                            FAKE_MODE in the production workflow.
#   FAKE_LATEST_TIMESTAMP    ISO-8601 timestamp (or empty string for "no
#                            objects found") used AS the "most recent object"
#                            timestamp when FAKE_MODE=1.
#
# Writes (if $GITHUB_OUTPUT is set — silently skipped when run locally):
#   fresh        true | false
#   latest       ISO-8601 timestamp of the newest object, or "none"
#   age_hours    integer hours since that object, or "n/a"
#   detail       one-line human-readable summary for the alert body
#
# Exit code: 0 = fresh backup found; 1 = stale, missing, or misconfigured —
# fail-loud on purpose (project convention: an alert channel that can go
# silent on its own misconfiguration is worse than a false alarm).
set -euo pipefail

MAX_AGE_HOURS="${MAX_AGE_HOURS:-24}"
BACKUP_PREFIX="${BACKUP_PREFIX:-backups/}"
FAKE_MODE="${FAKE_MODE:-0}"

write_output() {
  # $1=key $2=value — no-op when $GITHUB_OUTPUT isn't set (local runs).
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1=$2" >> "$GITHUB_OUTPUT"
  fi
}

fail() {
  # $1=detail (human-readable, goes into the alert body via post-merge-alert.sh)
  write_output fresh false
  write_output latest "${LATEST:-none}"
  write_output age_hours "${AGE_HOURS:-n/a}"
  write_output detail "$1"
  echo "::error::check-backup-freshness.sh: $1" >&2
  exit 1
}

LATEST=""
AGE_HOURS=""

if [ "$FAKE_MODE" = "1" ]; then
  LATEST="${FAKE_LATEST_TIMESTAMP:-}"
  echo "[FAKE_MODE] using FAKE_LATEST_TIMESTAMP='${LATEST:-<empty>}' instead of querying S3 (test-only path)"
else
  for var in S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_REGION; do
    if [ -z "${!var:-}" ]; then
      fail "Проверка не выполнена: не задан \$$var"
    fi
  done

  AWS_EXTRA_ARGS=()
  if [ -n "${S3_ENDPOINT:-}" ]; then
    AWS_EXTRA_ARGS+=(--endpoint-url "${S3_ENDPOINT}")
  fi

  echo "==> Listing s3://${S3_BUCKET}/${BACKUP_PREFIX} (region=${S3_REGION})"
  set +e
  LATEST=$(AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
    aws s3api list-objects-v2 \
      --bucket "$S3_BUCKET" \
      --prefix "$BACKUP_PREFIX" \
      --region "$S3_REGION" \
      "${AWS_EXTRA_ARGS[@]+"${AWS_EXTRA_ARGS[@]}"}" \
      --query 'sort_by(Contents, &LastModified)[-1].LastModified' \
      --output text 2>&1)
  AWS_STATUS=$?
  set -e
  if [ "$AWS_STATUS" -ne 0 ]; then
    fail "Не удалось обратиться к бакету \`${S3_BUCKET}\` (AWS CLI код ${AWS_STATUS}): $(printf '%s' "$LATEST" | tr '\n' ' ' | cut -c1-200)"
  fi
  # `--output text` on an empty/absent query result prints the literal
  # string "None" (not an empty string) — normalise it to empty.
  if [ "$LATEST" = "None" ]; then
    LATEST=""
  fi
fi

if [ -z "$LATEST" ]; then
  fail "В бакете \`${S3_BUCKET:-<unset>}\` не найдено ни одного объекта резервной копии под префиксом \`${BACKUP_PREFIX}\` — см. docs/runbooks/deployment.md §8."
fi

# Portable age computation via python3 (hard dependency of this repo — see
# post-merge-alert.sh's own header comment on why: GNU vs BSD/macOS `date -d`
# behave differently, but `datetime.fromisoformat` doesn't care which OS runs
# it). `aws s3api` timestamps are RFC3339, e.g. "2026-08-02T03:00:15+00:00".
if ! AGE_HOURS=$(python3 - "$LATEST" <<'PYEOF'
import sys, datetime
raw = sys.argv[1].strip()
try:
    dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
except ValueError:
    sys.exit(1)
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=datetime.timezone.utc)
now = datetime.datetime.now(datetime.timezone.utc)
print(int((now - dt).total_seconds() // 3600))
PYEOF
); then
  fail "Не удалось разобрать timestamp последнего объекта: \`${LATEST}\`"
fi

echo "==> Newest backup object: ${LATEST} (age: ${AGE_HOURS}h, threshold: ${MAX_AGE_HOURS}h)"

if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  fail "Последняя резервная копия от \`${LATEST}\` — ${AGE_HOURS}ч назад (порог ${MAX_AGE_HOURS}ч). pg-backup.sh cron не настроен или не отрабатывает — см. docs/runbooks/deployment.md §8."
fi

echo "Backup freshness check PASSED (${AGE_HOURS}h old, threshold ${MAX_AGE_HOURS}h)"
write_output fresh true
write_output latest "$LATEST"
write_output age_hours "$AGE_HOURS"
write_output detail "Последняя резервная копия от \`${LATEST}\` — ${AGE_HOURS}ч назад (порог ${MAX_AGE_HOURS}ч)."
exit 0
