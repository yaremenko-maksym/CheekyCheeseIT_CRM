#!/usr/bin/env bash
# owner-verdict-wait-checks.sh — waits until every required context is green ON ONE COMMIT
# (HEAD_SHA), for owner-verdict-merge.yml. check-required-checks-complete.sh asks
# `gh pr checks <number>`, which follows the PR's CURRENT head: a push after the verdict would be
# waited on instead of the verified commit. This reads `commits/HEAD_SHA/check-runs` instead.
#
# A context is satisfied when its latest GitHub Actions check run (app id 15368 — what
# branch protection pins every required context to, so another app cannot post a look-alike) on
# HEAD_SHA is completed with success / skipped / neutral. Any other completed conclusion fails at
# once. A context with no run yet, or a run in progress, is pending — and pending at the timeout is
# a failure: a missing check is never read as a green one. A failed or unparseable API read is
# transient (the next poll retries it), never a pass.
# Env: REPO, HEAD_SHA, REQUIRED_CONTEXTS (one per line), REPORT_FILE (optional), GH_BIN (default
#      gh), INTERVAL_SECONDS (15), TIMEOUT_SECONDS (600), CALL_TIMEOUT_SECONDS (60).
# Exit: 0 all satisfied; 1 a failure, a timeout, or bad input.
# Tests: scripts/devops/tests/test-check-owner-approval.sh (section "Wait on HEAD_SHA").
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/run-with-timeout.sh
. "$SCRIPT_DIR/lib/run-with-timeout.sh"

: "${REPO:?}" "${HEAD_SHA:?}" "${REQUIRED_CONTEXTS:?}"
GH_BIN="${GH_BIN:-gh}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-15}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-600}"
CALL_TIMEOUT_SECONDS="${CALL_TIMEOUT_SECONDS:-60}"
REPORT_FILE="${REPORT_FILE:-/dev/null}"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::HEAD_SHA is not a 40-hex sha"; exit 1; }
contexts=$(printf '%s\n' "$REQUIRED_CONTEXTS" | sed '/^[[:space:]]*$/d')
[ -n "$contexts" ] || { echo "::error::REQUIRED_CONTEXTS is empty — refusing to guess"; exit 1; }
ctx_json=$(printf '%s\n' "$contexts" | jq -R . | jq -s .)

# One line per context: "<state> <context>", state = pass | fail:<conclusion> | pending.
# shellcheck disable=SC2016 # a jq program: $runs / $ctx are jq variables
EVAL='
  ($runs | map(select(.app_id == 15368))) as $r
  | $ctx[] as $c
  | ($r | map(select(.name == $c)) | sort_by(.started_at // "") | last) as $run
  | if $run == null then "pending \($c) (no run on this commit)"
    elif $run.status != "completed" then "pending \($c) (\($run.status))"
    elif ($run.conclusion | IN("success", "skipped", "neutral")) then "pass \($c)"
    else "fail:\($run.conclusion) \($c)" end'

deadline=$(($(date +%s) + TIMEOUT_SECONDS))
while :; do
  run_with_timeout "$CALL_TIMEOUT_SECONDS" "$GH_BIN" api --paginate \
    "repos/$REPO/commits/$HEAD_SHA/check-runs?per_page=100&filter=latest" \
    --jq '.check_runs[] | {name, status, conclusion, started_at, app_id: .app.id}'
  if [ "$_TIMEOUT_RC" -eq 0 ] && runs=$(printf '%s\n' "$_TIMEOUT_OUT" | jq -s .) &&
    lines=$(jq -nr --argjson runs "$runs" --argjson ctx "$ctx_json" "$EVAL"); then
    printf '%s\n' "$lines" >"$REPORT_FILE"
    if printf '%s\n' "$lines" | grep -q '^fail'; then
      echo "::error::a required check failed on $HEAD_SHA:"
      printf '%s\n' "$lines"
      exit 1
    fi
    if ! printf '%s\n' "$lines" | grep -qv '^pass'; then
      printf '%s\n' "$lines"
      echo "all required checks are green on $HEAD_SHA"
      exit 0
    fi
  else
    lines="WARN: check-runs read failed this poll (rc=$_TIMEOUT_RC) — treated as transient"
    printf '%s\n' "$lines" >"$REPORT_FILE"
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::required checks not all green on $HEAD_SHA after ${TIMEOUT_SECONDS}s:"
    printf '%s\n' "$lines"
    exit 1
  fi
  sleep "$INTERVAL_SECONDS"
done
