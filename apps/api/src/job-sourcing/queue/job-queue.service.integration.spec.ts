import { createHash, randomUUID } from 'node:crypto'
import { ForbiddenException, HttpException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import {
  type JobQueueCardResponseDto,
  type JobQueueListQuery,
  jobQueueCardResponseSchema,
  jobQueueListQuerySchema,
  jobQueueListResponseSchema,
  type SessionUser,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../config/env'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { loadRoster, MATCH_RULE_VERSION, type SeniorVersions } from '../runtime/recompute-inputs'
import { JobQueueService } from './job-queue.service'
import { parseCursor, signCursor } from './queue-cursor'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * r5 Task 6.2 — list and card against a real Postgres, as the API role (`crm_app`). A mocked E2E
 * cannot prove a backend scope. FOREIGN ROWS ARE THE POINT: team B's matches, submissions,
 * dismissals, clicks and a much higher score sit on the same opportunities team A reads, and each
 * case asserts they are absent from the RAW JSON, counts included, not merely unparsed.
 *
 * STUDIO cases stay on one page, filtered by this run's TAG: a STUDIO generation spans the database.
 */
const TAG = `qsvc${randomUUID().slice(0, 8)}`
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
async function mkTeam(key: string) {
  const { rows } = await sqlq(`INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id`, [
    `${TAG}-${key}`,
  ])
  ids[key] = rows[0].id as string
}
const join = (team: string, member: string) =>
  sqlq(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [id(team), id(member)])

interface OppOpts {
  revision?: number
  firstSeen?: string
  employerKey?: string
  description?: string
}
async function mkOpp(key: string, o: OppOpts = {}) {
  let sha: string | null = null
  if (o.description !== undefined) {
    sha = createHash('sha256').update(o.description).digest('hex')
    await sqlq(`INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2)`, [sha, o.description])
  }
  const { rows } = await sqlq(
    `INSERT INTO job_opportunities
       (title, title_key, revision, availability, first_seen_at, employer_name, employer_key, description_sha256)
     VALUES ($1, $2, $3, 'OPEN', COALESCE($4::timestamptz, now()), $5, $5, $6) RETURNING id`,
    [
      `${TAG} ${key}`,
      o.employerKey === undefined ? `${TAG}-${key}` : `${TAG}-dup`,
      o.revision ?? 1,
      o.firstSeen ?? null,
      o.employerKey ?? null,
      sha,
    ],
  )
  ids[key] = rows[0].id as string
  await link(key)
}
async function link(opp: string, linkedAt?: string): Promise<string> {
  seq += 1
  const { rows } = await sqlq(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3) RETURNING id`,
    [`${TAG}-ns`, `${TAG}-k${seq}`, `https://jobs.example.test/${TAG}/${seq}`],
  )
  const record = rows[0].id as string
  await sqlq(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version, linked_at)
     VALUES ($1, $2, 'r1', COALESCE($3::timestamptz, now()))`,
    [record, id(opp), linkedAt ?? null],
  )
  return record
}
/** A live match row: what the recompute worker would stamp for this senior right now. */
function match(opp: string, senior: string, outcome: string, evidence: Record<string, unknown>) {
  const v = live.get(id(senior)) as SeniorVersions
  return sqlq(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
        exclusion_version, rule_version, outcome, evidence)
     SELECT $1::uuid, $2::uuid, o.revision, $3::text, $4::text, $5::text,
            $6::job_opportunity_match_outcome, $7::jsonb
       FROM job_opportunities o WHERE o.id = $1::uuid`,
    [
      id(opp),
      id(senior),
      v.profile,
      v.exclusion,
      MATCH_RULE_VERSION,
      outcome,
      JSON.stringify(evidence),
    ],
  )
}
const lead = (opp: string, senior: string, score = 50, keyword = 'Go') =>
  match(opp, senior, 'LEAD', {
    score,
    reasons: [{ code: 'TECH_MATCH', evidence: [`${keyword}:CORE`], ruleVersion: 'r' }],
    rankWarnings: [],
  })
const stopListed = (opp: string, senior: string) =>
  match(opp, senior, 'EXCLUDED', {
    stage: 'SCOPED_RESTRICTIONS',
    reasons: [{ code: 'SENIOR_EXCLUSION', evidence: ['x'], ruleVersion: 'r' }],
  })
/**
 * THE ONE HELPER FOR THE EVALUATED STATE. An owner decision may add a column to this area: only this
 * helper would change, and the service reads the state through the predicates in `queue-scope.ts`.
 */
const evaluated = (opp: string, verdict: 'OPEN' | 'EXCLUDED') =>
  sqlq(
    `UPDATE job_opportunities SET evaluated_revision = revision, evaluation_verdict = $2 WHERE id = $1`,
    [id(opp), verdict],
  )
const grant = (opp: string, team: string) =>
  sqlq(
    `INSERT INTO job_opportunity_team_triage
       (opportunity_id, team_id, assigned_by, policy_version, opportunity_revision, expires_at)
     VALUES ($1, $2, $3, 1, 1, now() + interval '1 day')`,
    [id(opp), id(team), id('admin')],
  )
