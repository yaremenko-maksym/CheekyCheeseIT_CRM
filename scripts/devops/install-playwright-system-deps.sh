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
# LOCK SIGNATURE, AND WHY "CONTAINS THE PHRASE" WAS NOT ENOUGH (round 2
# review, PR #562 review 4956397222): the first version of this
# classifier asked "does the phrase appear ANYWHERE in the merged
# stdout+stderr", which the reviewer disproved by hand: a fake command
# that prints BOTH apt's real lock wording AND an unrelated, genuine
# `E: Unable to locate package libnonexistent-dep0` in the SAME call
# still classified as "lock" — a real missing dependency would have
# exited the job green with only a ::warning::, exactly the outcome the
# script's own header already called out as forbidden ("never to the
# dependency install itself being broken"). The intent was right; a
# substring search cannot enforce it, because apt legitimately prints a
# transient `W: ... — retrying internally` lock line and THEN a separate,
# unrelated `E: ...` failure in one run, and "contains" cannot tell
# "explains" from "also mentioned".
#
# The fix classifies by apt/dpkg's OWN distinction between the two, not
# by keyword search: apt/dpkg report every DEFINITIVE failure as a line
# starting with `E: ` — that is the tool's own severity marker, not
# vocabulary this script invented (a transient lock wait that is still
# retrying is reported as `W: `, never `E: `; see the real #562
# transcript's two `E: ` lines, both lock-family, and the reviewer's
# counter-example, whose `E: ` line is Unable-to-locate-package, not the
# lock). So: collect every `E: ` line in the merged output.
#   - NO `E: ` line at all → cannot prove the failure was lock-only →
#     "real" (see the WHEN-UNSURE rule below).
#   - EVERY `E: ` line matches the lock family → "lock".
#   - ANY `E: ` line does NOT match the lock family → "real", full stop
#     — one genuine error line outweighs any number of lock mentions
#     elsewhere in the same output, regardless of order (error-first or
#     lock-first — both required by this file's own tests).
#
# WHEN UNSURE, DECIDE TOWARD "real" (requirement, not a preference): the
# two mistakes are not symmetric. Misclassifying a cleared/transient lock
# as "real" costs one extra failed run someone re-triggers. Misclassifying
# a genuine missing dependency as "lock" ships a job that says PASS while
# the E2E gate it exists to protect never actually ran with what it
# needed — silent exactly when the gate matters most. Every branch above
# that cannot prove "lock and only lock" falls to "real".
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
#
# ROUND 3 (2026-11-18) — THE RETRY WAS COLLIDING WITH ITS OWN ORPHAN
# ------------------------------------------------------------------
# Round 2's patient tier assumed the lock belongs to SOMEONE ELSE, so
# waiting and retrying is the answer. On `E2E (webkit-iphone)` the holder
# was this step's OWN first install (gh run 44216565244, job 134507750848;
# red on main and on every code branch in the same hour, which made the
# aggregate required check `E2E Tests` red and blocked every code PR):
#
#   1. webkit's install needs far more packages than chromium's — 36s on a
#      healthy run (44193966361) against chromium's low single digits — and
#      that attempt exceeded the 90s per-attempt budget.
#   2. run_with_timeout kills only its DIRECT child (`pnpm`). The
#      `sudo apt-get` grandchild is root-owned and survives, holding
#      /var/lib/dpkg/lock-frontend (the same pid 4231 for over 4 minutes).
#   3. Every later attempt therefore collided with THIS script's own
#      install, was correctly classified "lock", and both tiers burned out
#      in ~3 minutes racing a holder that could not let go while they raced.
#   4. The step degraded per round 2 and reported `success`. The shard then
#      ran `9 tests` and reported `8 failed`, `1 passed`, every failure on
#      `MiniBrowser: error while loading shared libraries: libwoff2dec.so.1.0.2`.
#
# Three changes, none of them "retry harder":
#   - WAIT FOR THE HOLDER THE REFUSAL NAMES (_wait_for_holder), bounded,
#     instead of starting a competing install. Letting the first install
#     FINISH is what makes the next attempt a fast no-op over
#     already-installed packages. A genuinely foreign holder that outlives
#     the wait still degrades with round 2's warning — contract unchanged.
#   - PRINT A TIMED-OUT ATTEMPT'S CAPTURED OUTPUT (_print_attempt_output),
#     in every position including the last of a tier, which previously
#     printed nothing at all. Without it the log could not say WHERE apt
#     stalled, which is why the slowness itself stayed undiagnosed.
#   - PROBE THE BROWSER BEFORE DEGRADING (_verify_deps_or_fail), opt-in per
#     shard via DEPS_VERIFY_BROWSER, so a leg that genuinely cannot launch
#     fails THIS step by name instead of every test in the shard failing
#     one by one.
#     Asymmetric on purpose: a probe that NAMES a missing shared object
#     fails the step, and so does one that could not run at all (127 — see
#     _verify_deps_or_fail); every other failure is inconclusive.
# A step-wide wall-clock deadline (_remaining_budget) keeps the whole thing
# bounded now that the webkit leg's per-attempt budget is 240s.
#
# WHAT ROUND 3'S OWN REVIEW CHANGED
# ---------------------------------
# The holder wait was written as a property of the SCRIPT, but it is only
# ever useful to a leg whose own install can outlive its per-attempt budget
# and orphan an apt-get. Unscoped, it turned the chromium legs'
# fast-refusal path (two flat pauses, ~75s) into ~420s on jobs whose own
# ceiling is `timeout-minutes: 15` — a cost paid by legs that opted into
# none of this. Three corrections, all about the BOUNDARY of the new
# behaviour rather than the behaviour itself:
#
#   - THE WAIT IS SHARD-SCOPED in ci.yml (HOLDER_WAIT_MAX_SECONDS), the way
#     CALL_TIMEOUT_SECONDS already was, and switching it off restores the
#     flat pause rather than removing the pause altogether
#     (_pause_before_retry, _HOLDER_WAITED). "The wait did not run" and
#     "the wait ran and expired" are different answers and only the first
#     still owes the caller a pause.
#   - THE WAIT RESERVES THE RETRY'S BUDGET (HOLDER_WAIT_RESERVE_SECONDS)
#     and no pause may outlive the deadline (_sleep_bounded). A wait capped
#     at the bare remaining budget could consume all of it, leaving the
#     attempt it exists to enable a 1-2s clamped call (rc 124) — after
#     which a flat 60s pause ran the step past the deadline and the step
#     reported "continuing WITHOUT" on a run whose packages were by then
#     installed.
#   - A PROBE THAT CANNOT RUN FAILS THE STEP (exit 127). It was
#     inconclusive, i.e. the one leg that opts into the check would have
#     proceeded unprotected with nothing in the log saying so.
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

