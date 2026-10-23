/**
 * Pins the exact set of `*.timing.spec.ts` files.
 *
 * WHY: a file named `*.timing.spec.ts` is excluded from the default `vitest run` - the unit suite,
 * the mutation gate and pre-push (see `TIMING_SPEC_GLOB` in `apps/api/vitest.config.mts`) - and runs
 * only in the dedicated `Timing specs` CI job. That is a deliberate trade for specs whose assertion
 * is a stopwatch ratio, and a hole for anything else: a spec that merely happens to carry the name
 * would silently stop gating pushes. So the list is pinned, and adding to it is a reviewed edit to
 * THIS file rather than a side effect of a filename.
 *
 * Admission rule for a new entry: the assertion compares measured wall-clock times, AND a
 * deterministic counterpart for the same guarantee stays in the unit suite (see
 * `resumes/resume-offload-structure.spec.ts` and `job-sourcing/xml/growth.spec.ts`).
 *
 * It also pins that the CI job which runs them still exists, because deleting the job would
 * otherwise turn the timing guarantees off without a single red check.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = resolve(__dirname, '..')
const CI_YML = '.github/workflows/ci.yml'

/** Walk up to the checkout root (also correct inside a Stryker sandbox, which nests deeper). */
function findRepoRoot(from: string): string {
  let dir = from
  while (!existsSync(join(dir, CI_YML))) {
    const parent = resolve(dir, '..')
    if (parent === dir) throw new Error(`${CI_YML} not found above ${from}`)
    dir = parent
  }
  return dir
}
const REPO_ROOT = findRepoRoot(SRC_ROOT)

/** Paths relative to `apps/api/src`, sorted. */
const PINNED_TIMING_SPECS = [
  'job-sourcing/xml/growth.timing.spec.ts',
  'resumes/resume-render-responsiveness.timing.spec.ts',
]

function findTimingSpecs(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findTimingSpecs(full))
    else if (entry.name.endsWith('.timing.spec.ts')) found.push(relative(SRC_ROOT, full))
  }
  return found
}

describe('timing spec registry', () => {
  it('the set of *.timing.spec.ts files is exactly the pinned list', () => {
    expect(findTimingSpecs(SRC_ROOT).sort()).toEqual(PINNED_TIMING_SPECS)
  })

  it('the Timing specs CI job still selects them (TIMING_SPECS=1) and gates post-merge', () => {
    const ci = readFileSync(join(REPO_ROOT, CI_YML), 'utf8')
    expect(ci).toContain('timing_specs:')
    expect(ci).toContain("TIMING_SPECS: '1'")
    expect(ci).toMatch(/needs: \[[^\]]*timing_specs[^\]]*\]/)
  })
})
