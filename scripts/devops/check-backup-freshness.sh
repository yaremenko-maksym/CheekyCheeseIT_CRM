#!/usr/bin/env bash
#
# check-backup-freshness.sh — verify a recent PG backup object exists in R2/S3.
#
# RUNS ON THE VPS, over SSH (see deploy.yml's `deploy` job, step "Check backup
# freshness on VPS (SSH)") — NOT on the GitHub Actions runner. This is
# load-bearing, not a style choice (task-infra-prod-backup-safety-net, round
# 2, 2026-08-03): the owner is splitting the previously-shared R2 API token
# specifically so a compromised API container cannot read or delete 30 days
# of DB dumps. After the split:
#   - GitHub Secrets AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY → a token scoped
#     to `crm-documents` ONLY (what apps/api's container needs).
#   - The token that can read `crm-backups` lives ONLY in /etc/crm-backup.env
#     on the VPS — it is deliberately NEVER a GitHub secret. That is the
#     entire point of the split.
# Round 1 of this task ran this check on the GitHub Actions runner using the
# documents-scoped secrets — exactly the design the split defeats: it would
# Access-Denied on every run once the split lands, and the only two ways to
# make it green again would be to disable the check or hand the app's token
# access to the backups bucket back, i.e. undo the split. Hence: run where
# the backups-scoped credentials legitimately already live — the VPS itself.
#
# task-infra-prod-backup-safety-net (round 1, 2026-08-03) — the original
# reason this exists: the owner found NONE of the three prerequisites for
# automated backups on the live VPS (no /etc/crm-backup.env, no crontab
# entry, not even this repo's pg-backup.sh had ever been copied to the
# server) — prod had been running with ZERO backups since the first deploy,
# and nothing ever noticed.
#
# STDOUT CONTRACT — deploy.yml pipes this over SSH with `capture_stdout:
# true` and only ever reads these three lines. NEVER print secrets,
# endpoints, bucket names, or object keys here: the caller's log-secrecy
# guarantee rests on THIS SCRIPT never emitting them (not on ssh-action's
# stdout/stderr buffering behavior, which this script does not control or
# trust).
#   STATUS=not_configured | stale | fresh
#   AGE_HOURS=<int> | none
#   OBJECTS=found | none | n/a
#
# Exit codes:
#   0  a determinate STATUS was reached (not_configured / stale / fresh) —
#      the caller opens/updates/closes the alert issue based on STATUS.
#   1  could NOT determine the status (the `aws` CLI errored for a reason
#      OTHER than "the bucket/prefix legitimately has zero objects" — e.g.
#      network blip, R2 outage, unexpected CLI failure, bad timestamp). The
#      caller treats this EXACTLY like an SSH connection failure: a check
#      failure, never "backups are missing" — this project does not assert
#      a state it could not actually observe.
#
# Config file: /etc/crm-backup.env (docs/runbooks/deployment.md §8) — the
# SAME file pg-backup.sh's cron sources. Expected to define S3_BUCKET,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_REGION, and optionally
# S3_ENDPOINT. A missing file, or a file missing any of those four required
# vars, is today's actual prod state and yields STATUS=not_configured — not
# an error, a legitimate observation.
#
# Dependencies on the VPS: `aws` CLI v2 (already documented in pg-backup.sh's
# own header — same install step) and `python3` (Ubuntu Server ships it by
# default; used only for portable ISO-8601 age arithmetic).
#
# Tests: scripts/devops/tests/test-check-backup-freshness.sh — positive AND
# negative cases. Note this guard's red is the STATUS line above, not the exit
# code, so the tests assert both: STATUS=stale/not_configured for an observed bad
# state, and exit 1 with NO verdict at all when the aws call fails (a guard that
# reported "no backups" on a network blip would cry wolf; one that reported
# "fresh" would hide an outage — both directions are asserted).
#
# Optional env — TEST-ONLY, never set these in the real cron/SSH invocation:
#   CRM_BACKUP_ENV_FILE   override the config file path (default:
#                         /etc/crm-backup.env) — lets tests point at a temp
#                         file instead of writing to /etc.
#   FAKE_MODE=1           skip the config-file read AND the real `aws` call
#                         entirely — use FAKE_LATEST_TIMESTAMP instead, to
#                         test the age/threshold logic in isolation.
#   FAKE_LATEST_TIMESTAMP ISO-8601 timestamp (or empty string for "no
#                         objects") used AS the newest-object timestamp when
#                         FAKE_MODE=1.
#   MAX_AGE_HOURS         staleness threshold in hours (default: 24)
#   BACKUP_PREFIX         object-key prefix (default: backups/, matches
#                         pg-backup.sh's own upload path)
set -euo pipefail