# ── round 3 (2026-11-18) knobs ─────────────────────────────────────────────
# HOLDER_WAIT_MAX_SECONDS    bounded wait for the pid apt/dpkg NAMES as the
#                            lock holder, used INSTEAD of starting a
#                            competing install against it (default: 180).
#                            0 disables the wait (what this script's own
#                            test suite uses for the cases whose fixtures
#                            name a pid they never spawned).
# HOLDER_POLL_INTERVAL_SECONDS  poll granularity of that wait (default: 3).
# HOLDER_WAIT_RESERVE_SECONDS   seconds of the step budget the wait must
#                            NOT consume, so the retry it exists to enable
#                            still has budget when the holder exits late
#                            (default: 60).
# TIMEOUT_TAIL_LINES         how many lines of a timed-out attempt's
#                            captured output to print (default: 40).
# DEPS_VERIFY_BROWSER        when set (e.g. "webkit"), the degrade path
#                            probes that browser's real launch before
#                            letting the test run proceed without deps.
# DEPS_VERIFY_CMD            the probe itself; derived from
#                            DEPS_VERIFY_BROWSER when not set explicitly.
# DEPS_VERIFY_TIMEOUT_SECONDS   cap on that probe (default: 120).
# DEPS_STEP_DEADLINE_SECONDS    the step's OWN wall-clock ceiling
#                            (default: 420) — see _remaining_budget.
HOLDER_WAIT_MAX_SECONDS="${HOLDER_WAIT_MAX_SECONDS:-180}"
HOLDER_POLL_INTERVAL_SECONDS="${HOLDER_POLL_INTERVAL_SECONDS:-3}"
HOLDER_WAIT_RESERVE_SECONDS="${HOLDER_WAIT_RESERVE_SECONDS:-60}"
TIMEOUT_TAIL_LINES="${TIMEOUT_TAIL_LINES:-40}"
DEPS_VERIFY_BROWSER="${DEPS_VERIFY_BROWSER:-}"
DEPS_VERIFY_CMD="${DEPS_VERIFY_CMD:-}"
DEPS_VERIFY_TIMEOUT_SECONDS="${DEPS_VERIFY_TIMEOUT_SECONDS:-120}"
DEPS_STEP_DEADLINE_SECONDS="${DEPS_STEP_DEADLINE_SECONDS:-420}"

