#!/usr/bin/env bash
# test-install-playwright-system-deps.sh — proves
# scripts/devops/install-playwright-system-deps.sh (backlog item 122,
# .claude/tasks/BACKLOG-followups.md, 2026-08-18, round 2) actually does
# what round 2 asked for, not just "looks right on read":
#
#   1. THE GREEN PATH IS UNCHANGED — a working call succeeds on the first
#      attempt, no retry, no extra delay.
#   2. AN ORDINARY (non-lock) TRANSIENT FAILURE STILL RECOVERS within the
#      fast tier, same as round 1 — round 2 must not have narrowed this.
#   3. A HANG IS CUT OFF WELL UNDER THE JOB'S 15-MINUTE TIMEOUT and can
#      recover within the fast tier.
#   4. (a) A LOCK HELD THROUGH THE FAST TIER BUT RELEASED DURING THE
#      PATIENT TIER SUCCEEDS QUIETLY — no ::warning::, no step-summary
#      entry. "We wait, then move on without noise."
#   5. (c) A REAL (non-lock) DEPENDENCY ERROR STAYS A LOUD, IMMEDIATE
#      FAILURE — round 2's softening must never reach this case.
#   6. (b) A LOCK THAT NEVER CLEARS, THROUGH BOTH TIERS, DOES NOT FAIL THE
#      JOB — it exits 0 with a loud ::warning:: AND a $GITHUB_STEP_SUMMARY
#      entry, so the run stays visibly flagged instead of silently green.
#   7. (d) THE HEALTHY PATH (case 1 above) IS A SINGLE CALL, NO DELAY —
#      re-asserted with an explicit wall-clock bound alongside case 1.
#   8. MIXED OUTPUT, EITHER ORDER — a single call's output naming BOTH the
#      lock AND a genuine, unrelated dependency error must classify as a
#      real failure and fail loud, in BOTH orders (lock line first, real
#      line first). This is PR #562 review 4956397222's own finding: the
#      round-2-v1 classifier asked "does the lock phrase appear anywhere
#      in the merged output", which this exact fixture defeated by hand —
#      a real `E: Unable to locate package ...` sitting next to a lock
#      mention still came back "lock", and the job went green with a
#      missing dependency. This case is the one that must never again be
#      unrepresentable in this suite (the round-2-v1 gap the review named
#      as the more important finding, since it made the leak itself
#      untestable).
#
# Each timing-sensitive case is measured with `date +%s`, matching
# test-gh-merge-pr-with-retry.sh's own convention — "the message says it
# recovered" is not proof; "it actually finished in bounded time" is.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"
# The watchdog branch of run_install below bounds a case that a regression
# would make HANG rather than merely slow. Same lib the script under test
# uses, so the bound is the one the project already tests.
# shellcheck source=../lib/run-with-timeout.sh
. "$GUARD_DIR/lib/run-with-timeout.sh"

SCRIPT="$GUARD_DIR/install-playwright-system-deps.sh"
FAKE_PW="$SELF_DIR/lib/fake-playwright-deps.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

run_install() {
  # $1 = FAKE_PW_DEPS_RC_SEQUENCE, $2 = counter file path, remaining =
  # extra env assignments as NAME=value. Sleeps default to 0 so the suite
  # stays fast; individual cases override CALL_TIMEOUT_SECONDS /
  # FAST_MAX_ATTEMPTS / LOCK_MAX_ATTEMPTS / lock text as needed.
  #
  # HOLDER_WAIT_MAX_SECONDS=0 by default (round 3): the lock fixtures below
  # print apt's verbatim wording, which NAMES pid 3760 — a pid this suite
  # never spawned and which may well belong to a live, unrelated process on
  # the machine running the tests. Left at its production default, the new
  # holder wait would poll that stranger and stall these cases. The orphan
  # case that NEEDS the wait spawns a real holder and sets a real budget.
  #
  # RUN_INSTALL_WATCHDOG_SECONDS (round 3 review, CR-L-3): when set, the step
  # runs under run_with_timeout and a case that would otherwise NEVER RETURN
  # ends in a visible "WATCHDOG KILLED" line plus rc 124 instead of hanging
  # the suite. `env` is the direct child and execs bash in the same pid, so
  # the lib's kill reaches the spinning script itself.
  local rc_seq="$1" counter="$2"
  shift 2
  local extra_env=("$@")
  # RUN_INSTALL_PRODUCTION_COMM_REGEX=1 omits the override entirely, so the
  # script's OWN default applies. A case that exists to prove the production
  # regex matches something cannot be run with the regex replaced — that would
  # test the fixture (round 4 review, SR-L-7).
  local comm_regex=(HOLDER_COMM_REGEX="sleep")
  [ "${RUN_INSTALL_PRODUCTION_COMM_REGEX:-0}" = "1" ] && comm_regex=()
  local argv=(
    env
    PLAYWRIGHT_DEPS_CMD="$FAKE_PW"
    FAKE_PW_DEPS_RC_SEQUENCE="$rc_seq"
    FAKE_PW_DEPS_CALL_COUNTER="$counter"
    FAST_RETRY_SLEEP_SECONDS="0"
    LOCK_RETRY_SLEEP_SECONDS="0"
    HOLDER_WAIT_MAX_SECONDS="0"
    # HOLDER_COMM_REGEX (round 4 review, SR-L-2): production requires the
    # remembered pid to STILL be an apt/dpkg process before the step treats it
    # as the lock holder, because a pid consumed minutes after it was parsed
    # may have been reused. The fixtures' holder stand-in is a detached
    # `sleep` (lib/fake-playwright-deps.sh — the orphan must survive a kill of
    # its parent, which is the whole mechanism under test), so every orphan
    # case here would fail the production check. Pinned to the fixture's own
    # process name instead of weakening the production default; the case that
    # proves the check works sets it back to `apt|dpkg`.
    ${comm_regex[@]+"${comm_regex[@]}"}
    ${extra_env[@]+"${extra_env[@]}"}
    bash "$SCRIPT"
  )
  if [ -n "${RUN_INSTALL_WATCHDOG_SECONDS:-}" ]; then
    run_with_timeout "$RUN_INSTALL_WATCHDOG_SECONDS" "${argv[@]}"
    printf '%s\n' "$_TIMEOUT_OUT"
    if [ "$_TIMEOUT_RC" -eq 124 ]; then
      echo "WATCHDOG KILLED the step after ${RUN_INSTALL_WATCHDOG_SECONDS}s — it never returned on its own."
    fi
    return "$_TIMEOUT_RC"
  fi
  "${argv[@]}"
}

# ── (d)/1: the normal (healthy-shard) path is untouched ────────────────────
COUNTER1="$WS/counter-clean"
START1=$(date +%s)
assert_green "(d) a working call succeeds on the first attempt, no retry" \
  --contains "OK (fast attempt 1/2)" \
  --not-contains "::warning::" \
  -- run_install "0" "$COUNTER1"
END1=$(date +%s)
DURATION1=$((END1 - START1))
CALLS1="$(cat "$COUNTER1" 2>/dev/null || echo '?')"
if [ "$CALLS1" = "1" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] the healthy path makes exactly ONE call (5-of-6-shards case, no wasted retries)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] the healthy path made %s calls, expected 1\n' "$CALLS1"
fi
if [ "$DURATION1" -le 3 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] the healthy path finished in %ss (no added latency on the common case)\n' "$DURATION1"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] the healthy path took %ss — expected near-instant\n' "$DURATION1"
fi

# ── 2: an ordinary (non-lock) failure on attempt 1 recovers in the fast tier
COUNTER2="$WS/counter-fail-recovers"
assert_green "an ordinary apt-get error on attempt 1 recovers on attempt 2 (fast tier)" \
  --contains "exited 1 — retrying" \
  --contains "OK (fast attempt 2/2)" \
  --not-contains "::warning::" \
  -- run_install "1:0" "$COUNTER2"

# ── 3: a hung call within the fast tier is cut off well under the job's ────
# 15-minute timeout, and the retry recovers. CALL_TIMEOUT is 1s but the fake
# sleeps 3s on the first call only — run_with_timeout must kill it before it
# can answer, and the second (non-hanging) call must still succeed.
COUNTER3="$WS/counter-hang-recovers"
START3=$(date +%s)
assert_green "a hung call on the FIRST attempt is killed after CALL_TIMEOUT_SECONDS and recovers on retry" \
  --contains "did not respond within 1s" \
  --contains "OK (fast attempt 2/2)" \
  --not-contains "::warning::" \
  -- run_install "0:0" "$COUNTER3" \
       CALL_TIMEOUT_SECONDS=1 FAKE_PW_DEPS_SLEEP_ON_FIRST_CALL_SECONDS=3
END3=$(date +%s)
DURATION3=$((END3 - START3))
if [ "$DURATION3" -le 8 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] hang-then-recover finished in %ss — nowhere near the 15-minute job timeout it replaces\n' "$DURATION3"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] hang-then-recover took %ss — expected well under 8s\n' "$DURATION3"
fi

