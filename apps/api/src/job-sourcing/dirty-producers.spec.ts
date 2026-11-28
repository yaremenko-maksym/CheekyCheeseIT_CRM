import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  markExclusionDirty,
  markProjectClientDirty,
  markProjectEditDirty,
  markRoleDirty,
  markSeniorDirty,
  markSeniorResumeDirty,
  markSeniorsDirty,
  markUserEditDirty,
} from './dirty-producers'
import type { SqlExecutor } from './scheduling/host-state'

/** r5 Task 4.6 S5 — which writes enqueue a roster-side dirty row, and of which kind. */
const dialect = new PgDialect()
const ID = '7d9b0d1c-2e5f-4a8b-9c6d-1e2f3a4b5c6d'

/** An executor answering the role read with `role` and recording every insert's params. */
function scripted(role: string | null = 'SENIOR') {
  const inserts: unknown[][] = []
  const tx: SqlExecutor = {
    execute: (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q)
      if (sql.startsWith('SELECT role FROM users'))
        return Promise.resolve({ rows: role === null ? [] : [{ role }] })
      if (sql.includes('coalesce(max(target_version), 0)'))
        return Promise.resolve({ rows: [{ v: 4 }] })
      if (sql.includes('INSERT INTO job_dirty_work')) inserts.push(params)
      return Promise.resolve({ rows: [{ id: ID }] })
    },
  }
  return { tx, inserts }
}

/** `[kind, entity, version, reason]` of each insert. */
const rows = (inserts: unknown[][]) => inserts.map((p) => p.slice(0, 4))

describe('markSeniorDirty', () => {
  it('enqueues a SENIOR row at the next derived version for a SENIOR', async () => {
    const { tx, inserts } = scripted('SENIOR')
    await expect(markSeniorDirty(tx, ID, 'senior.team')).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.team']])
  })

  it.each(['JUNIOR', 'HR', 'ACCOUNTANT', 'ADMIN', 'DROP', null])(
    'enqueues nothing for %s (on nobody’s roster)',
    async (role) => {
      const { tx, inserts } = scripted(role)
      await expect(markSeniorDirty(tx, ID, 'senior.archive')).resolves.toBe(false)
      expect(inserts).toEqual([])
    },
  )
})

describe('markRoleDirty', () => {
  it.each([
    ['JUNIOR', 'SENIOR'],
    ['SENIOR', 'HR'],
  ])('enqueues on %s -> %s (into or out of the roster)', async (from, to) => {
    const { tx, inserts } = scripted('HR')
    await expect(markRoleDirty(tx, ID, from, to)).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.role']])
  })

  it.each([
    ['SENIOR', 'SENIOR'],
    ['JUNIOR', 'HR'],
  ])('enqueues nothing on %s -> %s', async (from, to) => {
    const { tx, inserts } = scripted()
    await expect(markRoleDirty(tx, ID, from, to)).resolves.toBe(false)
    expect(inserts).toEqual([])
  })
})

