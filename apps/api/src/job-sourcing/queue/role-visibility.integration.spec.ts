import { randomUUID } from 'node:crypto'
import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import type { SessionUser } from '@crm/shared'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JwtAuthGuard } from '../../auth/jwt.guard'
import { RolesGuard } from '../../common/guards/roles.guard'
import type { Env } from '../../config/env'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { DatabaseService } from '../../database/database.service'
import * as schema from '../../database/schema'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ZodExceptionFilter } from '../../zod-exception.filter'
import { ROLE_CLASSIFIER_VERSION } from '../funnel/role-classifier'
import { AVAILABILITY_REASON_PREFIX, enqueueDirty } from '../ownership/dirty-work.store'
import { RecomputeWorker, createRecomputeSteps } from '../runtime/recompute-worker'
import { JobQueueController } from './job-queue.controller'
import { JobQueueService } from './job-queue.service'
import { JobQueueActionsService } from './queue-actions.service'
import { JobQueueRecomputeService } from './queue-recompute.service'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * Senior roles PR 4 Task 4.5 (correction 1): a vacancy without known IT roles reaches no read.
 * Real Postgres as `crm_app`, the real recompute worker (dirty row -> evaluation -> stored verdict
 * and matches), then the real `/job-queue` routes through the real guard chain over Fastify.
 *
 * Every "hidden" case is first proven an opportunity-level EXCLUDED verdict written by the worker,
 * so the read-side absence is the verdict's, not a fixture's. A RULE vacancy with the same text is
 * the positive control on every surface. Rows are inserted with the current classifier version, so
 * the worker's lazy backfill leaves the role status under test as it is.
 *
 * DB-SKIP-GUARD: with no DATABASE_URL the suite is skipped (reported as skipped, never "passed").
 */
const TAG = `rvis${randomUUID().slice(0, 8)}`
const JWT_SECRET = 'role-visibility-integration-secret-00000000000'
const SECRET = 'role-visibility-cursor-secret-000000000000000'
const NOT_FOUND = 'JOB_OPPORTUNITY_NOT_FOUND'
const DESCRIPTION = 'We build Go and PostgreSQL services with Redis and Docker.'
const ROLES = ['BACKEND_ENGINEER']

const ids: Record<string, string> = {}
const id = (key: string) => ids[key] as string
const people: Record<string, SessionUser> = {}
const oppIds: string[] = []
let seq = 0

let session: CrmAppSession
let dbSvcRef: DatabaseService
let db: ReturnType<typeof drizzle<typeof schema>>
let app: NestFastifyApplication
let jwt: JwtService

const sqlq = (text: string, params: unknown[] = []) => session.admin.query(text, params)

