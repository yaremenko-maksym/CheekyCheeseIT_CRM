#!/usr/bin/env bash
# gh-merge-pr-with-retry.sh — squash-merges a PR, retrying ONLY the harmless
# "another merge landed on main a moment ago" race, never the "you are not
# allowed to merge this" case (backlog item 103, task-infra-honest-ci-verdicts,
# 2026-08-18).
#
# WHY: 2026-08-17, six PRs got `merge-approved` back to back. Five squashed
# within 40 seconds. The sixth hit
#   GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)
# — it landed in the exact window a sibling merge was rewriting main a
# moment earlier. Nothing about the sixth PR itself was wrong: re-adding
# `merge-approved` re-ran this workflow and it squashed on the very first
# try. That is retry-worthy — a blind, momentary race with the merge
# target, not a verdict about the PR.
#
# It is NOT the same class of error as
#   GraphQL: the base branch policy prohibits the merge (mergePullRequest)
# (backlog item 40 / PR #503's failure mode — a required check genuinely
# missing or not yet green). THAT one must fail fast: retrying it just
# re-asks the same question for the length of the whole retry budget while
# the answer stays no, and worse, it would report "gave up after N tries" —
# a manufactured mystery — instead of the real, current, named reason.
#
# Distinguish PURELY BY THE ERROR TEXT `gh pr merge` prints, not by exit
# code — `gh` exits non-zero for both cases alike; there is no separate
# code for "transient race" vs "policy refusal". Explicitly enumerated
# below:
#   RETRY:      "Base branch was modified" (GitHub's own GraphQL message;
#               the transient race above).
#   FAIL FAST:  "the base branch policy prohibits the merge" (branch
#               protection genuinely not satisfied — backlog #40).
#   FAIL FAST:  anything else. An unrecognized error is exactly the case
#               where blind retrying is LEAST justified — better to name it
#               and stop than to spend the retry budget guessing.
#
# CASE-INSENSITIVE ON PURPOSE (review round, PR #558): both patterns are
# matched against a lower-cased copy of the error text. GitHub does not
# publish a stability guarantee on GraphQL error message casing, and the
# two ways this can go wrong are NOT symmetric — a case-sensitive match
# failing on the RETRY pattern just makes an occasional merge fail once and
# need a manual re-label (annoying, visible, matches today's actual bug);
# failing on the FAIL-FAST policy pattern is worse: the retry loop would
# start blindly re-attempting a merge branch protection will never allow,
# burning the whole retry budget while *looking* like it is doing
# something, before still failing — the exact "mechanism stays in place,
# does nothing" failure mode this fix exists to close. Lower-casing both
# the haystack and the needles once, instead of relying on bash's
# `nocasematch` shell option (a global, easy-to-forget-to-scope toggle),
# keeps the fix local to the two comparisons that need it.
#
# THE CALL ITSELF IS TIMEOUT-WRAPPED (review round 2, PR #558): a hung
# `gh pr merge` (network stall, GitHub API slowness) used to have NO cap —
# this script would just sit inside the `run:` step until GitHub Actions'
# own default 6-HOUR job timeout finally killed it. That is the exact
# failure mode this whole task exists to close, only worse than the
# original bug: `merge-approved` stays on the PR, the job is red for hours
# without ever finishing, and PR #542's "Explain why auto-merge did not
# complete" step — the loud, named-reason signal — NEVER FIRES, because it
# only runs once THIS step reaches a terminal outcome. A silent hang here
# defeats the very mechanism built to prevent silent hangs.
#
# CALL_TIMEOUT_SECONDS default is 60 — reasoning is about ONE call's
# reasonable latency, not the job's lifetime: `gh pr merge` is a single
# synchronous GraphQL mutation, and this repo's own
# check-required-checks-complete.sh already treats 60s as a reasonable cap
# for a comparable single `gh` API round-trip (see CALL_TIMEOUT_SECONDS
# there) — reusing the same number keeps one convention instead of two
# guesses about what "too slow" means for this API.
#
# A TIMED-OUT CALL IS RETRIED, not failed fast — deliberately, and this is
# NOT the same branch as the "Base branch was modified" race (a timeout has
# no GraphQL error text to match; `gh` was killed before it could print
# one). The tradeoff considered: retrying costs more wall-clock time per
# hang (argument against); but a hang is, by nature, MORE likely to be
# transient (network blip, momentary GitHub slowness) than a deterministic
# policy answer is to change on a retry (argument for) — and because each
# attempt is now individually capped at CALL_TIMEOUT_SECONDS, retrying a
# hang is bounded, not unbounded: worst case is
# MAX_ATTEMPTS × CALL_TIMEOUT_SECONDS + (MAX_ATTEMPTS-1) × RETRY_SLEEP_SECONDS
# (≈4 minutes at the defaults below) — a fixed, small ceiling, a world away
# from the 6-hour ceiling this fix removes. A hung call is explicitly NEVER
# read as "the base branch policy prohibits the merge": it has no error
# text at all, so it cannot fall into that `case` pattern by accident
# (see the dedicated `$rc -eq 124` branch below, checked BEFORE the
# text-matching `case`).
#
# Env:
#   REPO           owner/repo (required)
#   PR_NUMBER      pull request number (required)
#   GH_BIN         gh binary to invoke (default: gh) — tests point this at
#                  tests/lib/fake-gh.sh.
#   MAX_ATTEMPTS   total attempts including the first (default: 4)
#   RETRY_SLEEP_SECONDS  pause between retryable attempts (default: 5)
#   CALL_TIMEOUT_SECONDS  cap on a SINGLE `gh pr merge` invocation
#                  (default: 60) — see "THE CALL ITSELF IS TIMEOUT-WRAPPED"
#                  above.
#
# Exit codes:
#   0  merged (first try or after a retry).
#   1  gave up — either a non-retryable error (fails on the FIRST attempt),
#      or a retryable condition (the base-branch race, or a hung call) kept
#      recurring past MAX_ATTEMPTS.
#
# The caller (.github/workflows/auto-merge-on-label.yml's "Squash and
# merge" step) is unchanged in shape: it still just needs this script's
# exit code to know whether the merge happened, and the "Explain why
# auto-merge did not complete" step downstream keys off THAT step's outcome
# exactly as before — this script does not need to know that step exists.
#
# Tests: scripts/devops/tests/test-gh-merge-pr-with-retry.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/run-with-timeout.sh
. "$SCRIPT_DIR/lib/run-with-timeout.sh"