describe('markUserEditDirty', () => {
  it('a role change wins over a roles edit in the same write (one row)', async () => {
    const { tx, inserts } = scripted()
    await expect(
      markUserEditDirty(
        tx,
        ID,
        { role: 'JUNIOR', technicalRoles: [] },
        { role: 'SENIOR', technicalRoles: ['BACKEND_ENGINEER'] },
      ),
    ).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.role']])
  })

  it('a real roles change marks senior.roles; an unchanged role is not a role change', async () => {
    const { tx, inserts } = scripted('SENIOR')
    await expect(
      markUserEditDirty(
        tx,
        ID,
        { role: 'SENIOR', technicalRoles: ['FRONTEND_ENGINEER'] },
        { role: 'SENIOR', technicalRoles: ['BACKEND_ENGINEER'] },
      ),
    ).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.roles']])
  })

  it('CR-M-1: an unchanged roles resubmit (any order) marks nothing', async () => {
    const { tx, inserts } = scripted('SENIOR')
    const existing = { role: 'SENIOR', technicalRoles: ['BACKEND_ENGINEER', 'DEVOPS_ENGINEER'] }
    await expect(
      markUserEditDirty(tx, ID, existing, {
        technicalRoles: ['DEVOPS_ENGINEER', 'BACKEND_ENGINEER'],
      }),
    ).resolves.toBe(false)
    expect(inserts).toEqual([])
    await expect(
      markUserEditDirty(tx, ID, existing, { technicalRoles: ['BACKEND_ENGINEER'] }),
    ).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.roles']])
  })

  it('a missing current roles value reads as empty: setting roles is a change, [] is not', async () => {
    const { tx, inserts } = scripted('SENIOR')
    await expect(
      markUserEditDirty(tx, ID, { role: 'SENIOR' }, { technicalRoles: [] }),
    ).resolves.toBe(false)
    expect(inserts).toEqual([])
    await expect(
      markUserEditDirty(tx, ID, { role: 'SENIOR' }, { technicalRoles: ['QA_ENGINEER'] }),
    ).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.roles']])
  })

  it('a techStack change no longer marks a SENIOR dirty', async () => {
    const { tx, inserts } = scripted('SENIOR')
    await expect(
      markUserEditDirty(
        tx,
        ID,
        { role: 'SENIOR', technicalRoles: ['BACKEND_ENGINEER'] },
        { techStack: ['Go'] },
      ),
    ).resolves.toBe(false)
    expect(inserts).toEqual([])
  })

  it('a roles change of a user who is not a SENIOR marks nothing', async () => {
    const { tx, inserts } = scripted('HR')
    await expect(
      markUserEditDirty(
        tx,
        ID,
        { role: 'HR', technicalRoles: [] },
        { technicalRoles: ['QA_ENGINEER'] },
      ),
    ).resolves.toBe(false)
    expect(inserts).toEqual([])
  })

  it('any other edit enqueues nothing', async () => {
    const { tx, inserts } = scripted()
    await expect(markUserEditDirty(tx, ID, { role: 'SENIOR' }, { telegram: '@x' })).resolves.toBe(
      false,
    )
    await expect(markUserEditDirty(tx, ID, { role: 'JUNIOR' }, { role: 'HR' })).resolves.toBe(false)
    expect(inserts).toEqual([])
  })
})

describe('markSeniorResumeDirty (SR-L-1: only a matcher-read skill change)', () => {
  const withSkills = (skills: readonly string[], technologies: readonly string[] = []) => ({
    content: { skills: [...skills] },
    facts: { experience: [{ technologies: [...technologies] }] },
  })

  it('a SENIOR whose resume skills changed is senior.resume on the user id', async () => {
    const { tx, inserts } = scripted('SENIOR')
    const change = { before: withSkills(['Go']), after: withSkills(['Go', 'Rust']) }
    await expect(markSeniorResumeDirty(tx, ID.toUpperCase(), change)).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.resume']])
  })

  it('a skill that arrives through the facts experience counts too', async () => {
    const { tx, inserts } = scripted('SENIOR')
    const change = { before: withSkills(['Go']), after: withSkills(['Go'], ['Kafka']) }
    await expect(markSeniorResumeDirty(tx, ID, change)).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.resume']])
  })

  it('a deleted resume (no skills after) is a change', async () => {
    const { tx, inserts } = scripted('SENIOR')
    const change = { before: withSkills(['Go']), after: {} }
    await expect(markSeniorResumeDirty(tx, ID, change)).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.resume']])
  })

  it.each([
    ['the same skills in another order or spelling', withSkills(['go', 'Rust'])],
    ['a synonym spelling of a skill already there', withSkills(['Go', 'Rust', 'Go lang'])],
    ['a duplicate of a skill already there', withSkills(['Go', 'Rust', 'Go'])],
  ])('%s is not a change: the matcher reads the same set', async (_label, after) => {
    const { tx, inserts } = scripted('SENIOR')
    const change = { before: withSkills(['Go', 'Rust']), after }
    await expect(markSeniorResumeDirty(tx, ID, change)).resolves.toBe(false)
    expect(inserts).toEqual([])
  })

  it('a non-skill edit of the same resume marks nothing', async () => {
    const { tx, inserts } = scripted('SENIOR')
    const before = { content: { skills: ['Go'], summary: 'a' }, facts: { experience: [] } }
    const after = { content: { skills: ['Go'], summary: 'b' }, facts: { experience: [] } }
    await expect(markSeniorResumeDirty(tx, ID, { before, after })).resolves.toBe(false)
    expect(inserts).toEqual([])
  })

  it.each([
    ['absent on both sides', {}, {}],
    ['stored as a JSON null (a row before any extraction)', { content: null, facts: null }, {}],
  ])('a resume with no skills, %s, marks nothing', async (_label, before, after) => {
    const { tx, inserts } = scripted('SENIOR')
    await expect(markSeniorResumeDirty(tx, ID, { before, after })).resolves.toBe(false)
    expect(inserts).toEqual([])
  })

  it('a resume of a user who is not a SENIOR (or is gone) marks nothing', async () => {
    for (const role of ['JUNIOR', null]) {
      const { tx, inserts } = scripted(role)
      const change = { before: {}, after: withSkills(['Go']) }
      await expect(markSeniorResumeDirty(tx, ID, change)).resolves.toBe(false)
      expect(inserts).toEqual([])
    }
  })
})