# ── 4: (a) THE #562 SHAPE — lock held through the whole fast tier, ───
# released partway through the patient (lock) tier: waits, then proceeds
# WITHOUT any warning or step-summary entry ("no noise" — the requirement
# this case exists to prove). Calls 1-2 (fast tier) refuse with the lock
# signature; call 3 (first lock-tier attempt) succeeds.
COUNTER4="$WS/counter-lock-clears"
assert_green "(a) a lock held through the fast tier but released during the patient tier succeeds quietly" \
  --contains "apt/dpkg lock held by another process — retrying" \
  --contains "switching to longer, more patient retries" \
  --contains "OK (lock attempt 1/2)" \
  --not-contains "::warning::" \
  -- run_install "1:1:0" "$COUNTER4" FAKE_PW_DEPS_LOCK_TEXT=1
CALLS4="$(cat "$COUNTER4" 2>/dev/null || echo '?')"
if [ "$CALLS4" = "3" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (a) lock-clears case made exactly 3 calls (2 fast-tier refusals + 1 lock-tier success)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (a) lock-clears case made %s calls, expected 3\n' "$CALLS4"
fi
SUMMARY4="$WS/summary-lock-clears"
: >"$SUMMARY4"
COUNTER4B="$WS/counter-lock-clears-summary-check"
run_install "1:1:0" "$COUNTER4B" FAKE_PW_DEPS_LOCK_TEXT=1 GITHUB_STEP_SUMMARY="$SUMMARY4" >/dev/null 2>&1
if [ ! -s "$SUMMARY4" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (a) lock-clears case writes NOTHING to GITHUB_STEP_SUMMARY (quiet recovery stays quiet)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (a) lock-clears case wrote to GITHUB_STEP_SUMMARY — it should have stayed silent\n'
fi

# ── 5: (c) RED — a real (non-lock) dependency error stays loud+immediate ───
# failure. Round 2's softening must never reach this case: the fast tier
# exhausts with a NON-lock, NON-timeout failure, so the patient tier is
# never entered and the step fails right away.
COUNTER5="$WS/counter-real-fails"
assert_red "(c) a real apt-get error (not a lock, not a hang) fails loud immediately after the fast tier — never enters the patient tier" \
  --contains "::error::" \
  --contains "FAILED, last exit code 1" \
  --contains "an actual apt-get/dependency error, not a lock wait and not a hang" \
  --not-contains "::warning::" \
  --not-contains "lock attempt" \
  -- run_install "1:1" "$COUNTER5"
CALLS5="$(cat "$COUNTER5" 2>/dev/null || echo '?')"
if [ "$CALLS5" = "2" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] (c) real-error case made exactly 2 calls (fast tier only — no patient-tier attempts wasted on a deterministic error)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] (c) real-error case made %s calls, expected 2\n' "$CALLS5"
fi

# ── 6: (b) THE HEADLINE CASE — a lock that NEVER clears, both tiers, ──
# does NOT fail the job (exit 0), but is loudly flagged: a ::warning:: log
# annotation AND a $GITHUB_STEP_SUMMARY entry, so it cannot be missed in a
# 6-shard-deep log wall the way round 1's ambiguous `cancelled` could be.
COUNTER6="$WS/counter-lock-never-clears"
SUMMARY6="$WS/summary-lock-never-clears"
: >"$SUMMARY6"
START6=$(date +%s)
assert_green "(b) a lock held through BOTH tiers does not fail the job — warns and continues" \
  --contains "apt/dpkg lock still held by another process after 4 attempts" \
  --contains "::warning::" \
  --contains "continuing WITHOUT installing system deps this run" \
  --contains "NOT a job failure" \
  --not-contains "::error::" \
  -- run_install "1" "$COUNTER6" FAKE_PW_DEPS_LOCK_TEXT=1 GITHUB_STEP_SUMMARY="$SUMMARY6"
END6=$(date +%s)
DURATION6=$((END6 - START6))
if [ "$DURATION6" -le 6 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (b) unresolved-lock case gave up in %ss — bounded, nowhere near the 15-minute job ceiling\n' "$DURATION6"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (b) unresolved-lock case took %ss — expected well under 6s at these test timeouts\n' "$DURATION6"
fi
CALLS6="$(cat "$COUNTER6" 2>/dev/null || echo '?')"
if [ "$CALLS6" = "4" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (b) unresolved-lock case made exactly 4 calls (FAST_MAX_ATTEMPTS=2 + LOCK_MAX_ATTEMPTS=2)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (b) unresolved-lock case made %s calls, expected 4\n' "$CALLS6"
fi
if grep -q "Playwright system deps skipped (apt lock held by another process)" "$SUMMARY6" 2>/dev/null \
  && grep -q "continuing WITHOUT installing system deps this run" "$SUMMARY6" 2>/dev/null; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (b) unresolved-lock case wrote a flagged entry to GITHUB_STEP_SUMMARY (visible in the run summary, not just the log wall)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (b) unresolved-lock case did not write the expected GITHUB_STEP_SUMMARY entry\n'
  [ -f "$SUMMARY6" ] && sed 's/^/      | /' "$SUMMARY6"
fi

# ── 7: a real dependency error surfacing AFTER the lock clears mid- ──
# patient-tier still fails loud — the softening in (b) is narrow to
# lock/timeout, not "anything that survives the fast tier". The patient
# tier still spends its own full LOCK_MAX_ATTEMPTS budget before deciding
# (same "exhaust the tier's budget, THEN classify the last attempt" shape
# as the fast tier's own case 2 above — not a special early-exit path) —
# so this is 2 fast-tier lock refusals + LOCK_MAX_ATTEMPTS(2) patient-tier
# attempts (both landing on the real, non-lock rc=2 the fake emits once
# FAKE_PW_DEPS_LOCK_UNTIL_CALL is passed) = 4 calls, THEN the loud failure.
COUNTER7="$WS/counter-lock-then-real"
assert_red "a real error surfacing after the lock clears mid patient-tier still fails loud, not folded into the warn-and-continue case" \
  --contains "::error::" \
  --contains "FAILED, last exit code 2" \
  --not-contains "::warning::" \
  -- run_install "1:1:2" "$COUNTER7" \
       FAKE_PW_DEPS_LOCK_UNTIL_CALL=2
CALLS7="$(cat "$COUNTER7" 2>/dev/null || echo '?')"
if [ "$CALLS7" = "4" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] lock-then-real case made exactly 4 calls (2 fast-tier lock refusals + LOCK_MAX_ATTEMPTS=2 patient-tier attempts, budget exhausted before classifying)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] lock-then-real case made %s calls, expected 4\n' "$CALLS7"
fi

# ── 8-9: MIXED OUTPUT — one call, BOTH signals present, either order ───────
# The finding from PR #562 review 4956397222: the round-2-v1 classifier
# asked "does the lock phrase appear anywhere in this call's merged
# output" — which a call whose output mentions the lock AND separately
# fails on a real, unrelated package defeats. This is exactly that call,
# reproduced via fake-playwright-deps.sh's own FAKE_PW_DEPS_MIXED_OUTPUT
# (not a hand-rolled one-off command outside the fixture, so this gap can
# never again be unrepresentable in this suite). Both tiers see the SAME
# mixed output on every failing call (no counter-based recovery), so this
# also proves the "real" classification holds even once the patient tier
# is reached — the softening must not leak in from either tier.
COUNTER8="$WS/counter-mixed-lock-then-real"
assert_red "(review 4956397222) a single call's output naming the lock FIRST, then a real error, still classifies real and fails loud" \
  --contains "::error::" \
  --contains "FAILED, last exit code 1" \
  --contains "Unable to locate package libnonexistent-dep0" \
  --not-contains "::warning::" \
  --not-contains "continuing WITHOUT installing system deps" \
  -- run_install "1" "$COUNTER8" FAKE_PW_DEPS_MIXED_OUTPUT=lock-then-real

COUNTER9="$WS/counter-mixed-real-then-lock"
assert_red "(review 4956397222) a single call's output naming a real error FIRST, then the lock, still classifies real and fails loud (order must not matter)" \
  --contains "::error::" \
  --contains "FAILED, last exit code 1" \
  --contains "Unable to locate package libnonexistent-dep0" \
  --not-contains "::warning::" \
  --not-contains "continuing WITHOUT installing system deps" \
  -- run_install "1" "$COUNTER9" FAKE_PW_DEPS_MIXED_OUTPUT=real-then-lock

# Both mixed cases exhaust FAST_MAX_ATTEMPTS(2) fast-tier calls (mixed
# output classifies "real" from attempt 1, but the fast tier still spends
# its own budget before deciding — same "exhaust the tier, then classify
# the last attempt" shape as every other case in this suite) and never
# enter the patient tier at all.
CALLS8="$(cat "$COUNTER8" 2>/dev/null || echo '?')"
if [ "$CALLS8" = "2" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] mixed lock-then-real case made exactly 2 calls (fast tier only)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] mixed lock-then-real case made %s calls, expected 2\n' "$CALLS8"
fi
CALLS9="$(cat "$COUNTER9" 2>/dev/null || echo '?')"
if [ "$CALLS9" = "2" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] mixed real-then-lock case made exactly 2 calls (fast tier only)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] mixed real-then-lock case made %s calls, expected 2\n' "$CALLS9"
fi

# ══ ROUND 3 (2026-11-18) ═══════════════════════════════════════════════════
# gh run 44216565244, job 134507750848: `E2E (webkit-iphone)` red on main and
# on every code branch in the same hour, so the aggregate required check
# `E2E Tests` was red and no code PR could merge.

