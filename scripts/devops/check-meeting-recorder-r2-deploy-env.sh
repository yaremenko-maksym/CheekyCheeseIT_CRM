#!/usr/bin/env bash
# check-meeting-recorder-r2-deploy-env.sh — fail-fast production preflight for
# the dedicated meeting-recorder Cloudflare R2 store (PR #869 CR-M-2).
#
# This guard is deliberately local/syntactic: it runs on the GitHub runner
# before deploy.yml opens the SSH step that writes /opt/crm/.env.production.
# It verifies every input used to construct that production endpoint and rejects
# whitespace-bearing credentials so a pasted multiline value cannot corrupt the
# env file. It never prints credential values.
set -u

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
BUCKET="${MEETING_RECORDER_MEDIA_S3_BUCKET:-}"
ACCESS_KEY_ID="${MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID:-}"
SECRET_ACCESS_KEY="${MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY:-}"

FAIL=0

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  FAIL=1
}

require_nonempty() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    fail "$name is required for the dedicated meeting-recorder R2 deployment."
  fi
}

require_nonempty "CLOUDFLARE_ACCOUNT_ID" "$ACCOUNT_ID"
require_nonempty "MEETING_RECORDER_MEDIA_S3_BUCKET" "$BUCKET"
require_nonempty "MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID" "$ACCESS_KEY_ID"
require_nonempty "MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY" "$SECRET_ACCESS_KEY"

# Do not run shape checks on missing values; the required-value errors above are
# more useful and avoid emitting a pile of secondary diagnostics.
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

# Cloudflare account IDs are 32 hexadecimal characters. deploy.yml embeds this
# value directly into https://<account-id>.r2.cloudflarestorage.com.
if ! [[ "$ACCOUNT_ID" =~ ^[0-9A-Fa-f]{32}$ ]]; then
  fail "CLOUDFLARE_ACCOUNT_ID must be exactly 32 hexadecimal characters."
fi

# R2 bucket names are DNS-safe lower-case names. Hold the deployment to the
# provider's 3..63 character shape before the API ever sees the value.
if [ "${#BUCKET}" -lt 3 ] || [ "${#BUCKET}" -gt 63 ] || \
  ! [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]]; then
  fail "MEETING_RECORDER_MEDIA_S3_BUCKET must be 3-63 lowercase letters/numbers/hyphens and start/end with a letter or number."
fi

# R2 S3 credentials are opaque, so this guard does not invent an exact provider
# length. It can still reject obvious copy/paste/config corruption: empty values
# (above), whitespace/newlines, and implausibly short values.
if [[ "$ACCESS_KEY_ID" =~ [[:space:]] ]] || [ "${#ACCESS_KEY_ID}" -lt 16 ]; then
  fail "MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID is malformed (must be a single non-whitespace value of at least 16 characters)."
fi
if [[ "$SECRET_ACCESS_KEY" =~ [[:space:]] ]] || [ "${#SECRET_ACCESS_KEY}" -lt 32 ]; then
  fail "MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY is malformed (must be a single non-whitespace value of at least 32 characters)."
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "OK: meeting-recorder Cloudflare R2 deployment inputs passed fail-fast validation."
