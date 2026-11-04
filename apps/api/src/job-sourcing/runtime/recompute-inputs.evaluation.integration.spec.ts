import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { Evaluated, Excluded } from '../funnel/evaluate'
import { type RosterInputs, installMatches, rosterVersions } from './recompute-inputs'

/**
 * SR-M-2 — `installMatches` records the evaluated revision and the opportunity-level verdict,
 * against a real Postgres as `crm_app`: on the empty-roster path, in the transaction of the match
 * rows, and never over a newer revision.
 */
const TAG = randomUUID().slice(0, 8)
const ROLLBACK = new Error('rollback')

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>
let senior: string
const oppIds: string[] = []

const empty: RosterInputs = {
  rosterSeniorIds: [],
  profiles: [],
  exclusions: [],
  versions: new Map(),
}
const audit = { noTeamAccess: [], ignoredExclusionIds: [] }
const common = {
  recordKey: 'k',
  opportunityId: 'unused',
  revisionId: '1',
  evaluatedAt: '2026-11-04T10:00:00.000Z',
  trace: [],
}
const open = {
  ...common,
  kind: 'EVALUATED',
  status: 'NO_MATCH',
  layer1: {},
  projections: [],
  audit: { ...audit, excluded: [] },
} as unknown as Evaluated
const excluded: Excluded = {
  ...common,
  kind: 'EXCLUDED',
  reasons: [],
  audit: {
    ...audit,
    excluded: [{ subject: 'OPPORTUNITY', stage: 'CLASSIFICATION', reasons: [], inputs: {} }],
  },
}

async function opportunity(label: string, revision = 1): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO job_opportunities (title, title_key, revision) VALUES ($1, $1, $2) RETURNING id`,
    [`eval-${TAG}-${label}`, revision],
  )
  const id = rows[0].id as string
  oppIds.push(id)
  return id
}

async function recorded(id: string) {
  const { rows } = await session.admin.query(
    `SELECT evaluated_revision, evaluation_verdict FROM job_opportunities WHERE id = $1`,
    [id],
  )
  return rows[0] as { evaluated_revision: number | null; evaluation_verdict: string | null }
}

const matchCount = async (id: string) =>
  (
    await session.admin.query(`SELECT 1 FROM job_opportunity_matches WHERE opportunity_id = $1`, [
      id,
    ])
  ).rowCount

describe.skipIf(!hasDatabaseUrl())('installMatches: the evaluation record (SR-M-2)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 2 })
    const probe = await session.admin.query(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
    const { rows } = await session.admin.query(
      `INSERT INTO users (email, display_name, role) VALUES ($1, 'eval senior', 'SENIOR') RETURNING id`,
      [`eval-senior-${TAG}@example.test`],
    )
    senior = rows[0].id as string
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      await session.admin.query(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [
        oppIds,
      ])
      await session.admin.query(`DELETE FROM users WHERE id = $1`, [senior])
    } finally {
      await session.close()
    }
  })

  it('a new opportunity is unevaluated: both columns NULL', async () => {
    expect(await recorded(await opportunity('new'))).toEqual({
      evaluated_revision: null,
      evaluation_verdict: null,
    })
  })

  it('the empty-roster path writes no rows and still records the verdict', async () => {
    const a = await opportunity('empty-open')
    const b = await opportunity('empty-excluded', 3)
    expect(await installMatches(db, a, 1, open, empty)).toBe(0)
    expect(await installMatches(db, b, 3, excluded, empty)).toBe(0)
    expect(await matchCount(a)).toBe(0)
    expect(await matchCount(b)).toBe(0)
    expect(await recorded(a)).toEqual({ evaluated_revision: 1, evaluation_verdict: 'OPEN' })
    expect(await recorded(b)).toEqual({ evaluated_revision: 3, evaluation_verdict: 'EXCLUDED' })
  })

  it('a stale install changes neither the record nor the rows of the newer revision', async () => {
    const o = await opportunity('stale', 5)
    await installMatches(db, o, 5, excluded, empty)
    await installMatches(db, o, 4, open, empty)
    expect(await recorded(o)).toEqual({ evaluated_revision: 5, evaluation_verdict: 'EXCLUDED' })
  })

  it('a re-evaluation of the SAME revision overwrites the verdict (an exclusion was lifted)', async () => {
    const o = await opportunity('same')
    await installMatches(db, o, 1, excluded, empty)
    await installMatches(db, o, 1, open, empty)
    expect(await recorded(o)).toEqual({ evaluated_revision: 1, evaluation_verdict: 'OPEN' })
  })

  it('a newer revision overwrites an older record', async () => {
    const o = await opportunity('newer', 2)
    await installMatches(db, o, 1, excluded, empty)
    await installMatches(db, o, 2, open, empty)
    expect(await recorded(o)).toEqual({ evaluated_revision: 2, evaluation_verdict: 'OPEN' })
  })

  it('the record and the rows commit or roll back together', async () => {
    const o = await opportunity('atomic')
    const profiles = [{ seniorId: senior, teamIds: ['t'], techStack: ['Go'] }]
    const roster: RosterInputs = {
      rosterSeniorIds: [senior],
      profiles,
      exclusions: [],
      versions: rosterVersions(profiles, []),
    }
    let installed = -1
    await db
      .transaction(async (tx) => {
        installed = await installMatches(tx, o, 1, excluded, roster)
        throw ROLLBACK
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e
      })
    expect(installed).toBe(1)
    expect(await matchCount(o)).toBe(0)
    expect((await recorded(o)).evaluated_revision).toBeNull()

    expect(await installMatches(db, o, 1, excluded, roster)).toBe(1)
    expect(await matchCount(o)).toBe(1)
    expect(await recorded(o)).toEqual({ evaluated_revision: 1, evaluation_verdict: 'EXCLUDED' })
  })

  it('the CHECK refuses a verdict without a revision, and a revision without a verdict', async () => {
    const o = await opportunity('pair')
    for (const set of [`evaluation_verdict = 'OPEN'`, `evaluated_revision = 1`]) {
      await expect(
        session.admin.query(`UPDATE job_opportunities SET ${set} WHERE id = $1`, [o]),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'ck_job_opportunities_evaluation_pair',
      })
    }
  })
})