# The probe is built here rather than in ci.yml so the workflow only has to
# name a browser: the `-e` argument deliberately contains NO spaces, because
# $DEPS_VERIFY_CMD is word-split on use (same contract as
# $PLAYWRIGHT_DEPS_CMD).
if [ -z "$DEPS_VERIFY_CMD" ] && [ -n "$DEPS_VERIFY_BROWSER" ]; then
  DEPS_VERIFY_CMD="pnpm --filter @crm/e2e exec node -e require('@playwright/test').$DEPS_VERIFY_BROWSER.launch().then(b=>b.close())"
fi

_STEP_STARTED_AT="$(date +%s)"
# The pid apt/dpkg named as holding the lock in the most recent refusal, or
# "" when the last failure named none.
_HOLDER_PID=""
# Did the most recent _wait_for_holder call actually wait? Three outcomes
# have to be told apart, not two: the holder is gone (retry now), the wait
# ran and expired (the budget is already spent), and the wait never ran at
# all (disabled by HOLDER_WAIT_MAX_SECONDS=0, or no budget left). Only the
# third still owes the caller the tier's flat pause — see
# _pause_before_retry.
_HOLDER_WAITED=0

# Best-effort summary write — a summary that cannot be written must never
# be what fails this step. Mirrors mutation-gate.mjs's summary().
_write_summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  { printf '%s\n' "$@"; } >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
}

# $1 = captured output, $2 = exit code. Echoes one of: lock | timeout | real
#
# Classifies by apt/dpkg's OWN `E: ` severity marker for a definitive
# failure, not by a keyword search over the whole blob — see the "LOCK
# SIGNATURE, AND WHY..." header comment above for why a plain substring
# match let a real dependency error hide behind an unrelated lock mention
# in the same output (round-2 review finding, PR #562). Unsure → "real"
# (WHEN-UNSURE rule above): a missing `E: ` line, or any `E: ` line this
# script does not recognize as lock-family, is never classified "lock".
_classify() {
  local out="$1" rc="$2"
  if [ "$rc" -eq 124 ]; then
    echo "timeout"
    return
  fi
  local e_lines non_lock_e_lines
  e_lines="$(printf '%s\n' "$out" | grep -E '^E: ')"
  if [ -z "$e_lines" ]; then
    # No apt/dpkg "E: " line at all — nothing here PROVES lock-only, so
    # this cannot be classified "lock" (WHEN-UNSURE rule).
    echo "real"
    return
  fi
  non_lock_e_lines="$(printf '%s\n' "$e_lines" | grep -Ev 'Could not get lock|Unable to lock directory|dpkg frontend lock')"
  if [ -n "$non_lock_e_lines" ]; then
    # At least one "E: " line names something other than the lock — a
    # real failure, regardless of how many lock mentions (any severity,
    # any position) sit alongside it in the same output.
    echo "real"
  else
    echo "lock"
  fi
}

_fail_real() {
  local rc="$1" out="$2"
  echo "::error::Install Playwright system deps: FAILED, last exit code $rc — an actual apt-get/dependency error, not a lock wait and not a hang. This step FAILED (job conclusion=failure), distinct from conclusion=cancelled (job timeout / preemption by a new push). See backlog item 122 / .claude/tasks/BACKLOG-followups.md. Last output:"
  [ -n "$out" ] && printf '%s\n' "$out"
  exit 1
}

