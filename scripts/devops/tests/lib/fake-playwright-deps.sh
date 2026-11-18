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
#   FAKE_PW_DEPS_LOCK_TEXT     optional (round 2, backlog item 122) — when
#                              set to "1", every FAILING call (rc != 0)
#                              prints apt/dpkg's own real "another process
#                              holds the lock" wording instead of the
#                              generic message below, so a test can drive
#                              install-playwright-system-deps.sh's lock
#                              classification without needing a real apt
#                              lock. Verbatim lines from the actual PR #562
#                              transcript this whole round exists to fix.
#                              Ignored if FAKE_PW_DEPS_LOCK_UNTIL_CALL is set.
#   FAKE_PW_DEPS_LOCK_UNTIL_CALL   optional (round 2) — a call number N:
#                              FAILING calls 1..N print the lock wording,
#                              FAILING calls after N print the generic
#                              message. Models "the lock clears, but the
#                              NEXT call hits a genuine, unrelated
#                              dependency error" — a case a blanket
#                              FAKE_PW_DEPS_LOCK_TEXT=1 cannot represent.
#   FAKE_PW_DEPS_ORPHAN_PIDFILE   optional (round 3, 2026-11-18) — models
#                              the gh-run-44216565244 mechanism at unit
#                              level, the one shape no other env here can
#                              express. On the FIRST call this stub spawns a
#                              DETACHED background sleeper (the stand-in for
#                              `sudo apt-get`, which real
#                              run_with_timeout cannot kill because it is a
#                              grandchild owned by root), records its pid in
#                              this file, and then hangs forever so the
#                              caller times it out and kills only THIS
#                              process — leaving the sleeper alive exactly
#                              as CI leaves the orphaned apt-get. Every
#                              LATER call checks that sleeper: still alive
#                              -> print apt's lock wording NAMING ITS REAL
#                              PID and fail; already exited -> succeed,
#                              because in CI the orphan's own install is
#                              what actually put the packages on disk.
#                              FAKE_PW_DEPS_RC_SEQUENCE is ignored in this
#                              mode. Takes priority over every other mode.
#   FAKE_PW_DEPS_ORPHAN_SLEEP_BIN  optional (round 4 review, SR-L-7) — the
#                              binary the detached sleeper runs, so a case can
#                              give the holder a specific process NAME (what
#                              HOLDER_COMM_REGEX is matched against). Default:
#                              `sleep`.
#   FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS   optional — how long that sleeper
#                              lives (default: 4).
#   FAKE_PW_DEPS_ORPHAN_SUCCESS_DELAY_SECONDS   optional (round 4) — how long
#                              the POST-ORPHAN success call takes before it
#                              answers. The real one is `apt-get install` over
#                              packages already on disk: seconds, not
#                              instant. Default 0 keeps every earlier case
#                              unchanged; a case that sets it can prove the
#                              re-check is given a timeout it can actually
#                              finish in, which an instant success cannot.
#   FAKE_PW_DEPS_ECHO_BEFORE_SLEEP   optional (round 3) — text printed
#                              BEFORE the stub hangs, so a test can prove
#                              the timed-out attempt's captured output is
#                              actually printed (requirement 3) rather than
#                              thrown away as it was on run 44216565244.
#   FAKE_PW_DEPS_MIXED_OUTPUT   optional (round 2, PR #562 review
#                              4956397222) — "lock-then-real" or
#                              "real-then-lock". Every FAILING call
#                              prints BOTH apt's real lock wording AND a
#                              genuine, unrelated `E: Unable to locate
#                              package libnonexistent-dep0` line in ONE
#                              call, in the given order. This is the
#                              reviewer's own counter-example shape: a
#                              substring search over the whole output
#                              cannot tell "the lock also happened to be
#                              mentioned" from "the lock explains the
#                              whole failure" — only a call that can
#                              print BOTH signals in a single invocation
#                              can prove the classifier tells them apart.
#                              Takes priority over FAKE_PW_DEPS_LOCK_TEXT
#                              and FAKE_PW_DEPS_LOCK_UNTIL_CALL if set.
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

