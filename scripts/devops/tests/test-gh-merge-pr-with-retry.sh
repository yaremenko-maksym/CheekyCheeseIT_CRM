#!/usr/bin/env bash
# test-gh-merge-pr-with-retry.sh — proves
# scripts/devops/gh-merge-pr-with-retry.sh retries ONLY the harmless
# "Base branch was modified" race and fails FAST (no retry) on the
# unrelated "the base branch policy prohibits the merge" refusal, telling
# them apart by error TEXT, not exit code (backlog #103,
# task-infra-honest-ci-verdicts, 2026-08-18).
#
# THE TWO HEADLINE CASES reproduce the exact shapes named in the backlog
# item:
#   - `race-recovers-on-retry`: 2026-08-17's six-PR pile-up — the FIRST
#     attempt hits "Base branch was modified", the SECOND succeeds. Must
#     end up merged.
#   - `policy-refusal-fails-fast`: backlog #40 / PR #503's failure mode —
#     "the base branch policy prohibits the merge". Must fail on the FIRST
#     attempt, with NO retry (proven by asserting the fake only ever saw
#     one call).
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SCRIPT="$GUARD_DIR/gh-merge-pr-with-retry.sh"
FAKE_GH="$SELF_DIR/lib/fake-gh.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

run_merge() {
  # $1 = FAKE_GH_MERGE_RC_SEQUENCE, $2 = FAKE_GH_MERGE_MSG_SEQUENCE,
  # $3 = path to write the call-counter to (so a case can assert call COUNT,
  # not just outcome), remaining = extra env assignments as NAME=value.
  local rc_seq="$1" msg_seq="$2" counter="$3"
  shift 3
  local extra_env=("$@")
  env \
    REPO="acme/crm" \
    PR_NUMBER="551" \
    GH_BIN="$FAKE_GH" \
    FAKE_GH_MERGE_RC_SEQUENCE="$rc_seq" \
    FAKE_GH_MERGE_MSG_SEQUENCE="$msg_seq" \
    FAKE_GH_MERGE_CALL_COUNTER="$counter" \
    RETRY_SLEEP_SECONDS="0" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$SCRIPT"
}

# ── green: merges cleanly on the first try, no retry needed ────────────────
COUNTER1="$WS/counter-clean"
assert_green "merges cleanly on the first attempt" \
  --contains "Merged PR #551 on attempt 1/4" \
  -- run_merge "0" "" "$COUNTER1"

# ── GREEN: THE 2026-08-17 SHAPE — race on attempt 1, succeeds on attempt 2 ─
COUNTER2="$WS/counter-race-recovers"
assert_green "THE 2026-08-17 SHAPE: 'Base branch was modified' race recovers on retry" \
  --contains "transient race" \
  --contains "Merged PR #551 on attempt 2/4" \
  -- run_merge "1:0" "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)|merged ok" "$COUNTER2"

# ── RED: the race keeps recurring past MAX_ATTEMPTS — gives up, named ──────
COUNTER3="$WS/counter-race-exhausted"
assert_red "the race is retried up to MAX_ATTEMPTS, then reported by name, not silently" \
  --contains "kept hitting the 'Base branch was modified' race after 2 attempts" \
  -- run_merge "1:1" \
       "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)|GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)" \
       "$COUNTER3" MAX_ATTEMPTS=2

# ── RED: THE #40/#503 SHAPE — policy refusal fails FAST, no retry at all ───
COUNTER4="$WS/counter-policy"
assert_red "THE #40/#503 SHAPE: branch-protection policy refusal is not retried" \
  --contains "refused by branch protection policy (not a transient error) — not retrying" \
  -- run_merge "1" "GraphQL: the base branch policy prohibits the merge (mergePullRequest)" "$COUNTER4" MAX_ATTEMPTS=4

# Prove it FAILED FAST — exactly one call, not four. A guard that merely
# prints the right words while still burning the whole retry budget would
# still be masking the real cause behind a manufactured "gave up" delay.
CALLS4="$(cat "$COUNTER4" 2>/dev/null || echo '?')"
if [ "$CALLS4" = "1" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] policy refusal made exactly ONE gh call, not %s (no wasted retries)\n' "4"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] policy refusal made exactly ONE gh call, not 4\n'
  printf '      reason: expected call count 1, got %s\n' "$CALLS4"
fi

# ── RED: an unrecognized error also fails fast (unknown != blindly retried) ─
COUNTER5="$WS/counter-unknown"
assert_red "an unrecognized error fails fast too — unknown is not a license to retry" \
  --contains "neither the known base-branch-moved race nor the known policy refusal" \
  -- run_merge "1" "GraphQL: some brand new error message nobody has seen (mergePullRequest)" "$COUNTER5" MAX_ATTEMPTS=4

guard_test_summary "test-gh-merge-pr-with-retry.sh"
