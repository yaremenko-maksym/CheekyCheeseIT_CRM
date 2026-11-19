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

# ── a zero-test mutant is re-run once, and only a SECOND zero fails the build
# (backlog 465, 2026-11-19) ──────────────────────────────────────────────────
#
# The decision these two cases pin is the whole of backlog 465: the cause of a
# zero-test mutant is a run-order-dependent truncation inside Vitest's
# related-file resolution (derivation in mutation-gate-runbook.md, "the
# mechanism, read out of the installed sources"), so the FIRST sighting is not
# evidence about the code — the reproduced mutant carried `coveredBy: 69` and
# was KILLED by its own isolated re-run, while the repo's history holds 21 of
# them across 6 files, never the same one twice.
# `main()` therefore re-runs each one in isolation and partitions the result
# with `partitionRetriedToolFailures()`; `confirmed` is what sets `exitCode = 1`.
#
# RED-THEN-GREEN, same first-pass input both times — the only difference is
# what the isolated re-run reported:
#   red   — the re-run also executed zero tests → confirmed → build fails
#   green — the re-run executed tests           → resolved  → build does not

assert_green "retry: a mutant the re-run did not verify is confirmed (this is the red — exitCode 1)" \
  --contains 'CONFIRMED=1 RESOLVED=0' \
  -- node --input-type=module -e "
import { partitionRetriedToolFailures } from '$GUARD'
const first = [
  { where: 'pkg/src/a.ts:42', mutator: 'ArrowFunction', replacement: 'undefined',
    rel: 'src/a.ts', line: 42, column: 7, endLine: 42, endColumn: 19 },
]
// The isolated re-run verified nothing at this key: it ran zero tests again.
const { confirmed, resolved } = partitionRetriedToolFailures(first, new Set())
console.log('CONFIRMED=' + confirmed.length + ' RESOLVED=' + resolved.length)
process.exit(confirmed.length === 1 && resolved.length === 0 ? 0 : 1)
"

assert_green "retry: the same mutant, verified by the isolated re-run, is resolved and does NOT fail the build" \
  --contains 'CONFIRMED=0 RESOLVED=1' \
  -- node --input-type=module -e "
import { partitionRetriedToolFailures, mutantKey } from '$GUARD'
const mutant = { where: 'pkg/src/a.ts:42', mutator: 'ArrowFunction', replacement: 'undefined',
  rel: 'src/a.ts', line: 42, column: 7, endLine: 42, endColumn: 19 }
// Same first pass; the re-run ran tests against this exact mutant.
const { confirmed, resolved } = partitionRetriedToolFailures([mutant], new Set([mutantKey(mutant)]))
console.log('CONFIRMED=' + confirmed.length + ' RESOLVED=' + resolved.length)
process.exit(confirmed.length === 0 && resolved.length === 1 ? 0 : 1)
"

# Mutant identity cannot be used for the match: Stryker's ids are per-run, so
# the re-run's ids never equal the first pass's. The key is the mutant's full
# span plus mutator plus replacement, and a DIFFERENT mutator verified on the
# same line must not absolve this one.
assert_green "retry: another mutator verified on the same line does NOT absolve this mutant" \
  --contains 'CONFIRMED=1 RESOLVED=0' \
  -- node --input-type=module -e "
import { partitionRetriedToolFailures } from '$GUARD'
const first = [
  { where: 'pkg/src/a.ts:42', mutator: 'ArrowFunction', replacement: 'undefined',
    rel: 'src/a.ts', line: 42, column: 7, endLine: 42, endColumn: 19 },
]
const verified = new Set(['src/a.ts|42:7-42:19|BooleanLiteral|false'])
const { confirmed, resolved } = partitionRetriedToolFailures(first, verified)
console.log('CONFIRMED=' + confirmed.length + ' RESOLVED=' + resolved.length)
process.exit(confirmed.length === 1 && resolved.length === 0 ? 0 : 1)
"

# CR-H-1 / SR-M-1 (PR #1424), and the reason the key is the full span and not
# `file:line|mutator`: ONE line commonly carries several mutants of the SAME
# mutator (`a && b` → two ConditionalExpressions; a nested object literal → two
# ObjectLiterals). Under the loose key, a sibling the re-run KILLED marked its
# unkilled neighbour `resolved` — the gate went green on a mutant that ran zero
# tests twice, which is the whole defect backlog 465 exists to stop.
assert_green "retry: a killed SIBLING of the same mutator on the same line does not absolve the zero-test mutant" \
  --contains 'CONFIRMED=1 RESOLVED=0' \
  -- node --input-type=module -e "
