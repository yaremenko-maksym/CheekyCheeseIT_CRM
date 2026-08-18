#!/usr/bin/env bash
# install-playwright-system-deps.sh — bounded retry wrapper around
# `playwright install-deps chromium` for the E2E CI job's cached-browser
# leg (backlog item 122, .claude/tasks/BACKLOG-followups.md, 2026-08-18).
#
# WHY THIS EXISTS
# ----------------
# The "Install Playwright system deps (cached run)" step in
# .github/workflows/ci.yml had NO cap of its own — the JOB's
# `timeout-minutes: 15` was the only thing that could ever stop it. That
# step hung indefinitely three times overnight (gh run 32084626391 on PR
# #560, its rerun, and PR #558 an hour earlier): 3 of 6 shards sat idle for
# ~14 minutes until the job timeout finally killed them, while the healthy
# shards in the SAME run finished in 3.5–6 minutes end to end — this was
# never a slow command, it was a STUCK one, and the E2E tests never even
# started (`Run E2E tests (shard ...)` showed `skipped`).
#
# `playwright install-deps` shells out to `sudo apt-get update && sudo
# apt-get install ...` — a network call to the Ubuntu apt mirrors, with no
# timeout of its own. That network call is the part with no cap; nothing
# about the package list itself is slow.
#
# WHY THE STEP STAYS (not removed) — decided by fact, not by the "(cached
# run)" label: GitHub's own hosted `ubuntu-latest` image already ships
# Google Chrome, Chromium, Microsoft Edge and Firefox pre-installed (see
# actions/runner-images' per-image "Pre-installed Browsers and Related
# Packages" doc) — apt pulling in THOSE packages already satisfies almost
# every shared library Playwright's own Chromium build needs to run
# headless, which is WHY 5 of 6 shards clear this step in low
# single-digit seconds today: apt has little or nothing left to install,
# not because the step does nothing. What is unbounded is `apt-get update`
# reaching the mirror to FIND OUT there is nothing to do — an occasional
# slow/unresponsive mirror hangs exactly that call.
#
# Playwright has no supported way to check "are deps already satisfied"
# without actually invoking apt: `install-deps --dry-run` only prints the
# apt command it WOULD run, it does not inspect host state
# (github.com/microsoft/playwright/issues/10232), and a real "is everything
# already installed" check is a still-open upstream feature request
# (github.com/microsoft/playwright/issues/40512). Skipping the step
# outright on a guess would trade today's rare multi-minute hang for a
# silent, occasional "chromium can't find libatk-bridge2.0-0" failure the
# moment GitHub ships a leaner runner image that does not pre-install a
# browser — and that failure would surface as an inexplicable E2E crash,
# not a named cause. Bounding the call is the fix that keeps the safety net
# and removes the unbounded wait; skipping it is not something we can
# currently justify by fact.
#
# SAME SHAPE AS THIS REPO'S OTHER CI-HANG FIXES — not a third invented
# method: check-pnpm-audit.mjs's `runRealAudit()` already retries a
# network call with no cap of its own (registry blip vs. real findings,
# same "give the transient case a bounded number of tries, then fail
# loud and named" shape), and this script sources the exact
# `run_with_timeout` helper gh-merge-pr-with-retry.sh already uses for a
# hung `gh pr merge` call — one canonical per-attempt-timeout
# implementation, not a second hand-rolled copy (see that lib's own header
# for why that matters).
#
# WHY THE FINAL FAILURE MESSAGE MATTERS AS MUCH AS THE TIMEOUT ITSELF: a
# job killed by ITS OWN `timeout-minutes: 15` gets GitHub conclusion
# `cancelled` — the EXACT SAME conclusion a run gets when a new push
# preempts it under this workflow's `concurrency: cancel-in-progress: true`
# (routine, no action needed). The `e2e_summary` aggregate step just prints
# `needs.e2e.result` verbatim, so both cases looked identical:
# `E2E_RESULT: cancelled`. This script's own retry budget (below) is far
# smaller than the job's 15-minute ceiling, so a real hang now ends with
# THIS step running to completion and exiting 1 — an ordinary `failure`
# conclusion, distinguishable from `cancelled` — and its own `::error::`
# names the actual cause instead of leaving the job timeout to erase it.
#
# Env (all optional; defaults are the production values):
#   PLAYWRIGHT_DEPS_CMD    the command to run, space-separated (default:
#                          "pnpm --filter @crm/e2e exec playwright
#                          install-deps chromium") — same convention as
#                          check-pnpm-audit.mjs's PNPM_AUDIT_CMD.
#                          Overridable ONLY so this script's own test can
#                          point it at a fake, deterministic, offline
#                          command instead of a real apt call.
#   MAX_ATTEMPTS           total attempts including the first (default: 3)
#   CALL_TIMEOUT_SECONDS   cap on a SINGLE attempt (default: 90) — 5 of 6
#                          shards finish the real command in low
#                          single-digit seconds today; 90s is generous
#                          headroom for a genuinely slow-but-working apt
#                          run without coming anywhere near the 15-minute
#                          job ceiling.
#   RETRY_SLEEP_SECONDS    pause between retryable attempts (default: 15)
#
# Worst-case total wall clock: MAX_ATTEMPTS × CALL_TIMEOUT_SECONDS +
# (MAX_ATTEMPTS-1) × RETRY_SLEEP_SECONDS = 3×90 + 2×15 = 300s = 5 minutes —
# a fixed, small ceiling, a world away from the 15-minute job timeout this
# replaces as the effective bound on this one step, and far short of the
# job's OTHER steps' remaining budget.
#
# Tests: scripts/devops/tests/test-install-playwright-system-deps.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/run-with-timeout.sh
. "$SCRIPT_DIR/lib/run-with-timeout.sh"