@Global()
@Module({
  providers: [{ provide: DatabaseService, useFactory: () => dbSvcRef }],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [JobQueueController],
  providers: [
    Reflector,
    // Explicit factories, as the sibling RBAC spec: the vitest/esbuild env emits no paramtypes.
    { provide: JobQueueScopeService, useFactory: () => new JobQueueScopeService() },
    {
      provide: JobQueueService,
      useFactory: (d: DatabaseService, scopes: JobQueueScopeService) =>
        new JobQueueService(d, scopes, { get: () => SECRET } as unknown as ConfigService<
          Env,
          true
        >),
      inject: [DatabaseService, JobQueueScopeService],
    },
    {
      provide: JobQueueActionsService,
      useFactory: (d: DatabaseService, scopes: JobQueueScopeService) =>
        new JobQueueActionsService(d, scopes),
      inject: [DatabaseService, JobQueueScopeService],
    },
    {
      provide: JobQueueRecomputeService,
      useFactory: (d: DatabaseService) => new JobQueueRecomputeService(d),
      inject: [DatabaseService],
    },
    {
      provide: APP_GUARD,
      useFactory: (j: JwtService, reflector: Reflector) => new JwtAuthGuard(j, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class RoleVisibilityTestModule {}

async function mkUser(key: string, role: SessionUser['role'], roles: string[] = []) {
  const email = `${TAG}-${key}@example.test`
  const { rows } = await sqlq(
    `INSERT INTO users (email, display_name, role, tech_stack, technical_roles)
     VALUES ($1, $2, $3, ARRAY['Go'], $4::text[]) RETURNING id`,
    [email, `${TAG} name ${key}`, role, roles],
  )
  ids[key] = rows[0].id as string
  people[key] = { id: id(key), email, role } as SessionUser
}
async function mkTeam(key: string, ...members: string[]) {
  const { rows } = await sqlq(`INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id`, [
    `${TAG}-${key}`,
  ])
  ids[key] = rows[0].id as string
  for (const m of members)
    await sqlq(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [id(key), id(m)])
}
/** A senior's resume skills, as the resume module stores them (content.skills). */
async function resume(senior: string, skills: string[]) {
  await sqlq(`INSERT INTO senior_resumes (user_id) VALUES ($1)`, [id(senior)])
  await sqlq(
    `UPDATE senior_resumes SET content = jsonb_set(content, '{skills}', $2::jsonb) WHERE user_id = $1`,
    [id(senior), JSON.stringify(skills)],
  )
}

interface OppOpts {
  status: 'RULE' | 'AI' | 'PENDING' | 'UNCLEAR' | 'NON_IT' | null
  roles?: string[]
  manualTeam?: string
}
/** An OPEN, verified-employer vacancy with one live source link and the given role columns. */
async function mkOpp(key: string, o: OppOpts) {
  const roles = o.roles ?? (o.status === 'RULE' || o.status === 'AI' ? ROLES : [])
  const { rows: blob } = await sqlq(
    `INSERT INTO job_text_blobs (sha256, text)
     VALUES (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $1)
     ON CONFLICT (sha256) DO UPDATE SET text = EXCLUDED.text RETURNING sha256`,
    [`${TAG} ${DESCRIPTION}`],
  )
  const { rows } = await sqlq(
    `INSERT INTO job_opportunities
       (title, title_key, revision, availability, employer_name, employer_key, employer_verified,
        location, description_sha256, technical_roles, role_status, role_classifier_version,
        manual_team_id)
     VALUES ($1, $2, 1, 'OPEN', $3, $2, true, 'Remote', $4, $5::text[], $6, $7, $8) RETURNING id`,
    [
      `Senior Go Engineer ${TAG} ${key}`,
      `${TAG}-${key}`,
      `${TAG} employer ${key}`,
      blob[0].sha256,
      roles,
      o.status,
      o.status === null ? null : ROLE_CLASSIFIER_VERSION,
      o.manualTeam === undefined ? null : id(o.manualTeam),
    ],
  )
  ids[key] = rows[0].id as string
  oppIds.push(id(key))
  seq += 1
  const rec = await sqlq(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3) RETURNING id`,
    [`${TAG}-ns`, `${TAG}-k${seq}`, `https://jobs.example.test/${TAG}/${seq}`],
  )
  await sqlq(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
     VALUES ($1, $2, 'r1')`,
    [rec.rows[0].id, id(key)],
  )
}

/** This spec's match-partition dirty rows only (the worker never claims AVAILABILITY:* rows). */
const MINE = `entity_id = ANY($1::uuid[]) AND NOT starts_with(reason, '${AVAILABILITY_REASON_PREFIX}')`

/** Enqueue `keys` and run the real worker over exactly those rows until none is pending. */
async function recompute(...keys: string[]) {
  for (const k of keys) await enqueueDirty(db, 'OPPORTUNITY', id(k), 1, `${TAG}-recompute`)
  for (let pass = 0; pass < 10; pass += 1) {
    // Dated in 2000, so a claim of exactly that many takes this spec's rows only.
    const { rowCount } = await sqlq(
      `UPDATE job_dirty_work SET created_at = '2000-01-01T00:00:00Z'::timestamptz + p.seq * interval '1 ms'
         FROM (SELECT id AS pid, row_number() OVER (ORDER BY created_at, id) AS seq
                 FROM job_dirty_work WHERE status = 'PENDING' AND ${MINE}) p
        WHERE id = p.pid`,
      [oppIds],
    )
    if (!rowCount) return
    await new RecomputeWorker(createRecomputeSteps(db, { onlyIds: oppIds }), {
      owner: TAG,
      batchSize: rowCount,
    }).runOnce()
  }
  throw new Error('the spec queue did not drain in 10 passes')
}

const verdict = async (key: string) =>
  (
    await sqlq(
      `SELECT evaluation_verdict AS v, evaluated_revision AS r FROM job_opportunities WHERE id = $1`,
      [id(key)],
    )
  ).rows[0] as { v: string | null; r: number | null }

interface Answer {
  status: number
  raw: string
  json: Record<string, unknown>
}
async function get(url: string, who: string): Promise<Answer> {
  const u = people[who] as SessionUser
  const res = await app.inject({
    method: 'GET',
    url: `/api/job-queue${url}`,
    cookies: { jwt: jwt.sign({ id: u.id, email: u.email, role: u.role }) },
  })
  return {
    status: res.statusCode,
    raw: res.body,
    json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  }
}
type ListItem = {
  opportunityId: string
  matchedKeywords: string[]
  stopListedSeniorCount: number
}
const search = `search=${encodeURIComponent(TAG)}&limit=50`
/** Every tab: an opportunity absent from all three is absent from the list. */
async function listed(who: string, extra = ''): Promise<Map<string, ListItem>> {
  const out = new Map<string, ListItem>()
  for (const tab of ['NEW', 'SUBMITTED', 'HIDDEN']) {
    const a = await get(`?${search}&tab=${tab}${extra}`, who)
    expect(a.status, `${who} ${tab}`).toBe(200)
    for (const i of a.json['items'] as ListItem[]) out.set(i.opportunityId, i)
  }
  return out
}
const keysIn = (m: Map<string, ListItem>, keys: string[]) => keys.filter((k) => m.has(id(k)))
/** The opportunities of a team's PUBLISHED generation (the cached snapshot a list reads). */
const generationOf = async (team: string) =>
  (
    await sqlq(
      `SELECT e.opportunity_id FROM job_queue_generation_entries e
         JOIN job_queue_generations g ON g.id = e.generation_id
        WHERE g.team_id = $1 AND g.status = 'PUBLISHED'`,
      [id(team)],
    )
  ).rows.map((r: { opportunity_id: string }) => r.opportunity_id)

const HIDDEN = ['oppPending', 'oppUnclear', 'oppNonIt']
const NEVER_EVALUATED = ['nePending', 'neUnclear', 'neNonIt', 'neNull']

describe.skipIf(!hasDatabaseUrl())('/job-queue — vacancies without IT roles (roles PR 4.5)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const probe = await sqlq(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
    dbSvcRef = { pool: session.pool, db: session.databaseService.db } as unknown as DatabaseService

    await mkUser('admin', 'ADMIN')
    for (const hr of ['hrA', 'hrB', 'hrS']) await mkUser(hr, 'HR')
    await mkUser('senA', 'SENIOR', ROLES)
    await mkUser('senB', 'SENIOR', ROLES)
    await resume('senA', ['Go', 'PostgreSQL'])
    await resume('senB', ['Go', 'Redis'])
    await mkTeam('teamA', 'hrA', 'senA')
    await mkTeam('teamB', 'hrB', 'senB')
    // A team without seniors that sees vacancies only through its SOFTWARE triage subscription.
    await mkTeam('teamS', 'hrS')
    await sqlq(
      `INSERT INTO job_team_triage_subscriptions
         (team_id, role_family, policy_version, actor_id, reason, expires_at)
       VALUES ($1, 'SOFTWARE', 1, $2, 'rvis', now() + interval '1 day')`,
      [id('teamS'), id('admin')],
    )

    await mkOpp('oppRule', { status: 'RULE' })
    await mkOpp('oppPending', { status: 'PENDING' })
    await mkOpp('oppUnclear', { status: 'UNCLEAR' })
    await mkOpp('oppNonIt', { status: 'NON_IT' })
    await mkOpp('oppMismatch', { status: 'RULE', roles: ['HARDWARE_ENGINEER'] })
    await recompute('oppRule', ...HIDDEN, 'oppMismatch')
    // Stored, never evaluated (no dirty row): the STUDIO triage case.
    await mkOpp('nePending', { status: 'PENDING' })
    await mkOpp('neUnclear', { status: 'UNCLEAR' })
    await mkOpp('neNonIt', { status: 'NON_IT' })
    await mkOpp('neNull', { status: null })
    await mkOpp('neRule', { status: 'RULE' })
    // A manual card: placed by a person, never match-evaluated; its NULL roles do not hide it.
    await mkOpp('manual', { status: null, manualTeam: 'teamA' })

    const moduleRef = await Test.createTestingModule({ imports: [RoleVisibilityTestModule] })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'role-visibility-cookie-secret' })
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) await app.close()
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
      await sqlq(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [oppIds])
      await sqlq(`DELETE FROM job_opportunity_matches WHERE opportunity_id = ANY($1::uuid[])`, [
        oppIds,
      ])
      await sqlq(`DELETE FROM job_opportunity_sources WHERE opportunity_id = ANY($1::uuid[])`, [
        oppIds,
      ])
      await sqlq(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [oppIds])
      await sqlq(`DELETE FROM job_source_records WHERE namespace = $1`, [`${TAG}-ns`])
      await sqlq(`DELETE FROM job_text_blobs WHERE text LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_team_triage_subscriptions WHERE team_id IN (${teams})`, [
        `${TAG}%`,
      ])
      await sqlq(
        `DELETE FROM senior_resumes WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
        [`${TAG}%`],
      )
      await sqlq(`DELETE FROM team_members WHERE team_id IN (${teams})`, [`${TAG}%`])
      await sqlq(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    } finally {
      await session.close()
    }
  })

  it('the worker records an opportunity-level EXCLUDED verdict for PENDING / UNCLEAR / NON_IT, OPEN for RULE', async () => {
    expect(await verdict('oppRule')).toEqual({ v: 'OPEN', r: 1 })
    for (const k of HIDDEN) expect(await verdict(k), k).toEqual({ v: 'EXCLUDED', r: 1 })
    // a role mismatch is per senior: the vacancy itself stays OPEN
    expect(await verdict('oppMismatch')).toEqual({ v: 'OPEN', r: 1 })
  })

  it('ROLE_PENDING, ROLE_UNCLEAR and NON_IT vacancies are hidden from the STUDIO list (ADMIN)', async () => {
    const studio = await listed('admin')
    expect(keysIn(studio, ['oppRule', ...HIDDEN])).toEqual(['oppRule'])
  })

  it('... hidden from a TEAM list', async () => {
    const team = await listed('hrA')
    expect(keysIn(team, ['oppRule', ...HIDDEN])).toEqual(['oppRule'])
  })

  it('... hidden from a team subscription read', async () => {
    const sub = await listed('hrS')
    expect(keysIn(sub, ['oppRule', ...HIDDEN])).toEqual(['oppRule'])
  })

  it('... absent from the cached generation', async () => {
    await listed('hrA')
    await listed('hrS')
    for (const team of ['teamA', 'teamS']) {
      const entries = await generationOf(team)
      expect(entries, team).toContain(id('oppRule'))
      for (const k of HIDDEN) expect(entries, `${team} ${k}`).not.toContain(id(k))
    }
  })

  it('a freshly stored, never-evaluated PENDING / UNCLEAR / NON_IT row and a NULL role_status row are absent from the STUDIO list', async () => {
    for (const k of NEVER_EVALUATED) expect(await verdict(k), k).toEqual({ v: null, r: null })
    expect(keysIn(await listed('admin'), NEVER_EVALUATED)).toEqual([])
  })

  it('a never-evaluated RULE row stays listed in STUDIO as triage, as today; so does a manual card', async () => {
    expect(await verdict('neRule')).toEqual({ v: null, r: null })
    expect(keysIn(await listed('admin'), ['neRule', 'manual'])).toEqual(['neRule', 'manual'])
  })

  it('a TEAM viewer gets the not-visible response from GET /job-queue/:id, /:id/sources and /:id/seniors for a PENDING / UNCLEAR / NON_IT row', async () => {
    for (const k of HIDDEN)
      for (const url of [`/${id(k)}`, `/${id(k)}/sources`, `/${id(k)}/seniors`]) {
        const a = await get(url, 'hrA')
        expect(a.status, `${k} ${url}`).toBe(404)
        expect(a.json['code']).toBe(NOT_FOUND)
      }
    // the positive control: the same routes answer for the RULE vacancy
    expect((await get(`/${id('oppRule')}/seniors`, 'hrA')).status).toBe(200)
  })

  it('an ADMIN in STUDIO can still open a PENDING row by id (documented A1)', async () => {
    expect((await get(`/${id('oppPending')}`, 'admin')).status).toBe(200)
    expect((await get(`/${id('nePending')}`, 'admin')).status).toBe(200)
  })

  it('a role-mismatched vacancy is not in a TEAM list; STOP_LISTED count is unchanged by ROLE_MISMATCH', async () => {
    expect(keysIn(await listed('hrA'), ['oppMismatch'])).toEqual([])
    const { rows } = await sqlq(
      `SELECT outcome, evidence->>'stage' AS stage FROM job_opportunity_matches
        WHERE opportunity_id = $1 AND senior_id = $2`,
      [id('oppMismatch'), id('senA')],
    )
    // no LEAD; whatever the mismatch row is, it is never a stop-list (SCOPED_RESTRICTIONS) row
    expect(rows.every((r: { outcome: string }) => r.outcome !== 'LEAD')).toBe(true)
    expect(rows.some((r: { stage: string | null }) => r.stage === 'SCOPED_RESTRICTIONS')).toBe(
      false,
    )
    const studio = await listed('admin')
    expect(studio.get(id('oppMismatch'))?.stopListedSeniorCount).toBe(0)
  })

  it('a role match is exact on the list row and the card: the own matched skills, OVERLAP {matched, total}', async () => {
    const row = (await listed('hrA')).get(id('oppRule'))
    expect(row?.matchedKeywords).toEqual(['Go', 'PostgreSQL'])
    const a = await get(`/${id('oppRule')}/seniors`, 'hrA')
    expect(a.status).toBe(200)
    const items = a.json['items'] as Array<Record<string, unknown>>
    expect(items.map((s) => [s['seniorId'], s['matchApproximate'], s['matchedKeywords']])).toEqual([
      [id('senA'), false, ['Go', 'PostgreSQL']],
    ])
    // vacancy technologies of DESCRIPTION: Docker, Go, PostgreSQL, Redis
    expect(items[0]?.['skillOverlap']).toEqual({
      kind: 'OVERLAP',
      matched: ['Go', 'PostgreSQL'],
      total: 4,
    })
  })

  it('a TEAM viewer never receives another team senior skillOverlap', async () => {
    // Redis is team B's senior's skill only; ADMIN (studio-wide) sees it, team A never does.
    expect((await listed('admin')).get(id('oppRule'))?.matchedKeywords).toEqual([
      'Go',
      'PostgreSQL',
      'Redis',
    ])
    expect((await listed('hrA')).get(id('oppRule'))?.matchedKeywords).not.toContain('Redis')
    const seniors = await get(`/${id('oppRule')}/seniors`, 'hrA')
    expect(seniors.raw).not.toContain('Redis')
    expect(seniors.raw).not.toContain(id('senB'))
  })

  it('HR of team A gets 404 / an empty list for team B queue, as today', async () => {
    for (const url of [`/${id('oppRule')}`, `/${id('oppRule')}/seniors`]) {
      const a = await get(`${url}?teamId=${id('teamB')}`, 'hrA')
      expect(a.status, url).toBe(404)
      expect(a.json['code']).toBe(NOT_FOUND)
    }
    const list = await get(`?${search}&teamId=${id('teamB')}`, 'hrA')
    // a foreign teamId resolves to no scope: an empty 200, the same as an empty team
    expect(list.status).toBe(200)
    expect(list.json['items']).toEqual([])
    expect(list.raw).not.toContain('Redis')
  })
})