# ── 10: THE ORPHAN — the step collides with its OWN first install ──────────
# The mechanism, at unit level: attempt 1 outlives its budget;
# run_with_timeout kills only the direct child; the install itself survives
# as an orphan holding the dpkg lock; every later attempt collides with it,
# is correctly classified "lock", and both tiers burn out against a holder
# that was never going to let go while they raced it.
#
# Before the fix this case ends in ::warning:: + no deps (what main did).
# After it, the step WAITS for the holder it named, the orphan's own install
# completes, and the next attempt is a fast no-op success.
ORPHAN_PIDFILE="$WS/orphan-pid"
COUNTER10="$WS/counter-orphan"
START10=$(date +%s)
assert_green "(round 3) a timed-out attempt's own orphaned installer is WAITED OUT, not raced — the step recovers instead of degrading" \
  --contains "did not respond within 2s" \
  --contains "apt/dpkg lock held by another process" \
  --contains "Waiting up to" \
  --contains "NOT starting a competing install" \
  --contains "exited after" \
  --contains "OK (lock attempt 1/2)" \
  --not-contains "::warning::" \
  --not-contains "continuing WITHOUT installing system deps" \
  -- run_install "0" "$COUNTER10" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=6 \
       CALL_TIMEOUT_SECONDS=2 \
       HOLDER_WAIT_MAX_SECONDS=40 \
       HOLDER_POLL_INTERVAL_SECONDS=1
END10=$(date +%s)
DURATION10=$((END10 - START10))
CALLS10="$(cat "$COUNTER10" 2>/dev/null || echo '?')"
if [ "$CALLS10" = "3" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3) orphan case made exactly 3 calls (1 timeout + 1 collision that NAMES the holder + 1 success after it exits)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3) orphan case made %s calls, expected 3\n' "$CALLS10"
fi
# The wait must be bounded by the holder's actual exit, not by the budget:
# 40s of budget for a 6s orphan must cost ~6s, not 40.
if [ "$DURATION10" -le 25 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3) orphan case finished in %ss — the wait ends when the holder exits, it does not burn its whole 40s budget\n' "$DURATION10"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3) orphan case took %ss — expected well under 25s\n' "$DURATION10"
fi
ORPHAN_PID_SEEN="$(cat "$ORPHAN_PIDFILE" 2>/dev/null || echo '')"
if [ -n "$ORPHAN_PID_SEEN" ] && ! ps -p "$ORPHAN_PID_SEEN" >/dev/null 2>&1; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3) the orphan (pid %s) really did outlive the attempt that spawned it and is gone by the end — the fixture models the grandchild, not a killable child\n' "$ORPHAN_PID_SEEN"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3) orphan fixture did not behave as modelled (pid=%s)\n' "${ORPHAN_PID_SEEN:-none}"
fi

# ── 11: a timed-out attempt's OUTPUT IS PRINTED (requirement 3) ────────────
# On run 44216565244 the rc=124 branch printed one line and dropped
# $LAST_OUT, and the LAST attempt of a tier printed nothing at all (log
# lines 3562/3563 are adjacent) — which is why the cause of the slowness
# itself stayed unknown. FAST/LOCK are 1 here so the single attempt of each
# tier IS the last one: the case proves the final-position print too.
COUNTER11="$WS/counter-timeout-tail"
APT_LINE="Get:12 http://azure.archive.ubuntu.com/ubuntu noble/main amd64 libwoff1 amd64 1.0.2-3"
assert_green "(round 3) a timed-out attempt prints a bounded tail of its captured output, including in the LAST position of a tier" \
  --contains "lines of its captured output" \
  --contains "libwoff1" \
  --contains "last attempt of this tier" \
  --contains "::warning::" \
  -- run_install "0" "$COUNTER11" \
       FAKE_PW_DEPS_SLEEP_SECONDS=3 \
       FAKE_PW_DEPS_ECHO_BEFORE_SLEEP="$APT_LINE" \
       CALL_TIMEOUT_SECONDS=1 \
       FAST_MAX_ATTEMPTS=1 \
       LOCK_MAX_ATTEMPTS=1

# ── 12-14: the degrade path no longer hands a dead browser to the shard ───
# Requirement 4, asymmetric so it can add no false failure of its own.
PROBE_MISSING="$WS/probe-missing.sh"
cat >"$PROBE_MISSING" <<'PROBE'
#!/usr/bin/env bash
# Stand-in for the real launch probe on a runner whose webkit deps are
# absent — the verbatim loader failure from gh run 44216565244 line 3652.
echo "/home/runner/.cache/ms-playwright/webkit-2272/minibrowser-wpe/bin/MiniBrowser: error while loading shared libraries: libwoff2dec.so.1.0.2: cannot open shared object file: No such file or directory" >&2
exit 1
PROBE
PROBE_OK="$WS/probe-ok.sh"
printf '#!/usr/bin/env bash\necho "browser launched and closed"\nexit 0\n' >"$PROBE_OK"
# "The probe RAN and failed for a reason that says nothing about the
# libraries" — the inconclusive branch. It must not be a 127: as of round
# 3's review a probe that could not run at all fails the step (see the
# `no-such-probe` case below), so 127 no longer models this branch.
PROBE_OTHER="$WS/probe-other.sh"
cat >"$PROBE_OTHER" <<'PROBE'
#!/usr/bin/env bash
echo "TypeError: Cannot read properties of undefined (reading 'launch')" >&2
exit 1
PROBE

COUNTER12="$WS/counter-verify-missing"
SUMMARY12="$WS/summary-verify-missing"
: >"$SUMMARY12"
assert_red "(round 3) deps skipped AND the browser cannot launch — the STEP fails, naming the missing library, instead of the whole shard dying on browserType.launch" \
  --contains "::error::" \
  --contains "the browser cannot start without them" \
  --contains "libwoff2dec.so.1.0.2" \
  -- run_install "1" "$COUNTER12" FAKE_PW_DEPS_LOCK_TEXT=1 \
       DEPS_VERIFY_CMD="bash $PROBE_MISSING" GITHUB_STEP_SUMMARY="$SUMMARY12"
# Round 3 review, CR-L-2: the summary is written BEFORE the probe can
# decide (on purpose — the record of why the install was skipped must
# survive), so on this path it used to show ":warning: skipped" as the
# heading of a step whose conclusion is `failure`. The verdict is now
# appended, and the summary has to carry BOTH.
if grep -q "THIS STEP FAILED" "$SUMMARY12" 2>/dev/null \
  && grep -q "Playwright system deps skipped" "$SUMMARY12" 2>/dev/null; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] (round 3 review) the failing-probe path appends its verdict to GITHUB_STEP_SUMMARY, so the summary no longer reads as a warning for a step that FAILED\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] (round 3 review) the failing-probe path left only the warning heading in GITHUB_STEP_SUMMARY\n'
  [ -f "$SUMMARY12" ] && sed 's/^/      | /' "$SUMMARY12"
fi

# Playwright's OWN pre-flight refusal, which it raises INSTEAD of launching
# — a different string from the loader failure above, and the one a real
# runner is at least as likely to produce. Verbatim from playwright-core.
PROBE_HOSTDEPS="$WS/probe-hostdeps.sh"
cat >"$PROBE_HOSTDEPS" <<'PROBE'
#!/usr/bin/env bash
echo "Host system is missing dependencies to run browsers." >&2
echo "Please install them with the following command:" >&2
echo "    sudo npx playwright install-deps" >&2
exit 1
PROBE

COUNTER12B="$WS/counter-verify-hostdeps"
assert_red "(round 3) Playwright's own 'Host system is missing dependencies' refusal also fails the STEP — its clearest answer must not read as inconclusive" \
  --contains "::error::" \
  --contains "the browser cannot start without them" \
  --contains "Host system is missing dependencies" \
  --not-contains "inconclusive" \
  -- run_install "1" "$COUNTER12B" FAKE_PW_DEPS_LOCK_TEXT=1 \
       DEPS_VERIFY_CMD="bash $PROBE_HOSTDEPS"

COUNTER13="$WS/counter-verify-ok"
assert_green "(round 3) deps skipped but the browser launches anyway — stays a warning, exactly as before (this is the 5-of-6-shards reality the degrade rests on)" \
  --contains "Launch probe OK" \
  --contains "::warning::" \
  --not-contains "::error::" \
  -- run_install "1" "$COUNTER13" FAKE_PW_DEPS_LOCK_TEXT=1 \
       DEPS_VERIFY_CMD="bash $PROBE_OK"

COUNTER14="$WS/counter-verify-inconclusive"
assert_green "(round 3) a probe that fails WITHOUT naming a missing library is inconclusive and never fails the step — the gate adds no false failure of its own" \
  --contains "inconclusive" \
  --not-contains "::error::" \
  -- run_install "1" "$COUNTER14" FAKE_PW_DEPS_LOCK_TEXT=1 \
       DEPS_VERIFY_CMD="bash $PROBE_OTHER"

# ── 15: a shard that does NOT opt in is untouched ──────────────────────────
# chromium shards pass with no install at all; they must keep doing so.
COUNTER15="$WS/counter-no-verify"
assert_green "(round 3) with no DEPS_VERIFY_BROWSER/DEPS_VERIFY_CMD set, the degrade path is byte-for-byte round 2's behaviour (chromium shards unaffected)" \
  --contains "::warning::" \
  --contains "continuing WITHOUT installing system deps" \
  --not-contains "::error::" \
  --not-contains "launch probe" \
  -- run_install "1" "$COUNTER15" FAKE_PW_DEPS_LOCK_TEXT=1

