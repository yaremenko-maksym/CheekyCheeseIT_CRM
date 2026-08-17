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
#   RETRY:      "Base branch was modified" (case-sensitive match on GitHub's
#               own GraphQL message; the transient race above).
#   FAIL FAST:  "the base branch policy prohibits the merge" (branch
#               protection genuinely not satisfied — backlog #40).
#   FAIL FAST:  anything else. An unrecognized error is exactly the case
#               where blind retrying is LEAST justified — better to name it
#               and stop than to spend the retry budget guessing.
#
# Env:
#   REPO           owner/repo (required)
#   PR_NUMBER      pull request number (required)
#   GH_BIN         gh binary to invoke (default: gh) — tests point this at
#                  tests/lib/fake-gh.sh.
#   MAX_ATTEMPTS   total attempts including the first (default: 4)
#   RETRY_SLEEP_SECONDS  pause between retryable attempts (default: 5)
#
# Exit codes:
#   0  merged (first try or after a retry).
#   1  gave up — either a non-retryable error (fails on the FIRST attempt),
#      or the retryable race kept recurring past MAX_ATTEMPTS.
#
# The caller (.github/workflows/auto-merge-on-label.yml's "Squash and
# merge" step) is unchanged in shape: it still just needs this script's
# exit code to know whether the merge happened, and the "Explain why
# auto-merge did not complete" step downstream keys off THAT step's outcome
# exactly as before — this script does not need to know that step exists.
#
# Tests: scripts/devops/tests/test-gh-merge-pr-with-retry.sh
set -u

REPO="${REPO:?REPO env var required (owner/repo)}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER env var required}"
GH_BIN="${GH_BIN:-gh}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-4}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-5}"

attempt=1
last_out=""
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  last_out="$("$GH_BIN" pr merge "$PR_NUMBER" --repo "$REPO" --squash --delete-branch 2>&1)"
  rc=$?

  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$last_out"
    echo "Merged PR #$PR_NUMBER on attempt $attempt/$MAX_ATTEMPTS."
    exit 0
  fi

  case "$last_out" in
    *"Base branch was modified"*)
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
