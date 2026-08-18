#!/usr/bin/env bash
# test-gh-clear-label-if-set.sh — proves
# scripts/devops/gh-clear-label-if-set.sh never fails its own exit code over
# label housekeeping, while still surfacing a genuine, repeated failure as a
# loud `::warning::` instead of silence (backlog #96,
# task-infra-honest-ci-verdicts, 2026-08-18).
#
# THE HEADLINE CASE is `transient-5xx-is-forgiven`: it reproduces the exact
# PR #549/#550 shape — the label-removal API call fails with something that
# is NOT a 404 (e.g. a transient 503). The github-script this script
# replaces rethrew on anything but 404, which failed the STEP and reds the
# whole JOB even though the real check (prettier / guard-test) had already
# passed. This script must exit 0 regardless, or it has not fixed anything.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SCRIPT="$GUARD_DIR/gh-clear-label-if-set.sh"
FAKE_GH="$SELF_DIR/lib/fake-gh.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

run_clear() {
  # $1 = FAKE_GH_LABEL_DELETE_RC_SEQUENCE, $2 = FAKE_GH_LABEL_DELETE_MSG_SEQUENCE
  # (may be empty), remaining = extra env assignments as NAME=value.
  local rc_seq="$1" msg_seq="$2"
  shift 2
  local extra_env=("$@")
  local counter
  counter="$(mktemp -u "$WS/label-counter-XXXXXX")"
  env \
    REPO="acme/crm" \
    PR_NUMBER="549" \
    LABEL="hook-bypass-warning" \
    GH_BIN="$FAKE_GH" \
    FAKE_GH_LABEL_DELETE_RC_SEQUENCE="$rc_seq" \
    FAKE_GH_LABEL_DELETE_MSG_SEQUENCE="$msg_seq" \
    FAKE_GH_LABEL_CALL_COUNTER="$counter" \
    RETRY_SLEEP_SECONDS="0" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$SCRIPT"
}

# ── green: label removed on the first try ──────────────────────────────────
assert_green "label removed cleanly on the first attempt" \
  --contains "Removed label 'hook-bypass-warning'" \
  -- run_clear "0" ""

# ── green: 404 (label already absent) is silent success, not a warning ─────
assert_green "a 404 (label already absent) is the ordinary case — no warning" \
  --contains "was not present on PR #549 (nothing to remove)" \
  --not-contains "::warning::" \
  -- run_clear "1" "gh: Label does not exist (HTTP 404)"

# ── green: THE PR #549/#550 SHAPE — a non-404 error never fails the script ─
# This is the case the old actions/github-script rethrew on, failing the
# step and reddening the whole job even though the real check had passed.
assert_green "THE #549/#550 BUG: a transient 503 does not fail this script" \
  --contains "::warning::" \
  --contains "Could not remove label 'hook-bypass-warning'" \
  -- run_clear "1:1:1" "gh: HTTP 503 (Service Unavailable)|gh: HTTP 503 (Service Unavailable)|gh: HTTP 503 (Service Unavailable)" \
       RETRIES=3

# ── green: a transient error that clears on retry succeeds without warning ─
assert_green "a transient error that clears on retry succeeds silently (no warning)" \
  --contains "Removed label 'hook-bypass-warning'" \
  --not-contains "::warning::" \
  -- run_clear "1:0" "gh: HTTP 503 (Service Unavailable)|" \
       RETRIES=3

# ── negative-shaped case, still exit 0 by contract: verify the warning names
#    the label and PR, so the annotation is actually actionable and not just
#    "something failed somewhere" (this IS this script's negative case in
#    spirit — it proves the failure path — even though the script's OWN
#    contract is "exit 0 always"; see its header. A literal assert_red would
#    misdescribe the script's actual, intentional exit-code contract).
assert_green "the exhausted-retries warning names both the label and the PR" \
  --contains "hook-bypass-warning" \
  --contains "PR #549" \
  -- run_clear "1:1" "boom|boom" RETRIES=2

guard_test_summary "test-gh-clear-label-if-set.sh"