# ── 16: the PRODUCTION default probe command, derived from the knob CI ────
# actually sets. Cases 12-14 above all inject DEPS_VERIFY_CMD directly, so
# none of them ever executed the string the script BUILDS from
# DEPS_VERIFY_BROWSER — the only form ci.yml uses. That string is expanded
# UNQUOTED into run_with_timeout, so its word-splitting is load-bearing: if
# `-e` and the JS lost their boundary the probe would die 127/"not found",
# land in the inconclusive branch and exit 0, leaving requirement 4 silently
# off on the one shard it exists for. A fake `pnpm` first on PATH records
# the argv it receives and then plays the loader failure, so this case
# proves BOTH that the derived argv is the intended one and that the real
# default reaches the error branch.
FAKE_BIN="$WS/bin"
mkdir -p "$FAKE_BIN"
ARGV_LOG="$WS/pnpm-argv.txt"
cat >"$FAKE_BIN/pnpm" <<PNPM
#!/usr/bin/env bash
# Records its argv one-per-line, then fails exactly like a runner whose
# webkit deps are missing.
printf '%s\n' "\$@" >"$ARGV_LOG"
echo "/home/runner/.cache/ms-playwright/webkit-2272/minibrowser-wpe/bin/MiniBrowser: error while loading shared libraries: libwoff2dec.so.1.0.2: cannot open shared object file: No such file or directory" >&2
exit 1
PNPM
chmod +x "$FAKE_BIN/pnpm"

COUNTER16="$WS/counter-verify-derived"
assert_red "(round 3) the DEFAULT probe command derived from DEPS_VERIFY_BROWSER (the only form ci.yml sets) really runs and really fails the step" \
  --contains "::error::" \
  --contains "the browser cannot start without them" \
  --contains "libwoff2dec.so.1.0.2" \
  --not-contains "inconclusive" \
  -- run_install "1" "$COUNTER16" FAKE_PW_DEPS_LOCK_TEXT=1 \
       DEPS_VERIFY_BROWSER=webkit \
       PATH="$FAKE_BIN:$PATH"

DERIVED_ARGV="$(cat "$ARGV_LOG" 2>/dev/null || echo '<the fake pnpm was never called>')"
EXPECTED_ARGV="$(printf '%s\n' '--filter' '@crm/e2e' 'exec' 'node' '-e' "require('@playwright/test').webkit.launch().then(b=>b.close())")"
if [ "$DERIVED_ARGV" = "$EXPECTED_ARGV" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] the derived probe argv is exactly the 6 intended words, with the JS kept whole in -e\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] the derived probe argv is not the intended one.\n  got:\n%s\n  expected:\n%s\n' "$DERIVED_ARGV" "$EXPECTED_ARGV"
fi

# ══ ROUND 3 REVIEW (2026-11-18) ════════════════════════════════════════════
# Every case below covers a branch the round-3 suite shipped WITHOUT one.
# The gap was not cosmetic: the step deadline and the holder-wait expiry are
# the two mechanisms that bound this step, and a green suite proved nothing
# about either (review findings CR-M-2 / CR-M-3 / SPEC-M-1 / SPEC-M-2).

# ── 17: a probe that CANNOT RUN fails the step (CR-L-1) ───────────────────
# 127 used to land in `inconclusive` and exit 0, so a mistake in the
# DEPS_VERIFY_CMD derivation (word-split unquoted) would switch this gate
# off on the one shard that opts into it, silently. A probe that never ran
# is not evidence that the browser launches.
COUNTER17="$WS/counter-verify-127"
assert_red "(round 3 review) a launch probe that cannot be executed at all (127) FAILS the step — a probe that never ran is not evidence the browser launches" \
  --contains "::error::" \
  --contains "could not be executed at all (exit 127" \
  --not-contains "inconclusive" \
  -- run_install "1" "$COUNTER17" FAKE_PW_DEPS_LOCK_TEXT=1 \
       DEPS_VERIFY_CMD="$WS/no-such-probe-command"

# ── 18: the wait switched OFF still pauses (SPEC-H-1) ─────────────────────
# Every non-webkit shard sets HOLDER_WAIT_MAX_SECONDS=0 in ci.yml. With the
# wait off, _wait_for_holder returns at its budget guard — and before the
# review's fix _pause_before_retry returned 0 right there, so a NAMED
# holder meant retrying with NO pause at all: a second behaviour change on
# legs that opted into none of this. Every other lock fixture in this suite
# runs with flat sleeps of 0, so nothing here could catch it.
COUNTER18="$WS/counter-wait-off-still-pauses"
START18=$(date +%s)
assert_green "(round 3 review) with the holder wait switched off (what every non-webkit shard sets) a NAMED holder still gets the tier's flat pause" \
  --contains "apt/dpkg lock held by another process" \
  --contains "::warning::" \
  --not-contains "Waiting up to" \
  -- run_install "1" "$COUNTER18" FAKE_PW_DEPS_LOCK_TEXT=1 \
       HOLDER_WAIT_MAX_SECONDS=0 \
       FAST_RETRY_SLEEP_SECONDS=4 \
       LOCK_RETRY_SLEEP_SECONDS=4
END18=$(date +%s)
DURATION18=$((END18 - START18))
# WHERE THE FLOOR COMES FROM (round 3 review, CR-M-4). The old band [3, 15]
# could not fail the regression this case exists to catch, and the comment
# that justified it ("a regression that drops the fallback finishes in ~0s")
# was arithmetically wrong: run_with_timeout polls its child with `sleep 1`
# and takes that branch even for a child that exits in milliseconds, so EVERY
# fake call costs ~1s whether anything pauses or not. Four calls are therefore
# ~4s on their own, and the measured fallback-removed mutant was exactly 4s —
# inside the old band, green.
#
# The floor is now derived from the part of the case that does NOT depend on
# the per-call cost: the two flat pauses are 4s each, so the real script
# sleeps 8s here no matter what a loaded runner does to the calls, and
# whole-second START/END arithmetic can under-read a span by at most 1s —
# hence 7. The mutant has no pauses at all, so to reach 7 its four calls would
# have to cost 1.75s each. Measured: real 12s, mutant 4s.
#
# The ceiling moves with the floor (the case is ~4s longer than it was) and
# stays a runaway guard, not a proof: 25 leaves ~13s of slack on the measured
# 12s.
if [ "$DURATION18" -ge 7 ] && [ "$DURATION18" -le 25 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3 review) the wait-off case really slept its two 4s tier pauses (%ss total) instead of racing the holder with no pause\n' "$DURATION18"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3 review) the wait-off case took %ss — expected ~12s (two flat 4s pauses + ~1s per fake call); ~4s means the flat-pause fallback is gone\n' "$DURATION18"
fi

# ── 19: the STEP DEADLINE actually stops the step (CR-M-2 / SPEC-M-2) ─────
# DEPS_STEP_DEADLINE_SECONDS appeared in NO case at this round's head, so
# `_run_tier`'s `rem <= 0` early return and its per-attempt clamp never ran
# — although that deadline is the only thing standing between webkit's
# 480s x 4 attempts (32 min, round 4) and the job's `timeout-minutes: 15`.
# CALL_TIMEOUT_SECONDS=50 against a 3s deadline proves the clamp too: the
# attempt must be cut at 3s, so "within 50s" must never appear.
COUNTER19="$WS/counter-deadline-stops"
START19=$(date +%s)
assert_green "(round 3 review) the step's own wall-clock deadline stops it, and clamps each attempt to what remains" \
  --contains "wall-clock budget is spent" \
  --contains "did not respond within 3s" \
  --not-contains "within 50s" \
  --contains "::warning::" \
  --contains "after 1 attempt across both retry tiers" \
  --contains "wall-clock budget was spent first" \
  --not-contains "after 4 attempts" \
  -- run_install "0" "$COUNTER19" \
       DEPS_STEP_DEADLINE_SECONDS=3 \
       CALL_TIMEOUT_SECONDS=50 \
       FAKE_PW_DEPS_SLEEP_SECONDS=5
END19=$(date +%s)
DURATION19=$((END19 - START19))
CALLS19="$(cat "$COUNTER19" 2>/dev/null || echo '?')"
if [ "$CALLS19" = "1" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3 review) the spent deadline stopped the step after exactly 1 call, not FAST_MAX+LOCK_MAX=4\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3 review) deadline case made %s calls, expected 1\n' "$CALLS19"
fi
if [ "$DURATION19" -le 12 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3 review) the deadline case finished in %ss — the 3s deadline bound it, not the 50s per-attempt budget\n' "$DURATION19"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3 review) deadline case took %ss — expected well under 12s\n' "$DURATION19"
fi

# ── 20: the probe keeps its floor once the deadline is spent ──────────────
# _verify_deps_or_fail's `[ "$rem" -lt 30 ] && rem=30` floor: the probe is
# the whole point of the degrade branch, so a spent budget must not shrink
# it to zero. The step now prints the effective timeout, which is what
# makes this branch observable without a 30-second test.
COUNTER20="$WS/counter-probe-floor"
assert_green "(round 3 review) with the step budget spent, the launch probe still gets its 30s floor instead of a zero timeout" \
  --contains "probe timeout 30s" \
  --contains "Launch probe OK" \
  --not-contains "::error::" \
  -- run_install "0" "$COUNTER20" \
       DEPS_STEP_DEADLINE_SECONDS=3 \
       CALL_TIMEOUT_SECONDS=50 \
       FAKE_PW_DEPS_SLEEP_SECONDS=5 \
       DEPS_VERIFY_CMD="bash $PROBE_OK"

