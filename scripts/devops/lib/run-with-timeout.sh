#!/usr/bin/env bash
# run-with-timeout.sh — portable per-attempt timeout wrapper for a single
# external command invocation.
#
# EXTRACTED (task-infra-honest-ci-verdicts, PR #558 review round, 2026-08-18)
# from check-required-checks-complete.sh, where this exact function was
# first written (review round MED-4, task-guards-that-do-not-guard) to cap
# a single hung `gh pr checks` call instead of letting it eat the whole
# outer wait budget silently. gh-merge-pr-with-retry.sh needed the identical
# capability for a hung `gh pr merge` call — copying the function a second
# time would have created exactly the failure mode this task already fixed
# once today (scripts/devops/tests/lib/fake-gh.sh's sequence-cursor logic
# briefly existing as two near-identical inline copies before being shared):
# two descriptions of one mechanism that can silently drift apart, each
# looking correct in isolation. One canonical implementation, sourced by
# both callers, is the fix.
#
# WHY NOT THE GNU `timeout` COMMAND: `timeout` is coreutils, absent by
# default on macOS (confirmed: `which timeout` finds nothing on a stock
# Mac), and this exact, unmodified script is what this repo's local guard
# tests run on a developer's Mac — a hard dependency on `timeout` would make
# the very call this wrapper times out untestable outside CI. Same class of
# portability trap this repo has already hit once (see
# scripts/devops/post-merge-alert.sh's "GNU timeout/mktemp" comment).
#
# WHY THE SIDE-CHANNEL VARIABLES, NOT $(...) CAPTURE: capturing a function's
# stdout from a caller via command substitution AND ALSO getting a
# meaningful exit code back out of a backgrounded child is not something
# $(...) can do at the same time — mirrors tests/lib/harness.sh's own
# _GT_OUT/_GT_RC side-channel for the identical reason.
#
# Usage:
#   run_with_timeout <seconds> <command...>
#   # then read:
#   $_TIMEOUT_OUT   merged stdout+stderr of the command
#   $_TIMEOUT_RC    its exit code, or 124 if it was killed for running past
#                   <seconds> (matches GNU `timeout`'s own convention, so a
#                   caller that already knows that convention needs no new
#                   one to learn).
#
# Bash-3.2 compatible on purpose (macOS default /bin/bash — same constraint
# as tests/lib/harness.sh and check-required-checks-complete.sh): no
# associative arrays, no `${var,,}`.
#
# Tests: exercised indirectly via
#   scripts/devops/tests/test-check-required-checks-complete.sh
#   scripts/devops/tests/test-gh-merge-pr-with-retry.sh
# (both callers' own test suites prove this wrapper actually cuts a hung
# call off and lets a subsequent retry recover — there is no separate
# standalone test file for this lib, matching how tests/lib/harness.sh and
# tests/lib/fake-gh.sh are proven through their callers' tests, not on
# their own.)
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