PLAYWRIGHT_DEPS_CMD="${PLAYWRIGHT_DEPS_CMD:-pnpm --filter @crm/e2e exec playwright install-deps chromium}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
CALL_TIMEOUT_SECONDS="${CALL_TIMEOUT_SECONDS:-90}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-15}"

attempt=1
last_out=""
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  # shellcheck disable=SC2086  # deliberate word-splitting: PLAYWRIGHT_DEPS_CMD is a space-separated command line, not a single path
  run_with_timeout "$CALL_TIMEOUT_SECONDS" $PLAYWRIGHT_DEPS_CMD
  last_out="$_TIMEOUT_OUT"
  rc="$_TIMEOUT_RC"

  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$last_out"
    echo "Install Playwright system deps: OK on attempt $attempt/$MAX_ATTEMPTS."
    exit 0
  fi

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    if [ "$rc" -eq 124 ]; then
      echo "Attempt $attempt/$MAX_ATTEMPTS: '$PLAYWRIGHT_DEPS_CMD' did not respond within ${CALL_TIMEOUT_SECONDS}s (hung — apt-get/network stall) — retrying in ${RETRY_SLEEP_SECONDS}s."
    else
      echo "Attempt $attempt/$MAX_ATTEMPTS: '$PLAYWRIGHT_DEPS_CMD' exited $rc — retrying in ${RETRY_SLEEP_SECONDS}s:"
      [ -n "$last_out" ] && printf '%s\n' "$last_out"
    fi
    sleep "$RETRY_SLEEP_SECONDS"
    attempt=$((attempt + 1))
    continue
  fi

  if [ "$rc" -eq 124 ]; then
    echo "::error::Install Playwright system deps: HUNG on every one of $MAX_ATTEMPTS attempts (each capped at ${CALL_TIMEOUT_SECONDS}s) — apt-get/network stall, not a code regression. This step FAILED (job conclusion=failure); it did NOT reach the job's 15-minute timeout, so this is NOT the harmless case of a new push preempting a still-running check (that ends in conclusion=cancelled). See backlog item 122 / .claude/tasks/BACKLOG-followups.md."
  else
    echo "::error::Install Playwright system deps: FAILED on every one of $MAX_ATTEMPTS attempts, last exit code $rc — an actual apt-get error, not a hang. This step FAILED (job conclusion=failure), distinct from conclusion=cancelled (job timeout / preemption by a new push). See backlog item 122 / .claude/tasks/BACKLOG-followups.md. Last output:"
    [ -n "$last_out" ] && printf '%s\n' "$last_out"
  fi
  exit 1
done
