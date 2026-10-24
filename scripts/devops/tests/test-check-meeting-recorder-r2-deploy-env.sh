#!/usr/bin/env bash
# test-check-meeting-recorder-r2-deploy-env.sh — CR-M-2 regression coverage.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-meeting-recorder-r2-deploy-env.sh"
GOOD_ACCOUNT_ID="0123456789abcdef0123456789abcdef"
GOOD_BUCKET="crm-meeting-recorder-media"
GOOD_ACCESS_KEY="R2ACCESSKEY0123456789AB"
GOOD_SECRET_KEY="R2SecretAccessKey0123456789abcdefghijklmnopqrstuvwxyz"

run_guard() {
  CLOUDFLARE_ACCOUNT_ID="${1-}" \
    MEETING_RECORDER_MEDIA_S3_BUCKET="${2-}" \
    MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID="${3-}" \
    MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY="${4-}" \
    bash "$GUARD"
}

check_workflow_wiring() {
  python3 - "$REPO_ROOT/.github/workflows/deploy.yml" <<'PY'
import pathlib
import sys

text = pathlib.Path(sys.argv[1]).read_text()
validate = text.index("- name: Validate meeting recorder media R2 deployment inputs")
write = text.index("- name: Write .env.production via SSH")
block = text[validate:write]

assert validate < write, "R2 validation must run before the production env SSH write"
assert "bash scripts/devops/check-meeting-recorder-r2-deploy-env.sh" in block
for name in (
    "CLOUDFLARE_ACCOUNT_ID",
    "MEETING_RECORDER_MEDIA_S3_BUCKET",
    "MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID",
    "MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY",
):
    assert f"{name}: ${{{{ secrets.{name} }}}}" in block, f"workflow does not pass {name} to preflight"
print("workflow wiring: R2 preflight runs before production env write with all required secrets")
PY
}

echo "== test-check-meeting-recorder-r2-deploy-env.sh =="
echo

assert_green "valid Cloudflare R2 deployment inputs pass" \
  --contains "passed fail-fast validation" \
  -- run_guard "$GOOD_ACCOUNT_ID" "$GOOD_BUCKET" "$GOOD_ACCESS_KEY" "$GOOD_SECRET_KEY"

assert_green "deploy.yml runs the R2 preflight before writing .env.production" \
  --contains "preflight runs before production env write" \
  -- check_workflow_wiring

assert_red "CR-M-2: missing Cloudflare account ID fails before endpoint construction" \
  --contains "CLOUDFLARE_ACCOUNT_ID is required" \
  -- run_guard "" "$GOOD_BUCKET" "$GOOD_ACCESS_KEY" "$GOOD_SECRET_KEY"

assert_red "CR-M-2: missing R2 bucket fails before production env write" \
  --contains "MEETING_RECORDER_MEDIA_S3_BUCKET is required" \
  -- run_guard "$GOOD_ACCOUNT_ID" "" "$GOOD_ACCESS_KEY" "$GOOD_SECRET_KEY"

assert_red "CR-M-2: missing R2 access key fails before production env write" \
  --contains "MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID is required" \
  -- run_guard "$GOOD_ACCOUNT_ID" "$GOOD_BUCKET" "" "$GOOD_SECRET_KEY"

assert_red "CR-M-2: missing R2 secret key fails before production env write" \
  --contains "MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY is required" \
  -- run_guard "$GOOD_ACCOUNT_ID" "$GOOD_BUCKET" "$GOOD_ACCESS_KEY" ""

assert_red "malformed Cloudflare account ID is rejected" \
  --contains "32 hexadecimal characters" \
  -- run_guard "not-an-account-id" "$GOOD_BUCKET" "$GOOD_ACCESS_KEY" "$GOOD_SECRET_KEY"

assert_red "malformed R2 bucket name is rejected" \
  --contains "MEETING_RECORDER_MEDIA_S3_BUCKET must be 3-63" \
  -- run_guard "$GOOD_ACCOUNT_ID" "Bad/Bucket" "$GOOD_ACCESS_KEY" "$GOOD_SECRET_KEY"

assert_red "whitespace-bearing R2 access key is rejected" \
  --contains "MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID is malformed" \
  -- run_guard "$GOOD_ACCOUNT_ID" "$GOOD_BUCKET" "bad access key value" "$GOOD_SECRET_KEY"

assert_red "too-short R2 secret key is rejected" \
  --contains "MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY is malformed" \
  -- run_guard "$GOOD_ACCOUNT_ID" "$GOOD_BUCKET" "$GOOD_ACCESS_KEY" "too-short"

guard_test_summary "test-check-meeting-recorder-r2-deploy-env.sh"