REPO="${REPO:?REPO env var required (owner/repo)}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER env var required}"
GH_BIN="${GH_BIN:-gh}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-4}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-5}"
CALL_TIMEOUT_SECONDS="${CALL_TIMEOUT_SECONDS:-60}"

attempt=1
last_out=""
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  run_with_timeout "$CALL_TIMEOUT_SECONDS" "$GH_BIN" pr merge "$PR_NUMBER" --repo "$REPO" --squash --delete-branch
  last_out="$_TIMEOUT_OUT"
  rc="$_TIMEOUT_RC"

  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$last_out"
    echo "Merged PR #$PR_NUMBER on attempt $attempt/$MAX_ATTEMPTS."
    exit 0
  fi

  # A hung call (see "THE CALL ITSELF IS TIMEOUT-WRAPPED" above) has no
  # GraphQL error text to match — checked BEFORE the text-based `case`
  # below so it can never be misread as the policy-refusal branch.
  if [ "$rc" -eq 124 ]; then
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "Attempt $attempt/$MAX_ATTEMPTS: 'gh pr merge' did not respond within ${CALL_TIMEOUT_SECONDS}s (hung call, treated as transient) — retrying in ${RETRY_SLEEP_SECONDS}s."
      [ -n "$last_out" ] && printf '%s\n' "$last_out"
      sleep "$RETRY_SLEEP_SECONDS"
      attempt=$((attempt + 1))
      continue
    fi
    echo "::error::gh pr merge did not respond within ${CALL_TIMEOUT_SECONDS}s on any of $MAX_ATTEMPTS attempts — giving up. This is a HUNG CALL (network stall / GitHub API slowness), not a policy refusal and not the base-branch race — the merge's actual outcome is unknown; check the PR and GitHub's status page before re-adding merge-approved."
    exit 1
  fi

  # Bash-3.2 compatible lower-casing (no `${var,,}`, that's bash 4+) — same
  # constraint tests/lib/harness.sh and check-required-checks-complete.sh
  # already document for this repo's guard scripts.
  last_out_lc="$(printf '%s' "$last_out" | tr '[:upper:]' '[:lower:]')"

  case "$last_out_lc" in
    *"base branch was modified"*)
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "Attempt $attempt/$MAX_ATTEMPTS: base branch moved under the merge (transient race) — retrying in ${RETRY_SLEEP_SECONDS}s:"
        printf '%s\n' "$last_out"
        sleep "$RETRY_SLEEP_SECONDS"
        attempt=$((attempt + 1))
        continue
      fi
      echo "::error::gh pr merge kept hitting the 'Base branch was modified' race after $MAX_ATTEMPTS attempts — giving up. Last error:"
      printf '%s\n' "$last_out"
      exit 1
      ;;
    *"the base branch policy prohibits the merge"*)
      # (Matched case-insensitively above — see the CASE-INSENSITIVE header
      # note for why this branch, specifically, must not be the one that
      # silently degrades into a retry if GitHub ever re-cases this string.)
      echo "::error::gh pr merge was refused by branch protection policy (not a transient error) — not retrying. This usually means a required check is not actually green/complete yet; see backlog #40 / scripts/devops/check-required-checks-complete.sh. Error:"
      printf '%s\n' "$last_out"
      exit 1
      ;;
    *)
      echo "::error::gh pr merge failed with an unrecognized error (neither the known base-branch-moved race nor the known policy refusal) — not retrying:"
      printf '%s\n' "$last_out"
      exit 1
      ;;
  esac
done