CRM_BACKUP_ENV_FILE="${CRM_BACKUP_ENV_FILE:-/etc/crm-backup.env}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-24}"
BACKUP_PREFIX="${BACKUP_PREFIX:-backups/}"
FAKE_MODE="${FAKE_MODE:-0}"

# $1=STATUS $2=AGE_HOURS $3=OBJECTS — the ENTIRE stdout contract, see header.
emit() {
  printf 'STATUS=%s\nAGE_HOURS=%s\nOBJECTS=%s\n' "$1" "$2" "$3"
}

LATEST=""

if [ "$FAKE_MODE" = "1" ]; then
  LATEST="${FAKE_LATEST_TIMESTAMP:-}"
  echo "[FAKE_MODE] using FAKE_LATEST_TIMESTAMP='${LATEST:-<empty>}' instead of reading ${CRM_BACKUP_ENV_FILE} / calling aws (test-only path)" >&2
else
  if [ ! -f "$CRM_BACKUP_ENV_FILE" ]; then
    echo "check-backup-freshness: config file not found at ${CRM_BACKUP_ENV_FILE}" >&2
    emit not_configured none n/a
    exit 0
  fi

  # Source into this process's env — never echoed, never written anywhere
  # else. `set -a` so plain KEY=value lines in the file become env for the
  # `aws` invocation below without listing each var by name (aws CLI reads
  # AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY from env automatically).
  set -a
  # shellcheck disable=SC1090  # dynamic path by design (VPS-local config file)
  . "$CRM_BACKUP_ENV_FILE"
  set +a

  MISSING=""
  for var in S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY S3_REGION; do
    if [ -z "${!var:-}" ]; then
      MISSING="${MISSING:+$MISSING }$var"
    fi
  done
  if [ -n "$MISSING" ]; then
    # Variable NAMES only (never values) — safe to log, useful to fix.
    echo "check-backup-freshness: ${CRM_BACKUP_ENV_FILE} is missing required var(s): ${MISSING}" >&2
    emit not_configured none n/a
    exit 0
  fi

  AWS_EXTRA_ARGS=()
  if [ -n "${S3_ENDPOINT:-}" ]; then
    AWS_EXTRA_ARGS+=(--endpoint-url "${S3_ENDPOINT}")
  fi

  set +e
  LATEST=$(aws s3api list-objects-v2 \
      --bucket "$S3_BUCKET" \
      --prefix "$BACKUP_PREFIX" \
      --region "$S3_REGION" \
      "${AWS_EXTRA_ARGS[@]+"${AWS_EXTRA_ARGS[@]}"}" \
      --query 'sort_by(Contents, &LastModified)[-1].LastModified' \
      --output text 2>/dev/null)
  AWS_STATUS=$?
  set -e
  if [ "$AWS_STATUS" -ne 0 ]; then
    # Deliberately generic — no endpoint, no bucket, no raw CLI error text
    # (which could itself echo the endpoint/bucket). Diagnose by SSHing in.
    echo "check-backup-freshness: aws s3api call failed (exit ${AWS_STATUS}) — inspect manually on the VPS, do not trust this as 'no backups'" >&2
    exit 1
  fi
  # `--output text` on an empty/absent query result prints the literal
  # string "None" (not an empty string) — normalise it to empty.
  if [ "$LATEST" = "None" ]; then
    LATEST=""
  fi
fi

if [ -z "$LATEST" ]; then
  emit stale none none
  exit 0
fi

# Portable age computation via python3 (RFC3339 timestamps from `aws s3api`,
# e.g. "2026-08-02T03:00:15+00:00" — datetime.fromisoformat handles it
# identically regardless of which OS/locale runs this).
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
  echo "check-backup-freshness: could not parse the newest object's timestamp" >&2
  exit 1
fi

if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  emit stale "$AGE_HOURS" found
  exit 0
fi

emit fresh "$AGE_HOURS" found
exit 0
