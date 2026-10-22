#!/usr/bin/env bash
# test-mutation-gate-schema-exclude.sh — pins the owner decision of 2026-10-13:
# declarative Drizzle schema definitions (apps/api/src/database/schema/** and the
# schema.ts barrel) are never mutated by scripts/devops/mutation-gate.mjs, in
# BOTH --changed (isExcludedFromMutation, used by planChanged) and --full
# (planFull's `!`-negated globs) — and NOTHING ELSE is swept up with them.
#
# Case (a): schema files are excluded. Case (b): non-schema apps/api logic files,
# including ones whose names merely resemble schema, are STILL mutated — the
# guard against over-exclusion (this must never become the rejected `ignoreStatic`).
# Pure-function checks via exported helpers; no Stryker run, same style as
# test-mutation-gate-reporting.sh. Each snippet exits 0 when the assertion holds.
set -u
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib/harness.sh"

GUARD="$GUARD_DIR/mutation-gate.mjs"

echo "== test-mutation-gate-schema-exclude.sh =="
echo

assert_green "(a) --changed: files under database/schema/** and the schema.ts barrel are NOT mutated" \
  --contains 'EXCLUDED=3' \
  -- node --input-type=module -e "
import { PACKAGES, isExcludedFromMutation } from '$GUARD'
const api = PACKAGES.find((p) => p.name === '@crm/api')
const files = ['src/database/schema/users.ts', 'src/database/schema/finance/transactions.ts', 'src/database/schema.ts']
const n = files.filter((f) => isExcludedFromMutation(api, f)).length
console.log('EXCLUDED=' + n)
process.exit(n === files.length ? 0 : 1)"

assert_green "(a) --full: planFull() negates the schema dir and barrel for @crm/api" \
  --contains 'FULL_OK' \
  -- node --input-type=module -e "
import { planFull } from '$GUARD'
const api = planFull().plan.find((e) => e.pkg.name === '@crm/api')
const ok = api.patterns.includes('!src/database/schema/**') && api.patterns.includes('!src/database/schema.ts')
console.log(ok ? 'FULL_OK' : 'FULL_MISSING')
process.exit(ok ? 0 : 1)"

assert_green "(b) non-schema apps/api logic files are STILL mutated (no over-exclusion)" \
  --contains 'MUTATED=5' \
  -- node --input-type=module -e "
import { PACKAGES, isExcludedFromMutation } from '$GUARD'
const api = PACKAGES.find((p) => p.name === '@crm/api')
const files = [
  'src/finance/finance.service.ts',
  'src/auth/auth.controller.ts',
  'src/database/database.service.ts',
  'src/database/schema-helpers.ts',
  'src/common/schema/validation.ts',
]
const n = files.filter((f) => !isExcludedFromMutation(api, f)).length
console.log('MUTATED=' + n)
process.exit(n === files.length ? 0 : 1)"

assert_green "(b) exclusion is api-only: @crm/shared and @crm/web still mutate a database/schema path" \
  --contains 'OTHERS_MUTATED' \
  -- node --input-type=module -e "
import { PACKAGES, isExcludedFromMutation } from '$GUARD'
const bad = PACKAGES.filter((p) => p.name !== '@crm/api').filter((p) => isExcludedFromMutation(p, 'src/database/schema/x.ts'))
console.log(bad.length === 0 ? 'OTHERS_MUTATED' : 'LEAK')
process.exit(bad.length === 0 ? 0 : 1)"

guard_test_summary "test-mutation-gate-schema-exclude.sh"