describe('exclusion and project producers', () => {
  it('an exclusion create / delete is an EXCLUSION row on the exclusion id', async () => {
    const { tx, inserts } = scripted()
    await markExclusionDirty(tx, ID, 'exclusion.create')
    await markExclusionDirty(tx, ID, 'exclusion.delete')
    expect(rows(inserts)).toEqual([
      ['EXCLUSION', ID, 5, 'exclusion.create'],
      ['EXCLUSION', ID, 5, 'exclusion.delete'],
    ])
  })

  it('a project create is a PROJECT_CLIENT row on the project id', async () => {
    const { tx, inserts } = scripted()
    await markProjectClientDirty(tx, ID, 'project.create')
    expect(rows(inserts)).toEqual([['PROJECT_CLIENT', ID, 5, 'project.create']])
  })

  it.each(['name', 'companyName', 'seniorId'])(
    'a project update writing %s is project.client',
    async (column) => {
      const { tx, inserts } = scripted()
      await expect(
        markProjectEditDirty(tx, ID, { [column]: 'old' }, { [column]: 'x', updatedAt: 1 }),
      ).resolves.toBe(true)
      expect(rows(inserts)).toEqual([['PROJECT_CLIENT', ID, 5, 'project.client']])
    },
  )

  it('a project update writing none of them enqueues nothing', async () => {
    const { tx, inserts } = scripted()
    await expect(markProjectEditDirty(tx, ID, {}, { rate: 10, archivedAt: null })).resolves.toBe(
      false,
    )
    // CR-M-1: the column is present but its value did not change.
    const same = { name: 'Acme', companyName: 'Acme Ltd', seniorId: ID }
    await expect(markProjectEditDirty(tx, ID, same, { ...same, rate: 10 })).resolves.toBe(false)
    expect(inserts).toEqual([])
  })
})

describe('SR-L-1 / SR-L-2: id case and lock order', () => {
  const UPPER = ID.toUpperCase()

  it('an uppercase route id is lowercased before it reaches the store', async () => {
    const { tx, inserts } = scripted('SENIOR')
    await expect(markSeniorDirty(tx, UPPER, 'senior.archive')).resolves.toBe(true)
    await markRoleDirty(tx, UPPER, 'SENIOR', 'HR')
    await markExclusionDirty(tx, UPPER, 'exclusion.delete')
    await markProjectClientDirty(tx, UPPER, 'project.create')
    expect(inserts.map((p) => p[1])).toEqual([ID, ID, ID, ID])
  })

  it('several seniors are locked in sorted id order, each once', async () => {
    const A = '00000000-0000-4000-8000-00000000000a'
    const B = '00000000-0000-4000-8000-00000000000b'
    const locks: unknown[] = []
    const { tx } = scripted('SENIOR')
    const spy: SqlExecutor = {
      execute: (q: SQL) => {
        const r = dialect.sqlToQuery(q)
        if (r.sql.includes('pg_advisory_xact_lock')) locks.push(r.params[0])
        return tx.execute(q)
      },
    }
    await expect(markSeniorsDirty(spy, [B, A.toUpperCase(), B], 'senior.team')).resolves.toBe(2)
    expect(locks).toEqual([`job_dirty_work:SENIOR:${A}`, `job_dirty_work:SENIOR:${B}`])
  })
})
