#!/usr/bin/env bash
# fake-playwright-deps.sh — stub for `playwright install-deps chromium`,
# used only by test-install-playwright-system-deps.sh (backlog item 122,
# 2026-08-18). Same sequence/counter-file shape as tests/lib/fake-gh.sh's
# `pr merge` stub, trimmed to this script's single call site — there is
# only one command to fake here, so this file skips fake-gh.sh's
# subcommand dispatch entirely rather than copying it unused.
#
# Env:
#   FAKE_PW_DEPS_RC_SEQUENCE   ':'-separated exit codes, one per call
#                              (e.g. "1:0" = fail, then succeed). Exhausted
#                              list repeats its last entry.
#   FAKE_PW_DEPS_CALL_COUNTER  required — fresh path this stub writes its
#                              call count into (a fresh process per
#                              invocation cannot keep state any other way).
#   FAKE_PW_DEPS_SLEEP_SECONDS            optional — sleeps this long before
#                              answering EVERY call (simulates a hang on
#                              every attempt — the retry budget must exhaust
#                              in bounded time).
#   FAKE_PW_DEPS_SLEEP_ON_FIRST_CALL_SECONDS   optional — sleeps this long
#                              before answering ONLY the FIRST call (every
#                              later call answers immediately), simulating
#                              one hung call that then recovers.
set -u

: "${FAKE_PW_DEPS_RC_SEQUENCE:?FAKE_PW_DEPS_RC_SEQUENCE not set}"
: "${FAKE_PW_DEPS_CALL_COUNTER:?FAKE_PW_DEPS_CALL_COUNTER not set}"

n=0
[ -f "$FAKE_PW_DEPS_CALL_COUNTER" ] && n="$(cat "$FAKE_PW_DEPS_CALL_COUNTER")"
was_first_call=0
[ "$n" -eq 0 ] && was_first_call=1

# Record the call BEFORE sleeping — a caller simulating a timeout kills
# this process mid-sleep, which would otherwise mean the counter file
# update below never runs and every retry re-reads n=0 forever (an
# infinite hang disguised as "recovers on retry"). Same reasoning as
# fake-gh.sh's `pr merge` branch.
n=$((n + 1))
printf '%s' "$n" >"$FAKE_PW_DEPS_CALL_COUNTER"

if [ -n "${FAKE_PW_DEPS_SLEEP_SECONDS:-}" ]; then
  sleep "$FAKE_PW_DEPS_SLEEP_SECONDS"
elif [ -n "${FAKE_PW_DEPS_SLEEP_ON_FIRST_CALL_SECONDS:-}" ] && [ "$was_first_call" -eq 1 ]; then
  sleep "$FAKE_PW_DEPS_SLEEP_ON_FIRST_CALL_SECONDS"
fi

total="$(printf '%s\n' "$FAKE_PW_DEPS_RC_SEQUENCE" | tr ':' '\n' | wc -l | tr -d ' ')"
use_n="$n"
[ "$use_n" -gt "$total" ] && use_n="$total"
rc="$(printf '%s\n' "$FAKE_PW_DEPS_RC_SEQUENCE" | tr ':' '\n' | sed -n "${use_n}p")"

if [ "$rc" -eq 0 ]; then
  echo "fake-playwright-deps: call $n ok (0 upgraded, 0 newly installed)"
  exit 0
fi
echo "fake-playwright-deps: call $n failed (rc=$rc)" >&2
exit "$rc"
