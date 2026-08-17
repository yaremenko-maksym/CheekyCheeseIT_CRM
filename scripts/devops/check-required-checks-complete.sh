#!/usr/bin/env bash
#
# check-required-checks-complete.sh — proves ALL required status checks
# actually EXIST and are green before letting auto-merge proceed (backlog
# item 40, task-guards-that-do-not-guard, 2026-08-17).
#
# THE BUG THIS REPLACES: .github/workflows/auto-merge-on-label.yml used
#   gh pr checks "$PR_NUMBER" --repo "$REPO" --watch --required --interval 15
# `--required` filters `gh pr checks`'s output down to whatever checks are
# CURRENTLY VISIBLE on the PR that also happen to be required — it does not
# ask "which contexts does branch protection require" and wait for each of
# THOSE to appear. If a required context has not been created as a check-run
# yet (its workflow job has not started, or has not reported a status at
# all), `--required` simply has nothing to show for it, `--watch` sees zero
# pending required checks, and exits 0. One required check going green is
# then indistinguishable from all of them going green.
#
# 2026-08-08, PR #503: `Typecheck · Lint · Unit Tests` finished first,
# auto-merge declared victory, called `gh pr merge --squash`, and got
# `the base branch policy prohibits the merge` back — `E2E Tests` (the
# second required context) had not reported in yet. The PR sat with
# `merge-approved` and a plain red "Squash merge if CI green" step for two
# days, indistinguishable in the checks list from an ordinary CI failure.
#
# THE FIX: wait for EVERY context branch protection actually requires, not
# just whichever ones happen to already exist — poll `gh pr checks` until
# each required context has appeared AND reached a terminal, passing state.
# A context that has not appeared at all is reported and treated differently
# from one that appeared and is still pending, which is different again from
# one that appeared and failed — three distinct diagnoses the old one-line
# command could not tell apart.
#
# THE REQUIRED-CONTEXT LIST ITSELF comes from the caller (REQUIRED_CONTEXTS
# env, one context per line) — this script does NOT call
# `branches/main/protection` itself, on purpose: reading branch protection
# needs the `administration` permission, which is not one GITHUB_TOKEN can
# ever hold (it is not among the scopes GitHub Actions' `permissions:` block
# accepts at all — confirmed with `actionlint`, not merely undocumented — the
# same GitHub-enforced wall this workflow already documents for `workflows`).
# .github/workflows/auto-merge-on-label.yml resolves the list in ONE
# dedicated step using `secrets.ADMIN_PAT` (already used for admin-only
# operations, see e2e-watchdog.yml) for exactly that one read call, and hands
# the result to this script — so the list is still live, API-sourced, never
# hardcoded, just fetched by the one thing in the job with permission to.
#
# WHAT COUNTS AS SATISFIED: bucket == "pass" or "skipping". `gh pr checks
# --json` categorises every check into bucket: pass, fail, pending, skipping,
# cancel (see `gh pr checks --help`). "skipping" is GitHub's own neutral/
# skipped conclusion, which GitHub's branch-protection merge gate itself
# treats as satisfying a required check (a job gated by an `if:` that
# legitimately did not run still lets the PR merge) — this script mirrors
# that, not invents a stricter rule GitHub itself does not enforce.
# "fail" and "cancel" are hard stops, reported immediately without waiting
# out the rest of the timeout (matches the old command's fail-fast
# behaviour). "pending" and "absent entirely" both keep polling until the
# timeout, but are reported as different things when the timeout is hit.
#
# WHAT THIS DOES NOT DO: verify the checks are checking the right thing, or
# that the required-context LIST itself is complete (that is what actually
# editing branch protection is for) — it verifies that whatever branch
# protection currently requires has actually shown up and passed, which is
# exactly the gap PR #503 fell through.
#
# Env:
#   REPO               owner/repo (required)
#   PR_NUMBER          pull request number (required)
#   REQUIRED_CONTEXTS  the required context names, ONE PER LINE (required —
#                       see "THE REQUIRED-CONTEXT LIST ITSELF" above for why
#                       this script does not fetch it itself).
#   GH_BIN             `gh` binary to invoke (default: gh) — overridable so
#                       tests/test-check-required-checks-complete.sh can point
#                       this at a fixture stub instead of the real GitHub API.
#   INTERVAL_SECONDS   poll interval (default: 15)
#   TIMEOUT_SECONDS    total time to wait before giving up (default: 1800)
#   CALL_TIMEOUT_SECONDS  cap on a SINGLE `gh pr checks` invocation (default:
#                       60) — the OLD `gh pr checks --watch` command this
#                       script replaces ran inside a `timeout 1800` wrapper;
#                       that capped the WHOLE watch, not any one call, so a
#                       single hung `gh` invocation could still eat the
#                       entire budget unnoticed. Each poll attempt here is
#                       capped individually instead — a hang is reported and
#                       retried like a transient failure, not left to run out
#                       the whole clock alone (review round, MED-4).
#   REPORT_FILE        optional path — the final human-readable report is
#                       ALSO written here (success or failure), so a later
#                       workflow step can quote it verbatim in a loud PR
#                       comment instead of making a human go read Actions logs
#                       to find out why auto-merge did not proceed.
#
# Exit codes:
#   0  every required context is present and passing (or skipping).
#   1  a required context failed/was cancelled, OR the timeout was reached
#      with something still missing/pending, OR REQUIRED_CONTEXTS was empty
#      (fail-loud: this script never treats "I was not told what is
#      required" as "nothing is required").
#
# Bash-3.2 compatible on purpose (macOS default /bin/bash — same constraint
# as tests/lib/harness.sh): no associative arrays, no `${var,,}`.
#
# Tests: scripts/devops/tests/test-check-required-checks-complete.sh
set -u