# Seconds left in the step's OWN wall-clock budget.
#
# WHY A DEADLINE EXISTS AT ALL (round 3): raising CALL_TIMEOUT_SECONDS for a
# slow browser leg multiplies by the attempt count — webkit's 240s across
# both tiers' 4 attempts is 16 minutes, past the e2e job's
# `timeout-minutes: 15`. That would resurrect exactly the ambiguous
# `cancelled` conclusion round 1 existed to remove (a job killed by its own
# timeout is indistinguishable from `cancel-in-progress` preemption). The
# deadline, not the per-attempt knobs, is what keeps this step bounded.
_remaining_budget() {
  local now elapsed
  now="$(date +%s)"
  elapsed=$((now - _STEP_STARTED_AT))
  echo $((DEPS_STEP_DEADLINE_SECONDS - elapsed))
}

# Echoes the pid apt/dpkg named as the lock holder in $1, or nothing.
# apt's wording: "It is held by process 4231 (apt-get)".
_lock_holder_pid() {
  printf '%s\n' "$1" | sed -n 's/.*held by process \([0-9][0-9]*\).*/\1/p' | head -1
}

# Bounded wait for pid $1 to exit. 0 = it is gone (retry now makes sense),
# 1 = still alive when the budget ran out.
#
# THE BUG THIS FIXES (gh run 44216565244, job 134507750848, 2026-11-18):
# run_with_timeout kills only its DIRECT child (`pnpm`). The
# `sudo apt-get` grandchild survives as an orphan and keeps
# /var/lib/dpkg/lock-frontend. Every later attempt then collided with this
# step's OWN first install (same pid 4231 for over 4 minutes), was correctly
# classified "lock", exhausted both tiers in ~3 minutes and degraded without
# the deps — after which 8 of the shard's 9 tests died on
# `libwoff2dec.so.1.0.2`. Waiting for the holder lets that first install
# FINISH; the next attempt is then a fast no-op over already-installed
# packages. Starting a competing install never could have worked.
_wait_for_holder() {
  local pid="$1" budget waited=0 rem usable
  _HOLDER_WAITED=0
  [ -n "$pid" ] || return 1
  rem="$(_remaining_budget)"
  # RESERVE (round 3 review, CR-M-1): the wait must leave budget for the
  # attempt it exists to enable. Capped at the bare remaining budget, a
  # holder that exited one second before the deadline left the retry a
  # clamped 1s call (rc 124) and the step reported "continuing WITHOUT"
  # although the holder's own install had just put the packages on disk.
  #
  # The reserve is deliberately NOT one CALL_TIMEOUT_SECONDS: on the webkit
  # leg that is 240s against a tier-boundary remainder of ~162s, which
  # would switch the wait off in exactly the incident this round fixes.
  # What has to fit is a no-op `apt-get install` over already-installed
  # packages, i.e. seconds — the FULL webkit install measured 36s (run
  # 44193966361, job 134446128885).
  usable=$((rem - HOLDER_WAIT_RESERVE_SECONDS))
  budget="$HOLDER_WAIT_MAX_SECONDS"
  [ "$budget" -gt "$usable" ] && budget="$usable"
  [ "$budget" -le 0 ] && return 1
  _HOLDER_WAITED=1

  # `ps -p`, NOT `kill -0`: the holder is `sudo apt-get`, owned by root, and
  # `kill -0` on a root pid from the unprivileged runner user answers EPERM
  # — which is indistinguishable from "the process is gone" and would make
  # this wait return instantly and collide all over again.
  ps -p "$pid" >/dev/null 2>&1 || return 0

  echo "Waiting up to ${budget}s for the apt/dpkg lock holder (pid $pid) to finish — NOT starting a competing install. In the webkit case this round fixes, that holder is this step's own orphaned 'sudo apt-get', left running because a timed-out attempt killed only its parent."
  while [ "$waited" -lt "$budget" ]; do
    sleep "$HOLDER_POLL_INTERVAL_SECONDS"
    waited=$((waited + HOLDER_POLL_INTERVAL_SECONDS))
    if ! ps -p "$pid" >/dev/null 2>&1; then
      echo "Lock holder (pid $pid) exited after ~${waited}s — retrying now."
      return 0
    fi
  done
  echo "Lock holder (pid $pid) is STILL alive after ${budget}s of waiting."
  return 1
}

