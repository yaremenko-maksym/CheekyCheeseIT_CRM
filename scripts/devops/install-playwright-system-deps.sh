#!/usr/bin/env bash
# install-playwright-system-deps.sh — bounded retry wrapper around
# `playwright install-deps chromium` for the E2E CI job's cached-browser
# leg (backlog item 122, .claude/tasks/BACKLOG-followups.md, 2026-08-18;
# revised same day once the FIRST fix's own live run exposed the real
# cause).
#
# WHY THIS EXISTS (round 1)
# --------------------------
# The "Install Playwright system deps (cached run)" step in
# .github/workflows/ci.yml had NO cap of its own — the JOB's
# `timeout-minutes: 15` was the only thing that could ever stop it. That
# step hung indefinitely three times overnight (gh run 32084626391 on PR
# #560, its rerun, and PR #558 an hour earlier): 3 of 6 shards sat idle for
# ~14 minutes until the job timeout finally killed them, while the healthy
# shards in the SAME run finished in 3.5–6 minutes end to end. Round 1 gave
# this ONE step its own short per-attempt timeout + bounded retry, so a
# real hang would end in an ordinary, loud, named `failure` instead of an
# ambiguous `cancelled` (job-timeout and `cancel-in-progress` preemption by
# a new push share that same conclusion — see the reasoning kept below).
#
# WHAT ROUND 1'S OWN FIRST LIVE RUN THEN PROVED WRONG
# -----------------------------------------------------
# On PR #562 itself (the round-1 fix's own shakeout run, `E2E (misc)`
# shard), round 1 worked exactly as designed — failed loud in ~2 minutes
# instead of hanging 15 — but the transcript it produced named the real
# cause, and it is NOT a slow/unresponsive apt mirror:
#
#   Attempt 1/3: ... did not respond within 90s (hung) — retrying in 15s.
#   Attempt 2/3: ... exited 1 — retrying in 15s
#   E: Could not get lock /var/lib/apt/lists/lock. It is held by process
#      3760 (apt-get)
#   E: Unable to lock directory /var/lib/apt/lists/
#
# A SEPARATE, un-coordinated `apt-get` — GitHub's own hosted-runner image
# maintenance, not anything this repo's workflow starts — was holding
# /var/lib/apt/lists/lock. Attempt 1's 90s hang was very likely that same
# lock (apt on recent Ubuntu images blocks internally waiting for the lock
# before giving up; nothing about this repo's `apt-get` call is itself
# slow — see the round-1 evidence below that 5 of 6 shards clear this step
# in low single digits every run). Attempt 2 got the explicit refusal once
# our own call stopped silently blocking and started erroring immediately.
# Two retries 15s apart cannot outlast a lock a background process can
# reasonably hold for MINUTES — round 1 correctly named the failure, but
# treated a temporary, someone-else's-fault condition exactly like a
# permanent, our-fault one (same short retry budget, same hard job
# failure). That equivalence is what round 2 below removes.
#
# ROUND 2: TELL THE LOCK APART FROM A REAL DEPENDENCY ERROR
# ------------------------------------------------------------
# Two tiers, not one flat retry loop:
#
#   TIER 1 ("fast tier", FAST_MAX_ATTEMPTS attempts, FAST_RETRY_SLEEP_SECONDS
#   apart) — unchanged in spirit from round 1: catches a quick blip
#   (transient network hiccup, a lock that clears in seconds) without any
#   extra latency on the common case. Applies uniformly regardless of what
#   the failure looks like — this is what keeps a GENUINE, non-lock,
#   transient failure's existing retry-then-recover behavior intact.
#
#   Only entered if tier 1 exhausts: classify the LAST failed attempt —
#     - its output matches the apt/dpkg lock signature (below), OR
#     - it was killed by OUR OWN timeout (rc=124, no output to inspect —
#       the #562 evidence above is exactly this shape, so a bare timeout
#       is treated as "possibly the lock", not dismissed)
#   → TIER 2 ("lock tier", LOCK_MAX_ATTEMPTS attempts,
#   LOCK_RETRY_SLEEP_SECONDS apart — deliberately much longer gaps than
#   tier 1: a maintenance apt-get holding this lock for minutes is not
#   going to release it 15s later, and round 1's own #562 run is direct
#   proof that back-to-back short retries just waste the whole budget
#   restating the same refusal).
#
#   If a REAL failure is classified instead (attempt errors with neither
#   the lock signature nor a timeout — an actual apt/dependency error) →
#   fail loud immediately, tier 2 is never entered. Softening the verdict
#   is deliberately narrow: it only ever applies to "someone else is
#   holding a lock we don't control", never to "the dependency install
#   itself is broken".
#
#   If tier 2 ALSO exhausts and the last failure is STILL lock/timeout
#   classified — the job does NOT fail. GitHub's own hosted `ubuntu-latest`
#   image already ships Chrome/Chromium/Edge/Firefox pre-installed (see
#   actions/runner-images' per-image "Pre-installed Browsers and Related
#   Packages" doc), which already satisfies almost every shared library
#   Playwright's Chromium build needs to run headless — this is WHY 5 of 6
#   shards clear this step in low single-digit seconds today (apt has
#   little or nothing left to install), not because the step does nothing.
#   So an unresolved lock most likely means "nothing new needed anyway".
#   IF it turns out something genuinely was missing, Playwright's own test
#   run fails fast and by name (a `browserType.launch` error naming the
#   missing shared library) — that failure, not this step, stays the real
#   gate. This step instead prints a `::warning::` AND appends a clearly
#   flagged block to `$GITHUB_STEP_SUMMARY` (this run's own log wall is 6
#   shards deep and easy to miss — a hidden warning is just next round's
#   "red that means nothing" turned inside out) and exits 0.
#
# WHY THE STEP STAYS ON THE HEALTHY PATH (not removed) — still true, still
# decided by fact: Playwright has no supported way to check "are deps
# already satisfied" without actually invoking apt. `install-deps
# --dry-run` only prints the apt command it WOULD run, it does not inspect
# host state (github.com/microsoft/playwright/issues/10232), and a real
# "is everything already installed" check is a still-open upstream feature
# request (github.com/microsoft/playwright/issues/40512). That has not
# changed since round 1 — re-confirmed, not re-investigated, for round 2.
#
# LOCK SIGNATURE: apt/dpkg's own wording for "another process holds the
# lock" — "Could not get lock" / "Unable to lock directory" (both lines
# seen verbatim in the #562 transcript above; `dpkg frontend lock` folded
# in too, same family of contention, different lock file).
#
# BUDGET, WORKED OUT SO TESTS STILL HAVE ROOM WITHIN THE JOB'S 15 MINUTES:
#   tier 1 worst case: FAST_MAX_ATTEMPTS×CALL_TIMEOUT_SECONDS +
#     (FAST_MAX_ATTEMPTS-1)×FAST_RETRY_SLEEP_SECONDS = 2×90 + 1×15 = 195s
#   tier 2 worst case: LOCK_MAX_ATTEMPTS×CALL_TIMEOUT_SECONDS +
#     (LOCK_MAX_ATTEMPTS-1)×LOCK_RETRY_SLEEP_SECONDS = 2×90 + 1×60 = 240s
#   combined worst case (the "warn and continue" path): 195+240 = 435s
#   = 7m15s. This is the ONLY path where the extra time matters (a real
#   failure or a quick recovery both end long before this) — it leaves
#   900-435 = 465s = 7m45s of the job's 15-minute ceiling for every other
#   step, comfortably above this same script's own round-1 measurement
#   that a HEALTHY shard runs 3.5–6 minutes end to end (a figure that
#   already includes this step at its normal near-zero cost, so it is the
#   right thing to compare the remaining slack against).
#
# SAME SHAPE AS THIS REPO'S OTHER CI-HANG FIXES — not a third invented
# method: check-pnpm-audit.mjs's `runRealAudit()` already retries a
# network call with no cap of its own, and this script sources the exact
# `run_with_timeout` helper gh-merge-pr-with-retry.sh already uses for a
# hung `gh pr merge` call — one canonical per-attempt-timeout
# implementation, not a second hand-rolled copy. The `$GITHUB_STEP_SUMMARY`
# write mirrors mutation-gate.mjs's `summary()`: best-effort, a summary
# write that itself fails must never be what fails the gate.
#
# WHY THE FAILURE MESSAGE STILL MATTERS AS MUCH AS THE TIMEOUT: a job
# killed by its OWN `timeout-minutes: 15` gets GitHub conclusion
# `cancelled` — the SAME conclusion a run gets when a new push preempts it
# under this workflow's `concurrency: cancel-in-progress: true` (routine,
# no action needed). Both this script's own retry budgets are far smaller
# than the job's 15-minute ceiling, so a REAL (non-lock) failure still ends
# with this step running to completion and exiting 1 — an ordinary
# `failure` conclusion, distinguishable from `cancelled` — with its own
# `::error::` naming the actual cause.
#
# Env (all optional; defaults are the production values):
#   PLAYWRIGHT_DEPS_CMD        the command to run, space-separated
#                              (default: "pnpm --filter @crm/e2e exec
#                              playwright install-deps chromium").
#                              Overridable ONLY so this script's own test
#                              can point it at a fake, deterministic,
#                              offline command instead of a real apt call.
#   CALL_TIMEOUT_SECONDS       cap on a SINGLE attempt, either tier
#                              (default: 90) — 5 of 6 shards finish the
#                              real command in low single-digit seconds
#                              today; 90s is generous headroom for a
#                              genuinely slow-but-working apt run.
#   FAST_MAX_ATTEMPTS          tier-1 total attempts (default: 2)
#   FAST_RETRY_SLEEP_SECONDS   pause between tier-1 attempts (default: 15)
#   LOCK_MAX_ATTEMPTS          tier-2 total attempts, entered only on a
#                              lock/timeout classification (default: 2)
#   LOCK_RETRY_SLEEP_SECONDS   pause between tier-2 attempts (default: 60)
#                              — deliberately much longer than tier 1's;
#                              see "ROUND 2" above for why.
#
# Tests: scripts/devops/tests/test-install-playwright-system-deps.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/run-with-timeout.sh
. "$SCRIPT_DIR/lib/run-with-timeout.sh"

