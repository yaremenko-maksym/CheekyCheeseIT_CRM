#!/usr/bin/env bash
# test-mutation-gate-reporting.sh — proves the reporting layer of
# scripts/devops/mutation-gate.mjs actually distinguishes what
# task-mutation-gate-mechanical (AC2/AC3) requires it to distinguish, executed
# against fabricated Stryker-shaped reports rather than read by eye.
#
# Same discipline as test-check-mutation-tally.sh next to this file: a real
# mutation run is minutes, not milliseconds, so this exercises the REPORT-
# PROCESSING functions (readReport / groupSuppressions /
# splitUncoveredByIntegrationHint), which mutation-gate.mjs exports for exactly
# this purpose, against JSON shaped the way Stryker's own jsonReporter writes it.
#
# AC2 — a suppression directive silencing MORE mutants than the one line looked
# at (line x mutator, not "the mutant the author had in mind") must show its
# actual COUNT, not the word "эквивалентный". groupSuppressions() is what turns
# Stryker's flat mutant list back into that count; case 2 below is the exact
# shape of #531 (one directive silenced 8, only 2 were intended).
#
# AC3 — NoCoverage in a file also referenced by a *.integration.spec.ts must be
# told apart from a NoCoverage with no such hint, WITHOUT a human re-deriving it
# (PR #564 spent a full turn doing exactly that by hand). Cases below prove the
# split both against this repo's OWN integration specs (contact.controller.ts,
# imported by apps/api/src/contact/contact.integration.spec.ts) and against a
# throwaway fixture root, to prove the mechanism does not hardcode assumptions
# about this one repo's files (harness.sh's own discipline: exercise real code
# against a FAKE root, never mutate the repo being verified).
#
# Every case here is expressed as "the node snippet exits 0 when the assertion
# holds" and checked with assert_green — these are unit checks on pure helper
# functions, not a guard's own accept/reject contract, so assert_red (which
# means "the thing under test SHOULD refuse") does not apply; it is reserved for
# test-pre-bash-mutation-gate.sh next to this file, which does test a real
# accept/reject decision (the hook's BLOCK/SKIP/PASS verdict).
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/mutation-gate.mjs"

WS="$(guard_test_workspace)"
trap 'rm -rf "$WS"' EXIT

# ── fixture report writer ────────────────────────────────────────────────────
# $1 = report path. Remaining args describe mutants as
# STATUS[:mutator[:line[:reason[:testsCompleted]]]] — defaults keep the common
# cases terse. `testsCompleted` mirrors the field Stryker itself writes for
# every Survived mutant (mutation-test-report-helper.js: `testsCompleted:
# result.nrOfTests`) — omit it to fabricate the exact "tool ran zero tests"
# shape (case5 below), set it >0 for a genuine survivor (case4/case6).
write_report() {
  local report_path="$1"
  shift
  mkdir -p "$(dirname "$report_path")"
  {
    printf '{"schemaVersion":"1.0","files":{"src/thing.ts":{"language":"typescript","source":"","mutants":['
    local first=1 spec status mutator line reason testsCompleted id
    for spec in "$@"; do
      IFS=':' read -r status mutator line reason testsCompleted <<<"$spec"
      mutator="${mutator:-ArrowFunction}"
      line="${line:-1}"
      id="${status}${RANDOM}"
      [ "$first" = "1" ] || printf ','
      first=0
      printf '{"id":"%s","mutatorName":"%s","replacement":"true","status":"%s","location":{"start":{"line":%s,"column":1},"end":{"line":%s,"column":2}}' \
        "$id" "$mutator" "$status" "$line" "$line"
      if [ -n "${reason:-}" ]; then
        printf ',"statusReason":"%s"' "$reason"
      fi
      if [ -n "${testsCompleted:-}" ]; then
        printf ',"testsCompleted":%s' "$testsCompleted"
      fi
      printf '}'
    done
    printf ']}}}\n'
  } >"$report_path"
}

echo "== test-mutation-gate-reporting.sh =="
echo

# ── AC2: groupSuppressions() counts per (file:line, mutator) ────────────────

R1="$WS/case1.report.json"
write_report "$R1" "Ignored:ArrowFunction:10:the render is identical for null and undefined"

assert_green "one suppression, one mutant -> groupSuppressions reports count 1" \
  --contains '"count":1' \
  -- node --input-type=module -e "
import { readReport, groupSuppressions } from '$GUARD'
const parsed = readReport('$R1', { dir: 'pkg' })
const groups = groupSuppressions(parsed.suppressed)
console.log(JSON.stringify(groups))
process.exit(groups.length === 1 && groups[0].count === 1 ? 0 : 1)
"

