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
# STATUS[:mutator[:line[:reason]]] — defaults keep the common cases terse.
write_report() {
  local report_path="$1"
  shift
  mkdir -p "$(dirname "$report_path")"
  {
    printf '{"schemaVersion":"1.0","files":{"src/thing.ts":{"language":"typescript","source":"","mutants":['
    local first=1 spec status mutator line reason id
    for spec in "$@"; do
      IFS=':' read -r status mutator line reason <<<"$spec"
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
write_report "$R4" \
  "Survived:StringLiteral:3" \
  "NoCoverage:ConditionalExpression:8" \
  "NoCoverage:ConditionalExpression:9"

assert_green "readReport: 1 survivor, 2 uncovered — counted and kept in separate arrays (AC3)" \
  -- node --input-type=module -e "
import { readReport } from '$GUARD'
const parsed = readReport('$R4', { dir: 'pkg' })
process.exit(parsed.survivors.length === 1 && parsed.uncovered.length === 2 ? 0 : 1)
"

guard_test_summary "test-mutation-gate-reporting.sh"