PLAYWRIGHT_DEPS_CMD="${PLAYWRIGHT_DEPS_CMD:-pnpm --filter @crm/e2e exec playwright install-deps chromium}"
CALL_TIMEOUT_SECONDS="${CALL_TIMEOUT_SECONDS:-90}"
FAST_MAX_ATTEMPTS="${FAST_MAX_ATTEMPTS:-2}"
FAST_RETRY_SLEEP_SECONDS="${FAST_RETRY_SLEEP_SECONDS:-15}"
LOCK_MAX_ATTEMPTS="${LOCK_MAX_ATTEMPTS:-2}"
LOCK_RETRY_SLEEP_SECONDS="${LOCK_RETRY_SLEEP_SECONDS:-60}"

# Best-effort summary write — a summary that cannot be written must never
# be what fails this step. Mirrors mutation-gate.mjs's summary().
_write_summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  { printf '%s\n' "$@"; } >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
}

# $1 = captured output, $2 = exit code. Echoes one of: lock | timeout | real
_classify() {
  local out="$1" rc="$2"
  if [ "$rc" -eq 124 ]; then
    echo "timeout"
    return
  fi
  case "$out" in
    *"Could not get lock"* | *"Unable to lock directory"* | *"dpkg frontend lock"*)
      echo "lock"
      ;;
    *)
      echo "real"
      ;;
  esac
}

