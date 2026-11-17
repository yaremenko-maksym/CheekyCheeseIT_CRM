import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { hasDatabaseUrl } from '../../test/require-real-db'
import type { Excluded } from '../funnel/evaluate'
import { STUDIO_SCOPE } from '../queue/queue-scope'
import { JobQueueScopeService } from '../queue/queue-scope.service'
import { installMatches, loadRoster } from './recompute-inputs'

/**
 * Senior roles PR 4 Task 4.2 (Review Focus 3), real Postgres as `crm_app`: the profile version the
 * recompute stamps on a match row (`installMatches` over `loadRoster`) is the one the queue read
 * side compares it with (`JobQueueScopeService.liveVersions`), now that it covers the technical
 * roles and the canonical resume skills. A roles or resume-skills change stales the row; the skill
 * order and a synonym spelling do not.
 */
const TAG = randomUUID().slice(0, 8)

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>
let senior: string
let team: string
let opp: string

/** An opportunity-level EXCLUDED verdict: one row per roster senior, each stamped with versions. */
const excluded: Excluded = {
  recordKey: 'k',
  opportunityId: 'unused',
  revisionId: '1',
  evaluatedAt: '2026-11-17T10:00:00.000Z',
  trace: [],
  kind: 'EXCLUDED',
  reasons: [],
  roleFamily: 'SOFTWARE',
  audit: {
    noTeamAccess: [],
    ignoredExclusionIds: [],
    excluded: [{ subject: 'OPPORTUNITY', stage: 'CLASSIFICATION', reasons: [], inputs: {} }],
  },
}

const q = (text: string, params: unknown[] = []) => session.admin.query(text, params)

/** Records the verdict under the live roster, as the recompute worker does. */
const recompute = async () => installMatches(db, opp, 1, excluded, await loadRoster(db))

async function stamped(): Promise<string> {
  const { rows } = await q(
    `SELECT senior_profile_version FROM job_opportunity_matches
      WHERE opportunity_id = $1 AND senior_id = $2`,
    [opp, senior],
  )
  expect(rows).toHaveLength(1)
  return String(rows[0].senior_profile_version)
}

async function live(): Promise<string> {
  const versions = await new JobQueueScopeService().liveVersions(STUDIO_SCOPE, db)
  const mine = versions.find((v) => v.seniorId === senior)
  if (mine === undefined) throw new Error('the senior is not in the live roster')
  return mine.profile
}

const setSkills = (skills: string[], technologies: string[]) =>
  q(
    `UPDATE senior_resumes
        SET content = jsonb_set(content, '{skills}', $2::jsonb),
            facts = jsonb_build_object('experience',
                      jsonb_build_array(jsonb_build_object('technologies', $3::jsonb)))
      WHERE user_id = $1`,
    [senior, JSON.stringify(skills), JSON.stringify(technologies)],
  )

describe.skipIf(!hasDatabaseUrl())('roster roles and resume skills: stamp == live', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 2 })
    const probe = await q(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
    const u = await q(
      `INSERT INTO users (email, display_name, role, technical_roles)
       VALUES ($1, 'roster roles senior', 'SENIOR', ARRAY['BACKEND_ENGINEER']) RETURNING id`,
      [`roster-roles-${TAG}@example.test`],
    )
    senior = u.rows[0].id as string
    const t = await q(`INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id`, [
      `roster-roles-${TAG}`,
    ])
    team = t.rows[0].id as string
    await q(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [team, senior])
    const o = await q(
      `INSERT INTO job_opportunities (title, title_key, revision) VALUES ($1, $1, 1) RETURNING id`,
      [`roster-roles-${TAG}`],
    )
    opp = o.rows[0].id as string
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      await q(`DELETE FROM job_opportunities WHERE id = $1`, [opp])
      await q(`DELETE FROM team_members WHERE team_id = $1`, [team])
      await q(`DELETE FROM teams WHERE id = $1`, [team])
      await q(`DELETE FROM users WHERE id = $1`, [senior])
    } finally {
      await session.close()
    }
  })

  it('without a resume row the senior loads with skills null, and the stamp is the live version', async () => {
    const roster = await loadRoster(db)
    expect(roster.profiles.find((p) => p.seniorId === senior)).toEqual({
      seniorId: senior,
      teamIds: [team],
      roles: ['BACKEND_ENGINEER'],
      skills: null,
    })
    await recompute()
    expect(await stamped()).toBe(await live())
  })

  it('queue liveVersions equals the stamped senior_profile_version after a recompute', async () => {
    await q(`INSERT INTO senior_resumes (user_id) VALUES ($1)`, [senior])
    await setSkills(['Go', 'PostgreSQL'], ['Kafka'])
    const before = await stamped()
    // The resume skills are new input: the old stamp is stale until the recompute.
    expect(await live()).not.toBe(before)
    await recompute()
    expect(await stamped()).toBe(await live())
    const profile = (await loadRoster(db)).profiles.find((p) => p.seniorId === senior)
    expect(profile?.skills).toEqual(['Go', 'Kafka', 'PostgreSQL'])
  })

  it('a reordered or re-spelled skill list keeps the stamp live; a roles change stales it', async () => {
    const current = await stamped()
    // Synonym spellings collapse to the canonical name (`Golang` -> `Go`, `postgres` -> `PostgreSQL`).
    await setSkills(['postgres', 'Golang'], ['Kafka'])
    expect(await live()).toBe(current)
    await q(`UPDATE users SET technical_roles = ARRAY['DATA_ENGINEER'] WHERE id = $1`, [senior])
    expect(await live()).not.toBe(current)
    await recompute()
    expect(await stamped()).toBe(await live())
  })
})