# Prints a bounded tail of an attempt's captured output.
#
# WHY (round 3, requirement 3): the rc=124 branch printed ONE line and threw
# $LAST_OUT away, so the log of run 44216565244 could not say where apt
# stalled — which is why the cause of the slowness itself stayed unknown.
# The final attempt of a tier printed nothing at all (log lines 3562/3563
# are adjacent: fast attempt 2's output never appeared anywhere).
_print_attempt_output() {
  local label="$1" out="$2"
  if [ -z "$out" ]; then
    echo "  ($label produced no output at all before it was cut off.)"
    return
  fi
  echo "  --- $label: last ${TIMEOUT_TAIL_LINES} lines of its captured output ---"
  printf '%s\n' "$out" | tail -n "$TIMEOUT_TAIL_LINES" | sed 's/^/  | /'
  echo "  --- end of $label output ---"
}

# A flat pause that can never outlive the step's own deadline (round 3
# review, CR-M-1): LOCK_RETRY_SLEEP_SECONDS is 60s and used to be slept
# unconditionally, so a pause entered with 5s of budget left ran the step
# ~55s past the deadline ci.yml's comment says bounds it.
_sleep_bounded() {
  local want="$1" rem
  rem="$(_remaining_budget)"
  [ "$rem" -le 0 ] && return 0
  [ "$want" -gt "$rem" ] && want="$rem"
  [ "$want" -gt 0 ] && sleep "$want"
  return 0
}

# Pause between attempts: wait out a NAMED holder when there is one (never
# racing it), else the tier's flat pause.
_pause_before_retry() {
  local sleep_secs="$1" pid
  if [ -n "$_HOLDER_PID" ]; then
    pid="$_HOLDER_PID"
    _HOLDER_PID=""
    _wait_for_holder "$pid"
    # Only "the wait never ran" still owes the caller a pause. Without this
    # fallback a leg with the wait switched off (HOLDER_WAIT_MAX_SECONDS=0,
    # which is what every non-webkit shard sets) would retry with NO pause
    # at all — a second behaviour change, on legs that opted into none of
    # this (round 3 review, SPEC-H-1).
    [ "$_HOLDER_WAITED" -eq 1 ] && return 0
  fi
  _sleep_bounded "$sleep_secs"
}

# The step summary already carries its ":warning: skipped" heading by the
# time the probe can decide to fail the step — written there on purpose, so
# the record of WHY the install was skipped survives a failing probe. Append
# the verdict so the summary cannot read as a warning for a step whose
# conclusion is `failure` (round 3 review, CR-L-2).
_summary_probe_failed() {
  _write_summary \
    "" \
    "### :x: ...and the browser could not start without them — THIS STEP FAILED" \
    "" \
    "$1" \
    "" \
    "The \`:warning:\` heading above records why the install was skipped. This step's own conclusion is **failure**, not a warning." \
    "" \
    "Probe output:" \
    '```' \
    "$2" \
    '```'
}

