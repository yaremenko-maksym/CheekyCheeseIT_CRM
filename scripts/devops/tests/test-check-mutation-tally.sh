#!/usr/bin/env bash
# test-check-mutation-tally.sh — proves scripts/devops/check-mutation-tally.mjs
# reports `result=failure` for every way a night can be unverified
# (task-mutation-gate, 2026-08-11).
#
# Like check-backup-freshness.sh, this guard's failure signal is a STDOUT
# CONTRACT rather than an exit code — the nightly workflow needs the verdict AND
# the human detail as step outputs — so its negative cases use
# `assert_red_signal` (exit 0, but `result=failure` in the output).
#
# The two cases that carry the weight are `no-reports` and `unreadable`: all
# sweep legs green and nothing measured, and reports that exist but cannot be
# parsed. Both are "we do not know", and the whole point of the task this belongs
# to is that "we do not know" must never be rendered as "it is fine". A tally
# that answered `success` there would be a check that cannot fail sitting on top
# of the machinery built to find checks that cannot fail.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/check-mutation-tally.mjs"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# $1 = case name, $2 = mutant status list (space separated). Writes one
# StrykerJS-shaped report and echoes the directory to tally.
new_reports() {
  local name="$1"
  shift
  local root="$WS/$name/mutation-report-shared"
  mkdir -p "$root"
  {
    printf '{"schemaVersion":"1.0","files":{"src/thing.ts":{"language":"typescript","source":"","mutants":['
    local first=1 status
    for status in "$@"; do
      [ "$first" = "1" ] || printf ','
      first=0
      printf '{"id":"%s","mutatorName":"ConditionalExpression","replacement":"true","status":"%s","location":{"start":{"line":1,"column":1},"end":{"line":1,"column":2}}}' "$status$RANDOM" "$status"
    done
    printf ']}}}\n'
  } >"$root/shared.report.json"
  printf '%s' "$WS/$name"
}

ALL_KILLED="$(new_reports all-killed Killed Killed Timeout)"
ONE_SURVIVED="$(new_reports one-survived Killed Survived Killed)"
ONLY_NOCOV="$(new_reports only-nocov Killed NoCoverage NoCoverage)"
SUPPRESSED="$(new_reports suppressed Killed Ignored)"

NO_REPORTS="$WS/no-reports"
mkdir -p "$NO_REPORTS/mutation-report-shared"

UNREADABLE="$WS/unreadable/mutation-report-shared"
mkdir -p "$UNREADABLE"
printf '{"files":{"src/thing.ts":{"mutants":[{"status":"Kil' >"$UNREADABLE/shared.report.json"

echo "== test-check-mutation-tally.sh =="
echo

assert_green "everything killed → success, and the detail says so" \
  --contains "result=success" \
  --contains "no surviving mutants" \
  -- node "$GUARD" "$ALL_KILLED"

assert_green "suppressed mutants alone do not make a night red" \
  --contains "result=success" \
  --contains "1 suppressed" \
  -- node "$GUARD" "$SUPPRESSED"

assert_green "mutants nobody covers are counted but are not, by themselves, red" \
  --contains "result=success" \
  --contains "2 never executed" \
  -- node "$GUARD" "$ONLY_NOCOV"

assert_red_signal "ONE survivor is enough — this is not a percentage" \
  --contains "result=failure" \
  --contains "1 surviving mutant(s)" \
  -- node "$GUARD" "$ONE_SURVIVED"

assert_red_signal "THE CHEAT: every leg green and NOT ONE report produced" \
  --contains "result=failure" \
  --contains "NO report files" \
  --not-contains "result=success" \
  -- node "$GUARD" "$NO_REPORTS"

assert_red_signal "reports exist but cannot be parsed — unverified, not clean" \
  --contains "result=failure" \
  --contains "could not be parsed" \
  -- node "$GUARD" "$UNREADABLE"

assert_red_signal "a failed sweep leg is red even when the reports it did upload are clean" \
  --contains "result=failure" \
  --contains "nothing was verified" \
  -- env SWEEP_RESULT=failure node "$GUARD" "$ALL_KILLED"

assert_green "a cancelled sweep is a no-op, not a finding" \
  --contains "result=cancelled" \
  -- env SWEEP_RESULT=cancelled node "$GUARD" "$ALL_KILLED"

guard_test_summary "test-check-mutation-tally.sh"
