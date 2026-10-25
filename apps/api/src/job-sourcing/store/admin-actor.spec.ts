import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * SR-M-3 (PR #1164): `asAdminActor` is the only mint of an `AdminActor`, and nothing in production
 * code may call it yet. Task 4.6 adds exactly one caller — the ADMIN-guarded controller path, from
 * the authenticated request principal — and must extend `ALLOWED` here, so a mint from literals in
 * some other module is a failing test rather than a silent ADMIN. (The dispositions re-check the
 * role in the database too; this pins the second half of the finding.)
 */
const SRC = join(__dirname, '..', '..')
const ALLOWED = ['job-sourcing/store/canonical.store.ts']

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path)
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : []
  })
}

describe('asAdminActor callers (SR-M-3)', () => {
  it('is referenced by no production file but its own', () => {
    const files = sources(SRC)
    expect(files.length).toBeGreaterThan(100)
    const callers = files
      .filter((f) => readFileSync(f, 'utf8').includes('asAdminActor'))
      .map((f) => relative(SRC, f).split(sep).join('/'))
    expect(callers).toEqual(ALLOWED)
  })
})