_fail_real() {
  local rc="$1" out="$2"
  echo "::error::Install Playwright system deps: FAILED, last exit code $rc — an actual apt-get/dependency error, not a lock wait and not a hang. This step FAILED (job conclusion=failure), distinct from conclusion=cancelled (job timeout / preemption by a new push). See backlog item 122 / .claude/tasks/BACKLOG-followups.md. Last output:"
  [ -n "$out" ] && printf '%s\n' "$out"
  exit 1
}

# Runs up to $1 attempts of PLAYWRIGHT_DEPS_CMD, $2 seconds apart, labelling
# log lines with $3 (tier name). Exits 0 immediately on success. On
# exhaustion, sets LAST_RC/LAST_OUT/LAST_CLASS and returns (does not exit) —
# the caller decides what exhaustion means for its own tier.
LAST_RC=0
LAST_OUT=""
LAST_CLASS=""
_run_tier() {
  local max_attempts="$1" sleep_secs="$2" tier_label="$3"
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    # shellcheck disable=SC2086  # deliberate word-splitting: PLAYWRIGHT_DEPS_CMD is a space-separated command line, not a single path
    run_with_timeout "$CALL_TIMEOUT_SECONDS" $PLAYWRIGHT_DEPS_CMD
    LAST_OUT="$_TIMEOUT_OUT"
    LAST_RC="$_TIMEOUT_RC"

    if [ "$LAST_RC" -eq 0 ]; then
      printf '%s\n' "$LAST_OUT"
      echo "Install Playwright system deps: OK ($tier_label attempt $attempt/$max_attempts)."
      exit 0
    fi

    LAST_CLASS="$(_classify "$LAST_OUT" "$LAST_RC")"

    if [ "$attempt" -lt "$max_attempts" ]; then
      if [ "$LAST_RC" -eq 124 ]; then
        echo "$tier_label attempt $attempt/$max_attempts: '$PLAYWRIGHT_DEPS_CMD' did not respond within ${CALL_TIMEOUT_SECONDS}s — retrying in ${sleep_secs}s."
      elif [ "$LAST_CLASS" = "lock" ]; then
        echo "$tier_label attempt $attempt/$max_attempts: apt/dpkg lock held by another process — retrying in ${sleep_secs}s:"
        printf '%s\n' "$LAST_OUT"
      else
        echo "$tier_label attempt $attempt/$max_attempts: '$PLAYWRIGHT_DEPS_CMD' exited $LAST_RC — retrying in ${sleep_secs}s:"
        [ -n "$LAST_OUT" ] && printf '%s\n' "$LAST_OUT"
      fi
      sleep "$sleep_secs"
    fi
    attempt=$((attempt + 1))
  done
}