async function submit(opp: string, senior: string, team: string, by: string): Promise<string> {
  const { rows } = await sqlq(
    `INSERT INTO job_queue_assignments (senior_id, opportunity_id, scope_kind, team_id, assignee_id)
     VALUES ($1, $2, 'TEAM', $3, $4) RETURNING id`,
    [id(senior), id(opp), id(team), id(by)],
  )
  return rows[0].id as string
}
const dismiss = (opp: string, team: string, by: string) =>
  sqlq(
    `INSERT INTO job_queue_dismissals (opportunity_id, scope_kind, team_id, reason, dismissed_by)
     VALUES ($1, 'TEAM', $2, 'not ours', $3)`,
    [id(opp), id(team), id(by)],
  )
async function opened(opp: string, team: string, by: string) {
  const { rows } = await sqlq(
    `SELECT source_record_id FROM job_opportunity_sources WHERE opportunity_id = $1 LIMIT 1`,
    [id(opp)],
  )
  await sqlq(
    `INSERT INTO job_queue_actions
       (kind, opportunity_id, source_record_id, actor_id, scope_kind, team_id, idempotency_key)
     VALUES ('OPENED', $1, $2, $3, 'TEAM', $4, $5)`,
    [id(opp), rows[0].source_record_id, id(by), id(team), randomUUID()],
  )
}

/** The published generation row of a team, as a fact in the database. */
const publishedOf = async (team: string) =>
  (
    await sqlq(`SELECT id FROM job_queue_generations WHERE team_id = $1 AND status = 'PUBLISHED'`, [
      id(team),
    ])
  ).rows.map((r: { id: string }) => r.id)
const expireGeneration = (team: string) =>
  sqlq(
    `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
      WHERE team_id = $1 AND status = 'PUBLISHED'`,
    [id(team)],
  )

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  const e: unknown = await p.then(
    () => new Error('expected a refusal'),
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpException)
  const http = e as HttpException
  return { status: http.getStatus(), code: (http.getResponse() as { code: string }).code }
}
const NOT_FOUND = { status: 404, code: 'JOB_OPPORTUNITY_NOT_FOUND' }
const MALFORMED = { status: 400, code: 'JOB_QUEUE_CURSOR_MALFORMED' }
const REFRESH = { status: 409, code: 'JOB_QUEUE_REFRESH_REQUIRED' }

const hrA = () => asUser('hrA', 'HR')
const hrB = () => asUser('hrB', 'HR')
const admin = () => asUser('admin', 'ADMIN')
const itemOf = async (user: SessionUser, opp: string, over: Record<string, unknown> = {}) => {
  const res = await service.list(user, q({ tab: 'NEW', ...over }))
  return res.items.find((i) => i.opportunityId === id(opp))
}
const seniorOn = (card: JobQueueCardResponseDto, senior: string) =>
  card.seniors.items.find((s) => s.seniorId === id(senior))