# ── 21: A HOLDER THAT OUTLIVES THE WAIT (CR-M-3 / SPEC-M-1) ──────────────
# The contract the PR header promises — "a genuinely foreign holder that
# outlives the bounded wait still degrades with round 2's warning" — had no
# test on the new code path: every lock fixture ran with budget 0 (returns
# before the poll loop) and the one real-budget case had its holder exit in
# ~6s (always the success path). So the poll loop's exhaustion, its
# `STILL alive` line and the degrade that follows never executed.
#
# All THREE call sites are covered here: the tier-boundary wait, the in-tier
# one inside _pause_before_retry (reached because the lock tier's first
# attempt is not its last), and round 4's post-tier _recheck_after_holder
# (reached because the last failure is still class `lock` and names a pid).
# Each site that polls a holder to exhaustion prints its own "STILL alive"
# line, so the COUNT of those lines is what tells the sites apart — the
# duration band that used to carry this claim could not (round 3 review,
# CR-M-5; see the assertion below).
ORPHAN_PIDFILE_B="$WS/orphan-pid-outlives"
COUNTER21="$WS/counter-holder-outlives"
START21=$(date +%s)
assert_green "(round 3 review) a holder that OUTLIVES a positive wait budget degrades with round 2's warning and exit 0 — the contract the header promises, now executed" \
  --contains "Waiting up to 4s" \
  --contains "is STILL alive after 4s of waiting" \
  --contains "::warning::" \
  --contains "continuing WITHOUT installing system deps" \
  --contains "after 4 attempts across both retry tiers" \
  --not-contains "::error::" \
  --not-contains "exited after" \
  --not-contains "wall-clock budget was spent first" \
  -- run_install "0" "$COUNTER21" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_B" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=45 \
       CALL_TIMEOUT_SECONDS=2 \
       HOLDER_WAIT_MAX_SECONDS=4 \
       HOLDER_POLL_INTERVAL_SECONDS=1
END21=$(date +%s)
DURATION21=$((END21 - START21))
# The sleeper outlives the whole case on purpose — reap it by the pid the
# fixture recorded (never by pattern: a sibling agent's processes are not
# ours to kill, agent-isolation.md rule 5).
ORPHAN_PID_B="$(cat "$ORPHAN_PIDFILE_B" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_B" ] && kill "$ORPHAN_PID_B" 2>/dev/null
CALLS21="$(cat "$COUNTER21" 2>/dev/null || echo '?')"
if [ "$CALLS21" = "4" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3 review) holder-outlives case made exactly 4 calls (both tiers exhausted against a holder that never let go)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3 review) holder-outlives case made %s calls, expected 4\n' "$CALLS21"
fi
# TWO CALL SITES, COUNTED RATHER THAN TIMED (round 3 review, CR-M-5). The
# duration floor this replaces (`-ge 8`) claimed that "under 8s means only one
# call site waited", and the arithmetic does not support it: the honest mutant
# — the in-tier wait inside _pause_before_retry replaced by the tier's flat
# pause — removes exactly one 4s wait from the measured 14s, leaving ~10s,
# which the floor passed. Nothing else in the case objected either: the call
# count stays 4, and each `--contains` is satisfied by a single occurrence.
#
# The number of exhausted poll loops is directly observable, needs no timing
# at all, and is what the case is actually about: each site that polls a
# holder to exhaustion prints the line once. Measured: 2 before round 4, 3
# after it added the post-tier re-check, 1 for the honest mutant that drops
# the in-tier wait. `grep -c` exits non-zero when it counts zero, so the
# `|| true` keeps a regression reporting "0" instead of killing the suite.
STILL_ALIVE21="$(printf '%s\n' "$_GT_OUT" | grep -c 'STILL alive after 4s' || true)"
if [ "$STILL_ALIVE21" = "3" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3 review) holder-outlives case exhausted exactly 3 poll loops — the tier-boundary wait, the in-tier one and round 4 post-tier re-check all ran\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3 review) holder-outlives case printed "STILL alive after 4s" %s time(s), expected 3 (one per polling call site)\n' "$STILL_ALIVE21"
fi
# Kept as a runaway guard only — it proves nothing about the call sites. The
# case measures ~18s (call 1 times out at 2s holding the lock, calls 2-4 are
# ~1s refusals, and the three waits are 4s each) and nothing here should
# approach 35s.
if [ "$DURATION21" -le 35 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3 review) holder-outlives case spent %ss, inside its 35s runaway bound\n' "$DURATION21"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3 review) holder-outlives case spent %ss — over its 35s runaway bound\n' "$DURATION21"
fi

# ── 22: the wait is clamped by the REMAINING step budget, not its own knob ─
# _wait_for_holder's `[ "$budget" -gt "$usable" ]` branch. With a 180s knob
# (webkit's production value is 420s; 180 is this case's stand-in for any knob
# larger than the budget) and a 12s deadline minus a 5s reserve, the wait must
# announce the handful of seconds it can actually afford — never 180.
#
# DEPS_RECHECK_WAIT_FLOOR_SECONDS=0 below (round 4 review, SR-H-1): this case
# predates the post-tier wait floor and its subject is the IN-TIER clamp/veto,
# which the floor deliberately does not touch (in-tier callers pass no floor).
# Left at its production 60s the floor rescues this fixture's 45s orphan through
# the post-tier re-check, and the case stops exercising what it exists for. The
# floor's own path is case 28.
ORPHAN_PIDFILE_C="$WS/orphan-pid-clamped"
COUNTER22="$WS/counter-wait-clamped"
assert_green "(round 3 review) the holder wait is clamped by the step's remaining budget (minus the retry reserve), not by its own knob" \
  --contains "Waiting up to" \
  --contains "is STILL alive after" \
  --not-contains "Waiting up to 180s" \
  --contains "::warning::" \
  -- run_install "0" "$COUNTER22" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_C" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=45 \
       CALL_TIMEOUT_SECONDS=2 \
       HOLDER_WAIT_MAX_SECONDS=180 \
       HOLDER_WAIT_RESERVE_SECONDS=5 \
       DEPS_STEP_DEADLINE_SECONDS=12 \
       DEPS_RECHECK_WAIT_FLOOR_SECONDS=0 \
       HOLDER_POLL_INTERVAL_SECONDS=1
ORPHAN_PID_C="$(cat "$ORPHAN_PIDFILE_C" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_C" ] && kill "$ORPHAN_PID_C" 2>/dev/null

# ── 23: NO SLEEP MAY OUTLIVE THE DEADLINE (CR-M-1, second half) ──────────
# LOCK_RETRY_SLEEP_SECONDS is 60s in production and used to be slept flat,
# unconditionally: a pause entered with a few seconds of budget left ran
# the step ~55s past the deadline that ci.yml's comment says bounds it, and
# the step then reported "continuing WITHOUT" on a run whose packages were
# already installed. Every attempt here times out (no holder is ever
# named), so _pause_before_retry takes its FLAT branch each time.
# Unclamped, the lock tier's pause alone would make this case ~68s.
COUNTER23="$WS/counter-sleep-clamped"
START23=$(date +%s)
assert_green "(round 3 review) a flat inter-attempt pause is clamped to the remaining budget — no sleep may outlive the step's own deadline" \
  --contains "wall-clock budget is spent" \
  --contains "::warning::" \
  -- run_install "0" "$COUNTER23" \
       DEPS_STEP_DEADLINE_SECONDS=10 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_RETRY_SLEEP_SECONDS=2 \
       LOCK_RETRY_SLEEP_SECONDS=60 \
       FAKE_PW_DEPS_SLEEP_SECONDS=30
END23=$(date +%s)
DURATION23=$((END23 - START23))
if [ "$DURATION23" -le 25 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3 review) the clamped pauses kept the step at %ss against its 10s deadline — unclamped, the 60s lock-tier pause alone would make this ~68s\n' "$DURATION23"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3 review) sleep-clamp case took %ss — expected under 25s; a 60s+ result means a flat sleep outlived the deadline\n' "$DURATION23"
fi

# ── 24: THE RETRY RESERVE (CR-M-1, first half) ───────────────────────────
# The wait exists to enable the NEXT attempt, so it must not be able to
# consume the budget that attempt needs. Here the whole remaining budget is
# smaller than the reserve, so the correct answer is to NOT wait at all and
# fall back to the tier's pause. Without the reserve the budget would be
# `min(180, ~10)` and the step would announce and spend a ~10s wait it
# cannot afford — which is the shape that left a second orphaned apt-get
# behind an rc-124 retry on a spent budget.
#
# DEPS_RECHECK_WAIT_FLOOR_SECONDS=0 below (round 4 review, SR-H-1): this case
# predates the post-tier wait floor and its subject is the IN-TIER clamp/veto,
# which the floor deliberately does not touch (in-tier callers pass no floor).
# Left at its production 60s the floor rescues this fixture's 45s orphan through
# the post-tier re-check, and the case stops exercising what it exists for. The
# floor's own path is case 28.
ORPHAN_PIDFILE_D="$WS/orphan-pid-reserve"
COUNTER24="$WS/counter-reserve-refuses"
assert_green "(round 3 review) the wait refuses to start when the remaining budget is smaller than the retry reserve, and the tier's flat pause takes over" \
  --contains "apt/dpkg lock held by another process" \
  --contains "::warning::" \
  --not-contains "Waiting up to" \
  -- run_install "0" "$COUNTER24" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_D" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=45 \
       CALL_TIMEOUT_SECONDS=2 \
       DEPS_STEP_DEADLINE_SECONDS=12 \
       HOLDER_WAIT_MAX_SECONDS=180 \
       DEPS_RECHECK_WAIT_FLOOR_SECONDS=0 \
       HOLDER_POLL_INTERVAL_SECONDS=1