R2="$WS/case2.report.json"
# The #531 shape: one line x mutator directive, EIGHT mutants generated under
# it — this is what "printed a number, not a word" exists to catch.
write_report "$R2" \
  "Ignored:ArrowFunction:42:documented equivalent mutant" \
  "Ignored:ArrowFunction:42:documented equivalent mutant" \
  "Ignored:ArrowFunction:42:documented equivalent mutant" \
  "Ignored:ArrowFunction:42:documented equivalent mutant" \
  "Ignored:ArrowFunction:42:documented equivalent mutant" \
  "Ignored:ArrowFunction:42:documented equivalent mutant" \
  "Ignored:ArrowFunction:42:documented equivalent mutant" \
  "Ignored:ArrowFunction:42:documented equivalent mutant"

assert_green "one directive silencing EIGHT mutants -> groupSuppressions reports 8, not 1" \
  --contains '"count":8' \
  -- node --input-type=module -e "
import { readReport, groupSuppressions } from '$GUARD'
const parsed = readReport('$R2', { dir: 'pkg' })
const groups = groupSuppressions(parsed.suppressed)
console.log(JSON.stringify(groups))
process.exit(groups.length === 1 && groups[0].count === 8 ? 0 : 1)
"

R3="$WS/case3.report.json"
# Two DIFFERENT directives (different lines) must stay two separate groups,
# not collapse into one count — groupSuppressions keys on (where, mutator).
write_report "$R3" \
  "Ignored:ArrowFunction:5:reason one" \
  "Ignored:ConditionalExpression:9:reason two"

assert_green "two distinct directives stay two groups of 1, never merged into one count" \
  --contains 'GROUPS=2' \
  -- node --input-type=module -e "
import { readReport, groupSuppressions } from '$GUARD'
const parsed = readReport('$R3', { dir: 'pkg' })
const groups = groupSuppressions(parsed.suppressed)
console.log('GROUPS=' + groups.length)
process.exit(groups.length === 2 && groups.every((g) => g.count === 1) ? 0 : 1)
"

# ── AC3: splitUncoveredByIntegrationHint() / looksIntegrationOnly() ─────────

assert_green "a real file this repo's integration specs import -> hinted 'likely'" \
  -- node --input-type=module -e "
import { looksIntegrationOnly } from '$GUARD'
process.exit(looksIntegrationOnly('apps/api/src/contact/contact.controller.ts') === true ? 0 : 1)
"

assert_green "an invented filename nothing references -> NOT hinted (a false positive here would defeat the point)" \
  -- node --input-type=module -e "
import { looksIntegrationOnly } from '$GUARD'
process.exit(looksIntegrationOnly('apps/api/src/definitely-nonexistent-xyz123/whatever-random-thing.ts') === false ? 0 : 1)
"

assert_green "stoplisted generic name ('index.ts') never hints, even where it would textually match" \
  -- node --input-type=module -e "
import { looksIntegrationOnly } from '$GUARD'
process.exit(looksIntegrationOnly('apps/api/src/contact/index.ts') === false ? 0 : 1)
"

# Fixture-root case: the heuristic against a THROWAWAY repo, not this one —
# proves the mechanism generalises rather than hardcoding this repo's files.
FIXTURE="$WS/fixture-root"
mkdir -p "$FIXTURE/src"
(
  cd "$FIXTURE" || exit 1
  git init -q
  printf "import { widgetThing } from '../src/widget-thing'\n" >widget-thing.integration.spec.ts
  git add -A
)

assert_green "fixture root: basename referenced in a fixture integration spec -> hinted" \
  -- node --input-type=module -e "
import { looksIntegrationOnly } from '$GUARD'
process.exit(looksIntegrationOnly('src/widget-thing.ts', '$FIXTURE') === true ? 0 : 1)
"

assert_green "fixture root: a name absent from the fixture corpus -> not hinted" \
  -- node --input-type=module -e "
import { looksIntegrationOnly } from '$GUARD'
process.exit(looksIntegrationOnly('src/some-totally-different-thing.ts', '$FIXTURE') === false ? 0 : 1)
"

assert_green "NoCoverage split: hinted file -> likely bucket, unhinted file -> real bucket" \
  --contains 'LIKELY=1 REAL=1' \
  -- node --input-type=module -e "