REPO="${REPO:?REPO env var required (owner/repo)}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER env var required}"
required="${REQUIRED_CONTEXTS:?REQUIRED_CONTEXTS env var required (one context per line)}"
GH_BIN="${GH_BIN:-gh}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-15}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-1800}"
CALL_TIMEOUT_SECONDS="${CALL_TIMEOUT_SECONDS:-60}"
REPORT_FILE="${REPORT_FILE:-}"

report() {
  # Prints to stdout AND (if set) appends to REPORT_FILE, so both the live
  # step log and a later "explain the failure" step see the same text.
  printf '%s\n' "$1"
  if [ -n "$REPORT_FILE" ]; then
    printf '%s\n' "$1" >>"$REPORT_FILE"
  fi
}

# Portable per-attempt timeout wrapper (review round, MED-4) — deliberately
# NOT built on the GNU `timeout` command. `timeout` is coreutils, absent by
# default on macOS (confirmed: `which timeout` finds nothing on a stock Mac),
# and this exact, unmodified script is what
# tests/test-check-required-checks-complete.sh runs locally on a developer's
# Mac — a hard dependency on `timeout` would make the very call this wrapper
# times out untestable outside CI. Same class of portability trap this
# repo's already hit once (see post-merge-alert.sh's "GNU timeout/mktemp"
# comment). Sets _TIMEOUT_OUT / _TIMEOUT_RC instead of using $(...) capture,
# because capturing a function's stdout from a caller and ALSO getting a
# meaningful exit code back out of a backgrounded child is not something
# $(...) can do at the same time — mirrors tests/lib/harness.sh's own
# _GT_OUT/_GT_RC side-channel for the identical reason.
_TIMEOUT_OUT=""
_TIMEOUT_RC=0
run_with_timeout() {
  local secs="$1"
  shift
  local tmp waited pid
  tmp="$(mktemp)"
  "$@" >"$tmp" 2>&1 &
  pid=$!
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      _TIMEOUT_OUT="$(cat "$tmp")"
      _TIMEOUT_RC=124
      rm -f "$tmp"
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
  _TIMEOUT_RC=$?
  _TIMEOUT_OUT="$(cat "$tmp")"
  rm -f "$tmp"
}

[ -n "$REPORT_FILE" ] && : >"$REPORT_FILE"