ORPHAN_PID_D="$(cat "$ORPHAN_PIDFILE_D" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_D" ] && kill "$ORPHAN_PID_D" 2>/dev/null

# ── 25: THE POLL INTERVAL CANNOT STOP ADVANCING (CR-L-3) ─────────────────
# _wait_for_holder's poll loop advances `waited` by HOLDER_POLL_INTERVAL_SECONDS
# and by nothing else, and it never re-reads _remaining_budget — so a 0 left
# `waited` constant and the wait unbounded, with the step's own deadline
# unable to stop it (measured on the unclamped loop: waited=0 after 500
# iterations against a budget of 4). It would have run to the e2e job's
# `timeout-minutes: 15` and produced the ambiguous `cancelled` conclusion this
# script exists to remove. The knob invites the value: its NEIGHBOUR documents
# 0 as "off" (HOLDER_WAIT_MAX_SECONDS=0 is what every non-webkit shard sets).
#
# WHY THIS ONE CASE IS WATCHDOGGED: a regression here does not make the case
# slow, it makes it never return — and a duration check placed after the call
# cannot print a FAIL it never reaches. The suite would hang until CI killed
# the job, which is the same ambiguous outcome. Under the watchdog the failure
# is a FAIL line: rc 124 plus a "WATCHDOG KILLED" string this case refuses.
#
# Shape: the fast tier's first attempt times out and leaves the orphan holding
# the lock (its output names no pid, so no wait runs there); its second
# attempt gets apt's real refusal, which NAMES the orphan — so the
# tier-boundary wait polls it with the clamped interval and ends at its 2s
# budget. 3 calls, ~6s.
run_install_bounded() {
  local limit="$1"
  shift
  local RUN_INSTALL_WATCHDOG_SECONDS="$limit"
  run_install "$@"
}

ORPHAN_PIDFILE_E="$WS/orphan-pid-poll-zero"
COUNTER25="$WS/counter-poll-zero"
assert_green "(round 3 review) HOLDER_POLL_INTERVAL_SECONDS=0 is clamped to a positive integer — the holder wait still ends instead of spinning past the job's own timeout" \
  --contains "is not a positive integer" \
  --contains "Waiting up to 2s" \
  --contains "is STILL alive after 2s" \
  --contains "::warning::" \
  --not-contains "WATCHDOG KILLED" \
  -- run_install_bounded 40 "0" "$COUNTER25" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_E" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=45 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_MAX_ATTEMPTS=2 \
       LOCK_MAX_ATTEMPTS=1 \
       HOLDER_WAIT_MAX_SECONDS=2 \
       HOLDER_POLL_INTERVAL_SECONDS=0
ORPHAN_PID_E="$(cat "$ORPHAN_PIDFILE_E" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_E" ] && kill "$ORPHAN_PID_E" 2>/dev/null
CALLS25="$(cat "$COUNTER25" 2>/dev/null || echo '?')"
if [ "$CALLS25" = "3" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 3 review) the clamped-poll case made exactly 3 calls (2 fast-tier + 1 lock-tier) — the wait between the tiers terminated instead of spinning\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 3 review) clamped-poll case made %s calls, expected 3\n' "$CALLS25"
fi

# ── 26: ROUND 4 — THE HOLDER NAMED BY A TIER'S *LAST* ATTEMPT ────────────
# The hole case 10 cannot reach. There the naming refusal arrives on the lock
# tier's FIRST of two attempts, so _pause_before_retry runs and the wait
# happens. When the refusal is a tier's LAST attempt — the shape of CI run
# 44267330203, where the webkit leg's orphaned `sudo apt-get` was named by the
# final attempt of both tiers — _run_tier returns without ever pausing, and
# every structural chance to wait for that holder is gone. Before round 4 the
# step degraded with ::warning:: on a run whose own orphan went on to install
# the packages seconds later; _recheck_after_holder gives that holder one
# last bounded wait and then RE-CHECKS the install instead of warning.
#
# Shape: 1 fast attempt (times out, leaves the orphan holding the lock, names
# no pid) + 1 lock attempt (apt's refusal, NAMES the orphan — and is the
# tier's last, so no in-tier pause follows) + the post-tier re-check, which
# waits ~4s for the 6s orphan and then gets the no-op success. 3 calls, ~7s.
# The one assertion that distinguishes round 4 from main is the SUCCESS: on
# main this exact case ends in ::warning:: + "continuing WITHOUT".
ORPHAN_PIDFILE_F="$WS/orphan-pid-last-attempt"
COUNTER26="$WS/counter-recheck-after-holder"
START26=$(date +%s)
assert_green "(round 4) a holder named by a tier's LAST attempt is waited out by the post-tier re-check — the step SUCCEEDS instead of warning on deps its own orphan installed" \
  --contains "Both retry tiers are done" \
  --contains "Waiting up to 20s" \
  --contains "NOT starting a competing install" \
  --contains "exited after" \
  --contains "Lock holder is gone — re-checking the install once" \
  --contains "OK (round-4 re-check after the lock holder finished)" \
  --not-contains "::warning::" \
  --not-contains "::error::" \
  --not-contains "continuing WITHOUT installing system deps" \
  -- run_install "0" "$COUNTER26" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_F" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=6 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_MAX_ATTEMPTS=1 \
       LOCK_MAX_ATTEMPTS=1 \
       HOLDER_WAIT_MAX_SECONDS=20 \
       HOLDER_WAIT_RESERVE_SECONDS=1 \
       DEPS_STEP_DEADLINE_SECONDS=60 \
       HOLDER_POLL_INTERVAL_SECONDS=1
END26=$(date +%s)
DURATION26=$((END26 - START26))
ORPHAN_PID_F="$(cat "$ORPHAN_PIDFILE_F" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_F" ] && kill "$ORPHAN_PID_F" 2>/dev/null
CALLS26="$(cat "$COUNTER26" 2>/dev/null || echo '?')"
# EXACTLY 3: the re-check must run the install ONCE more, never twice, and
# never start a competing install while the holder is still alive (a fourth
# call would mean it raced the orphan, which is the defect, not the fix).
if [ "$CALLS26" = "3" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 4) last-attempt-holder case made exactly 3 calls (1 fast timeout + 1 naming refusal + 1 post-tier re-check)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 4) last-attempt-holder case made %s calls, expected 3\n' "$CALLS26"
fi
# The wait ends on the holder's exit (~6s from the first call), not on its 20s
# budget: a case that burned the budget would land near 22s.
if [ "$DURATION26" -le 15 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 4) last-attempt-holder case finished in %ss — the re-check waits for the holder'"'"'s exit, not for its whole 20s budget\n' "$DURATION26"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 4) last-attempt-holder case took %ss — expected under 15s\n' "$DURATION26"
fi

# ── 27: ROUND 4 — THE RE-CHECK HAS A FLOOR, NOT A CLAMP TO ZERO ──────────
# The production shape case 26 cannot express. With 2+2 attempts of up to
# CALL_TIMEOUT_SECONDS=480 and a 60s reserve, the holder usually exits in the
# LAST seconds of the step's budget — so the re-check, clamped to what little
# remains, got a 1-3s timeout for a call that takes seconds, answered rc 124,
# and degraded on packages that were already on disk. That is hole (b) of the
# round-2 design reappearing one layer later, and `rem <= 0 -> return 0`
# would have walked away from the same outcome entirely.
#
# Shape: the holder is named by the lock tier's last attempt and exits during
# the post-tier wait, which leaves 2-3s of budget — less than the no-op
# install's 4s. Only DEPS_RECHECK_FLOOR_SECONDS makes that call survivable.
# Without the floor this case ends in ::warning:: + rc-124 output.
ORPHAN_PIDFILE_G="$WS/orphan-pid-recheck-floor"
COUNTER27="$WS/counter-recheck-floor"
assert_green "(round 4) the post-tier re-check gets its floor when the retries ate the budget — a holder that exits in the last seconds still ends in a success, not a warning" \
  --contains "exited after" \
  --contains "re-checking the install once (timeout 20s)" \
  --contains "OK (round-4 re-check after the lock holder finished)" \
  --not-contains "::warning::" \
  --not-contains "::error::" \
  -- run_install "0" "$COUNTER27" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_G" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=5 \
       FAKE_PW_DEPS_ORPHAN_SUCCESS_DELAY_SECONDS=4 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_MAX_ATTEMPTS=1 \
       LOCK_MAX_ATTEMPTS=1 \
       HOLDER_WAIT_MAX_SECONDS=10 \
       HOLDER_WAIT_RESERVE_SECONDS=0 \
       DEPS_STEP_DEADLINE_SECONDS=8 \
       DEPS_RECHECK_FLOOR_SECONDS=20 \
       HOLDER_POLL_INTERVAL_SECONDS=1