import { splitUncoveredByIntegrationHint } from '$GUARD'
const uncovered = [
  { where: 'apps/api/src/contact/contact.controller.ts:7', mutator: 'ConditionalExpression' },
  { where: 'apps/api/src/zzz-definitely-unreferenced-anywhere/zzz-nomatch-xyz123.ts:19', mutator: 'ConditionalExpression' },
]
const { likely, real } = splitUncoveredByIntegrationHint(uncovered)
console.log('LIKELY=' + likely.length + ' REAL=' + real.length)
process.exit(likely.length === 1 && real.length === 1 ? 0 : 1)
"

# ── Survived and NoCoverage are read into separate arrays, never conflated ──

R4="$WS/case4.report.json"
# testsCompleted:4 makes this a GENUINE survivor (tests ran, none failed) —
# see case5/case6 below for the zero-tests shape this used to be
# indistinguishable from before the reclassification existed.
write_report "$R4" \
  "Survived:StringLiteral:3::4" \
  "NoCoverage:ConditionalExpression:8" \
  "NoCoverage:ConditionalExpression:9"

assert_green "readReport: 1 survivor, 2 uncovered — counted and kept in separate arrays (AC3)" \
  -- node --input-type=module -e "
import { readReport } from '$GUARD'
const parsed = readReport('$R4', { dir: 'pkg' })
process.exit(parsed.survivors.length === 1 && parsed.uncovered.length === 2 ? 0 : 1)
"

# ── tool failure vs a surviving mutant (owner decision, 2026-08-25) ─────────
#
# Reproduced live on this repo before this fix existed: a @crm/web diff
# generated 33 Survived mutants, Stryker's clear-text reporter printed "Ran
# 0.00 tests per mutant on average", and the gate blocked a PR on code no
# test had actually touched. See mutation-gate-runbook.md "Tool failure vs a
# surviving mutant" for the full reproduction; these cases pin the
# reporting-layer contract that fixes it, per-mutant.

R5="$WS/case5.report.json"
# Status Survived, testsCompleted OMITTED entirely — the exact shape
# @stryker-mutator/api's toMutantRunResult() writes when a mutant run
# completes having executed zero tests (nrOfTests defaults to 0, and Stryker
# calls that "no failure" i.e. Survived regardless of how many tests ran).
write_report "$R5" "Survived:ConditionalExpression:10"

assert_green "readReport: a Survived mutant with NO testsCompleted field is a TOOL FAILURE, not a survivor" \
  -- node --input-type=module -e "
import { readReport } from '$GUARD'
const parsed = readReport('$R5', { dir: 'pkg' })
process.exit(
  parsed.survivors.length === 0 &&
  parsed.toolFailures.length === 1 &&
  parsed.counts.Survived === 0 &&
  parsed.counts.ToolFailure === 1
    ? 0 : 1,
)
"

R5B="$WS/case5b.report.json"
# Same shape, testsCompleted EXPLICITLY 0 rather than omitted — the field is
# optional in the schema, but readReport() must treat 'absent' and '0' the
# same way (both mean "coalesces to zero" via \`?? 0\`), not just the one the
# fixture writer happens to emit by default.
write_report "$R5B" "Survived:ConditionalExpression:10::0"

assert_green "readReport: testsCompleted:0 (explicit) is ALSO a tool failure, same as omitted" \
  -- node --input-type=module -e "
import { readReport } from '$GUARD'
const parsed = readReport('$R5B', { dir: 'pkg' })
process.exit(parsed.survivors.length === 0 && parsed.toolFailures.length === 1 ? 0 : 1)
"

R6="$WS/case6.report.json"
# The mixed case is the one that matters most: ONE real survivor (tests ran,
# missed it) alongside ONE tool failure (zero tests ran), same report, same
# mutator even — proving the split is per-mutant, not per-file or per-run.
# A batch/heuristic reclassification would get this case wrong in one
# direction or the other; a per-mutant one is the only shape that can put
# exactly one mutant in each bucket here.
write_report "$R6" \
  "Survived:EqualityOperator:20::7" \
  "Survived:EqualityOperator:25"

assert_green "readReport: mixed report — real survivor blocks, tool failure does not, never conflated" \
  --contains 'SURV=1 TOOL=1' \
  -- node --input-type=module -e "
import { readReport } from '$GUARD'
const parsed = readReport('$R6', { dir: 'pkg' })
console.log('SURV=' + parsed.survivors.length + ' TOOL=' + parsed.toolFailures.length)
process.exit(
  parsed.survivors.length === 1 &&
  parsed.toolFailures.length === 1 &&
  parsed.survivors[0].where.endsWith(':20') &&
  parsed.toolFailures[0].where.endsWith(':25')
    ? 0 : 1,
)
"

guard_test_summary "test-mutation-gate-reporting.sh"
