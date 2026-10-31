import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  markExclusionDirty,
  markProjectClientDirty,
  markProjectEditDirty,
  markRoleDirty,
  markSeniorDirty,
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
  it('a role change wins over a stack edit in the same write (one row)', async () => {
    const { tx, inserts } = scripted()
    await markUserEditDirty(tx, ID, 'JUNIOR', { role: 'SENIOR', techStack: ['Go'] })
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.role']])
  })

  it('a stack edit of a SENIOR is senior.stack; an unchanged role is not a role change', async () => {
    const { tx, inserts } = scripted('SENIOR')
    await expect(
      markUserEditDirty(tx, ID, 'SENIOR', { role: 'SENIOR', techStack: ['Go'] }),
    ).resolves.toBe(true)
    expect(rows(inserts)).toEqual([['SENIOR', ID, 5, 'senior.stack']])
  })

  it('any other edit enqueues nothing', async () => {
    const { tx, inserts } = scripted()
    await expect(markUserEditDirty(tx, ID, 'SENIOR', { telegram: '@x' })).resolves.toBe(false)
    await expect(markUserEditDirty(tx, ID, 'JUNIOR', { role: 'HR' })).resolves.toBe(false)
    expect(inserts).toEqual([])
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
      await expect(markProjectEditDirty(tx, ID, { [column]: 'x', updatedAt: 1 })).resolves.toBe(
        true,
      )
      expect(rows(inserts)).toEqual([['PROJECT_CLIENT', ID, 5, 'project.client']])
    },
  )

  it('a project update writing none of them enqueues nothing', async () => {
    const { tx, inserts } = scripted()
    await expect(markProjectEditDirty(tx, ID, { rate: 10, archivedAt: null })).resolves.toBe(false)
    expect(inserts).toEqual([])
  })
})