import { partitionRetriedToolFailures, mutantKey } from '$GUARD'
// Two ConditionalExpression mutants on line 42, told apart only by their span.
const target  = { where: 'pkg/src/a.ts:42', mutator: 'ConditionalExpression', replacement: 'false',
  rel: 'src/a.ts', line: 42, column: 7, endLine: 42, endColumn: 19 }
const sibling = { where: 'pkg/src/a.ts:42', mutator: 'ConditionalExpression', replacement: 'true',
  rel: 'src/a.ts', line: 42, column: 24, endLine: 42, endColumn: 31 }
const { confirmed, resolved } = partitionRetriedToolFailures([target], new Set([mutantKey(sibling)]))
console.log('CONFIRMED=' + confirmed.length + ' RESOLVED=' + resolved.length)
process.exit(confirmed.length === 1 && resolved.length === 0 ? 0 : 1)
"

# The absence that used to read as success: the re-run produced a report, but
# this mutant is not in it at all (its range missed, or it was not generated).
# Absence is never evidence of verification — it stays red.
assert_green "retry: a mutant missing from the retry report entirely stays confirmed" \
  --contains 'CONFIRMED=1 RESOLVED=0' \
  -- node --input-type=module -e "
import { partitionRetriedToolFailures } from '$GUARD'
const first = [
  { where: 'pkg/src/a.ts:42', mutator: 'ObjectLiteral', replacement: '{}',
    rel: 'src/a.ts', line: 42, column: 21, endLine: 46, endColumn: 6 },
]
// The retry report verified a different file's mutants and nothing here.
const verified = new Set(['src/zz.ts|9:1-9:4|ArrowFunction|undefined'])
const { confirmed, resolved } = partitionRetriedToolFailures(first, verified)
console.log('CONFIRMED=' + confirmed.length + ' RESOLVED=' + resolved.length)
process.exit(confirmed.length === 1 && resolved.length === 0 ? 0 : 1)
"

# `verifiedKeys` is extracted by readReport() from a real report shape, so the
# extraction itself is covered rather than assumed: a Killed mutant is in the
# set, and the Survived-with-zero-tests mutant beside it is NOT (it is the one
# the retry has to re-verify).
# A report carrying both shapes: one Killed mutant (verified) and one Survived
# mutant with no tests completed (the zero-test shape the retry exists for).
RTF="$WS/retry-verified.json"
write_report "$RTF" \
  "Survived:ArrowFunction:3" \
  "Killed:BooleanLiteral:7"
assert_green "readReport: verifiedKeys holds the killed mutant's exact key and not the zero-test mutant's" \
  --contains 'KILLED_IN=true ZERO_IN=false' \
  -- node --input-type=module -e "
import { readReport, mutantKey } from '$GUARD'
const parsed = readReport('$RTF', { dir: 'pkg' })
const killed = mutantKey({ rel: 'src/thing.ts', line: 7, column: 1, endLine: 7, endColumn: 2,
  mutator: 'BooleanLiteral', replacement: 'true' })
const zero = mutantKey({ rel: 'src/thing.ts', line: 3, column: 1, endLine: 3, endColumn: 2,
  mutator: 'ArrowFunction', replacement: 'true' })
const killedIn = parsed.verifiedKeys.has(killed)
const zeroIn = parsed.verifiedKeys.has(zero)
console.log('KILLED_IN=' + killedIn + ' ZERO_IN=' + zeroIn)
process.exit(killedIn && !zeroIn ? 0 : 1)
"

# CR-M-1: the retry's `mutate` range is LINES, so it re-generates every
# neighbour on those lines — including mutants the FIRST pass already reported
# as survivors. Only the re-run survivors that ARE the first pass's unverified
# mutants may be pushed again; the rest are already counted.
assert_green "retry: a neighbour survivor on the same line is not counted a second time" \
  --contains 'SURVIVORS=1' \
  -- node --input-type=module -e "
import { retrySurvivorsForFirstPass } from '$GUARD'
const target = { where: 'pkg/src/a.ts:42', mutator: 'ConditionalExpression', replacement: 'false',
  rel: 'src/a.ts', line: 42, column: 7, endLine: 42, endColumn: 19 }
const neighbour = { where: 'pkg/src/a.ts:42', mutator: 'ConditionalExpression', replacement: 'true',
  rel: 'src/a.ts', line: 42, column: 24, endLine: 42, endColumn: 31 }
