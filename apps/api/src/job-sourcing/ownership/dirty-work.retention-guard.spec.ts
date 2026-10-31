import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * r5 Task 4.6 S5, CR-M-3 / SR-L-3: the derived version of SENIOR / EXCLUSION / PROJECT_CLIENT
 * dirty work is the newest `target_version` among the entity's own rows, so it is monotonic only
 * while no code deletes from `job_dirty_work`. This guard reads every non-test source file of the
 * API and every SQL file under `drizzle/`, and fails on a DELETE / TRUNCATE of that table. A
 * future retention job must follow the rule written at `NEW_STORE_CLEANUP_DISABLED`
 * (`job-sourcing/retention.ts`) and then change this guard deliberately.
 */
const API = resolve(__dirname, '../../..')
const DELETES = [
  /DELETE\s+FROM\s+(?:public\.)?"?job_dirty_work"?/i,
  /TRUNCATE\s+(?:TABLE\s+)?[^;]*\bjob_dirty_work\b/i,
  /\.delete\(\s*jobDirtyWork\s*\)/,
]
const isTest = (p: string) =>
  /\.(spec|test)\.ts$/.test(p) || /__test-helpers__|\/test\//.test(p) || p.endsWith('.d.ts')

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, keep, out)
    else if (keep(p)) out.push(p)
  }
  return out
}

describe('job_dirty_work is never pruned (S5 derived-version invariant)', () => {
  it('the patterns catch the shapes a cleanup would use', () => {
    for (const sample of [
      'DELETE FROM job_dirty_work WHERE status = $1',
      'delete from public."job_dirty_work"',
      'TRUNCATE TABLE job_queue_actions, job_dirty_work',
      'await tx.delete(jobDirtyWork).where(x)',
    ])
      expect(DELETES.some((re) => re.test(sample))).toBe(true)
    expect(DELETES.some((re) => re.test('SELECT * FROM job_dirty_work'))).toBe(false)
  })

  it('no production TypeScript or SQL deletes from job_dirty_work', () => {
    const files = [
      ...walk(join(API, 'src'), (p) => p.endsWith('.ts') && !isTest(p)),
      ...walk(join(API, 'drizzle'), (p) => p.endsWith('.sql')),
    ]
    // The scan must actually read the tree: a zero here means it looked at nothing.
    expect(files.length).toBeGreaterThan(500)
    const offenders = files
      .filter((f) => DELETES.some((re) => re.test(readFileSync(f, 'utf8'))))
      .map((f) => relative(API, f))
    expect(offenders).toEqual([])
  })
})
