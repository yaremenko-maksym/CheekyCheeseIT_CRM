#!/usr/bin/env bash
# fake-gh.sh — stub `gh` CLI for check-required-checks-complete.sh's tests
# (task-guards-that-do-not-guard, 2026-08-17).
#
# The guard's polling loop makes exactly one kind of `gh` call:
#   gh pr checks <pr> --repo <repo> --json name,bucket,state
# (the required-context LIST is a caller-supplied env var, REQUIRED_CONTEXTS
# — resolved by a SEPARATE step in .github/workflows/auto-merge-on-label.yml
# using an admin-scoped PAT, since GITHUB_TOKEN can never read branch
# protection; see the guard's own header. The `api ... protection` branch
# below existed for an earlier revision where the guard fetched that itself
# — kept as a harmless stub for `gh api` in case a future test needs it, but
# no current test exercises it.)
#
# This stub answers from fixture files instead of hitting the real GitHub
# API, driven entirely by ENV VARS — never by parsing argv — so this file
# never has to track exactly which flags the guard happens to pass.
#
#   FAKE_GH_PROTECTION_FILE   path to the JSON body `gh api .../protection`
#                             should print, if that branch is ever exercised.
#   FAKE_GH_PROTECTION_EXIT   its exit code (default 0).
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
#   FAKE_GH_CHECKS_SLEEP_ON_FIRST_CALL   optional — if set, `sleep`s this
#                             long before answering ONLY the FIRST `pr checks`
#                             call (every later call in the same
#                             FAKE_GH_CALL_COUNTER answers immediately),
#                             simulating one `gh` invocation that hangs
#                             (network stall, GitHub API slowness) and then
#                             recovers. Lets a test prove the guard's
#                             per-attempt timeout wrapper (run_with_timeout)
#                             actually cuts the hung call off and retries,
#                             instead of blocking the whole poll loop on it
#                             forever — see the "hung call recovers" case in
#                             test-check-required-checks-complete.sh.
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
    was_first_call=0
    [ "$n" -eq 0 ] && was_first_call=1

    # Record the call BEFORE sleeping, not after: a caller simulating a
    # timeout (review round MED-4's test) KILLS this process mid-sleep, which
    # would otherwise mean the counter file update below never runs and every
    # retry re-reads n=0 forever — an infinite hang disguised as "recovers on
    # retry". Marking the turn used first is what actually lets it recover.
    n=$((n + 1))
    printf '%s' "$n" >"$FAKE_GH_CALL_COUNTER"

    if [ -n "${FAKE_GH_CHECKS_SLEEP_ON_FIRST_CALL:-}" ] && [ "$was_first_call" -eq 1 ]; then
      sleep "$FAKE_GH_CHECKS_SLEEP_ON_FIRST_CALL"
    fi

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
