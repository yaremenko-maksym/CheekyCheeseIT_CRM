import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * r5 Task 4.6 S5, CR-M-3 / SR-L-3 / CR-M-5: the derived version of SENIOR / EXCLUSION /
 * PROJECT_CLIENT dirty work is the newest `target_version` among the entity's own rows, so it is
 * monotonic only while nothing deletes from `job_dirty_work`. A future retention job must follow
 * the rule at `NEW_STORE_CLEANUP_DISABLED` (`job-sourcing/retention.ts`) and change this guard
 * deliberately.
 *
 * THIS IS A TRIPWIRE, NOT A PROOF. It reads the repository's own code (API sources, drizzle SQL
 * including `manual*`, `scripts/`, `.github/workflows/`) and fails on the deletion shapes below.
 * It cannot see a table name assembled at runtime, SQL typed into a console, or a tool outside
 * the repository. There is no database-level backstop: the app role holds DELETE on the table
 * (privileges are deliberately not changed by this slice).
 */
const REPO = resolve(__dirname, '../../../../..')

/** Quotes, schema qualifiers, `ONLY` and whitespace removed; lowercased. */
export function normaliseSql(text: string): string {
  return text
    .replace(/["`]/g, '')
    .replace(/\b[a-z_][a-z0-9_]*\.(?=job_dirty_work\b)/gi, '')
    .replace(/\bonly\s+/gi, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

const SQL_DELETES = [
  /\bdelete from job_dirty_work\b/,
  /\btruncate (?:table )?[^;]*\bjob_dirty_work\b/,
]

/** Every local name `jobDirtyWork` is imported under (`as` aliases and namespace imports). */
function drizzleNames(text: string): { direct: string[]; namespaces: string[] } {
  const direct = new Set<string>()
  const namespaces = new Set<string>()
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]+['"]/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/)
      if (name === 'jobDirtyWork') direct.add((alias ?? name).trim())
    }
  }
  for (const m of text.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]*schema[^'"]*['"]/g))
    namespaces.add(m[1] as string)
  direct.add('jobDirtyWork')
  return { direct: [...direct], namespaces: [...namespaces] }
}

/** The deletion shapes this file contains (empty when it is clean). */
export function deletionsIn(text: string): string[] {
  const hits: string[] = []
  const sql = normaliseSql(text)
  for (const re of SQL_DELETES) if (re.test(sql)) hits.push(re.source)
  const { direct, namespaces } = drizzleNames(text)
  const targets = [
    ...direct,
    ...namespaces.map((n) => `${n}\\s*\\.\\s*jobDirtyWork`),
    '\\w+\\s*\\.\\s*jobDirtyWork',
  ]
  for (const t of targets)
    if (new RegExp(`\\.delete\\(\\s*${t}\\s*\\)`).test(text)) hits.push(`.delete(${t})`)
  return hits
}

const isTest = (p: string) =>
  /\.(spec|test)\.[cm]?[jt]sx?$/.test(p) ||
  /__test-helpers__|\/test\/|\/tests\//.test(p) ||
  p.endsWith('.d.ts')

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, keep, out)
    else if (keep(p)) out.push(p)
  }
  return out
}

const CODE = /\.(ts|mts|cts|js|mjs|cjs|sql|sh|py|ya?ml)$/

describe('job_dirty_work is never pruned (S5 derived-version invariant)', () => {
  it.each([
    ['plain', 'DELETE FROM job_dirty_work WHERE status = $1'],
    ['quoted and schema-qualified', 'delete from "public"."job_dirty_work" where true'],
    ['ONLY', 'DELETE FROM ONLY public.job_dirty_work'],
    ['line-broken', 'DELETE\n   FROM\n  job_dirty_work'],
    ['truncate list', 'TRUNCATE TABLE job_queue_actions, "job_dirty_work"'],
    ['truncate ONLY', 'TRUNCATE ONLY job_dirty_work CASCADE'],
    ['drizzle symbol', 'await tx.delete(jobDirtyWork).where(x)'],
    [
      'drizzle namespace',
      "import * as schema from '../database/schema'\ndb.delete(schema.jobDirtyWork)",
    ],
    [
      'drizzle alias',
      "import { jobDirtyWork as q } from '../database/schema'\nawait db.delete( q )",
    ],
    ['other namespace', 'await db.delete(s.jobDirtyWork)'],
  ])('flags a %s deletion', (_name, text) => {
    expect(deletionsIn(text)).not.toEqual([])
  })

  it.each([
    ['a read', 'SELECT * FROM job_dirty_work WHERE id = $1'],
    ['an update', 'UPDATE job_dirty_work SET status = $1'],
    ['another table', 'DELETE FROM job_dirty_work_archive_x WHERE true'],
    ['another drizzle table', 'await db.delete(jobRunRecords)'],
  ])('does not flag %s', (_name, text) => {
    expect(deletionsIn(text)).toEqual([])
  })

  it('test files (whose fixtures do delete) are not scanned', () => {
    expect(isTest('apps/api/src/job-sourcing/ownership/dirty-work.store.integration.spec.ts')).toBe(
      true,
    )
    expect(isTest('apps/api/src/test/record-store-fixtures.ts')).toBe(true)
    expect(isTest('scripts/devops/tests/test-x.sh')).toBe(true)
    expect(isTest('apps/api/src/job-sourcing/retention.ts')).toBe(false)
  })

  it('no production code, SQL, script or workflow in the repository deletes from job_dirty_work', () => {
    const roots: [string, (p: string) => boolean][] = [
      [join(REPO, 'apps/api/src'), (p) => /\.ts$/.test(p) && !isTest(p)],
      [join(REPO, 'apps/api/drizzle'), (p) => CODE.test(p)],
      [join(REPO, 'scripts'), (p) => CODE.test(p) && !isTest(p)],
      [join(REPO, '.github/workflows'), (p) => CODE.test(p)],
    ]
    const counts = roots.map(([dir, keep]) => walk(dir, keep).length)
    // Each root must actually be read: a zero means the scan looked at nothing there.
    expect(counts.every((n) => n > 0)).toBe(true)
    expect(counts[0]).toBeGreaterThan(400) // ~485 non-test API sources on 2026-10-31
    const offenders = roots
      .flatMap(([dir, keep]) => walk(dir, keep))
      .filter((f) => deletionsIn(readFileSync(f, 'utf8')).length > 0)
      .map((f) => relative(REPO, f))
    expect(offenders).toEqual([])
  })
})
