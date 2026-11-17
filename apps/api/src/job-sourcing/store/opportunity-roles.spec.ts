import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { SqlExecutor } from '../scheduling/host-state'
import { deriveOpportunityRoles, writeOpportunityRoles } from './opportunity-roles'

/** Senior roles PR 2 Task 2.3: the ingest role derivation, on a scripted fake executor. */

const dialect = new PgDialect()
const SHA = 'a'.repeat(64)

function fakeTx(rows: Record<string, unknown>[] = []) {
  const queries: { sql: string; params: unknown[] }[] = []
  const tx: SqlExecutor = {
    async execute(query: SQL) {
      queries.push(dialect.sqlToQuery(query))
      return { rows }
    },
  }
  return { tx, queries }
}

const input = (title: string, descriptionSha256: string | null = SHA) => ({
  title,
  titleKey: title.toLowerCase(),
  tags: [] as string[],
  descriptionSha256,
})

describe('deriveOpportunityRoles', () => {
  it('RULE for a classified title, no cache read', async () => {
    const { tx, queries } = fakeTx()
    expect(await deriveOpportunityRoles(tx, input('Senior Backend Engineer'))).toEqual({
      status: 'RULE',
      roles: ['BACKEND_ENGINEER'],
      classifierVersion: 'rc.1',
    })
    expect(queries).toHaveLength(0)
  })

  it('NON_IT for an excluded phrase', async () => {
    const { tx, queries } = fakeTx()
    expect(await deriveOpportunityRoles(tx, input('Recruiter'))).toEqual({
      status: 'NON_IT',
      roles: [],
      classifierVersion: 'rc.1',
    })
    expect(queries).toHaveLength(0)
  })

  it('PENDING and no cache lookup when descriptionSha256 is null', async () => {
    // Review Focus 2: a title-only record never reuses a full-text answer.
    const { tx, queries } = fakeTx([{ outcome: 'AI', technical_roles: ['BACKEND_ENGINEER'] }])
    expect(await deriveOpportunityRoles(tx, input('Wizard of Things', null))).toEqual({
      status: 'PENDING',
      roles: [],
      classifierVersion: 'rc.1',
    })
    expect(queries).toHaveLength(0)
  })

  it('AI roles from an AI cache row at the current version only', async () => {
    const { tx, queries } = fakeTx([
      { outcome: 'AI', technical_roles: ['FRONTEND_ENGINEER', 'BACKEND_ENGINEER'] },
    ])
    expect(await deriveOpportunityRoles(tx, input('Wizard of Things'))).toEqual({
      status: 'AI',
      roles: ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER'],
      classifierVersion: 'rc.1',
    })
    expect(queries).toHaveLength(1)
    expect(queries[0]?.sql).toContain('FROM job_role_classifications')
    expect(queries[0]?.sql).toContain('classifier_version = $3')
    expect(queries[0]?.params).toEqual(['wizard of things', SHA, 'rc.1'])
  })

  it('an AI cache row with no roles is PENDING, never an AI status with empty roles', async () => {
    const { tx } = fakeTx([{ outcome: 'AI', technical_roles: [] }])
    expect((await deriveOpportunityRoles(tx, input('Wizard of Things'))).status).toBe('PENDING')
  })

  it.each([
    ['UNCLEAR', 'UNCLEAR'],
    ['FAILED', 'PENDING'],
  ])('a %s cache row gives %s with no roles', async (outcome, status) => {
    const { tx } = fakeTx([{ outcome, technical_roles: [] }])
    expect(await deriveOpportunityRoles(tx, input('Wizard of Things'))).toEqual({
      status,
      roles: [],
      classifierVersion: 'rc.1',
    })
  })

  it('no cache row gives PENDING with no roles', async () => {
    const { tx, queries } = fakeTx([])
    expect(await deriveOpportunityRoles(tx, input('Wizard of Things'))).toEqual({
      status: 'PENDING',
      roles: [],
      classifierVersion: 'rc.1',
    })
    expect(queries).toHaveLength(1)
  })

  it('a FAILED cache row carrying roles is still PENDING: only an AI row gives AI roles', async () => {
    const { tx } = fakeTx([{ outcome: 'FAILED', technical_roles: ['BACKEND_ENGINEER'] }])
    expect(await deriveOpportunityRoles(tx, input('Wizard of Things'))).toEqual({
      status: 'PENDING',
      roles: [],
      classifierVersion: 'rc.1',
    })
  })
})

describe('writeOpportunityRoles', () => {
  it('updates the 3 role columns only, never revision', async () => {
    const { tx, queries } = fakeTx()
    await writeOpportunityRoles(tx, 'opp-1', {
      status: 'RULE',
      roles: ['BACKEND_ENGINEER'],
      classifierVersion: 'rc.1',
    })
    expect(queries).toHaveLength(1)
    const q = queries[0]!
    expect(q.sql).toMatch(/^UPDATE job_opportunities\s+SET technical_roles = /)
    expect(q.sql).toContain('role_status = $2')
    expect(q.sql).toContain('role_classifier_version = $3')
    expect(q.sql).not.toContain('revision =')
    expect(q.sql).not.toContain('updated_at')
    expect(q.params).toEqual(['["BACKEND_ENGINEER"]', 'RULE', 'rc.1', 'opp-1'])
  })
})
