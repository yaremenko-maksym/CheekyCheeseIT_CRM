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
#
# CASE-INSENSITIVITY (PR #558 review, MED): the script matches error text
# lower-cased on purpose, because the two ways a casing drift can go wrong
# are NOT symmetric. The `*-different-casing` cases below prove BOTH
# directions, not just the safe one:
#   - a re-cased RACE message must still retry and recover (if this regresses
#     to case-sensitive, the failure mode is "occasionally needs a manual
#     re-label" — annoying but visible, today's actual starting bug).
#   - a re-cased POLICY message must still fail fast on the FIRST call, not
#     fall through to the retry branch (if THIS regresses, the script starts
#     blindly retrying a merge branch protection will never allow — the
#     retry mechanism stays in place and does nothing, exactly the silent
#     failure this whole task exists to close). The call-count assertion is
#     what actually proves "fast", not just "eventually failed".
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

# ── GREEN: a re-cased race message still retries and recovers ──────────────
# Proves the match is genuinely case-insensitive, not merely coincidentally
# matching GitHub's current casing — if GitHub ever ships ALL-CAPS,
# Title-Case, or any other casing of this same message, this must still
# behave exactly like COUNTER2 above.
COUNTER2B="$WS/counter-race-recovers-different-casing"
assert_green "a DIFFERENTLY-CASED 'Base branch was modified' race still retries and recovers" \
  --contains "transient race" \
  --contains "Merged PR #551 on attempt 2/4" \
  -- run_merge "1:0" "GraphQL: BASE BRANCH WAS MODIFIED. Review and try the merge again. (mergePullRequest)|merged ok" "$COUNTER2B"

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

# ── RED: a re-cased policy refusal STILL fails fast — the case that matters ─
# THE HEADLINE CASE FOR THIS REVIEW ROUND: if this match were still
# case-sensitive, a re-cased policy message would fall through to the
# `*)` catch-all below... which also fails fast today, so a naive test
# could pass here for the WRONG reason (matching the unrecognized-error
# branch, not the policy branch) and hide a real regression. The
# `--contains "refused by branch protection policy"` assertion pins it to
# the RIGHT branch specifically — the unrecognized-error branch prints
# different text ("neither the known base-branch-moved race..."). The call
# count on top of that is what would actually catch a future regression
# where the policy pattern silently moved into the RETRY branch instead.
COUNTER4B="$WS/counter-policy-different-casing"
assert_red "a DIFFERENTLY-CASED policy refusal is still refused by name (not just 'failed'), fast, not retried" \
  --contains "refused by branch protection policy (not a transient error) — not retrying" \
  -- run_merge "1" "GraphQL: The Base Branch Policy Prohibits The Merge (mergePullRequest)" "$COUNTER4B" MAX_ATTEMPTS=4

CALLS4B="$(cat "$COUNTER4B" 2>/dev/null || echo '?')"
if [ "$CALLS4B" = "1" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] differently-cased policy refusal ALSO made exactly ONE gh call (did not silently start retrying)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] differently-cased policy refusal made exactly ONE gh call\n'
  printf '      reason: expected call count 1, got %s — a case-sensitivity regression would show up EXACTLY as this: the script silently retrying a merge branch protection will never allow.\n' "$CALLS4B"
fi

# ── RED: an unrecognized error also fails fast (unknown != blindly retried) ─
COUNTER5="$WS/counter-unknown"
assert_red "an unrecognized error fails fast too — unknown is not a license to retry" \
  --contains "neither the known base-branch-moved race nor the known policy refusal" \
  -- run_merge "1" "GraphQL: some brand new error message nobody has seen (mergePullRequest)" "$COUNTER5" MAX_ATTEMPTS=4

guard_test_summary "test-gh-merge-pr-with-retry.sh"
