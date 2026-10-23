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

/**
 * The non-comment text of one top-level job in `ci.yml`: from its `  <name>:` line to the next
 * job header. Comment lines are dropped so a name that survives only in a comment does not count,
 * and the block is scoped so a string in a DIFFERENT job does not count either.
 */
function jobBody(ci: string, name: string): string {
  const lines = ci.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  if (start === -1) throw new Error(`job ${name} not found in ${CI_YML}`)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const isComment = line.trimStart().startsWith('#')
    if (/^ {2}\S/.test(line) && !isComment) break
    if (!isComment) body.push(line)
  }
  return body.join('\n')
}

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

  it('the Timing specs job really runs them, and the post-merge verdict really depends on it', () => {
    const ci = readFileSync(join(REPO_ROOT, CI_YML), 'utf8')
    const timing = jobBody(ci, 'timing_specs')
    const alert = jobBody(ci, 'post_merge_alert')

    // The job selects the timing files and actually invokes vitest (not a comment, not another job).
    expect(timing).toContain("TIMING_SPECS: '1'")
    expect(timing).toMatch(/run: .*vitest run/)
    expect(timing).not.toMatch(/^\s*if:\s*false\b/m)

    // The alert job lists it in ITS OWN needs, reads its result, and the verdict uses that result:
    // a failure raises the alert, and the closing success requires it. Dropping any one of the
    // three would let the alert stop depending on the job while a bare string check stayed green.
    expect(alert).toMatch(/^\s*needs: \[[^\]]*\btiming_specs\b[^\]]*\]/m)
    expect(alert).toContain('TIMING: ${{ needs.timing_specs.result }}')
    expect(alert).toContain('[ "$TIMING" = "failure" ] && FAILED=')
    expect(alert).toMatch(/elif .*\[ "\$TIMING" = "success" \]/)
  })
})
