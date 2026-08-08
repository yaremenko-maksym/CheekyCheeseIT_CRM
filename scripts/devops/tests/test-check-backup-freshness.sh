#!/usr/bin/env bash
# test-check-backup-freshness.sh — proves scripts/devops/check-backup-freshness.sh
# actually reports a bad backup state instead of quietly saying "fresh".
#
# READ THIS BEFORE JUDGING THE ASSERTIONS: this guard's red is NOT an exit code.
# Its contract (see the script's own STDOUT CONTRACT header) is three stdout
# lines, and exit 0 means "I reached a determinate verdict", not "backups are
# fine". deploy.yml opens/closes the alert issue off STATUS. So:
#   - a stale/absent backup  -> STATUS=stale, exit 0   (assert_red_signal)
#   - "I could not tell"     -> exit 1                 (assert_red)
# The exit-1 branch is the one that matters most and is the easiest to get
# wrong: a guard that reports "no backups" when the S3 call merely failed would
# cry wolf on every network blip, and a guard that reports "fresh" in that case
# would hide a real outage. Both directions are asserted below.
#
# The `aws` CLI is replaced by a PATH shim, so these cases run offline and can
# exercise the failure branch — which no test against a real bucket could.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-backup-freshness.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

NOW_ISO="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())')"
OLD_ISO="$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=72)).isoformat())')"

# A config file with every var the guard requires. Values are fake; the `aws`
# shim below never uses them.
ENV_FILE="$WS/crm-backup.env"
cat >"$ENV_FILE" <<'ENVEOF'
S3_BUCKET=crm-backups-fixture
AWS_ACCESS_KEY_ID=fixture-key-id
AWS_SECRET_ACCESS_KEY=fixture-secret
S3_REGION=auto
S3_ENDPOINT=https://fixture.r2.cloudflarestorage.com
ENVEOF

INCOMPLETE_ENV_FILE="$WS/crm-backup-incomplete.env"
cat >"$INCOMPLETE_ENV_FILE" <<'ENVEOF'
S3_BUCKET=crm-backups-fixture
S3_REGION=auto
ENVEOF

# $1 = shim name suffix, $2 = shim body -> echoes the dir to prepend to PATH
make_aws_shim() {
  local name="$1" body="$2"
  local root="$WS/shim-$name"
  guard_test_shim "$root" aws "$body"
  printf '%s' "$root/bin"
}

FRESH_SHIM="$(make_aws_shim fresh "#!/bin/sh
echo '$NOW_ISO'")"
STALE_SHIM="$(make_aws_shim stale "#!/bin/sh
echo '$OLD_ISO'")"
# `aws s3api --output text` prints the literal string None when the query
# matched nothing — i.e. the bucket exists and is EMPTY. That is "no backups",
# not an error.
EMPTY_SHIM="$(make_aws_shim empty "#!/bin/sh
echo None")"
FAILING_SHIM="$(make_aws_shim failing "#!/bin/sh
echo 'An error occurred (AccessDenied) when calling ListObjectsV2' >&2
exit 255")"
GARBAGE_SHIM="$(make_aws_shim garbage "#!/bin/sh
echo 'yesterday-ish'")"

# Runs the guard with a shimmed PATH and an explicit config-file override.
# $1 = PATH prefix dir, $2 = config file
run_guard() {
  local shim_dir="$1" env_file="$2"
  PATH="$shim_dir:$PATH" CRM_BACKUP_ENV_FILE="$env_file" bash "$GUARD"
}

# No shim needed: FAKE_MODE bypasses both the config read and the aws call.
run_fake() {
  FAKE_MODE=1 FAKE_LATEST_TIMESTAMP="$1" bash "$GUARD"
}

echo "== test-check-backup-freshness.sh =="
echo

# ── positive ───────────────────────────────────────────────────────────────────
assert_green "a backup uploaded just now reports STATUS=fresh" \
  --contains "STATUS=fresh" \
  --contains "OBJECTS=found" \
  -- run_guard "$FRESH_SHIM" "$ENV_FILE"

assert_green "FAKE_MODE with a current timestamp reports STATUS=fresh" \
  --contains "STATUS=fresh" \
  -- run_fake "$NOW_ISO"

# ── negative ───────────────────────────────────────────────────────────────────
assert_red_signal "72h-old backup reports STATUS=stale, never fresh" \
  --contains "STATUS=stale" \
  --contains "AGE_HOURS=72" \
  --not-contains "STATUS=fresh" \
  -- run_guard "$STALE_SHIM" "$ENV_FILE"

assert_red_signal "THE CHEAT: bucket exists but holds NO objects -> stale, not fresh" \
  --contains "STATUS=stale" \
  --contains "OBJECTS=none" \
  --not-contains "STATUS=fresh" \
  -- run_guard "$EMPTY_SHIM" "$ENV_FILE"

assert_red_signal "no config file on the VPS at all -> not_configured (today's real prod gap)" \
  --contains "STATUS=not_configured" \
  --not-contains "STATUS=fresh" \
  -- run_guard "$FRESH_SHIM" "$WS/nonexistent-crm-backup.env"

assert_red_signal "config file present but missing required vars -> not_configured" \
  --contains "STATUS=not_configured" \
  --contains "missing required var(s)" \
  --not-contains "STATUS=fresh" \
  -- run_guard "$FRESH_SHIM" "$INCOMPLETE_ENV_FILE"

assert_red "aws call fails -> exit 1 and NO verdict at all (never 'backups missing')" \
  --contains "do not trust this as 'no backups'" \
  --not-contains "STATUS=" \
  -- run_guard "$FAILING_SHIM" "$ENV_FILE"

assert_red "unparseable object timestamp -> exit 1, no verdict invented" \
  --contains "could not parse" \
  --not-contains "STATUS=fresh" \
  -- run_guard "$GARBAGE_SHIM" "$ENV_FILE"

guard_test_summary "test-check-backup-freshness.sh"