# Requirement 4 (round 3): the degrade path must not hand a browser that
# cannot start to the shard's tests.
#
# Round 2 rested the degrade on "the runner image already ships what
# Playwright needs in the overwhelming common case". That holds for
# chromium — which is why 5 of 6 shards clear this step in single digits
# and pass with no install at all — and is FALSE for webkit, whose
# minibrowser-wpe build needs libwoff2dec/libwebpdemux/libenchant and
# friends that ubuntu-24.04 does not carry. On run 44216565244 the step
# reported `success` and the shard's tests then died on
# `browserType.launch` (measured on that job: 8 failed, 1 passed).
#
# ASYMMETRIC ON PURPOSE: it fails only on evidence, never on the absence
# of evidence about the RUNNER. The one exception, added in round 3's
# review, is a probe that could not run at all — a statement about this
# gate's own wiring, not about the runner (see 127 below):
#   - probe exits 0                       -> continue (today's behaviour)
#   - probe names a missing shared object -> FAIL THE STEP, cause named
#   - probe exits 127 (could not run)     -> FAIL THE STEP (see below)
#   - probe fails any other way           -> inconclusive, continue + warn
#
# 127 JOINED THE FAILING SET IN ROUND 3's REVIEW (CR-L-1). It was
# inconclusive, and a probe that never ran is not evidence that the browser
# launches: on the ONE leg that opts in, a tolerated 127 is this gate
# switched off with nothing in the log saying so. It is also the exact
# failure a mistake in the DEPS_VERIFY_CMD derivation produces (the command
# is word-split unquoted), so it reports a defect in the gate itself rather
# than a fact about the runner. It cannot misfire on a healthy runner: the
# step runs inside a job that has already used `pnpm` several times, so
# `pnpm` is on PATH by the time the probe is built.
#
# A timeout (124) and every other non-zero exit stay INCONCLUSIVE on
# purpose. Once the retries have eaten the budget the probe gets only the
# 30s floor below, and on a contended runner a slow-but-working launch
# inside 30s is likelier than a broken one — failing there would be the
# false failure this asymmetry exists to prevent. The tests themselves stay
# the gate in that case, as round 2 argued.
# It also runs ONLY on the degrade path and ONLY when a browser is named
# (DEPS_VERIFY_BROWSER), so a shard that installed its deps successfully,
# and every shard that does not opt in, is untouched by construction.
_verify_deps_or_fail() {
  [ -n "$DEPS_VERIFY_CMD" ] || return 0
  local rem vt vrc vout
  rem="$(_remaining_budget)"
  # The probe is the whole point of this branch — give it a floor even when
  # the retries ate the budget.
  [ "$rem" -lt 30 ] && rem=30
  vt="$DEPS_VERIFY_TIMEOUT_SECONDS"
  [ "$vt" -gt "$rem" ] && vt="$rem"

  echo "The system deps were NOT installed this run — probing whether the browser can actually start before letting the test run proceed (probe timeout ${vt}s): $DEPS_VERIFY_CMD"
  # shellcheck disable=SC2086  # deliberate word-splitting, same contract as PLAYWRIGHT_DEPS_CMD
  run_with_timeout "$vt" $DEPS_VERIFY_CMD
  vrc="$_TIMEOUT_RC"
  vout="$_TIMEOUT_OUT"

  if [ "$vrc" -eq 0 ]; then
    echo "Launch probe OK — the libraries this leg needs are present despite the skipped install, so the warning above stands and the run continues."
    return 0
  fi

  # Two distinct definitive signatures, both verified against
  # playwright-core's own strings and the run-44216565244 log:
  #   - the dynamic loader's own failure, which is what the webkit tests hit
  #     ("error while loading shared libraries: libwoff2dec.so.1.0.2");
  #   - Playwright's OWN pre-flight refusal ("Host system is missing
  #     dependencies to run browsers."), which it raises INSTEAD of
  #     launching. Without this second one the probe would call Playwright's
  #     clearest possible answer "inconclusive" and let the shard proceed to
  #     the exact mass failure this gate exists to prevent.
  if printf '%s\n' "$vout" | grep -qE 'error while loading shared libraries|cannot open shared object file|Host system is missing dependencies'; then
    _summary_probe_failed "The launch probe died on a missing shared library — the browser genuinely cannot start without the deps this step failed to install." "$vout"
    echo "::error::Install Playwright system deps: the system deps were NOT installed this run (apt/dpkg lock) AND the browser cannot start without them — the launch probe died on a missing shared library. This step FAILS with the cause named here, instead of letting every test in the shard die one by one on browserType.launch (gh run 44216565244, job 134507750848: 8 of the shard's 9 tests failed on libwoff2dec.so.1.0.2 while THIS step reported success). Probe exit code $vrc. Probe output:"
    _print_attempt_output "launch probe" "$vout"
    exit 1
  fi

  if [ "$vrc" -eq 127 ]; then
    _summary_probe_failed "The launch probe could not be executed at all (exit 127) — so nothing was verified about the browser, and the only shard that opts into this check would have proceeded unprotected." "$vout"
    echo "::error::Install Playwright system deps: the system deps were NOT installed this run (apt/dpkg lock) AND the launch probe could not be executed at all (exit 127 — command not found). A probe that cannot run is not evidence that the browser launches, and this is the one shard that opted into the check, so the step FAILS instead of continuing unprotected. Check DEPS_VERIFY_CMD / DEPS_VERIFY_BROWSER wiring in .github/workflows/ci.yml. Probe command: $DEPS_VERIFY_CMD. Probe output:"
    _print_attempt_output "launch probe" "$vout"
    exit 1
  fi

  echo "::warning::Install Playwright system deps: the launch probe exited $vrc WITHOUT naming a missing shared library — inconclusive, so it is not treated as evidence the deps are missing and this step does not fail on it. Probe output:"
  _print_attempt_output "launch probe" "$vout"
  return 0
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
  local attempt=1 rem call_timeout label
  while [ "$attempt" -le "$max_attempts" ]; do
    rem="$(_remaining_budget)"
    if [ "$rem" -le 0 ]; then
      echo "$tier_label tier: the step's own ${DEPS_STEP_DEADLINE_SECONDS}s wall-clock budget is spent — stopping after $((attempt - 1)) attempt(s) here rather than running into the job's 15-minute timeout (whose conclusion would be an ambiguous 'cancelled')."
      return
    fi
    # Never let one attempt outlive the step's remaining budget.
    call_timeout="$CALL_TIMEOUT_SECONDS"
    [ "$call_timeout" -gt "$rem" ] && call_timeout="$rem"
    label="$tier_label attempt $attempt/$max_attempts"

    # shellcheck disable=SC2086  # deliberate word-splitting: PLAYWRIGHT_DEPS_CMD is a space-separated command line, not a single path
    run_with_timeout "$call_timeout" $PLAYWRIGHT_DEPS_CMD
    LAST_OUT="$_TIMEOUT_OUT"
    LAST_RC="$_TIMEOUT_RC"

    if [ "$LAST_RC" -eq 0 ]; then
      printf '%s\n' "$LAST_OUT"
      echo "Install Playwright system deps: OK ($tier_label attempt $attempt/$max_attempts)."
      exit 0
    fi

    LAST_CLASS="$(_classify "$LAST_OUT" "$LAST_RC")"
    if [ "$LAST_CLASS" = "lock" ]; then
      _HOLDER_PID="$(_lock_holder_pid "$LAST_OUT")"
    fi

    if [ "$attempt" -lt "$max_attempts" ]; then
      if [ "$LAST_RC" -eq 124 ]; then
        echo "$label: '$PLAYWRIGHT_DEPS_CMD' did not respond within ${call_timeout}s — retrying."
        _print_attempt_output "$label" "$LAST_OUT"
      elif [ "$LAST_CLASS" = "lock" ]; then
        echo "$label: apt/dpkg lock held by another process — retrying once it clears:"
        printf '%s\n' "$LAST_OUT"
      else
        echo "$label: '$PLAYWRIGHT_DEPS_CMD' exited $LAST_RC — retrying in ${sleep_secs}s:"
        [ -n "$LAST_OUT" ] && printf '%s\n' "$LAST_OUT"
      fi
      _pause_before_retry "$sleep_secs"
    else
      # The LAST attempt of a tier used to print nothing whatsoever — the
      # reason run 44216565244's log never showed fast attempt 2's output.
      if [ "$LAST_RC" -eq 124 ]; then
        echo "$label: '$PLAYWRIGHT_DEPS_CMD' did not respond within ${call_timeout}s (last attempt of this tier)."
        _print_attempt_output "$label" "$LAST_OUT"
      elif [ "$LAST_CLASS" = "lock" ]; then
        # Must keep the classification's own vocabulary here: reporting a
        # lock refusal as a bare "exited 1" in the last position is how the
        # tier boundary hid WHY it was switching tiers at all.
        echo "$label: apt/dpkg lock held by another process (last attempt of this tier):"
        printf '%s\n' "$LAST_OUT"
      else
        echo "$label: '$PLAYWRIGHT_DEPS_CMD' exited $LAST_RC (last attempt of this tier):"
        [ -n "$LAST_OUT" ] && printf '%s\n' "$LAST_OUT"
      fi
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

# The holder the fast tier's last refusal NAMED is, in the webkit case
# round 3 fixes, this step's own orphaned apt-get. Wait for it here too:
# without this, the patient tier's first attempt collides with it
# immediately, which is precisely what burned both tiers in ~3 minutes on
# run 44216565244.
if [ -n "$_HOLDER_PID" ]; then
  _wait_for_holder "$_HOLDER_PID"
  _HOLDER_PID=""
fi

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

# Deliberately AFTER the warning and the step summary: if the probe decides
# this shard genuinely cannot run, the run still carries the full record of
# why the install was skipped.
_verify_deps_or_fail

exit 0