# `${VAR:?...}` above only rejects UNSET/empty-string — a value of literal
# whitespace would slip through and then match nothing below. Reject that too
# rather than silently waiting for zero required contexts.
if [ -z "$(printf '%s' "$required" | tr -d '[:space:]')" ]; then
  report "FAIL: REQUIRED_CONTEXTS was given but contains no actual context names."
  report "Refusing to treat 'nothing to wait for' as satisfied — that is exactly the kind"
  report "of silent pass that let PR #503's merge attempt fire on one green check out of"
  report "two required."
  exit 1
fi

report "Required status check contexts (from branches/main/protection):"
printf '%s\n' "$required" | while IFS= read -r c; do [ -n "$c" ] && report "  - $c"; done

start_ts=$(date +%s)
deadline=$((start_ts + TIMEOUT_SECONDS))

while true; do
  run_with_timeout "$CALL_TIMEOUT_SECONDS" "$GH_BIN" pr checks "$PR_NUMBER" --repo "$REPO" \
    --json name,bucket,state
  checks_json="$_TIMEOUT_OUT"
  if [ "$_TIMEOUT_RC" -eq 124 ]; then
    report "WARN: 'gh pr checks' did not respond within ${CALL_TIMEOUT_SECONDS}s this poll — treating as transient:"
    checks_json="[]"
  elif ! printf '%s' "$checks_json" | jq -e . >/dev/null 2>&1; then
    report "WARN: 'gh pr checks' did not return parseable JSON this poll — treating as transient:"
    report "$checks_json"
    checks_json="[]"
  fi

  missing_list=""
  fail_list=""
  pending_list=""
  pass_list=""

  while IFS= read -r ctx; do
    [ -z "$ctx" ] && continue
    matches="$(printf '%s' "$checks_json" | jq -c --arg ctx "$ctx" '[.[] | select(.name == $ctx)]')"
    count="$(printf '%s' "$matches" | jq 'length')"
    if [ "$count" -eq 0 ]; then
      missing_list="${missing_list}${ctx}
"
      continue
    fi
    has_fail="$(printf '%s' "$matches" | jq '[.[] | select(.bucket=="fail" or .bucket=="cancel")] | length')"
    if [ "$has_fail" -gt 0 ]; then
      fail_list="${fail_list}${ctx}
"
      continue
    fi
    not_satisfied="$(printf '%s' "$matches" | jq '[.[] | select(.bucket!="pass" and .bucket!="skipping")] | length')"
    if [ "$not_satisfied" -gt 0 ]; then
      pending_list="${pending_list}${ctx}
"
    else
      pass_list="${pass_list}${ctx}
"
    fi
  done <<REQUIRED
$required
REQUIRED

  if [ -n "$fail_list" ]; then
    report ""
    report "FAIL: required check(s) failed or were cancelled:"
    printf '%s' "$fail_list" | while IFS= read -r c; do [ -n "$c" ] && report "  - $c"; done
    exit 1
  fi

  if [ -z "$missing_list" ] && [ -z "$pending_list" ]; then
    report ""
    report "OK: every required context is present and passing:"
    printf '%s' "$pass_list" | while IFS= read -r c; do [ -n "$c" ] && report "  - $c"; done
    exit 0
  fi

  now_ts=$(date +%s)
  if [ "$now_ts" -ge "$deadline" ]; then
    report ""
    report "FAIL: timed out after ${TIMEOUT_SECONDS}s waiting for required checks."
    if [ -n "$missing_list" ]; then
      report "  NEVER APPEARED (branch protection requires these, nothing on the PR names them yet):"
      printf '%s' "$missing_list" | while IFS= read -r c; do [ -n "$c" ] && report "    - $c"; done
    fi
    if [ -n "$pending_list" ]; then
      report "  STILL PENDING (appeared, not yet finished):"
      printf '%s' "$pending_list" | while IFS= read -r c; do [ -n "$c" ] && report "    - $c"; done
    fi
    exit 1
  fi

  sleep "$INTERVAL_SECONDS"
done
