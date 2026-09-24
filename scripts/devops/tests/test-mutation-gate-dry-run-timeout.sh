#!/usr/bin/env bash
# test-mutation-gate-dry-run-timeout.sh — proves parseDryRunTimeoutMinutes()
# in scripts/devops/mutation-gate.mjs (task-mutation-gate-dryrun-timeout,
# 2026-09-24), executed rather than read by eye — same discipline as
# test-mutation-gate-reporting.sh next to this file: exercise the exported
# pure function directly, no real Stryker run involved.
#
# WHY THIS EXISTS: Stryker's own dryRunTimeoutMinutes default (5) stopped
# covering the `@crm/web` leg's initial (unmutated) dry run — ~2900 tests
# under `coverageAnalysis: perTest` on a shared CI runner — and the PR gate
# went red TWICE on the same commit with zero mutants actually tried (PR
# #706, "DryRunExecutor Initial test run timed out!" at exactly 5:00). The
# fix raises the default to 20 and makes it configurable via
# MUTATION_DRY_RUN_TIMEOUT_MINUTES; these cases pin that contract.
#
# No assert_red here on purpose: parseDryRunTimeoutMinutes() is a graceful-
# degradation function, not a guard that blocks anything — an invalid value
# falls back to the default WITH a warning, it never fails or exits non-zero
# (see the function's own header comment for why: an operator typo in one
# knob must not turn "the gate could not run" into the failure mode). It is
# also not a scripts/devops/check-* script, so
# scripts/devops/check-guard-tests-exist.sh's negative-case requirement does
# not apply to it — confirmed against that script's own inventory glob
# (`check-*.{sh,py,mjs}`), which mutation-gate.mjs does not match.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/mutation-gate.mjs"

echo "== test-mutation-gate-dry-run-timeout.sh =="
echo

assert_green "unset -> default (20), no warning" \
  --contains 'VALUE=20 WARNING=null' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes(undefined)
console.log('VALUE=' + r.value + ' WARNING=' + (r.warning === null ? 'null' : 'SET'))
process.exit(r.value === 20 && r.warning === null ? 0 : 1)
"

assert_green "empty string -> default (20), no warning (same as unset, not an error)" \
  --contains 'VALUE=20 WARNING=null' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes('')
console.log('VALUE=' + r.value + ' WARNING=' + (r.warning === null ? 'null' : 'SET'))
process.exit(r.value === 20 && r.warning === null ? 0 : 1)
"

assert_green "whitespace-only -> default (20), no warning" \
  --contains 'VALUE=20 WARNING=null' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes('   ')
console.log('VALUE=' + r.value + ' WARNING=' + (r.warning === null ? 'null' : 'SET'))
process.exit(r.value === 20 && r.warning === null ? 0 : 1)
"

assert_green "valid positive integer '30' -> honoured, no warning" \
  --contains 'VALUE=30 WARNING=null' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes('30')
console.log('VALUE=' + r.value + ' WARNING=' + (r.warning === null ? 'null' : 'SET'))
process.exit(r.value === 30 && r.warning === null ? 0 : 1)
"

assert_green "surrounding whitespace around a valid value is trimmed" \
  --contains 'VALUE=15 WARNING=null' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes('  15  ')
console.log('VALUE=' + r.value + ' WARNING=' + (r.warning === null ? 'null' : 'SET'))
process.exit(r.value === 15 && r.warning === null ? 0 : 1)
"

assert_green "zero -> rejected (not positive), falls back to default WITH a warning" \
  --contains 'VALUE=20 WARNING=SET' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes('0')
console.log('VALUE=' + r.value + ' WARNING=' + (r.warning === null ? 'null' : 'SET'))
process.exit(r.value === 20 && typeof r.warning === 'string' && r.warning.includes('0') ? 0 : 1)
"

assert_green "negative -> rejected, falls back to default WITH a warning" \
  --contains 'VALUE=20 WARNING=SET' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes('-5')
console.log('VALUE=' + r.value + ' WARNING=' + (r.warning === null ? 'null' : 'SET'))
process.exit(r.value === 20 && r.warning !== null ? 0 : 1)
"

assert_green "non-integer decimal -> rejected, falls back to default WITH a warning" \
  --contains 'VALUE=20 WARNING=SET' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes('5.5')
console.log('VALUE=' + r.value + ' WARNING=' + (r.warning === null ? 'null' : 'SET'))
process.exit(r.value === 20 && r.warning !== null ? 0 : 1)
"

assert_green "non-numeric string -> rejected, falls back to default WITH a warning naming the bad value" \
  --contains 'MUTATION_DRY_RUN_TIMEOUT_MINUTES=' \
  -- node --input-type=module -e "
import { parseDryRunTimeoutMinutes } from '$GUARD'
const r = parseDryRunTimeoutMinutes('not-a-number')
console.log(r.warning)
process.exit(r.value === 20 && r.warning && r.warning.includes('not-a-number') ? 0 : 1)
"

guard_test_summary "test-mutation-gate-dry-run-timeout.sh"