# ── round 3: the orphaned-holder mode ─────────────────────────────────────
if [ -n "${FAKE_PW_DEPS_ORPHAN_PIDFILE:-}" ]; then
  orphan_lifetime="${FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS:-4}"
  if [ "$was_first_call" -eq 1 ]; then
    # Detached on purpose (setsid when available, plain background
    # otherwise): the caller must NOT be able to reap it by killing this
    # process, which is the entire mechanism under test.
    # FAKE_PW_DEPS_ORPHAN_SLEEP_BIN (round 4 review, SR-L-7): the holder's
    # process NAME is what HOLDER_COMM_REGEX is matched against, and `ps -o
    # comm=` truncates it to 15 characters on Linux. A case that needs the
    # runner's real holder name (`unattended-upgrade` -> `unattended-upgr`)
    # points this at a copy of sleep carrying that name.
    orphan_bin="${FAKE_PW_DEPS_ORPHAN_SLEEP_BIN:-sleep}"
    if command -v setsid >/dev/null 2>&1; then
      setsid "$orphan_bin" "$orphan_lifetime" >/dev/null 2>&1 &
    else
      "$orphan_bin" "$orphan_lifetime" >/dev/null 2>&1 &
    fi
    printf '%s' "$!" >"$FAKE_PW_DEPS_ORPHAN_PIDFILE"
    echo "fake-playwright-deps: call $n started the install (pid $! holds the lock)"
    # Hang until killed — the stand-in for an apt-get run that outlives its
    # per-attempt budget. `exec` on purpose: run_with_timeout kills the
    # direct child only, so a forked `sleep` here would SURVIVE the kill and
    # leak one long sleeper per suite run (measured: five stale `sleep 3600`
    # processes after five runs). exec replaces this shell, so the pid the
    # caller kills IS the sleep, and the bound is short enough that an
    # abandoned one cannot linger.
    exec sleep 60
  fi
  orphan_pid="$(cat "$FAKE_PW_DEPS_ORPHAN_PIDFILE" 2>/dev/null || echo '')"
  if [ -n "$orphan_pid" ] && ps -p "$orphan_pid" >/dev/null 2>&1; then
    echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process $orphan_pid (apt-get)" >&2
    echo "E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?" >&2
    exit 1
  fi
  # The orphan finished — in CI its own apt-get is what installed the
  # packages, so this call is the no-op success that follows. It is not
  # instant in reality (apt still reads its lists and resolves), hence the
  # optional delay.
  orphan_success_delay="${FAKE_PW_DEPS_ORPHAN_SUCCESS_DELAY_SECONDS:-0}"
  [ "$orphan_success_delay" -gt 0 ] && sleep "$orphan_success_delay"
  echo "fake-playwright-deps: call $n ok (the previous install had already finished; 0 newly installed)"
  exit 0
fi

if [ -n "${FAKE_PW_DEPS_ECHO_BEFORE_SLEEP:-}" ]; then
  echo "$FAKE_PW_DEPS_ECHO_BEFORE_SLEEP"
fi

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

LOCK_LINE='E: Could not get lock /var/lib/apt/lists/lock. It is held by process 3760 (apt-get)'
REAL_LINE='E: Unable to locate package libnonexistent-dep0'

case "${FAKE_PW_DEPS_MIXED_OUTPUT:-}" in
  lock-then-real)
    echo "$LOCK_LINE" >&2
    echo "E: Unable to lock directory /var/lib/apt/lists/" >&2
    echo "$REAL_LINE" >&2
    exit "$rc"
    ;;
  real-then-lock)
    echo "$REAL_LINE" >&2
    echo "$LOCK_LINE" >&2
    echo "E: Unable to lock directory /var/lib/apt/lists/" >&2
    exit "$rc"
    ;;
  "") ;;
  *)
    echo "fake-playwright-deps: unknown FAKE_PW_DEPS_MIXED_OUTPUT '$FAKE_PW_DEPS_MIXED_OUTPUT'" >&2
    exit 2
    ;;
esac

use_lock_text=0
if [ -n "${FAKE_PW_DEPS_LOCK_UNTIL_CALL:-}" ]; then
  [ "$n" -le "$FAKE_PW_DEPS_LOCK_UNTIL_CALL" ] && use_lock_text=1
elif [ "${FAKE_PW_DEPS_LOCK_TEXT:-}" = "1" ]; then
  use_lock_text=1
fi

if [ "$use_lock_text" -eq 1 ]; then
  echo "$LOCK_LINE" >&2
  echo "E: Unable to lock directory /var/lib/apt/lists/" >&2
else
  echo "fake-playwright-deps: call $n failed (rc=$rc)" >&2
fi
exit "$rc"