ORPHAN_PID_G="$(cat "$ORPHAN_PIDFILE_G" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_G" ] && kill "$ORPHAN_PID_G" 2>/dev/null
CALLS27="$(cat "$COUNTER27" 2>/dev/null || echo '?')"
if [ "$CALLS27" = "3" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (round 4) recheck-floor case made exactly 3 calls (1 fast timeout + 1 naming refusal + 1 floored re-check)\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (round 4) recheck-floor case made %s calls, expected 3\n' "$CALLS27"
fi

# ── 28: ROUND 4 REVIEW (SR-H-1) — THE RESERVE AT ITS PRODUCTION VALUE ────
# The state CI run 44280561902 (job 134719798567) actually left, and the one
# cases 26 and 27 cannot express: both neutralise HOLDER_WAIT_RESERVE_SECONDS
# (26 sets 1, 27 sets 0), which is the single knob whose production default of
# 60 made the post-tier re-check unreachable. On that run the log printed
# "Both retry tiers are done ... Giving that holder a final bounded wait" and
# then NOTHING — no wait, no re-check, straight to the degrade warning —
# because _wait_for_holder computes `usable = rem - reserve`, which is
# negative for the whole last 60s of the budget, returns 1, and the re-check's
# `|| return 0` exits before the install.
#
# This case leaves the reserve UNSET (so the default 60 applies) and gives the
# step a 4s budget, i.e. `usable` is ~-58 when the re-check starts: exactly the
# veto. DEPS_RECHECK_WAIT_FLOOR_SECONDS is what makes the wait happen anyway.
# The two numbers in the assertions are the proof the floor — not a surviving
# budget — is what granted them: "Waiting up to 20s" with a 4s step budget and
# a 60s reserve can only come from the wait floor, and the re-check's own
# "timeout 20s" from DEPS_RECHECK_FLOOR_SECONDS.
#
# On the unfixed script this case ends in ::warning:: + "continuing WITHOUT",
# with 2 calls instead of 3.
ORPHAN_PIDFILE_H="$WS/orphan-pid-reserve-default"
COUNTER28="$WS/counter-recheck-wait-floor"
assert_green "(round 4 review, SR-H-1) the post-tier wait survives HOLDER_WAIT_RESERVE_SECONDS at its production default — the re-check runs and the step SUCCEEDS instead of degrading on a spent budget" \
  --contains "Both retry tiers are done" \
  --contains "Waiting up to 20s" \
  --contains "NOT starting a competing install" \
  --contains "exited after" \
  --contains "re-checking the install once (timeout 20s)" \
  --contains "OK (round-4 re-check after the lock holder finished)" \
  --not-contains "::warning::" \
  --not-contains "::error::" \
  --not-contains "continuing WITHOUT installing system deps" \
  -- run_install "0" "$COUNTER28" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_H" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=6 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_MAX_ATTEMPTS=1 \
       LOCK_MAX_ATTEMPTS=1 \
       HOLDER_WAIT_MAX_SECONDS=20 \
       DEPS_STEP_DEADLINE_SECONDS=4 \
       DEPS_RECHECK_WAIT_FLOOR_SECONDS=20 \
       DEPS_RECHECK_FLOOR_SECONDS=20 \
       HOLDER_POLL_INTERVAL_SECONDS=1
ORPHAN_PID_H="$(cat "$ORPHAN_PIDFILE_H" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_H" ] && kill "$ORPHAN_PID_H" 2>/dev/null
CALLS28="$(cat "$COUNTER28" 2>/dev/null || echo '?')"
if [ "$CALLS28" = "3" ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (SR-H-1) reserve-at-default case made exactly 3 calls (1 fast timeout + 1 naming refusal + 1 re-check) — the re-check was NOT vetoed\n'
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (SR-H-1) reserve-at-default case made %s calls, expected 3 — 2 means the reserve vetoed the post-tier wait, which is the CI failure this case exists to catch\n' "$CALLS28"
fi

# ── 29: ROUND 4 REVIEW (SR-L-2) — THE REMEMBERED PID'S IDENTITY ──────────
# The pid is parsed out of apt's refusal during a tier and consumed by the
# post-tier re-check minutes later. `ps -p` proves only that SOME process owns
# that pid now, never that it is still the `sudo apt-get` apt named, so a pid
# reused in between makes the step wait on an unrelated process.
#
# Shape: the fixture's holder is a `sleep`, and this case alone restores the
# PRODUCTION HOLDER_COMM_REGEX (`apt|dpkg`), so the remembered pid is alive but
# is NOT an apt/dpkg process — the pid-reuse state. The step must say so, must
# NOT wait on it, and must still ask apt once (the cheap, bounded question);
# that call collides with the fixture's still-held lock, so this case ends in
# the degrade warning rather than a success. What it proves is the absence of
# the wait, not the outcome.
ORPHAN_PIDFILE_I="$WS/orphan-pid-foreign-comm"
COUNTER29="$WS/counter-holder-identity"
START29=$(date +%s)
assert_green "(round 4 review, SR-L-2) a remembered holder pid that is no longer an apt/dpkg process is NOT waited on — the step says so and does not burn its budget on a stranger" \
  --contains "Both retry tiers are done" \
  --contains "no longer an apt/dpkg process" \
  --not-contains "Waiting up to" \
  --not-contains "NOT starting a competing install" \
  --contains "::warning::" \
  -- run_install "0" "$COUNTER29" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_I" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=30 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_MAX_ATTEMPTS=1 \
       LOCK_MAX_ATTEMPTS=1 \
       HOLDER_WAIT_MAX_SECONDS=20 \
       HOLDER_COMM_REGEX='apt|dpkg' \
       DEPS_STEP_DEADLINE_SECONDS=60 \
       DEPS_RECHECK_FLOOR_SECONDS=5 \
       HOLDER_POLL_INTERVAL_SECONDS=1
END29=$(date +%s)
DURATION29=$((END29 - START29))
ORPHAN_PID_I="$(cat "$ORPHAN_PIDFILE_I" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_I" ] && kill "$ORPHAN_PID_I" 2>/dev/null
# The holder stand-in lives 30s and the wait budget is 20s, so a step that
# trusted the pid would take at least 20s. Under 15s is the measurement that
# proves no wait happened — the message alone is not proof.
if [ "$DURATION29" -le 15 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (SR-L-2) identity-mismatch case finished in %ss — no 20s wait was spent on a pid that is not apt/dpkg\n' "$DURATION29"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (SR-L-2) identity-mismatch case took %ss — expected under 15s; a longer run means the step waited on a stranger\n' "$DURATION29"
fi

# ── 30: ROUND 4 REVIEW (item 13) — THE IN-TIER IDENTITY BRANCH, BY ITS OWN
# WORDS ────────────────────────────────────────────────────────────────────────
# Two DIFFERENT branches refuse a reused pid: _wait_for_holder's own (reached at
# the tier boundary, line "Not spending the step's budget on it") and
# _recheck_after_holder's post-tier one ("it was reused in the minutes since apt
# printed it"). Case 29 asserted only the substring they SHARE, so either one
# alone satisfied it and the in-tier branch was never pinned. This case pins it
# by the sentence only it prints, and requires the post-tier one in the same run
# — two tiers, two refusals, both named.
#
# FAST_MAX_ATTEMPTS=2 is load-bearing: the boundary wait is reached only when an
# attempt of the fast tier actually NAMED a pid (_HOLDER_PID), which attempt 1
# cannot do — it is the one that spawns the holder and is killed by its own
# timeout. With one attempt per tier the in-tier branch is unreachable, which is
# why case 29 could pass without ever entering it. The reserve is lowered for
# the same kind of reason: _wait_for_holder returns BEFORE the identity check
# when the granted budget (remaining minus the reserve, floored) is not
# positive, so at the 60s production reserve this branch is unreachable too.
ORPHAN_PIDFILE_J="$WS/orphan-pid-in-tier-identity"
COUNTER30="$WS/counter-in-tier-identity"
assert_green "(round 4 review, item 13) the TIER-BOUNDARY wait refuses a reused pid in its own words, distinct from the post-tier refusal" \
  --contains "Not spending the step's budget on it" \
  --contains "it was reused in the minutes since apt printed it" \
  --not-contains "Waiting up to" \
  -- run_install "0" "$COUNTER30" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_J" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=30 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_MAX_ATTEMPTS=2 \
       LOCK_MAX_ATTEMPTS=1 \
       HOLDER_WAIT_MAX_SECONDS=20 \
       HOLDER_COMM_REGEX='apt|dpkg' \
       DEPS_STEP_DEADLINE_SECONDS=120 \
       HOLDER_WAIT_RESERVE_SECONDS=5 \
       DEPS_RECHECK_FLOOR_SECONDS=5 \
       HOLDER_POLL_INTERVAL_SECONDS=1
ORPHAN_PID_J="$(cat "$ORPHAN_PIDFILE_J" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_J" ] && kill "$ORPHAN_PID_J" 2>/dev/null

