import { randomUUID } from 'node:crypto'
import type { ConfigService } from '@nestjs/config'
import { type JobQueueListQuery, jobQueueListQuerySchema, type SessionUser } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Env } from '../../config/env'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { loadRoster, MATCH_RULE_VERSION, type SeniorVersions } from '../runtime/recompute-inputs'
import { JobQueueService } from './job-queue.service'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * task-hr-queue-all-teams — the HR queue against a real Postgres, as the API role (`crm_app`).
 *
 * Step 1 (the "0 vacancies" report): a senior who joined a DROP-type team (`JOIN_DROP_TEAM`, Drop
 * role phase 1) is in the matching roster (`loadRoster` counts any active membership), so ADMIN's
 * STUDIO list filtered by that senior shows their LEAD; the HR of that same team must see it too.
 */
const TAG = `qhrt${randomUUID().slice(0, 8)}`
const SECRET = 'integration-secret-integration-secret'
const config = { get: () => SECRET } as unknown as ConfigService<Env, true>

const ids: Record<string, string> = {}
const id = (key: string) => ids[key] as string
const asUser = (key: string, role: SessionUser['role']): SessionUser =>
  ({ id: id(key), role, email: `${key}@example.test` }) as SessionUser
const q = (over: Record<string, unknown> = {}): JobQueueListQuery =>
  jobQueueListQuerySchema.parse({ search: TAG, limit: 50, ...over })

let session: CrmAppSession
let service: JobQueueService
let live: ReadonlyMap<string, SeniorVersions>
let seq = 0

const sqlq = (text: string, params: unknown[] = []) => session.admin.query(text, params)

async function mkUser(key: string, role: SessionUser['role']) {
  const { rows } = await sqlq(
    `INSERT INTO users (email, display_name, role, tech_stack) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${TAG}-${key}@example.test`, `${TAG} name ${key}`, role, ['Go']],
  )
  ids[key] = rows[0].id as string
}
async function mkTeam(key: string, type: 'SENIOR' | 'DROP' = 'SENIOR') {
  const { rows } = await sqlq(`INSERT INTO teams (name, type) VALUES ($1, $2) RETURNING id`, [
    `${TAG}-${key}`,
    type,
  ])
  ids[key] = rows[0].id as string
}
const join = (team: string, member: string) =>
  sqlq(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [id(team), id(member)])

async function mkOpp(key: string) {
  const { rows } = await sqlq(
    `INSERT INTO job_opportunities
       (title, title_key, revision, availability, first_seen_at, technical_roles, role_status)
     VALUES ($1, $2, 1, 'OPEN', now(), ARRAY['BACKEND_ENGINEER'], 'RULE') RETURNING id`,
    [`${TAG} ${key}`, `${TAG}-${key}`],
  )
  ids[key] = rows[0].id as string
  seq += 1
  const record = await sqlq(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3) RETURNING id`,
    [`${TAG}-ns`, `${TAG}-k${seq}`, `https://jobs.example.test/${TAG}/${seq}`],
  )
  await sqlq(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
     VALUES ($1, $2, 'r1')`,
    [record.rows[0].id, id(key)],
  )
}
/** A live LEAD: what the recompute worker would stamp for this senior right now. */
function lead(opp: string, senior: string, score = 50) {
  const v = live.get(id(senior)) as SeniorVersions
  return sqlq(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
        exclusion_version, rule_version, outcome, evidence)
     SELECT $1::uuid, $2::uuid, o.revision, $3, $4, $5, 'LEAD', $6::jsonb
       FROM job_opportunities o WHERE o.id = $1::uuid`,
    [
      id(opp),
      id(senior),
      v.profile,
      v.exclusion,
      MATCH_RULE_VERSION,
      JSON.stringify({
        score,
        reasons: [{ code: 'TECH_MATCH', evidence: ['Go:CORE'], ruleVersion: 'r' }],
        rankWarnings: [],
      }),
    ],
  )
}

const listed = async (user: SessionUser, over: Record<string, unknown> = {}) =>
  (await service.list(user, q({ tab: 'NEW', ...over }))).items.map((i) => i.opportunityId)

describe.skipIf(!hasDatabaseUrl())('HR job queue across teams (task-hr-queue-all-teams)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const probe = await sqlq(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    service = new JobQueueService(session.databaseService, new JobQueueScopeService(), config)

    await mkUser('admin', 'ADMIN')
    await mkUser('hrDrop', 'HR')
    await mkUser('drop', 'DROP')
    await mkUser('senDrop', 'SENIOR')
    // The drop-team shape `createDropTeam` + `addSeniorToDropTeam` build: drop, HR, one senior.
    await mkTeam('teamDrop', 'DROP')
    for (const m of ['drop', 'hrDrop', 'senDrop']) await join('teamDrop', m)
    live = (await loadRoster(session.databaseService.db)).versions

    await mkOpp('oppDrop')
    await lead('oppDrop', 'senDrop')
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      const teams = `SELECT id FROM teams WHERE name LIKE $1`
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE status <> 'INVALIDATED' AND team_id IN (${teams})`,
        [`${TAG}%`],
      )
      await sqlq(`DELETE FROM job_queue_generations WHERE team_id IN (${teams})`, [`${TAG}%`])
      // Only one STUDIO generation may be PUBLISHED in the database: leave none behind.
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE scope_kind = 'STUDIO' AND status = 'PUBLISHED'`,
      )
      await sqlq(
        `DELETE FROM job_queue_generations WHERE scope_kind = 'STUDIO' AND status = 'INVALIDATED'`,
      )
      const opps = `SELECT id FROM job_opportunities WHERE title LIKE $1`
      await sqlq(`DELETE FROM job_opportunity_sources WHERE opportunity_id IN (${opps})`, [
        `${TAG}%`,
      ])
      await sqlq(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_source_records WHERE namespace = $1`, [`${TAG}-ns`])
      await sqlq(`DELETE FROM team_members WHERE team_id IN (${teams})`, [`${TAG}%`])
      await sqlq(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    } finally {
      await session.close()
    }
  })

  describe('Step 1 — a drop-team senior', () => {
    it('ADMIN STUDIO filtered by the senior lists their LEAD (the owner’s control view)', async () => {
      expect(await listed(asUser('admin', 'ADMIN'), { seniorIds: id('senDrop') })).toContain(
        id('oppDrop'),
      )
    })

    it('the HR of the same team sees the same opportunity, named team or not', async () => {
      const hr = asUser('hrDrop', 'HR')
      expect(await listed(hr, { teamId: id('teamDrop') })).toContain(id('oppDrop'))
      expect(await listed(hr)).toContain(id('oppDrop'))
      await expect(service.card(hr, id('oppDrop'))).resolves.toMatchObject({
        opportunityId: id('oppDrop'),
      })
    })

    it('the HR’s senior picker offers the drop-team senior', async () => {
      const { items } = await service.seniorOptions(asUser('hrDrop', 'HR'), {})
      expect(items.map((i) => i.id)).toEqual([id('senDrop')])
    })
  })
})