const kept = retrySurvivorsForFirstPass([target], [target, neighbour])
console.log('SURVIVORS=' + kept.length)
process.exit(kept.length === 1 && kept[0].replacement === 'false' ? 0 : 1)
"

# Panel finding on PR #1424: the retry can RUN tests against a zero-test mutant
# and still not kill it. That mutant is a real survivor — and it must NOT also
# be `resolved`, because `resolved` is what main() prints "verified by the
# isolated re-run — not a coverage gap" for. Reporting both made the gate
# contradict itself about one mutant: cleared and blocking at the same time.
assert_green "retry: a mutant the re-run executed but did not kill is a survivor, never also resolved" \
  --contains 'CONFIRMED=0 RESOLVED=0 SURVIVORS=1' \
  -- node --input-type=module -e "
import { retryOutcome, mutantKey } from '$GUARD'
const mutant = { where: 'pkg/src/a.ts:42', mutator: 'ConditionalExpression', replacement: 'false',
  rel: 'src/a.ts', line: 42, column: 7, endLine: 42, endColumn: 19 }
// The retry ran tests against it (so it IS in verifiedKeys) and reported it
// Survived.
const out = retryOutcome({
  addressable: [mutant],
  verifiedKeys: new Set([mutantKey(mutant)]),
  retrySurvivors: [mutant],
})
console.log('CONFIRMED=' + out.confirmed.length + ' RESOLVED=' + out.resolved.length +
  ' SURVIVORS=' + out.survivors.length)
process.exit(out.confirmed.length === 0 && out.resolved.length === 0 && out.survivors.length === 1 ? 0 : 1)
"

# The same mutant the retry KILLED (not in its survivors) stays resolved — the
# notice is still printed where it is true.
assert_green "retry: a mutant the re-run killed is resolved, and gets the notice" \
  --contains 'RESOLVED=1 SURVIVORS=0' \
  -- node --input-type=module -e "
import { retryOutcome, mutantKey } from '$GUARD'
const mutant = { where: 'pkg/src/a.ts:42', mutator: 'ConditionalExpression', replacement: 'false',
  rel: 'src/a.ts', line: 42, column: 7, endLine: 42, endColumn: 19 }
const out = retryOutcome({
  addressable: [mutant],
  verifiedKeys: new Set([mutantKey(mutant)]),
  retrySurvivors: [],
})
console.log('CONFIRMED=' + out.confirmed.length + ' RESOLVED=' + out.resolved.length +
  ' SURVIVORS=' + out.survivors.length)
process.exit(out.confirmed.length === 0 && out.resolved.length === 1 && out.survivors.length === 0 ? 0 : 1)
"

# CR-M-2 / SR-LOW: a mutant with no file or no line has no `mutate` pattern, so
# the retry cannot say anything about it. It is confirmed, NOT dropped — before
# this, one addressable neighbour was enough to make it vanish from the verdict.
assert_green "retry: a mutant the retry cannot address is confirmed, not silently dropped" \
  --contains 'CONFIRMED=1 UNADDRESSABLE=1' \
  -- node --input-type=module -e "
import { splitAddressable, retryOutcome, mutantKey } from '$GUARD'
const addressed = { where: 'pkg/src/a.ts:42', mutator: 'ArrowFunction', replacement: 'undefined',
  rel: 'src/a.ts', line: 42, column: 7, endLine: 42, endColumn: 19 }
const opaque = { where: 'pkg/src/b.ts:?', mutator: 'ObjectLiteral', replacement: '{}',
  rel: 'src/b.ts', line: null }
const split = splitAddressable([addressed, opaque])
// Every ADDRESSABLE mutant was verified by the re-run; without the fix the
// verdict would be empty and the build green.
const out = retryOutcome({ ...split, verifiedKeys: new Set([mutantKey(addressed)]) })
console.log('CONFIRMED=' + out.confirmed.length + ' UNADDRESSABLE=' + split.unaddressable.length +
  ' RESOLVED=' + out.resolved.length)
process.exit(out.confirmed.length === 1 && out.resolved.length === 1 ? 0 : 1)
"

