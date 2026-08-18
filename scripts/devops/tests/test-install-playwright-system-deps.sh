#!/usr/bin/env bash
# test-install-playwright-system-deps.sh — proves
# scripts/devops/install-playwright-system-deps.sh (backlog item 122,
# .claude/tasks/BACKLOG-followups.md, 2026-08-18) actually does the three
# things the backlog item asked for, not just "looks right on read":
#
#   1. THE GREEN PATH IS UNCHANGED — a working call succeeds on the first
#      attempt, no retry, no extra delay. This is the "don't break 5 of 6
#      shards" requirement — proven by call-count AND bounded wall clock,
#      not just by exit code.
#   2. A HANG IS CUT OFF WELL UNDER THE JOB'S 15-MINUTE TIMEOUT, retried,
#      and can recover. Measured with date +%s, the same way
#      test-gh-merge-pr-with-retry.sh proves its own hang-cutoff cases —
#      "the message says it recovered" is not proof; "it actually finished
#      in bounded time" is.
#   3. A HANG (OR FAILURE) ON EVERY ATTEMPT GIVES UP LOUD AND NAMED, in
#      bounded time, with wording that explicitly distinguishes this
#      script's own `failure` conclusion from the job-timeout `cancelled`
#      conclusion this whole task exists to stop being confused with.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

SCRIPT="$GUARD_DIR/install-playwright-system-deps.sh"
FAKE_PW="$SELF_DIR/lib/fake-playwright-deps.sh"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

run_install() {
  # $1 = FAKE_PW_DEPS_RC_SEQUENCE, $2 = counter file path, remaining =
  # extra env assignments as NAME=value.
  local rc_seq="$1" counter="$2"
  shift 2
  local extra_env=("$@")
  env \
    PLAYWRIGHT_DEPS_CMD="$FAKE_PW" \
    FAKE_PW_DEPS_RC_SEQUENCE="$rc_seq" \
    FAKE_PW_DEPS_CALL_COUNTER="$counter" \
    RETRY_SLEEP_SECONDS="0" \
    ${extra_env[@]+"${extra_env[@]}"} \
    bash "$SCRIPT"
}

# ── GREEN: the normal (healthy-shard) path is untouched ────────────────────
COUNTER1="$WS/counter-clean"
START1=$(date +%s)
assert_green "a working call succeeds on the first attempt, no retry" \
  --contains "OK on attempt 1/3" \
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

# ── GREEN: an ordinary (non-hung) failure on attempt 1 still recovers ──────
COUNTER2="$WS/counter-fail-recovers"
assert_green "an ordinary apt-get error on attempt 1 recovers on attempt 2" \
  --contains "exited 1 — retrying" \
  --contains "OK on attempt 2/3" \
  -- run_install "1:0" "$COUNTER2"

# ── GREEN: THE ACTUAL BACKLOG-122 SHAPE — a hung call is cut off well ──────
# under the job's 15-minute timeout, and the retry recovers. CALL_TIMEOUT
# is 1s but the fake sleeps 3s on the first call only — run_with_timeout
# must kill it before it can answer, and the second (non-hanging) call must
# still succeed.
COUNTER3="$WS/counter-hang-recovers"
START3=$(date +%s)
assert_green "a hung call (THE #560/#558 SHAPE) is killed after CALL_TIMEOUT_SECONDS and retried" \
  --contains "did not respond within 1s" \
  --contains "OK on attempt 2/3" \
  -- run_install "0:0" "$COUNTER3" \
       CALL_TIMEOUT_SECONDS=1 FAKE_PW_DEPS_SLEEP_ON_FIRST_CALL_SECONDS=3
END3=$(date +%s)
DURATION3=$((END3 - START3))
# Generous bound (well under the 15-minute job timeout this replaces, and
# well under this script's own 5-minute production worst case at the
# defaults) — proves "actually finished", not merely "printed the right
# words while still hanging".
if [ "$DURATION3" -le 8 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [green] hang-then-recover finished in %ss — nowhere near the 15-minute job timeout it replaces\n' "$DURATION3"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [green] hang-then-recover took %ss — expected well under 8s\n' "$DURATION3"
fi

# ── RED: a call that hangs on EVERY attempt gives up in bounded time, ──────
# with a message that explicitly names this as `failure`, NOT `cancelled` —
# the exact ambiguity backlog item 122 exists to close.
COUNTER4="$WS/counter-hang-exhausted"
START4=$(date +%s)
assert_red "a call that hangs on EVERY attempt gives up after MAX_ATTEMPTS, distinguishing failure from cancelled" \
  --contains "did not respond within 1s" \
  --contains "HUNG on every one of 2 attempts" \
  --contains "job conclusion=failure" \
  --contains "did NOT reach the job's 15-minute timeout" \
  --contains "NOT the harmless case of a new push preempting" \
  -- run_install "0:0" "$COUNTER4" \
       MAX_ATTEMPTS=2 CALL_TIMEOUT_SECONDS=1 FAKE_PW_DEPS_SLEEP_SECONDS=3
END4=$(date +%s)
DURATION4=$((END4 - START4))
if [ "$DURATION4" -le 6 ]; then
  GUARD_TEST_PASS=$((GUARD_TEST_PASS + 1))
  printf 'PASS  [RED  ] exhausted-hang gave up in %ss — bounded, nowhere near the 15-minute job ceiling\n' "$DURATION4"
else
  GUARD_TEST_FAIL=$((GUARD_TEST_FAIL + 1))
  printf 'FAIL  [RED  ] exhausted-hang took %ss — expected well under 6s (2 attempts x CALL_TIMEOUT_SECONDS=1, RETRY_SLEEP_SECONDS=0)\n' "$DURATION4"
fi

# ── RED: a non-hang failure on every attempt also fails loud and named ─────
COUNTER5="$WS/counter-fail-exhausted"
assert_red "a real apt-get error (not a hang) on every attempt also fails loud, distinctly worded from the hang case" \
  --contains "FAILED on every one of 2 attempts, last exit code 1" \
  --contains "an actual apt-get error, not a hang" \
  --contains "job conclusion=failure" \
  --not-contains "HUNG on every one" \
  -- run_install "1:1" "$COUNTER5" MAX_ATTEMPTS=2

guard_test_summary "test-install-playwright-system-deps.sh"
