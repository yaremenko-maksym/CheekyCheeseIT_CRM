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
#
# Each timing-sensitive case is measured with `date +%s`, matching
# test-gh-merge-pr-with-retry.sh's own convention — "the message says it
# recovered" is not proof; "it actually finished in bounded time" is.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SCRIPT="$GUARD_DIR/install-playwright-system-deps.sh"
FAKE_PW="$SELF_DIR/lib/fake-playwright-deps.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

run_install() {
  # $1 = FAKE_PW_DEPS_RC_SEQUENCE, $2 = counter file path, remaining =
  # extra env assignments as NAME=value. Sleeps default to 0 so the suite
  # stays fast; individual cases override CALL_TIMEOUT_SECONDS /
  # FAST_MAX_ATTEMPTS / LOCK_MAX_ATTEMPTS / lock text as needed.
  local rc_seq="$1" counter="$2"
  shift 2
  local extra_env=("$@")
  env \
    PLAYWRIGHT_DEPS_CMD="$FAKE_PW" \
    FAKE_PW_DEPS_RC_SEQUENCE="$rc_seq" \
    FAKE_PW_DEPS_CALL_COUNTER="$counter" \
    FAST_RETRY_SLEEP_SECONDS="0" \
    LOCK_RETRY_SLEEP_SECONDS="0" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$SCRIPT"
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

# ── (a) THE #562 SHAPE — apt/dpkg lock held through the whole fast tier, ───
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

# ── (c) RED — a real (non-lock) dependency error stays a loud, immediate ───
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

# ── (b) THE HEADLINE CASE — a lock that NEVER clears, through BOTH tiers, ──
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

# ── a real dependency error that only surfaces AFTER the lock clears mid- ──
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

guard_test_summary "test-install-playwright-system-deps.sh"