# The re-run only re-verifies what its `mutate` range actually contains.
# Stryker's range filter includes a mutant only if the mutant is CONTAINED in
# the range, so a start-line-only pattern silently mutates nothing for every
# multi-line mutant — no report, and the mutant reads as "still unverified",
# i.e. a false red. Measured 2026-11-19 on the reproduced zero-test mutant
# (`content-gates.ts` lines 361-365): `...:361-361` produced `0 mutant(s) in
# 119.7s` and no report at all. Hence the pattern carries the END line.
assert_green "retry: a multi-line mutant's pattern spans start-to-end, not start-to-start" \
  --contains 'PATTERNS=src/a.ts:361-365' \
  -- node --input-type=module -e "
import { retryMutatePatterns } from '$GUARD'
const p = retryMutatePatterns([
  { where: 'pkg/src/a.ts:361', mutator: 'ObjectLiteral', rel: 'src/a.ts', line: 361, endLine: 365 },
])
console.log('PATTERNS=' + p.join(','))
process.exit(p.length === 1 && p[0] === 'src/a.ts:361-365' ? 0 : 1)
"

# A single-line mutant, and two mutants on the same range, must still produce
# ONE pattern each — the re-run's cost is per range, not per mutant.
assert_green "retry: a single-line mutant and duplicates collapse to one range each" \
  --contains 'PATTERNS=src/a.ts:42-42,src/b.ts:7-9' \
  -- node --input-type=module -e "
import { retryMutatePatterns } from '$GUARD'
const p = retryMutatePatterns([
  { where: 'pkg/src/a.ts:42', mutator: 'ArrowFunction', rel: 'src/a.ts', line: 42 },
  { where: 'pkg/src/a.ts:42', mutator: 'BooleanLiteral', rel: 'src/a.ts', line: 42, endLine: 42 },
  { where: 'pkg/src/b.ts:7', mutator: 'ObjectLiteral', rel: 'src/b.ts', line: 7, endLine: 9 },
  { where: 'pkg/src/c.ts:1', mutator: 'ObjectLiteral', rel: null, line: null },
])
console.log('PATTERNS=' + p.join(','))
process.exit(p.length === 2 ? 0 : 1)
"

# ── AC 2 of the task: the VERDICT, not just the partition (CR-M-4 / SPEC-M-1) ─
#
# `main()` needs a real Stryker run and cannot be driven from here, so the two
# halves of AC 2 live in pure functions and are exercised directly:
#   exit 1 — a confirmed zero-test mutant fails the build, and the annotation
#            names file, line and mutator so the log alone is actionable
#   exit 2 — a retry that wrote no report is could-not-run, never a pass
#
# RED-THEN-GREEN on the same function: one confirmed mutant → 1, none → 0.
assert_green "verdict: one confirmed zero-test mutant makes the gate exit 1 (the red)" \
  --contains 'EXIT=1' \
  -- node --input-type=module -e "
import { toolFailureExitCode } from '$GUARD'
const code = toolFailureExitCode([{ where: 'pkg/src/a.ts:42', mutator: 'ArrowFunction' }])
console.log('EXIT=' + code)
process.exit(code === 1 ? 0 : 1)
"

assert_green "verdict: no confirmed zero-test mutant leaves the exit code alone (the green)" \
  --contains 'EXIT=0' \
  -- node --input-type=module -e "
import { toolFailureExitCode } from '$GUARD'
const code = toolFailureExitCode([])
console.log('EXIT=' + code)
process.exit(code === 0 ? 0 : 1)
"

assert_green "verdict: the annotation names the file, the line, the mutator and the coveredBy count" \
  --contains 'ANNOTATION_OK' \
  -- node --input-type=module -e "
import { toolFailureAnnotation } from '$GUARD'
const line = toolFailureAnnotation({ where: 'apps/api/src/a.ts:361', mutator: 'ObjectLiteral',
  replacement: '{}', coveredBy: 69 })
console.log(line)
const ok = line.startsWith('::error file=apps/api/src/a.ts,line=361::') &&
  line.includes('mutant NOT VERIFIED (ObjectLiteral)') &&
  line.includes('69 test(s) cover it') &&
  line.includes('fails the build')
console.log(ok ? 'ANNOTATION_OK' : 'ANNOTATION_BAD')
process.exit(ok ? 0 : 1)
"

# Exit 2, asserted on a REAL child process: `fail()` is what the no-report
# branch calls, and the whole point is that it does not return a verdict the
# caller could soften. The child is expected to die with 2; this case is green
# when it does.
assert_green "verdict: a retry that produced no report exits 2 (could-not-run, never a pass)" \
  --contains 'CHILD_EXIT=2' \
  -- node --input-type=module -e "