describe.skipIf(!hasDatabaseUrl())('JobQueueService against Postgres (Task 6.2)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const probe = await sqlq(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    const scopes = new JobQueueScopeService(session.databaseService)
    service = new JobQueueService(session.databaseService, scopes, config)

    await mkUser('admin', 'ADMIN')
    for (const hr of ['hrA', 'hrA2', 'hrB', 'hrNone', 'hrBig']) await mkUser(hr, 'HR')
    for (const s of ['senA', 'senB', 'senShared']) await mkUser(s, 'SENIOR')
    await mkUser('junA', 'JUNIOR')
    for (const t of ['teamA', 'teamB', 'teamBig']) await mkTeam(t)
    for (const m of ['hrA', 'hrA2', 'senA', 'senShared', 'junA']) await join('teamA', m)
    for (const m of ['hrB', 'senB', 'senShared']) await join('teamB', m)
    await join('teamBig', 'hrBig')
    // 205 seniors in one team, for the 200 preview.
    await sqlq(
      `WITH made AS (
         INSERT INTO users (email, display_name, role, tech_stack)
         SELECT $1 || '-big' || g || '@example.test', $1 || ' big ' || g, 'SENIOR', ARRAY['Go']
           FROM generate_series(1, 205) g RETURNING id)
       INSERT INTO team_members (team_id, user_id) SELECT $2::uuid, id FROM made`,
      [TAG, id('teamBig')],
    )
    live = (await loadRoster(session.databaseService.db)).versions

    await mkOpp('oppShared', { description: `${TAG} secret body` })
    await link('oppShared', '2000-01-01T00:00:00Z')
    await lead('oppShared', 'senA', 50, 'KeywordA')
    await lead('oppShared', 'senB', 900, 'KeywordForeign')
    await lead('oppShared', 'senShared', 40, 'KeywordShared')

    await mkOpp('oppForeign')
    await lead('oppForeign', 'senB')

    await mkOpp('oppGrant')
    await grant('oppGrant', 'teamA')
    await evaluated('oppGrant', 'OPEN')

    await mkOpp('oppExcluded')
    await evaluated('oppExcluded', 'EXCLUDED')
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      // The only way to clean an append-only table is to be its owner, as the 1.3b spec does.
      await sqlq(`ALTER TABLE job_queue_actions DISABLE TRIGGER trg_job_queue_actions_append_only`)
      const users = `SELECT id FROM users WHERE email LIKE $1`
      await sqlq(`DELETE FROM job_queue_actions WHERE actor_id IN (${users})`, [`${TAG}%`])
      await sqlq(
        `ALTER TABLE job_queue_actions ENABLE ALWAYS TRIGGER trg_job_queue_actions_append_only`,
      )
      const teams = `SELECT id FROM teams WHERE name LIKE $1`
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE status <> 'INVALIDATED' AND team_id IN (${teams})`,
        [`${TAG}%`],
      )
      await sqlq(`DELETE FROM job_queue_generations WHERE team_id IN (${teams})`, [`${TAG}%`])
      // Files run one at a time, and only one STUDIO generation may be PUBLISHED in the database:
      // the schema spec publishes its own, so this run must not leave one behind.
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE scope_kind = 'STUDIO' AND status = 'PUBLISHED'`,
      )
      await sqlq(
        `DELETE FROM job_queue_generations WHERE scope_kind = 'STUDIO' AND status = 'INVALIDATED'`,
      )
      const opps = `SELECT id FROM job_opportunities WHERE title LIKE $1`
      await sqlq(`DELETE FROM job_queue_assignments WHERE opportunity_id IN (${opps})`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_opportunity_sources WHERE opportunity_id IN (${opps})`, [
        `${TAG}%`,
      ])
      await sqlq(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_source_records WHERE namespace = $1`, [`${TAG}-ns`])
      await sqlq(`DELETE FROM job_text_blobs WHERE text LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM team_members WHERE team_id IN (${teams})`, [`${TAG}%`])
      await sqlq(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    } finally {
      await session.close()
    }
  })

  describe('role and scope', () => {
    it('roles outside the queue are a 403, not an empty list', async () => {
      await expect(service.list(asUser('junA', 'JUNIOR'), q())).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      await expect(service.card(asUser('senA', 'SENIOR'), id('oppShared'))).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    it('an HR with no team: empty list and counts, the same 404 on a card', async () => {
      const none = asUser('hrNone', 'HR')
      await expect(service.list(none, q())).resolves.toEqual({
        items: [],
        nextCursor: null,
        counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
      })
      expect(await refusal(service.card(none, id('oppShared')))).toEqual(NOT_FOUND)
    })

    it('an HR naming a foreign team is the NONE scope: empty, no fallback', async () => {
      const res = await service.list(hrA(), q({ teamId: id('teamB') }))
      expect(res.items).toEqual([])
      expect(res.counts).toEqual({ NEW: 0, SUBMITTED: 0, HIDDEN: 0 })
    })

    it('a foreign opportunity is the same 404 as a missing or malformed one', async () => {
      for (const missing of [id('oppForeign'), randomUUID(), 'not-an-id']) {
        expect(await refusal(service.card(hrA(), missing))).toEqual(NOT_FOUND)
        expect(await refusal(service.sources(hrA(), missing, {}))).toEqual(NOT_FOUND)
        expect(await refusal(service.seniors(hrA(), missing, {}))).toEqual(NOT_FOUND)
      }
    })

    it('team A lists its LEAD and its grant, never the foreign row, in the raw JSON too', async () => {
      const res = await service.list(hrA(), q())
      expect(jobQueueListResponseSchema.safeParse(res).success).toBe(true)
      const listed = res.items.map((i) => i.opportunityId)
      expect(listed).toEqual(expect.arrayContaining([id('oppShared'), id('oppGrant')]))
      const raw = JSON.stringify(res)
      expect(raw).not.toContain(id('oppForeign'))
      expect(raw).not.toContain(id('senB'))
      expect(raw).not.toContain('name senB')
      expect(raw).not.toContain('KeywordForeign')
    })

    it('eligibility: a live LEAD is LEAD, a grant alone is TRIAGE', async () => {
      expect((await itemOf(hrA(), 'oppShared'))?.eligibility).toBe('LEAD')
      expect((await itemOf(hrA(), 'oppGrant'))?.eligibility).toBe('TRIAGE')
    })

    it('STUDIO: an ADMIN spans teams, EXCLUDED is not listed but opens by id', async () => {
      const res = await service.list(admin(), q())
      const listed = res.items.map((i) => i.opportunityId)
      expect(listed).toEqual(expect.arrayContaining([id('oppShared'), id('oppForeign')]))
      expect(listed).not.toContain(id('oppExcluded'))
      expect((await service.card(admin(), id('oppExcluded'))).opportunityId).toBe(id('oppExcluded'))
    })

    it('an ADMIN naming a team reads as that team, not as the studio', async () => {
      const res = await service.list(admin(), q({ teamId: id('teamA') }))
      expect(res.items.map((i) => i.opportunityId)).not.toContain(id('oppForeign'))
      const item = res.items.find((i) => i.opportunityId === id('oppShared'))
      expect(item?.matchedSeniorCount).toBe(2)
    })
  })

  describe('card-field authorization: a visible row does not license every field', () => {
    it('matched count: own seniors only, ADMIN studio-wide', async () => {
      expect((await itemOf(hrA(), 'oppShared'))?.matchedSeniorCount).toBe(2)
      expect((await itemOf(admin(), 'oppShared'))?.matchedSeniorCount).toBe(3)
    })

    it('foreign submission, dismissal and click on a shared row: as if none, in counts too', async () => {
      await mkOpp('oppWorked')
      await lead('oppWorked', 'senA')
      await lead('oppWorked', 'senB')
      await expireGeneration('teamA')
      const before = await service.list(hrA(), q())
      const baseline = before.items.find((i) => i.opportunityId === id('oppWorked'))

      await submit('oppWorked', 'senB', 'teamB', 'hrB')
      await dismiss('oppWorked', 'teamB', 'hrB')
      await opened('oppWorked', 'teamB', 'hrB')

      const after = await service.list(hrA(), q())
      expect(after.counts).toEqual(before.counts)
      expect(after.items.find((i) => i.opportunityId === id('oppWorked'))).toEqual(baseline)
      const card = await service.card(hrA(), id('oppWorked'))
      expect(card).toMatchObject({ submittedSeniorCount: 0, openedByTeam: false, hidden: false })

      // The other side sees its own activity, so the assertion above is not vacuous.
      expect((await service.list(hrB(), q({ tab: 'HIDDEN' }))).counts.HIDDEN).toBeGreaterThan(0)
      const own = await service.card(hrB(), id('oppWorked'))
      expect(own).toMatchObject({ submittedSeniorCount: 1, openedByTeam: true, hidden: true })
    })

    it('stop-list: HR gets a count of their own seniors, and never who', async () => {
      await mkOpp('oppStop')
      await lead('oppStop', 'senA')
      await stopListed('oppStop', 'senShared')
      await stopListed('oppStop', 'senB')
      await expireGeneration('teamA')
      expect((await itemOf(hrA(), 'oppStop'))?.stopListedSeniorCount).toBe(1)
      const card = await service.card(hrA(), id('oppStop'))
      expect(card.stopListedSeniorCount).toBe(1)
      expect(card.seniors.items.map((s) => s.seniorId)).toEqual([id('senA')])
      expect(JSON.stringify(card)).not.toContain(id('senShared'))
    })

    it('filtering by a senior: a stop-listed row goes (owner: intended), a foreign senior is empty', async () => {
      const mine = await service.list(hrA(), q({ seniorId: id('senShared') }))
      const listed = mine.items.map((i) => i.opportunityId)
      expect(listed).toContain(id('oppShared'))
      expect(listed).not.toContain(id('oppStop'))
      const foreign = await service.list(hrA(), q({ seniorId: id('senB') }))
      expect(foreign.items).toEqual([])
      expect(foreign.counts).toEqual(mine.counts)
    })

    it('card keywords and names: the own seniors only', async () => {
      const card = await service.card(hrA(), id('oppShared'))
      expect(jobQueueCardResponseSchema.safeParse(card).success).toBe(true)
      expect(card.seniors.totalCount).toBe(2)
      expect(seniorOn(card, 'senA')?.matchedKeywords).toEqual(['KeywordA'])
      const raw = JSON.stringify(card)
      expect(raw).not.toContain('KeywordForeign')
      expect(raw).not.toContain('name senB')
      expect(raw).not.toContain(id('senB'))
    })

    it('the rank: a foreign senior score cannot move a row in this team', async () => {
      await mkOpp('oppRankLow', { firstSeen: '2020-01-02T00:00:00Z' })
      await lead('oppRankLow', 'senA', 10)
      await lead('oppRankLow', 'senB', 999)
      await mkOpp('oppRankHigh', { firstSeen: '2020-01-01T00:00:00Z' })
      await lead('oppRankHigh', 'senA', 20)
      await expireGeneration('teamA')
      const order = (await service.list(hrA(), q())).items.map((i) => i.opportunityId)
      expect(order.indexOf(id('oppRankHigh'))).toBeLessThan(order.indexOf(id('oppRankLow')))
    })

    it('duplicates: a foreign copy is absent from the items and from the total', async () => {
      await mkOpp('dupVisible', { employerKey: `${TAG}-co` })
      await lead('dupVisible', 'senA')
      await mkOpp('dupOwn', { employerKey: `${TAG}-co` })
      await lead('dupOwn', 'senA')
      await mkOpp('dupForeign', { employerKey: `${TAG}-co` })
      await lead('dupForeign', 'senB')
      const card = await service.card(hrA(), id('dupVisible'))
      expect(card.possibleDuplicates?.totalCount).toBe(1)
      expect(card.possibleDuplicates?.items.map((d) => d.opportunityId)).toEqual([id('dupOwn')])
      expect(JSON.stringify(card)).not.toContain(id('dupForeign'))
      expect((await service.card(admin(), id('dupVisible'))).possibleDuplicates?.totalCount).toBe(2)
      expect((await service.card(hrA(), id('oppGrant'))).possibleDuplicates).toBeNull()
    })
  })

  describe('owner A3 (a): a senior shared by two teams', () => {
    let foreignSubmission = ''
    beforeAll(async () => {
      await mkOpp('oppA3')
      await lead('oppA3', 'senShared')
      await lead('oppA3', 'senA')
      foreignSubmission = await submit('oppA3', 'senShared', 'teamB', 'hrB')
    })

    it('a foreign LIVE submission is the bare marker, and nothing of the row is in the JSON', async () => {
      const card = await service.card(hrA(), id('oppA3'))
      expect(seniorOn(card, 'senShared')?.submission).toEqual({ submittedElsewhere: true })
      expect(card.submittedSeniorCount).toBe(0)
      const raw = JSON.stringify(card)
      expect(raw).not.toContain(foreignSubmission)
      expect(raw).not.toContain('name hrB')
      expect(raw).not.toContain(id('teamB'))
      expect(raw).not.toContain(id('hrB'))
      expect(raw).not.toContain('"version"')
      expect(raw).not.toContain('submittedAt')
      expect(raw).not.toContain('cancelledAt')
    })

    it('the team that made it sees the row in full, with the recruiter name', async () => {
      const card = await service.card(hrB(), id('oppA3'))
      expect(seniorOn(card, 'senShared')?.submission).toMatchObject({
        id: foreignSubmission,
        state: 'TAKEN',
        version: 1,
        cancelledAt: null,
        submittedByName: `${TAG} name hrB`,
      })
    })

    it('a cancelled foreign submission is indistinguishable from none', async () => {
      await sqlq(
        `UPDATE job_queue_assignments
            SET state = 'RELEASED', released_at = now(), released_by = $2, version = version + 1
          WHERE id = $1`,
        [foreignSubmission, id('hrB')],
      )
      const card = await service.card(hrA(), id('oppA3'))
      expect(seniorOn(card, 'senShared')?.submission).toBeNull()
      expect(seniorOn(card, 'senA')?.submission).toBeNull()
      expect(JSON.stringify(card)).not.toContain('submittedElsewhere')
      // The own team keeps the fact: a recorded cancellation, not an erasure.
      const own = await service.card(hrB(), id('oppA3'))
      expect(seniorOn(own, 'senShared')?.submission).toMatchObject({
        state: 'RELEASED',
        version: 2,
      })
    })

    it('an own submission shows in the own tab and counts, in full', async () => {
      await mkOpp('oppMine')
      await lead('oppMine', 'senA')
      await expireGeneration('teamA')
      const before = await service.list(hrA(), q())
      const submission = await submit('oppMine', 'senA', 'teamA', 'hrA')
      const after = await service.list(hrA(), q({ tab: 'SUBMITTED' }))
      expect(after.counts.SUBMITTED).toBe(before.counts.SUBMITTED + 1)
      expect(after.counts.NEW).toBe(before.counts.NEW - 1)
      expect(after.items.map((i) => i.opportunityId)).toContain(id('oppMine'))
      const card = await service.card(hrA(), id('oppMine'))
      expect(seniorOn(card, 'senA')?.submission).toMatchObject({
        id: submission,
        submittedByName: `${TAG} name hrA`,
      })
    })
  })

  describe('the generation', () => {
    it('a list request publishes one, the next serves the same one', async () => {
      await expireGeneration('teamB')
      await service.list(hrB(), q())
      const first = await publishedOf('teamB')
      expect(first).toHaveLength(1)
      await service.list(hrB(), q({ search: 'something else' }))
      expect(await publishedOf('teamB')).toEqual(first)
    })

    it('concurrent first requests coalesce into one generation, with its superseded row purged', async () => {
      await expireGeneration('teamB')
      await Promise.all([
        service.list(hrB(), q()),
        service.list(hrB(), q()),
        service.list(hrB(), q()),
      ])
      const { rows } = await sqlq(`SELECT status FROM job_queue_generations WHERE team_id = $1`, [
        id('teamB'),
      ])
      expect(rows).toEqual([{ status: 'PUBLISHED' }])
    })

    it('a generation carries integer rank, its rule, and the evaluated revision', async () => {
      await expireGeneration('teamA')
      await service.list(hrA(), q())
      const [generation] = await publishedOf('teamA')
      const { rows } = await sqlq(
        `SELECT g.rule_version, e.rank_score, e.opportunity_revision
           FROM job_queue_generations g JOIN job_queue_generation_entries e ON e.generation_id = g.id
          WHERE g.id = $1 AND e.opportunity_id = $2`,
        [generation, id('oppShared')],
      )
      // The best own score, 50, plus one match weight for the second own senior.
      expect(rows).toEqual([
        { rule_version: MATCH_RULE_VERSION, rank_score: 60, opportunity_revision: 1 },
      ])
    })

    it('an addition waits for a new generation; a removal shows at once, in counts too', async () => {
      await expireGeneration('teamA')
      const before = await service.list(hrA(), q())
      await mkOpp('oppLate')
      await lead('oppLate', 'senA')
      const stillBefore = await service.list(hrA(), q())
      expect(stillBefore.items.map((i) => i.opportunityId)).not.toContain(id('oppLate'))
      expect(stillBefore.counts).toEqual(before.counts)

      await sqlq(
        `UPDATE job_opportunity_team_triage SET revoked_at = now() WHERE opportunity_id = $1`,
        [id('oppGrant')],
      )
      const revoked = await service.list(hrA(), q())
      expect(revoked.items.map((i) => i.opportunityId)).not.toContain(id('oppGrant'))
      expect(revoked.counts.NEW).toBe(before.counts.NEW - 1)
      await sqlq(
        `UPDATE job_opportunity_team_triage SET revoked_at = NULL WHERE opportunity_id = $1`,
        [id('oppGrant')],
      )

      await expireGeneration('teamA')
      expect((await service.list(hrA(), q())).items.map((i) => i.opportunityId)).toContain(
        id('oppLate'),
      )
    })

    it('an expired head is never served: the first page republishes, a cursor must refresh', async () => {
      const paged = await service.list(hrA(), q({ limit: 1 }))
      expect(paged.nextCursor).not.toBeNull()
      const [old] = await publishedOf('teamA')
      // `expires_at` is frozen by the Task 1.3 trigger, so the clock moves instead of the row.
      vi.useFakeTimers({ now: Date.now() + 16 * 60 * 1000, toFake: ['Date'] })
      try {
        expect(
          await refusal(service.list(hrA(), q({ limit: 1, cursor: paged.nextCursor }))),
        ).toEqual(REFRESH)
        await service.list(hrA(), q())
      } finally {
        vi.useRealTimers()
      }
      const [fresh] = await publishedOf('teamA')
      expect(fresh).toBeDefined()
      expect(fresh).not.toBe(old)
    })
  })

  describe('paging', () => {
    const walk = async (user: SessionUser, over: Record<string, unknown>) => {
      const seen: string[] = []
      let cursor: string | null | undefined
      do {
        const page = await service.list(
          user,
          q({ ...over, limit: 2, ...(cursor ? { cursor } : {}) }),
        )
        seen.push(...page.items.map((i) => i.opportunityId))
        cursor = page.nextCursor
      } while (cursor)
      return seen
    }

    it('ties walk once each, ordered by first seen then id, both descending', async () => {
      const when = '2021-05-05T00:00:00Z'
      for (const k of ['tie1', 'tie2', 'tie3', 'tie4', 'tie5']) {
        await mkOpp(k, { firstSeen: when })
        await lead(k, 'senA', 33)
      }
      await expireGeneration('teamA')
      const seen = await walk(hrA(), { search: `${TAG} tie` })
      const expected = ['tie1', 'tie2', 'tie3', 'tie4', 'tie5'].map(id).sort().reverse()
      expect(seen).toEqual(expected)
    })

    it('a rank or source change between pages neither moves nor repeats a row', async () => {
      await expireGeneration('teamA')
      const first = await service.list(hrA(), q({ search: `${TAG} tie`, limit: 2 }))
      const [a, b] = first.items.map((i) => i.opportunityId)
      const later = (first.items[0] as { opportunityId: string }).opportunityId
      // Would jump to the top of a fresh order; this generation must not care.
      await sqlq(
        `UPDATE job_opportunity_matches SET evidence = jsonb_set(evidence, '{score}', '999') WHERE opportunity_id = ANY($1::uuid[])`,
        [[ids['tie1'], ids['tie2'], ids['tie3'], ids['tie4'], ids['tie5']]],
      )
      const added = Object.keys(ids).find((k) => ids[k] === later) as string
      await link(added)
      const second = await service.list(
        hrA(),
        q({ search: `${TAG} tie`, limit: 2, cursor: first.nextCursor }),
      )
      expect(second.items.map((i) => i.opportunityId)).not.toEqual(expect.arrayContaining([a, b]))
      expect(second.items).toHaveLength(2)
    })

    it('a revocation before LIMIT: the page still fills from what is left', async () => {
      await expireGeneration('teamA')
      const first = await service.list(hrA(), q({ search: `${TAG} tie`, limit: 1 }))
      const { rows } = await sqlq(
        `SELECT opportunity_id FROM job_queue_generation_entries e
           JOIN job_queue_generations g ON g.id = e.generation_id
          WHERE g.team_id = $1 AND g.status = 'PUBLISHED' AND e.opportunity_id = ANY($2::uuid[])
          ORDER BY e.order_key`,
        [id('teamA'), [ids['tie1'], ids['tie2'], ids['tie3'], ids['tie4'], ids['tie5']]],
      )
      const nextUp = rows[1].opportunity_id as string
      await sqlq(
        `UPDATE job_opportunity_matches SET outcome = 'EXCLUDED' WHERE opportunity_id = $1`,
        [nextUp],
      )
      const second = await service.list(
        hrA(),
        q({ search: `${TAG} tie`, limit: 1, cursor: first.nextCursor }),
      )
      expect(second.items).toHaveLength(1)
      expect(second.items[0]?.opportunityId).toBe(rows[2].opportunity_id)
      await sqlq(`UPDATE job_opportunity_matches SET outcome = 'LEAD' WHERE opportunity_id = $1`, [
        nextUp,
      ])
    })

    it('cursor misuse: another filter, actor or team grants nothing; a forgery is a 400', async () => {
      const page = await service.list(hrA(), q({ limit: 1 }))
      const cursor = page.nextCursor as string
      expect(await refusal(service.list(hrA(), q({ limit: 1, cursor, tab: 'HIDDEN' })))).toEqual(
        REFRESH,
      )
      expect(await refusal(service.list(asUser('hrA2', 'HR'), q({ limit: 1, cursor })))).toEqual(
        REFRESH,
      )
      expect(await refusal(service.list(hrB(), q({ limit: 1, cursor })))).toEqual(REFRESH)
      expect(await refusal(service.list(admin(), q({ limit: 1, cursor })))).toEqual(REFRESH)
      expect(
        await refusal(service.list(hrA(), q({ limit: 1, cursor: `${cursor.slice(0, -2)}xx` }))),
      ).toEqual(MALFORMED)
    })

    it('a signed cursor aimed at a foreign generation is still refused by the generation check', async () => {
      await service.list(hrB(), q())
      const [foreign] = await publishedOf('teamB')
      const page = await service.list(hrA(), q({ limit: 1 }))
      const mine = parseCursor(page.nextCursor as string, 'L', SECRET)
      const cursor = signCursor({ ...mine, g: foreign as string }, SECRET)
      expect(await refusal(service.list(hrA(), q({ limit: 1, cursor })))).toEqual(REFRESH)
    })

    it('a roster change between pages must refresh, and the fresh walk reflects it', async () => {
      const page = await service.list(hrA(), q({ limit: 1 }))
      await mkUser('senJoined', 'SENIOR')
      await join('teamA', 'senJoined')
      expect(await refusal(service.list(hrA(), q({ limit: 1, cursor: page.nextCursor })))).toEqual(
        REFRESH,
      )
      await expect(service.list(hrA(), q({ limit: 1 }))).resolves.toBeDefined()
      await sqlq(`UPDATE team_members SET left_at = now() WHERE user_id = $1`, [id('senJoined')])
    })

    it('an HR who left the team loses the rows at the next request, cursor or not', async () => {
      await mkUser('hrLeaver', 'HR')
      await join('teamA', 'hrLeaver')
      const leaver = asUser('hrLeaver', 'HR')
      const page = await service.list(leaver, q({ limit: 1 }))
      expect(page.items).toHaveLength(1)
      await sqlq(`UPDATE team_members SET left_at = now() WHERE user_id = $1`, [id('hrLeaver')])
      await expect(service.list(leaver, q({ limit: 1, cursor: page.nextCursor }))).resolves.toEqual(
        {
          items: [],
          nextCursor: null,
          counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
        },
      )
    })

    it('default 20: a list row never carries a description', async () => {
      const res = await service.list(hrA(), jobQueueListQuerySchema.parse({ search: TAG }))
      expect(res.items.length).toBeLessThanOrEqual(20)
      const raw = JSON.stringify(res)
      expect(raw).not.toContain('descriptionMd')
      expect(raw).not.toContain('secret body')
    })
  })

  describe('the card', () => {
    it('carries the description and the primary source chosen by first link', async () => {
      const card = await service.card(hrA(), id('oppShared'))
      expect(card.descriptionMd).toBe(`${TAG} secret body`)
      expect(card.alsoSeenOnCount).toBe(1)
      expect(card.sources.totalCount).toBe(2)
      const backdated = await sqlq(
        `SELECT source_record_id FROM job_opportunity_sources WHERE opportunity_id = $1 ORDER BY linked_at LIMIT 1`,
        [id('oppShared')],
      )
      expect(card.primarySource.sourceRecordId).toBe(backdated.rows[0].source_record_id)
    })

    it('an unlinked source leaves the count and the preview', async () => {
      await mkOpp('oppUnlink')
      await lead('oppUnlink', 'senA')
      const extra = await link('oppUnlink')
      await sqlq(
        `UPDATE job_opportunity_sources SET unlinked_at = now(), unlink_reason = 'test' WHERE source_record_id = $1`,
        [extra],
      )
      const card = await service.card(hrA(), id('oppUnlink'))
      expect(card.sources.totalCount).toBe(1)
      expect(card.alsoSeenOnCount).toBe(0)
      expect(JSON.stringify(card)).not.toContain(extra)
    })

    it('latest facts, and the newer-than-list warning after a revision bump', async () => {
      await mkOpp('oppMoved')
      await lead('oppMoved', 'senA')
      await expireGeneration('teamA')
      await service.list(hrA(), q())
      expect((await service.card(hrA(), id('oppMoved'))).newerThanList).toBe(false)
      await sqlq(`UPDATE job_opportunities SET revision = 2, title = $2 WHERE id = $1`, [
        id('oppMoved'),
        `${TAG} oppMoved renamed`,
      ])
      await sqlq(
        `UPDATE job_opportunity_matches SET opportunity_revision = 2 WHERE opportunity_id = $1`,
        [id('oppMoved')],
      )
      const card = await service.card(hrA(), id('oppMoved'))
      expect(card.title).toBe(`${TAG} oppMoved renamed`)
      expect(card.revision).toBe(2)
      expect(card.newerThanList).toBe(true)
    })

    it('over 200 seniors and over 20 sources: previews, totals and independent continuations', async () => {
      await mkOpp('oppBig')
      for (let i = 0; i < 24; i += 1) await link('oppBig')
      const { rows: seniors } = await sqlq(
        `SELECT u.id FROM users u JOIN team_members tm ON tm.user_id = u.id
          WHERE tm.team_id = $1 AND u.role = 'SENIOR' ORDER BY u.id`,
        [id('teamBig')],
      )
      expect(seniors).toHaveLength(205)
      for (const s of seniors as Array<{ id: string }>) {
        const v = live.get(s.id) as SeniorVersions
        await sqlq(
          `INSERT INTO job_opportunity_matches
             (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
              exclusion_version, rule_version, outcome, evidence)
           VALUES ($1, $2, 1, $3, $4, $5, 'LEAD', '{"score":1}')`,
          [id('oppBig'), s.id, v.profile, v.exclusion, MATCH_RULE_VERSION],
        )
      }
      const big = asUser('hrBig', 'HR')
      const card = await service.card(big, id('oppBig'))
      expect(card.seniors.items).toHaveLength(200)
      expect(card.seniors.totalCount).toBe(205)
      expect(card.sources.items).toHaveLength(20)
      expect(card.sources.totalCount).toBe(25)
      expect(card.alsoSeenOnCount).toBe(24)

      const moreSeniors = await service.seniors(big, id('oppBig'), {
        cursor: card.seniors.nextCursor as string,
      })
      expect(moreSeniors.items).toHaveLength(5)
      expect(moreSeniors.totalCount).toBe(205)
      expect(moreSeniors.nextCursor).toBeNull()
      expect(
        new Set([...card.seniors.items, ...moreSeniors.items].map((s) => s.seniorId)).size,
      ).toBe(205)

      const moreSources = await service.sources(big, id('oppBig'), {
        cursor: card.sources.nextCursor as string,
      })
      expect(moreSources.items).toHaveLength(5)
      expect(moreSources.totalCount).toBe(25)
      expect(
        new Set([...card.sources.items, ...moreSources.items].map((s) => s.sourceRecordId)).size,
      ).toBe(25)

      // A continuation cursor is this actor's on this opportunity, of this kind.
      const cursor = card.sources.nextCursor as string
      expect(await refusal(service.seniors(big, id('oppBig'), { cursor }))).toEqual(MALFORMED)
      expect(await refusal(service.sources(admin(), id('oppBig'), { cursor }))).toEqual(REFRESH)
      expect(await refusal(service.sources(big, id('oppBig'), { cursor: 'forged' }))).toEqual(
        MALFORMED,
      )
    })
  })

  describe('query plan (MP-13, small-scale)', () => {
    it('a page over 3000 entries is index-driven and within budget', async () => {
      await sqlq(
        `WITH made AS (
           INSERT INTO job_opportunities (title, title_key)
           SELECT $1 || ' bulk ' || g, $1 || '-bulk-' || g FROM generate_series(1, 3000) g RETURNING id)
         INSERT INTO job_opportunity_matches
           (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
            exclusion_version, rule_version, outcome, evidence)
         SELECT id, $2::uuid, 1, $3, $4, $5, 'LEAD', '{"score":1}' FROM made`,
        [
          TAG,
          id('senA'),
          (live.get(id('senA')) as SeniorVersions).profile,
          (live.get(id('senA')) as SeniorVersions).exclusion,
          MATCH_RULE_VERSION,
        ],
      )
      await sqlq(
        `WITH r AS (
           INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url)
           SELECT 'GREENHOUSE_ATS', $1 || '-ns', 'NATIVE_ID', $1 || '-b-' || o.id, 'https://jobs.example.test/' || o.id
             FROM job_opportunities o WHERE o.title LIKE $1 || ' bulk %' RETURNING id, identity_key)
         INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
         SELECT r.id, substring(r.identity_key from length($1) + 4)::uuid, 'r1' FROM r`,
        [TAG],
      )
      await expireGeneration('teamA')
      await service.list(hrA(), q({ search: 'first publication' }))
      await sqlq(`ANALYZE job_queue_generation_entries`)

      const execute = vi.spyOn(session.databaseService.db, 'execute')
      const started = Date.now()
      const page = await service.list(hrA(), q({ search: `${TAG} bulk`, limit: 20 }))
      const elapsed = Date.now() - started
      const statements = execute.mock.calls.map((c) => c[0])
      execute.mockRestore()

      expect(page.items).toHaveLength(20)
      expect(elapsed).toBeLessThan(5000)
      const pageStatement = statements[statements.length - 1] as Parameters<
        typeof session.databaseService.db.execute
      >[0]
      const plan = await session.databaseService.db.execute(sql`EXPLAIN ${pageStatement}`)
      const text = plan.rows.map((r) => String(r['QUERY PLAN'])).join('\n')
      expect(text).not.toContain('Seq Scan on job_queue_generation_entries')
    })
  })
})