# ── 31: ROUND 4 REVIEW (SR-L-7) — comm TRUNCATION, PRODUCTION REGEX ──────────
# `ps -o comm=` truncates to 15 characters on Linux, so the Ubuntu runner's own
# `unattended-upgrade` reports as `unattended-upgr`. With the regex `apt|dpkg`
# the single most common REAL holder on a GitHub runner read as "pid reused, not
# our installer" and the step skipped the wait it exists to perform.
#
# This case runs with the PRODUCTION regex (not overridden — see
# RUN_INSTALL_PRODUCTION_COMM_REGEX) and a holder that is a copy of `sleep`
# named `unattended-upgrade`. What ps reports is printed, so the case is
# readable as evidence rather than as a claim.
HOLDER_BIN_DIR="$WS/holder-bin"
mkdir -p "$HOLDER_BIN_DIR"
# A SYMLINK, not a copy: a copied `sleep` is SIGKILLed on macOS (code signing),
# measured here. `ps -o comm=` reports the symlink's own path, so the name under
# test survives on both platforms — truncated to `unattended-upgr` on Linux,
# full on macOS, and the production regex is written to match either.
ln -s "$(command -v sleep)" "$HOLDER_BIN_DIR/unattended-upgrade"
ORPHAN_PIDFILE_K="$WS/orphan-pid-unattended"
COUNTER31="$WS/counter-unattended"
RUN_INSTALL_PRODUCTION_COMM_REGEX=1 \
assert_green "(round 4 review, SR-L-7) a holder whose comm is truncated to 'unattended-upgr' IS accepted by the production regex and waited for" \
  --contains "Waiting up to" \
  --contains "NOT starting a competing install" \
  --not-contains "its pid was reused" \
  --not-contains "no longer an apt/dpkg process" \
  -- run_install "0" "$COUNTER31" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_K" \
       FAKE_PW_DEPS_ORPHAN_SLEEP_BIN="$HOLDER_BIN_DIR/unattended-upgrade" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=12 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_MAX_ATTEMPTS=2 \
       LOCK_MAX_ATTEMPTS=1 \
       HOLDER_WAIT_MAX_SECONDS=20 \
       DEPS_STEP_DEADLINE_SECONDS=120 \
       HOLDER_WAIT_RESERVE_SECONDS=5 \
       DEPS_RECHECK_FLOOR_SECONDS=10 \
       HOLDER_POLL_INTERVAL_SECONDS=1
ORPHAN_PID_K="$(cat "$ORPHAN_PIDFILE_K" 2>/dev/null || echo '')"
if [ -n "$ORPHAN_PID_K" ]; then
  # The evidence, not a claim: what the holder's comm actually was. Printed
  # before the kill; an already-exited holder prints empty, which is why the
  # assertions above are on the step's own output and this line is context.
  printf 'ps -o comm= for the holder pid %s: %s\n' "$ORPHAN_PID_K" "$(ps -o comm= -p "$ORPHAN_PID_K" 2>/dev/null || echo '(already exited)')"
  kill "$ORPHAN_PID_K" 2>/dev/null
fi
# The truncation itself, measured on THIS machine (macOS does not truncate;
# Linux does — the guard suite runs on both, and the regex must work where the
# truncation happens).
"$HOLDER_BIN_DIR/unattended-upgrade" 5 &
PROBE_PID=$!
# A backgrounded child is not necessarily visible to `ps` on the very next
# instruction; poll briefly rather than read an empty comm as a verdict
# (verification-integrity.md: an instrument that did not look reports nothing).
PROBE_COMM=""
PROBE_TRIES=0
while [ "$PROBE_TRIES" -lt 20 ]; do
  PROBE_COMM="$(ps -o comm= -p "$PROBE_PID" 2>/dev/null | sed 's#.*/##')"
  [ -n "$PROBE_COMM" ] && break
  PROBE_TRIES=$((PROBE_TRIES + 1))
  sleep 0.2
done
kill "$PROBE_PID" 2>/dev/null
if [ -z "$PROBE_COMM" ]; then
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (SR-L-7) ps never reported a comm for the probe pid — the measurement did not happen, which is not a pass\n'
elif printf '%s\n' "$PROBE_COMM" | grep -Eq 'apt|dpkg|unattended-upgr'; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (SR-L-7) comm as this kernel reports it (%s) matches the PRODUCTION regex\n' "$PROBE_COMM"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (SR-L-7) comm as this kernel reports it (%s) does NOT match the production regex\n' "$PROBE_COMM"
fi

# ── 32: ROUND 4 REVIEW (item 13) — A REFUSED WAIT IS NOT ANNOUNCED AS A WAIT ──
# The refusal needs `remaining - HOLDER_WAIT_RESERVE_SECONDS <= 0` with the
# floor at 0, which a large reserve produces deterministically — a tiny
# deadline would race the tiers instead, and could spend the budget before an
# attempt ever named the holder. _wait_for_holder then refuses and the step
# degrades. The old
# lead line said "giving that holder a final bounded wait" BEFORE that decision,
# so the log promised a wait that never happened. The promise must be gone and
# the refusal must be stated.
ORPHAN_PIDFILE_L="$WS/orphan-pid-refused-wait"
COUNTER32="$WS/counter-refused-wait"
assert_green "(round 4 review, item 13) a wait the floor refuses is NOT announced as one — the step says no wait was taken" \
  --contains "which is STILL ALIVE" \
  --contains "No wait was taken and none is claimed" \
  --not-contains "Giving that holder a final bounded wait" \
  --not-contains "Waiting up to" \
  --contains "::warning::" \
  -- run_install "0" "$COUNTER32" \
       FAKE_PW_DEPS_ORPHAN_PIDFILE="$ORPHAN_PIDFILE_L" \
       FAKE_PW_DEPS_ORPHAN_LIFETIME_SECONDS=30 \
       CALL_TIMEOUT_SECONDS=2 \
       FAST_MAX_ATTEMPTS=1 \
       LOCK_MAX_ATTEMPTS=1 \
       HOLDER_WAIT_MAX_SECONDS=20 \
       DEPS_STEP_DEADLINE_SECONDS=30 \
       HOLDER_WAIT_RESERVE_SECONDS=600 \
       DEPS_RECHECK_WAIT_FLOOR_SECONDS=0 \
       HOLDER_POLL_INTERVAL_SECONDS=1
ORPHAN_PID_L="$(cat "$ORPHAN_PIDFILE_L" 2>/dev/null || echo '')"
[ -n "$ORPHAN_PID_L" ] && kill "$ORPHAN_PID_L" 2>/dev/null

# ── 33: ROUND 4 REVIEW (item 14) — THE FIRST ATTEMPT IS CLAMPED TOO ───────────
# The unconditional first attempt (round 4 note 2) used to run at the FULL
# CALL_TIMEOUT_SECONDS whenever the budget was already spent, because the clamp
# was gated on `rem > 0`. On the webkit leg that is a 240s apt call starting
# after the step's own budget is gone, which can reach the job's
# timeout-minutes ceiling — whose conclusion is an ambiguous "cancelled" with no
# step log at all.
#
# Shape: budget spent at entry (deadline 0) and a hanging fixture, with
# CALL_TIMEOUT_SECONDS=120 and the floor at 2s. Unclamped the case takes 120s;
# clamped it takes ~2. The watchdog makes a regression visible instead of
# hanging the suite.
COUNTER33="$WS/counter-first-attempt-clamp"
START33=$(date +%s)
RUN_INSTALL_WATCHDOG_SECONDS=90 \
assert_green "(round 4 review, item 14) the unconditional first attempt is clamped by the floor, not left at the full per-call timeout" \
  --contains "::warning::" \
  --not-contains "WATCHDOG KILLED" \
  -- run_install "1" "$COUNTER33" \
       FAKE_PW_DEPS_SLEEP_SECONDS=120 \
       CALL_TIMEOUT_SECONDS=120 \
       DEPS_MIN_CALL_SECONDS=2 \
       FAST_MAX_ATTEMPTS=1 \
       LOCK_MAX_ATTEMPTS=1 \
       DEPS_STEP_DEADLINE_SECONDS=0
END33=$(date +%s)
DURATION33=$((END33 - START33))
if [ "$DURATION33" -le 30 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] (item 14) the spent-budget first attempt was cut at the floor — %ss, not the 120s CALL_TIMEOUT_SECONDS\n' "$DURATION33"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] (item 14) the spent-budget first attempt ran %ss — the clamp did not apply, so one attempt can outlive the job timeout\n' "$DURATION33"
fi

# ── 34: ROUND 4 REVIEW (item 12) — THE SOURCES LINE IS PRINTED, ALWAYS ────────
# Addendum 7's missing fact (`E: Unable to locate package fonts-unifont`, job
# 134961852153) was WHICH sources apt had. That dump used to live inside the
# progress sampler, which was off by default, so the one run that needed it did
# not have it. The sampler is gone; this line is unconditional. deb822 `URIs:`
# is the 24.04 form, which a `cat sources.list` does not show.
SOURCES_DIR="$WS/apt-sources"
mkdir -p "$SOURCES_DIR"
cat >"$SOURCES_DIR/ubuntu.sources" <<'EOF'
Types: deb
URIs: http://us-west-2.ec2.archive.ubuntu.com/ubuntu/
Suites: noble
Components: main universe
EOF
COUNTER34="$WS/counter-apt-sources"
assert_green "(round 4 review, item 12) the apt sources line is printed on the GREEN path too, and reads deb822 URIs" \
  --contains "apt sources:" \
  --contains "URIs: http://us-west-2.ec2.archive.ubuntu.com/ubuntu/" \
  --not-contains "deps-progress" \
  --not-contains "Progress sampler on" \
  -- run_install "0" "$COUNTER34" \
       APT_SOURCES_PATHS="$SOURCES_DIR"

guard_test_summary "test-install-playwright-system-deps.sh"
