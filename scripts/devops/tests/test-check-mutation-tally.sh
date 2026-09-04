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
  --contains "reason=clean" \
  -- node "$GUARD" "$ALL_KILLED"

assert_green "suppressed mutants alone do not make a night red" \
  --contains "result=success" \
  --contains "1 suppressed" \
  --contains "reason=clean" \
  -- node "$GUARD" "$SUPPRESSED"

assert_green "mutants nobody covers are counted but are not, by themselves, red" \
  --contains "result=success" \
  --contains "2 never executed" \
  --contains "reason=clean" \
  -- node "$GUARD" "$ONLY_NOCOV"

assert_red_signal "ONE survivor is enough — this is not a percentage" \
  --contains "result=failure" \
  --contains "1 surviving mutant(s)" \
  --contains "reason=survivors" \
  -- node "$GUARD" "$ONE_SURVIVED"

assert_red_signal "THE CHEAT: every leg green and NOT ONE report produced" \
  --contains "result=failure" \
  --contains "NO report files" \
  --contains "reason=incomplete" \
  --not-contains "result=success" \
  -- node "$GUARD" "$NO_REPORTS"

assert_red_signal "reports exist but cannot be parsed — unverified, not clean" \
  --contains "result=failure" \
  --contains "could not be parsed" \
  --contains "reason=incomplete" \
  -- node "$GUARD" "$UNREADABLE"

assert_red_signal "a failed sweep leg is red even when the reports it did upload are clean" \
  --contains "result=failure" \
  --contains "nothing was verified" \
  --contains "reason=incomplete" \
  -- env SWEEP_RESULT=failure node "$GUARD" "$ALL_KILLED"

assert_green "a cancelled sweep is a no-op, not a finding" \
  --contains "result=cancelled" \
  --contains "reason=cancelled" \
  -- env SWEEP_RESULT=cancelled node "$GUARD" "$ALL_KILLED"

# task-mutation-gate nightly-alert-fidelity, 2026-09-03 — `reason` and
# `missing_packages` exist so post-merge-alert.sh can tell "a leg crashed
# before Stryker ran" apart from "the sweep completed and found survivors"
# without parsing this script's prose `detail` string. The eight cases above
# already prove `reason` tracks `result` correctly; the two below prove
# `missing_packages` — informational only, never changes `result`/`reason`
# (see this script's own comment above `missingPackages`) — names exactly the
# expected package(s) with NO report at all, using the REAL basenames
# writeConfig() in mutation-gate.mjs produces
# (`pkg.name.replace(/[^a-z0-9]+/gi, '-')` + `.report.json`), not the
# `shared.report.json` shorthand `new_reports()` above uses for the
# count-only cases (irrelevant there — walk() matches any `*.report.json`
# regardless of basename; only EXPECTED_REPORTS's exact-basename lookup
# cares).

# $1 = case name, remaining args = exact report basenames to write (each with
# one Killed mutant — the counts do not matter for this pair of assertions,
# only which basenames exist at all).
new_named_reports() {
  local name="$1"
  shift
  local root="$WS/$name/mutation-report-x"
  mkdir -p "$root"
  local basename
  for basename in "$@"; do
    printf '{"schemaVersion":"1.0","files":{"src/thing.ts":{"language":"typescript","source":"","mutants":[{"id":"k%s","mutatorName":"ConditionalExpression","replacement":"true","status":"Killed","location":{"start":{"line":1,"column":1},"end":{"line":1,"column":2}}}]}}}\n' "$RANDOM" >"$root/$basename"
  done
  printf '%s' "$WS/$name"
}

TWO_OF_THREE="$(new_named_reports two-of-three -crm-shared.report.json -crm-api.report.json)"
ALL_THREE="$(new_named_reports all-three -crm-shared.report.json -crm-api.report.json -crm-web.report.json)"

assert_red_signal "missing_packages names the ONE package with no report at all — the web leg died before uploading" \
  --contains "reason=incomplete" \
  --contains "missing_packages=@crm/web" \
  -- env SWEEP_RESULT=failure node "$GUARD" "$TWO_OF_THREE"

assert_green "missing_packages is empty when every expected package reported — no stray '()' in the alert body" \
  --contains "missing_packages=" \
  --not-contains "missing_packages=@" \
  -- node "$GUARD" "$ALL_THREE"

guard_test_summary "test-check-mutation-tally.sh"
