#!/usr/bin/env bash
# gh-clear-label-if-set.sh — remove a bookkeeping label from a PR without
# EVER failing the calling job (backlog item 96, task-infra-honest-ci-verdicts,
# 2026-08-18).
#
# WHY THIS EXISTS: check-no-skip-hooks.yml's "check-formatting" job and
# guard-test-gate.yml's "guard-test" job each end with a housekeeping step
# that clears a label the job itself may have added on an earlier, now-fixed
# run (`hook-bypass-warning` / `needs-guard-test`). That step used to be
# inline `actions/github-script`, whose try/catch forgave ONLY a 404 ("label
# was never there") and RETHREW anything else — including a transient 503
# from the GitHub API. A rethrow inside actions/github-script fails the
# STEP, and a failed step reds the whole JOB, even though the actual check
# the job exists to run (prettier --check / the guard-test heuristic) had
# already printed "All matched files use Prettier code style!" two steps
# earlier. PR #549 and #550 (2026-08-17) hit exactly this: `steps[]` showed
# the LABEL-removal step failed, not the check.
#
# THE FIX: label housekeeping can never legitimately red a job that is not
# about labels — this script ALWAYS exits 0 (see "Exit codes" below).
#   - A genuinely-missing label (404) is the expected common case (the
#     label was already absent, or a previous run already cleared it) and
#     is silent.
#   - Anything else (5xx, network, auth) gets a bounded retry — transient
#     5xx is the norm for a REST API under load, and retrying costs seconds
#     against a job that already has the real answer.
#   - If every attempt still fails, that is NOT swallowed silently (that
#     would just trade a false red for silent label drift) — a loud
#     `::warning::` annotation names the reason, visible on the job summary,
#     without turning an unrelated check red over it.
#
# Env:
#   REPO         owner/repo (required)
#   PR_NUMBER    pull request number (required)
#   LABEL        label name to remove (required)
#   GH_BIN       gh binary to invoke (default: gh) — tests point this at
#                tests/lib/fake-gh.sh.
#   RETRIES      attempts total, including the first (default: 3)
#   RETRY_SLEEP_SECONDS  pause between attempts (default: 2)
#
# Exit codes: ALWAYS 0. Nothing downstream should branch on this script's
# exit code — branch on the `::warning::` annotation (or its own stdout) if
# you need to know whether the label was actually removed.
#
# Tests: scripts/devops/tests/test-gh-clear-label-if-set.sh
set -u

REPO="${REPO:?REPO env var required (owner/repo)}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER env var required}"
LABEL="${LABEL:?LABEL env var required}"
GH_BIN="${GH_BIN:-gh}"
RETRIES="${RETRIES:-3}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-2}"

attempt=1
last_out=""
while [ "$attempt" -le "$RETRIES" ]; do
  last_out="$("$GH_BIN" api -X DELETE "repos/$REPO/issues/$PR_NUMBER/labels/$LABEL" 2>&1)"
  rc=$?

  if [ "$rc" -eq 0 ]; then
    echo "Removed label '$LABEL' from PR #$PR_NUMBER."
    exit 0
  fi

  # 404 ("Label does not exist") is the ordinary case — the label was
  # already absent (the check passed clean, or a previous run already
  # cleared it). Not an error worth a warning, not worth retrying.
  case "$last_out" in
    *"HTTP 404"* | *"Not Found"*)
      echo "Label '$LABEL' was not present on PR #$PR_NUMBER (nothing to remove)."
      exit 0
      ;;
  esac

  if [ "$attempt" -lt "$RETRIES" ]; then
    echo "Attempt $attempt/$RETRIES to remove label '$LABEL' failed, retrying in ${RETRY_SLEEP_SECONDS}s:"
    printf '%s\n' "$last_out"
    sleep "$RETRY_SLEEP_SECONDS"
  fi
  attempt=$((attempt + 1))
done

echo "::warning::Could not remove label '$LABEL' from PR #$PR_NUMBER after $RETRIES attempt(s) — leaving it in place. This does NOT affect this job's own check verdict. Last error: $last_out"
exit 0