import { spawnSync } from 'node:child_process'
import { retryNoReportMessage } from '$GUARD'
const msg = retryNoReportMessage({ pkgName: '@crm/api', code: 1, timedOut: false,
  remainingMs: 600000,
  addressable: [{ where: 'apps/api/src/a.ts:312', mutator: 'ConditionalExpression' }] })
const child = spawnSync(process.execPath, ['--input-type=module', '-e',
  \"import { fail } from '$GUARD'; fail(process.argv[1])\", msg], { encoding: 'utf8' })
console.log('CHILD_EXIT=' + child.status)
const ok = child.status === 2 &&
  child.stderr.includes('apps/api/src/a.ts:312') &&
  child.stderr.includes('produced no report (exit 1)')
process.exit(ok ? 0 : 1)
"

# LOW on PR #1424: a retry the BUDGET cut short and a retry that crashed both
# ended up reading "produced no report", which sends the operator looking for a
# crash that never happened. The budget case says so, and names the time left.
assert_green "verdict: a retry killed by the time budget says so instead of 'produced no report'" \
  --contains 'BUDGET_WORDED' \
  -- node --input-type=module -e "
import { retryNoReportMessage } from '$GUARD'
const msg = retryNoReportMessage({ pkgName: '@crm/api', code: 137, timedOut: true,
  remainingMs: 42000,
  addressable: [{ where: 'apps/api/src/a.ts:312', mutator: 'ConditionalExpression' }] })
console.log(msg)
const ok = msg.includes('time budget') && msg.includes('42s left') &&
  msg.includes('MUTATION_BUDGET_SECONDS') && !msg.includes('produced no report')
console.log(ok ? 'BUDGET_WORDED' : 'BUDGET_NOT_WORDED')
process.exit(ok ? 0 : 1)
"

# ── timeouts are collected separately, never silently folded into "killed"
# (task-mutation-gate-timeout-visibility) ────────────────────────────────────
#
# Owner-approved follow-up to the ToolFailure split above: BOTH places that
# print a "killed" figure used to add Killed + Timeout with no way to tell
# how much of that number was a timeout — 16 of 34 in one real run, invisible
# in the summary. readReport() now collects every Timeout mutant into its own
# array (same shape as toolFailures/survivors), and formatKilled() renders the
# combined figure as `N (M timeout)` — but ONLY when M > 0, so a run with zero
# timeouts prints exactly what it always did.

R7="$WS/case7.report.json"
write_report "$R7" \
  "Killed:StringLiteral:2" \
  "Timeout:ConditionalExpression:6" \
  "Timeout:ConditionalExpression:11" \
  "Survived:EqualityOperator:20::3"

assert_green "readReport: Timeout mutants land in their own array, counted, never mixed into survivors/toolFailures" \
  --contains 'TIMEOUTS=2 COUNT=2 SURV=1 TOOL=0' \
  -- node --input-type=module -e "
import { readReport } from '$GUARD'
const parsed = readReport('$R7', { dir: 'pkg' })
console.log(
  'TIMEOUTS=' + parsed.timeouts.length +
  ' COUNT=' + parsed.counts.Timeout +
  ' SURV=' + parsed.survivors.length +
  ' TOOL=' + parsed.toolFailures.length,
)
process.exit(
  parsed.timeouts.length === 2 &&
  parsed.counts.Timeout === 2 &&
  parsed.survivors.length === 1 &&
  parsed.toolFailures.length === 0 &&
  parsed.timeouts.every((t) => t.where && t.mutator)
    ? 0 : 1,
)
"

assert_green "readReport: zero timeouts -> empty timeouts array, counts.Timeout stays 0" \
  --contains 'TIMEOUTS=0 COUNT=0' \
  -- node --input-type=module -e "
import { readReport } from '$GUARD'
const parsed = readReport('$R4', { dir: 'pkg' })
console.log('TIMEOUTS=' + parsed.timeouts.length + ' COUNT=' + parsed.counts.Timeout)
process.exit(parsed.timeouts.length === 0 && parsed.counts.Timeout === 0 ? 0 : 1)
"

assert_green "formatKilled: some timeouts -> 'N (M timeout)', the exact shape the owner asked for" \
  -- node --input-type=module -e "
import { formatKilled } from '$GUARD'
process.exit(formatKilled(34, 16) === '34 (16 timeout)' ? 0 : 1)
"

assert_green "formatKilled: zero timeouts -> plain number, no '(0 timeout)' noise" \
  -- node --input-type=module -e "
import { formatKilled } from '$GUARD'
process.exit(formatKilled(18, 0) === '18' ? 0 : 1)
"

assert_green "formatKilled: single timeout still pluralised the same way (no special-case for 1)" \
  -- node --input-type=module -e "
import { formatKilled } from '$GUARD'
process.exit(formatKilled(5, 1) === '5 (1 timeout)' ? 0 : 1)
"

# ── nothing to mutate vs a report-less tool failure ──────────────────────────
# (task-mutation-gate-zero-mutants, 2026-09-01)
#
# main() reads a report-less Stryker run as "legitimately nothing to mutate"
# ONLY when the instrumenter's own log line says EXACTLY zero mutants — see
# the module header, "NOTHING TO MUTATE vs A REPORT-LESS TOOL FAILURE", for
# why "no report + clean exit" is not by itself proof of that (the SAME shape
# is also what the already-documented `vitest.related` tool failure produces
# on code that DOES have real mutants). parseInstrumentedMutantCount() is the
# one fact read straight out of Stryker's own log, before any report exists —
# these cases pin its contract directly, against text shaped the way the real
# child-process output actually reads (captured live, PR #620, 2026-09-01),
# not a hand-simplified stand-in for it.

REAL_ZERO_LOG='mutation-gate: diff base 6624b7851837 (MUTATION_BASE_SHA)

=== mutation-gate: @crm/web — 1 file(s), 11 changed line(s) ===
    mutate app/components/layout/notifications-bell.tsx:184-184
12:06:43 (65654) INFO ProjectReader Found 1 of 443 file(s) to be mutated.
12:06:43 (65654) INFO Instrumenter Instrumented 1 source file(s) with 0 mutant(s)
12:06:46 (65654) INFO ConcurrencyTokenProvider Creating 4 test runner process(es).
12:06:49 (65654) INFO DryRunExecutor Starting initial test run (vitest test runner with "perTest" coverage analysis). This may take a while.
12:07:01 (65691) WARN VitestTestRunner Vitest failed to find test files related to mutated files.
12:07:01 (65654) INFO DryRunExecutor No tests were found
12:07:01 (65654) INFO MutationTestExecutor Done in 19 seconds.'

# Written to a real file rather than embedded inline — same discipline
# write_report() above uses for its JSON fixtures: the log text contains
# quotes, parens and newlines that would fight the surrounding shell
# quoting if passed straight into a 'node -e "..."' string.
LOG_ZERO="$WS/zero-mutant.log"
printf '%s' "$REAL_ZERO_LOG" >"$LOG_ZERO"

assert_green "parseInstrumentedMutantCount: real captured zero-mutant log -> 0" \
  -- node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { parseInstrumentedMutantCount } from '$GUARD'
const out = readFileSync('$LOG_ZERO', 'utf8')
process.exit(parseInstrumentedMutantCount(out) === 0 ? 0 : 1)
"

REAL_NONZERO_LOG='=== mutation-gate: @crm/web — 2 file(s), 30 changed line(s) ===
12:14:10 (71380) INFO ProjectReader Found 2 of 443 file(s) to be mutated.
12:14:10 (71380) INFO Instrumenter Instrumented 2 source file(s) with 5 mutant(s)
12:14:16 (71380) INFO ConcurrencyTokenProvider Creating 4 test runner process(es).'
LOG_NONZERO="$WS/nonzero-mutant.log"
printf '%s' "$REAL_NONZERO_LOG" >"$LOG_NONZERO"

assert_green "parseInstrumentedMutantCount: real captured 5-mutant log (2 files) -> 5, never mistaken for zero" \
  -- node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { parseInstrumentedMutantCount } from '$GUARD'
const out = readFileSync('$LOG_NONZERO', 'utf8')
process.exit(parseInstrumentedMutantCount(out) === 5 ? 0 : 1)
"

assert_green "parseInstrumentedMutantCount: line absent entirely -> null, never coerced to 0" \
  -- node --input-type=module -e "
import { parseInstrumentedMutantCount } from '$GUARD'
const out = 'Stryker crashed before instrumentation even started\nsome other noise\n'
process.exit(parseInstrumentedMutantCount(out) === null ? 0 : 1)
"

assert_green "parseInstrumentedMutantCount: empty string -> null" \
  -- node --input-type=module -e "
import { parseInstrumentedMutantCount } from '$GUARD'
process.exit(parseInstrumentedMutantCount('') === null ? 0 : 1)
"

guard_test_summary "test-mutation-gate-reporting.sh"