# Tier 1 — fast, catches quick blips (lock or otherwise) without extra
# latency on the common case. Never returns on success (_run_tier exits 0
# itself); only reaches here once FAST_MAX_ATTEMPTS have all failed.
_run_tier "$FAST_MAX_ATTEMPTS" "$FAST_RETRY_SLEEP_SECONDS" "fast"

if [ "$LAST_CLASS" = "real" ]; then
  # A genuine, non-lock, non-timeout apt/dependency error — this is
  # exactly the case round 2 must NOT soften (see header). Fail loud now;
  # tier 2's longer waits would only delay an outcome retrying cannot fix.
  _fail_real "$LAST_RC" "$LAST_OUT"
fi

echo "Install Playwright system deps: fast tier exhausted with an apt/dpkg lock (or an unexplained timeout that looks like one) still held by another process — switching to longer, more patient retries (backlog item 122 round 2)."

# Tier 2 — patient, entered only for lock/timeout. Never returns on
# success. Only reaches here once LOCK_MAX_ATTEMPTS have all failed too.
_run_tier "$LOCK_MAX_ATTEMPTS" "$LOCK_RETRY_SLEEP_SECONDS" "lock"

if [ "$LAST_CLASS" = "real" ]; then
  # The lock cleared partway through tier 2 and THEN apt hit a genuine
  # dependency error — rare, but this must still fail loud, not be folded
  # into the "warn and continue" branch below (see header, requirement 4).
  _fail_real "$LAST_RC" "$LAST_OUT"
fi

# Still lock-held (or still an unexplained timeout) after BOTH tiers.
# Deliberately NOT a job failure — see header "ROUND 2" for the fact this
# rests on (the runner image already ships the shared libraries Playwright
# needs in the overwhelming common case) and for why the softening stops
# exactly here and nowhere else. The real gate stays the E2E tests
# themselves: if something actually was missing, Playwright's own test run
# fails fast and by name.
WARN_MSG="Install Playwright system deps: apt/dpkg lock still held by another process after $((FAST_MAX_ATTEMPTS + LOCK_MAX_ATTEMPTS)) attempts across both retry tiers — continuing WITHOUT installing system deps this run. This is NOT a job failure: GitHub's ubuntu-latest image already ships the shared libraries Playwright needs in the overwhelming common case (why 5 of 6 shards clear this step in low single digits every run). If a library genuinely is missing, the E2E test run below will fail fast and name it — that failure, not this step, is this run's real gate. See backlog item 122 / .claude/tasks/BACKLOG-followups.md."
echo "::warning::$WARN_MSG"
_write_summary \
  "### :warning: Playwright system deps skipped (apt lock held by another process)" \
  "" \
  "$WARN_MSG" \
  "" \
  "Last attempt output:" \
  '```' \
  "$LAST_OUT" \
  '```'
exit 0
