#!/usr/bin/env bash
# fake-gh.sh — stub `gh` CLI for check-required-checks-complete.sh's tests
# (task-guards-that-do-not-guard, 2026-08-17).
#
# The guard makes exactly two kinds of `gh` call:
#   gh api repos/<repo>/branches/<base>/protection
#   gh pr checks <pr> --repo <repo> --json name,bucket,state
# This stub answers both from fixture files instead of hitting the real
# GitHub API, driven entirely by ENV VARS — never by parsing argv — so this
# file never has to track exactly which flags the guard happens to pass.
#
#   FAKE_GH_PROTECTION_FILE   path to the JSON body `gh api .../protection`
#                             should print.
#   FAKE_GH_PROTECTION_EXIT   its exit code (default 0) — set non-zero to
#                             simulate a permission/network failure reading
#                             branch protection.
#
#   FAKE_GH_CHECKS_SEQUENCE   ':'-separated list of file paths. Each `gh pr
#                             checks` call advances one step through this
#                             list (a counter lives in FAKE_GH_CALL_COUNTER,
#                             since each invocation is a fresh process); once
#                             the list is exhausted, the LAST path repeats.
#                             This is what lets a test simulate "a required
#                             context is still missing on the first poll,
#                             then appears on the second" without a real
#                             15-second sleep loop — see the polling case in
#                             test-check-required-checks-complete.sh.
#   FAKE_GH_CALL_COUNTER      required alongside FAKE_GH_CHECKS_SEQUENCE — a
#                             fresh path this stub writes its call count into.
set -u

case "${1:-}" in
  api)
    cat "${FAKE_GH_PROTECTION_FILE:?FAKE_GH_PROTECTION_FILE not set}"
    exit "${FAKE_GH_PROTECTION_EXIT:-0}"
    ;;
  pr)
    if [ "${2:-}" != "checks" ]; then
      echo "fake-gh: unexpected 'gh pr ${2:-}' invocation" >&2
      exit 2
    fi
    : "${FAKE_GH_CHECKS_SEQUENCE:?FAKE_GH_CHECKS_SEQUENCE not set}"
    : "${FAKE_GH_CALL_COUNTER:?FAKE_GH_CALL_COUNTER not set}"

    n=0
    [ -f "$FAKE_GH_CALL_COUNTER" ] && n="$(cat "$FAKE_GH_CALL_COUNTER")"
    n=$((n + 1))
    printf '%s' "$n" >"$FAKE_GH_CALL_COUNTER"

    # printf '%s\n' (NOT '%s') — a trailing newline is required for `wc -l` to
    # count a sequence with no ':' in it as ONE line rather than zero (`wc -l`
    # counts newline characters, and a bare single value has none of its own).
    total="$(printf '%s\n' "$FAKE_GH_CHECKS_SEQUENCE" | tr ':' '\n' | wc -l | tr -d ' ')"
    use_n="$n"
    [ "$use_n" -gt "$total" ] && use_n="$total"
    chosen="$(printf '%s\n' "$FAKE_GH_CHECKS_SEQUENCE" | tr ':' '\n' | sed -n "${use_n}p")"
    cat "$chosen"
    exit 0
    ;;
  *)
    echo "fake-gh: unexpected invocation: $*" >&2
    exit 2
    ;;
esac
