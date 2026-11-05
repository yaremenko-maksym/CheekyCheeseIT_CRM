import { randomUUID } from 'node:crypto'
import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { DESCRIPTION_MD_MAX, type SessionUser } from '@crm/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JwtAuthGuard } from '../../auth/jwt.guard'
import { RolesGuard } from '../../common/guards/roles.guard'
import type { Env } from '../../config/env'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import { DatabaseService } from '../../database/database.service'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { ZodExceptionFilter } from '../../zod-exception.filter'
import {
  loadRoster,
  MATCH_RULE_VERSION,
  opportunityInputsVersion,
  type SeniorVersions,
} from '../runtime/recompute-inputs'
import { JobQueueController } from './job-queue.controller'
import { JobQueueService } from './job-queue.service'
import { JobQueueActionsService } from './queue-actions.service'
import {
  JobQueueRecomputeService,
  RECOMPUTE_REASON_PREFIX,
  RECOMPUTE_TRIGGER_PREFIX,
} from './queue-recompute.service'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * r5 Task 6.4 — the `/job-queue` routes through the REAL guard chain (global `JwtAuthGuard`, the
 * controller's own `RolesGuard`), the real controller and services, over Fastify, against a real
 * Postgres as the API role (`crm_app`). A mocked E2E cannot prove a backend guard. NEVER `crm_db`:
 * `openCrmAppSession` refuses it, and the probe below refuses it again.
 *
 * Team A and team B share `senShared`. Every absence is asserted on the RAW response body: a field
 * that merely did not parse is still a leak on the wire.
 *
 * The suppression cases (r5 Task 6.4, security condition) run in order: the opportunity is listed,
 * carded and acted on first, so the generation published BEFORE the suppression is the one served
 * after it, and the absence proves that reads re-check visibility on every request.
 *
 * DB-SKIP-GUARD: with no DATABASE_URL the suite is skipped (reported as skipped, never "passed").
 */
const TAG = `qrbac${randomUUID().slice(0, 8)}`
const JWT_SECRET = 'job-queue-rbac-integration-secret-0000000000'
const SECRET = 'job-queue-rbac-cursor-secret-00000000000000'
const ROLE_REFUSAL = 'FORBIDDEN_INSUFFICIENT_ROLE'
const NOT_FOUND = 'JOB_OPPORTUNITY_NOT_FOUND'

const ids: Record<string, string> = {}
const id = (key: string) => ids[key] as string
const records: Record<string, string> = {}
const people: Record<string, SessionUser> = {}
const as = (key: string) => people[key] as SessionUser

let session: CrmAppSession
let dbSvcRef: DatabaseService
let app: NestFastifyApplication
let jwt: JwtService
let live: ReadonlyMap<string, SeniorVersions>
/** The live inputs version a TEAM scope requires of an evaluation record (studio exclusions). */
let liveInputs: string
let seq = 0

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
    // Every service by an explicit factory, as the sibling RBAC specs do: the vitest/esbuild env
    // emits no `design:paramtypes`, so nothing here may rest on constructor reflection.
    { provide: JobQueueScopeService, useFactory: () => new JobQueueScopeService() },
    {
      provide: JobQueueService,
      useFactory: (db: DatabaseService, scopes: JobQueueScopeService) =>
        new JobQueueService(db, scopes, { get: () => SECRET } as unknown as ConfigService<
          Env,
          true
        >),
      inject: [DatabaseService, JobQueueScopeService],
    },
    {
      provide: JobQueueActionsService,
      useFactory: (db: DatabaseService, scopes: JobQueueScopeService) =>
        new JobQueueActionsService(db, scopes),
      inject: [DatabaseService, JobQueueScopeService],
    },
    {
      provide: JobQueueRecomputeService,
      useFactory: (db: DatabaseService) => new JobQueueRecomputeService(db),
      inject: [DatabaseService],
    },
    // JwtAuthGuard as APP_GUARD, as AppModule does. RolesGuard is NOT global: the controller's own
    // `@UseGuards(RolesGuard)` is what is under test.
    {
      provide: APP_GUARD,
      useFactory: (j: JwtService, reflector: Reflector) => new JwtAuthGuard(j, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class JobQueueRbacTestModule {}

async function mkUser(key: string, role: SessionUser['role']) {
  const email = `${TAG}-${key}@example.test`
  const { rows } = await sqlq(
    `INSERT INTO users (email, display_name, role, tech_stack) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, `${TAG} name ${key}`, role, ['Go']],
  )
  ids[key] = rows[0].id as string
  people[key] = { id: id(key), email, role } as SessionUser
}
async function mkTeam(key: string) {
  const { rows } = await sqlq(`INSERT INTO teams (name, type) VALUES ($1, 'SENIOR') RETURNING id`, [
    `${TAG}-${key}`,
  ])
  ids[key] = rows[0].id as string
}
const join = (team: string, member: string) =>
  sqlq(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [id(team), id(member)])

/** An OPEN opportunity with one live source link. `dup` gives it the shared candidate key. */
async function mkOpp(key: string, o: { dup?: boolean; description?: string } = {}) {
  let sha: string | null = null
  if (o.description !== undefined) {
    const { rows } = await sqlq(
      `INSERT INTO job_text_blobs (sha256, text) VALUES (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $1)
       RETURNING sha256`,
      [o.description],
    )
    sha = rows[0].sha256 as string
  }
  const { rows } = await sqlq(
    `INSERT INTO job_opportunities
       (title, title_key, revision, availability, employer_name, employer_key, description_sha256)
     VALUES ($1, $2, 1, 'OPEN', $3, $3, $4) RETURNING id`,
    [`${TAG} ${key}`, o.dup ? `${TAG}-dup` : `${TAG}-${key}`, o.dup ? `${TAG}-emp` : null, sha],
  )
  ids[key] = rows[0].id as string
  seq += 1
  const rec = await sqlq(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url)
     VALUES ('GREENHOUSE_ATS', $1, 'NATIVE_ID', $2, $3) RETURNING id`,
    [`${TAG}-ns`, `${TAG}-k${seq}`, `https://jobs.example.test/${TAG}/${seq}`],
  )
  records[key] = rec.rows[0].id as string
  await sqlq(
    `INSERT INTO job_opportunity_sources (source_record_id, opportunity_id, rule_version)
     VALUES ($1, $2, 'r1')`,
    [records[key], id(key)],
  )
}
/** A LEAD match stamped with the senior's live versions: what makes it visible to their teams. */
function lead(opp: string, senior: string) {
  const v = live.get(id(senior)) as SeniorVersions
  return sqlq(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
        exclusion_version, rule_version, outcome, evidence)
     VALUES ($1, $2, 1, $3, $4, $5, 'LEAD', $6::jsonb)`,
    [
      id(opp),
      id(senior),
      v.profile,
      v.exclusion,
      MATCH_RULE_VERSION,
      JSON.stringify({
        score: 50,
        reasons: [{ code: 'TECH_MATCH', evidence: ['Go:CORE'], ruleVersion: 'r' }],
        rankWarnings: [],
      }),
    ],
  )
}
/** A standing triage subscription of a team (r5 Task 6.4c), actor ADMIN. */
const subscribe = (team: string, roleFamily: string, expires: string, revoked = false) =>
  sqlq(
    `INSERT INTO job_team_triage_subscriptions
       (team_id, role_family, policy_version, actor_id, reason, expires_at,
        revoked_at, revoked_by, revoke_reason)
     VALUES ($1, $2, 1, $3, 'qrbac', now() + $4::interval, $5, $6, $7)`,
    [
      id(team),
      roleFamily,
      id('admin'),
      expires,
      revoked ? new Date() : null,
      revoked ? id('admin') : null,
      revoked ? 'qrbac revoked' : null,
    ],
  )
/** An OPEN opportunity evaluated OPEN at the live inputs, with a persisted family and no LEAD. */
async function subOpp(key: string, roleFamily: string | null, verified = true) {
  await mkOpp(key)
  await sqlq(
    `UPDATE job_opportunities
        SET evaluated_revision = 1, evaluation_verdict = 'OPEN', evaluated_inputs_version = $2,
            role_family = $3, employer_verified = $4, employer_key = $5
      WHERE id = $1`,
    [id(key), liveInputs, roleFamily, verified, verified ? `${TAG}-emp-${key}` : null],
  )
}

interface Answer {
  status: number
  raw: string
  json: Record<string, unknown>
}
async function call(
  method: 'GET' | 'POST',
  url: string,
  who: string | null,
  payload?: unknown,
  token?: string,
): Promise<Answer> {
  const jwtCookie =
    token ??
    (who === null ? undefined : jwt.sign({ id: id(who), email: as(who).email, role: as(who).role }))
  const res = await app.inject({
    method,
    url: `/api/job-queue${url}`,
    cookies: jwtCookie === undefined ? {} : { jwt: jwtCookie },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })
  return {
    status: res.statusCode,
    raw: res.body,
    json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
  }
}
const get = (url: string, who: string | null) => call('GET', url, who)
const post = (url: string, who: string | null, payload?: unknown) => call('POST', url, who, payload)

const search = `search=${encodeURIComponent(TAG)}&limit=50`
const listedIds = (a: Answer) =>
  (a.json['items'] as Array<{ opportunityId: string }>).map((i) => i.opportunityId)
const total = (a: Answer) => {
  const c = a.json['counts'] as { NEW: number; SUBMITTED: number; HIDDEN: number }
  return c.NEW + c.SUBMITTED + c.HIDDEN
}
/** Every tab of a list: an opportunity absent from all three is absent from the list. */
async function inAnyTab(who: string, opp: string, extra = ''): Promise<boolean> {
  for (const tab of ['NEW', 'SUBMITTED', 'HIDDEN']) {
    const a = await get(`?${search}&tab=${tab}${extra}`, who)
    expect(a.status).toBe(200)
    if (listedIds(a).includes(id(opp))) return true
  }
  return false
}
const publishedGenerations = async (team: string) =>
  (
    await sqlq(`SELECT id FROM job_queue_generations WHERE team_id = $1 AND status = 'PUBLISHED'`, [
      id(team),
    ])
  ).rows.map((r: { id: string }) => r.id)
const dismissalRows = async (opp: string) =>
  (
    await sqlq(`SELECT scope_kind, team_id FROM job_queue_dismissals WHERE opportunity_id = $1`, [
      id(opp),
    ])
  ).rows
const suppressedRows = async (opp: string) =>
  (
    await sqlq(
      `SELECT actor_id FROM job_queue_actions WHERE opportunity_id = $1 AND kind = 'SUPPRESSED'`,
      [id(opp)],
    )
  ).rows
/** Recompute runs (r5 Task 6.4) any TAG user asked for: `requested_by` is the audit of who. */
const RECOMPUTE_RUNS = `SELECT id FROM job_collection_cycles
  WHERE trigger = 'MANUAL' AND starts_with(trigger_key, '${RECOMPUTE_TRIGGER_PREFIX}')
    AND requested_by IN (SELECT id FROM users WHERE email LIKE $1)`
const recomputeRuns = async () => (await sqlq(RECOMPUTE_RUNS, [`${TAG}%`])).rows

describe.skipIf(!hasDatabaseUrl())('/job-queue — real-controller RBAC (Task 6.4)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const probe = await sqlq(`SELECT current_database() AS db`)
    if (probe.rows[0].db === 'crm_db') throw new Error('refusing the live database')
    // A plain object, as the sibling RBAC specs use: `session.databaseService` is a real
    // `DatabaseService` instance, so Nest would run its `onModuleInit` (which reads a ConfigService
    // it was never given, CI round 1) and its `onModuleDestroy` (which ends a pool it never opened).
    // The pool stays the session's, closed by `session.close()`.
    dbSvcRef = {
      pool: session.pool,
      db: session.databaseService.db,
    } as unknown as DatabaseService

    await mkUser('admin', 'ADMIN')
    for (const hr of ['hrA', 'hrB', 'hrNone', 'hrE', 'hrS', 'hrS2']) await mkUser(hr, 'HR')
    for (const s of ['senA', 'senB', 'senShared']) await mkUser(s, 'SENIOR')
    await mkUser('jun', 'JUNIOR')
    await mkUser('acc', 'ACCOUNTANT')
    for (const t of ['teamA', 'teamB', 'teamE', 'teamS', 'teamS2']) await mkTeam(t)
    for (const m of ['hrA', 'senA', 'senShared']) await join('teamA', m)
    for (const m of ['hrB', 'senB', 'senShared']) await join('teamB', m)
    await join('teamE', 'hrE')
    await join('teamS', 'hrS')
    await join('teamS2', 'hrS2')
    const roster = await loadRoster(session.databaseService.db)
    live = roster.versions
    liveInputs = opportunityInputsVersion(roster.exclusions.filter((e) => e.seniorId === null))

    await mkOpp('oppOnlyA', { description: `${TAG} ${'d'.repeat(DESCRIPTION_MD_MAX + 100)}` })
    await lead('oppOnlyA', 'senA')
    await mkOpp('oppShared')
    await lead('oppShared', 'senA')
    await lead('oppShared', 'senShared')
    await mkOpp('oppSup', { dup: true })
    await lead('oppSup', 'senA')
    await mkOpp('oppDupHost', { dup: true })
    await lead('oppDupHost', 'senA')
    // Task 6.4c — subscriptions live on their own teams (S, S2), so team A's exact list stays as
    // it is. Each hidden opportunity differs from `oppSubLive` in exactly one condition.
    await subscribe('teamS', 'SOFTWARE', '1 day')
    await subscribe('teamS', 'DATA', '-1 minute')
    await subscribe('teamS', 'QA', '1 day', true)
    await subscribe('teamS2', 'DEVOPS', '1 day')
    await subOpp('oppSubLive', 'SOFTWARE')
    await subOpp('oppSubExpired', 'DATA')
    await subOpp('oppSubRevoked', 'QA')
    await subOpp('oppSubUnverified', 'SOFTWARE', false)
    await subOpp('oppSubForeign', 'DEVOPS')
    await subOpp('oppSubNullFamily', null)
    // Visible to team S through the SOFTWARE subscription until the ADMIN suppresses it below.
    await subOpp('oppSubSuppressed', 'SOFTWARE')

    const moduleRef = await Test.createTestingModule({
      imports: [JobQueueRbacTestModule],
    })
      // As the sibling RBAC specs do: the controller's own `@UseGuards(RolesGuard)` instantiates
      // the class through the injector, which leaves its `reflector` undefined in this test env
      // (no `design:paramtypes`) and answers every authenticated request with a 500 (CI round 2).
      // A properly constructed real guard keeps the decorator, and its role sets, under test.
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'job-queue-rbac-cookie-secret' })
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new ZodExceptionFilter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)
  })

  afterAll(async () => {
    if (app !== undefined) await app.close()
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
      // Only one STUDIO generation may be PUBLISHED in the database: leave none behind.
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE scope_kind = 'STUDIO' AND status = 'PUBLISHED'`,
      )
      await sqlq(
        `DELETE FROM job_queue_generations WHERE scope_kind = 'STUDIO' AND status = 'INVALIDATED'`,
      )
      const opps = `SELECT id FROM job_opportunities WHERE title LIKE $1`
      await sqlq(`DELETE FROM job_queue_assignments WHERE opportunity_id IN (${opps})`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_queue_dismissals WHERE opportunity_id IN (${opps})`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_opportunity_matches WHERE opportunity_id IN (${opps})`, [
        `${TAG}%`,
      ])
      await sqlq(`DELETE FROM job_opportunity_sources WHERE opportunity_id IN (${opps})`, [
        `${TAG}%`,
      ])
      await sqlq(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_source_records WHERE namespace = $1`, [`${TAG}-ns`])
      await sqlq(`DELETE FROM job_text_blobs WHERE text LIKE $1`, [`${TAG}%`])
      // Before users and teams: a subscription restricts its ADMIN actor.
      await sqlq(`DELETE FROM job_team_triage_subscriptions WHERE team_id IN (${teams})`, [
        `${TAG}%`,
      ])
      // Before users: a recompute run's work restricts its cycle, the cycle its ADMIN (RESTRICT).
      await sqlq(`DELETE FROM job_dirty_work WHERE cycle_id IN (${RECOMPUTE_RUNS})`, [`${TAG}%`])
      await sqlq(`DELETE FROM job_dirty_work WHERE reason = $1`, [`${TAG}-busy`])
      await sqlq(`DELETE FROM job_collection_cycles WHERE id IN (${RECOMPUTE_RUNS})`, [`${TAG}%`])
      await sqlq(`DELETE FROM team_members WHERE team_id IN (${teams})`, [`${TAG}%`])
      await sqlq(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
      await sqlq(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    } finally {
      await session.close()
    }
  })

  /** One request per route, with a valid id and a valid body: only the guard can refuse it. */
  const everyRoute = (): Array<['GET' | 'POST', string, unknown]> => [
    ['GET', '', undefined],
    ['GET', `/${id('oppOnlyA')}`, undefined],
    ['GET', `/${id('oppOnlyA')}/sources`, undefined],
    ['GET', `/${id('oppOnlyA')}/seniors`, undefined],
    [
      'POST',
      `/${id('oppOnlyA')}/submissions`,
      { seniorId: id('senA'), idempotencyKey: randomUUID(), expectedOpportunityRevision: 1 },
    ],
    [
      'POST',
      `/${id('oppOnlyA')}/submissions/${randomUUID()}/cancel`,
      { idempotencyKey: randomUUID(), expectedVersion: 1 },
    ],
    [
      'POST',
      `/${id('oppOnlyA')}/dismiss`,
      { scope: 'TEAM', reason: 'SPAM', idempotencyKey: randomUUID() },
    ],
    [
      'POST',
      `/${id('oppOnlyA')}/undo`,
      { scope: 'TEAM', idempotencyKey: randomUUID(), expectedVersion: 1 },
    ],
    ['POST', `/${id('oppOnlyA')}/opened`, { sourceRecordId: records['oppOnlyA'] }],
    ['POST', `/${id('oppOnlyA')}/suppress`, { idempotencyKey: randomUUID() }],
    ['POST', '/recompute', undefined],
    [
      'POST',
      '/manual',
      {
        title: `${TAG} guard`,
        companyName: 'Acme Inc',
        descriptionMd: `${TAG} guard`,
        idempotencyKey: randomUUID(),
        submission: { teamId: id('teamA'), seniorId: id('senA'), resumeId: randomUUID() },
      },
    ],
  ]

  describe('the guard chain', () => {
    it('no session is a 401 on every route; a forged token too', async () => {
      for (const [method, url, body] of everyRoute()) {
        expect((await call(method, url, null, body)).status, `${method} ${url}`).toBe(401)
        expect((await call(method, url, null, body, 'not-a-jwt')).status).toBe(401)
      }
    })

    it.each(['senA', 'jun', 'acc'])(
      '%s is a 403 from the RolesGuard on every route',
      async (who) => {
        for (const [method, url, body] of everyRoute()) {
          const a = await call(method, url, who, body)
          expect(a.status, `${method} ${url}`).toBe(403)
          expect(a.json['code']).toBe(ROLE_REFUSAL)
        }
        expect(await suppressedRows('oppOnlyA')).toEqual([])
        expect(await recomputeRuns()).toEqual([])
      },
    )

    it('suppress is ADMIN only: an HR is the RolesGuard 403 and writes nothing', async () => {
      const a = await post(`/${id('oppOnlyA')}/suppress`, 'hrA', { idempotencyKey: randomUUID() })
      expect(a.status).toBe(403)
      expect(a.json['code']).toBe(ROLE_REFUSAL)
      expect(await suppressedRows('oppOnlyA')).toEqual([])
    })

    it('recompute is ADMIN only: an HR is the RolesGuard 403 and opens no run', async () => {
      const a = await post('/recompute', 'hrA')
      expect(a.status).toBe(403)
      expect(a.json['code']).toBe(ROLE_REFUSAL)
      expect(await recomputeRuns()).toEqual([])
    })
  })

  describe('input is a 400 before any service runs', () => {
    it.each(['/not-a-uuid', '/not-a-uuid/sources', '/not-a-uuid/seniors'])(
      'GET %s',
      async (url) => {
        expect((await get(url, 'hrA')).status).toBe(400)
      },
    )

    it.each([
      'limit=51',
      'limit=0',
      'limit=abc',
      `cursor=${'c'.repeat(301)}`,
      'teamId=nope',
      'x=1',
    ])('GET ?%s', async (query) => {
      expect((await get(`?${query}`, 'hrA')).status).toBe(400)
    })

    it('a bad path id or body on a write is a 400, and writes nothing', async () => {
      const opp = id('oppOnlyA')
      expect((await post(`/nope/submissions`, 'hrA', {})).status).toBe(400)
      expect(
        (
          await post(`/${opp}/submissions/nope/cancel`, 'hrA', {
            idempotencyKey: randomUUID(),
            expectedVersion: 1,
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await post(`/${opp}/submissions`, 'hrA', {
            seniorId: id('senA'),
            idempotencyKey: 'not-a-uuid',
            expectedOpportunityRevision: 1,
          })
        ).status,
      ).toBe(400)
      expect((await post(`/${opp}/submissions`, 'hrA')).status).toBe(400)
      expect(
        (
          await post(`/${opp}/dismiss`, 'hrA', {
            scope: 'TEAM',
            reason: 'free text',
            idempotencyKey: randomUUID(),
          })
        ).status,
      ).toBe(400)
      expect((await post(`/${opp}/opened`, 'hrA', {})).status).toBe(400)
      expect((await post(`/${opp}/suppress`, 'admin', { idempotencyKey: 'nope' })).status).toBe(400)
      expect(await suppressedRows('oppOnlyA')).toEqual([])
      expect(await dismissalRows('oppOnlyA')).toEqual([])
    })

    it('a tampered cursor is the malformed-cursor 400, on the list and a continuation', async () => {
      const list = await get(`?cursor=forged.cursor`, 'hrA')
      expect(list.status).toBe(400)
      expect(list.json['code']).toBe('JOB_QUEUE_CURSOR_MALFORMED')
      const sources = await get(`/${id('oppOnlyA')}/sources?cursor=forged.cursor`, 'hrA')
      expect(sources.status).toBe(400)
      expect(sources.json['code']).toBe('JOB_QUEUE_CURSOR_MALFORMED')
    })
  })

  describe('reads, by scope', () => {
    it('ADMIN (studio): the list and any card are 200', async () => {
      const list = await get(`?${search}`, 'admin')
      expect(list.status).toBe(200)
      expect(listedIds(list)).toContain(id('oppOnlyA'))
      expect((await get(`/${id('oppOnlyA')}`, 'admin')).status).toBe(200)
    })

    it('own HR: listed and carded; the card is bounded and carries only its own keys', async () => {
      const list = await get(`?${search}`, 'hrA')
      expect(list.status).toBe(200)
      expect(listedIds(list).sort()).toEqual(
        [id('oppOnlyA'), id('oppShared'), id('oppSup'), id('oppDupHost')].sort(),
      )
      const card = await get(`/${id('oppOnlyA')}`, 'hrA')
      expect(card.status).toBe(200)
      expect(Object.keys(card.json).sort()).toEqual(
        [
          'alsoSeenOnCount',
          'applicationUrl',
          'availability',
          'companyName',
          'descriptionMd',
          'eligibility',
          'firstSeenAt',
          'hidden',
          'location',
          'matchedSeniorCount',
          'newerThanList',
          'openedByTeam',
          'opportunityId',
          'possibleDuplicates',
          'primarySource',
          'publishedAt',
          'revision',
          'seniors',
          'sources',
          'stopListedSeniorCount',
          'submittedSeniorCount',
          'title',
        ].sort(),
      )
      // The stored description is longer than the wire bound: the card is cut at 50 000.
      expect((card.json['descriptionMd'] as string).length).toBe(50_000)
      expect(card.raw).not.toContain('identity_key')
      expect(card.raw).not.toContain(`${TAG}-k`)
    })

    it('foreign HR, no-team HR and a foreign teamId: the same 404 as a missing opportunity', async () => {
      for (const url of [
        `/${id('oppOnlyA')}`,
        `/${id('oppOnlyA')}/sources`,
        `/${id('oppOnlyA')}/seniors`,
      ]) {
        for (const who of ['hrB', 'hrNone']) {
          const a = await get(url, who)
          expect(a.status, `${who} ${url}`).toBe(404)
          expect(a.json['code']).toBe(NOT_FOUND)
        }
        const viaTeam = await get(`${url}?teamId=${id('teamB')}`, 'hrA')
        expect(viaTeam.status).toBe(404)
        expect(viaTeam.json['code']).toBe(NOT_FOUND)
      }
      const missing = await get(`/${randomUUID()}`, 'hrA')
      expect(missing.status).toBe(404)
      expect(missing.json['code']).toBe(NOT_FOUND)
      expect(listedIds(await get(`?${search}`, 'hrB'))).not.toContain(id('oppOnlyA'))
    })

    it('an empty authorized list is a 200, for no team and for an empty team alike', async () => {
      const none = await get(`?${search}`, 'hrNone')
      expect(none.status).toBe(200)
      expect(none.json).toEqual({
        items: [],
        nextCursor: null,
        counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
        generation: null,
      })
      const empty = await get(`?${search}`, 'hrE')
      expect(empty.status).toBe(200)
      expect(empty.json['items']).toEqual([])
      expect(empty.json['counts']).toEqual({ NEW: 0, SUBMITTED: 0, HIDDEN: 0 })
    })

    it("A3 (a): another team's live submission of a shared senior is the bare marker, raw", async () => {
      const submitted = await post(`/${id('oppShared')}/submissions`, 'hrB', {
        seniorId: id('senShared'),
        idempotencyKey: randomUUID(),
        expectedOpportunityRevision: 1,
      })
      expect(submitted.status).toBe(201)
      const foreign = submitted.json['submission'] as Record<string, string | number>
      const card = await get(`/${id('oppShared')}`, 'hrA')
      expect(card.status).toBe(200)
      const seniors = (card.json['seniors'] as { items: Array<Record<string, unknown>> }).items
      const shared = seniors.find((s) => s['seniorId'] === id('senShared'))
      expect(shared?.['submission']).toEqual({ submittedElsewhere: true })
      for (const leak of [
        String(foreign['id']),
        String(foreign['submittedAt']),
        id('teamB'),
        id('hrB'),
        `${TAG} name hrB`,
      ]) {
        expect(card.raw).not.toContain(leak)
      }
      for (const key of ['submittedAt', 'cancelledAt', 'version', 'submittedByName', 'teamId']) {
        expect(JSON.stringify(shared?.['submission'])).not.toContain(key)
      }
    })

    it('a stale expected revision is the generic 409, naming no row', async () => {
      const a = await post(`/${id('oppOnlyA')}/submissions`, 'hrA', {
        seniorId: id('senA'),
        idempotencyKey: randomUUID(),
        expectedOpportunityRevision: 2,
      })
      expect(a.status).toBe(409)
      expect(a.json['code']).toBe('JOB_QUEUE_VERSION_CONFLICT')
      expect(Object.keys(a.json).sort()).toEqual(['code', 'message', 'statusCode'].sort())
    })

    it('a STUDIO dismissal by an HR and a TEAM dismissal by a non-member are refused, unwritten', async () => {
      const studio = await post(`/${id('oppOnlyA')}/dismiss`, 'hrA', {
        scope: 'STUDIO',
        reason: 'NOT_RELEVANT',
        idempotencyKey: randomUUID(),
      })
      expect(studio.status).toBe(404)
      expect(studio.json['code']).toBe(NOT_FOUND)
      const nonMember = await post(`/${id('oppOnlyA')}/dismiss`, 'hrB', {
        teamId: id('teamA'),
        scope: 'TEAM',
        reason: 'NOT_RELEVANT',
        idempotencyKey: randomUUID(),
      })
      expect(nonMember.status).toBe(404)
      expect(nonMember.json['code']).toBe(NOT_FOUND)
      expect(await dismissalRows('oppOnlyA')).toEqual([])
    })

    it('a generation no longer published is not served: its cursor is refresh-required', async () => {
      const first = await get(`?${search.replace('limit=50', 'limit=1')}`, 'hrA')
      expect(first.status).toBe(200)
      const cursor = first.json['nextCursor'] as string
      expect(typeof cursor).toBe('string')
      await sqlq(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now()
          WHERE team_id = $1 AND status = 'PUBLISHED'`,
        [id('teamA')],
      )
      const next = await get(
        `?${search.replace('limit=50', 'limit=1')}&cursor=${encodeURIComponent(cursor)}`,
        'hrA',
      )
      expect(next.status).toBe(409)
      expect(next.json['code']).toBe('JOB_QUEUE_REFRESH_REQUIRED')
    })
  })

  describe('Task 6.4c: a triage subscription shows only a live, verified family match to its team', () => {
    const hidden = [
      'oppSubExpired',
      'oppSubRevoked',
      'oppSubUnverified',
      'oppSubForeign',
      'oppSubNullFamily',
    ]

    it("the subscribing team's HR: exactly the live match is listed and carded", async () => {
      const list = await get(`?${search}`, 'hrS')
      expect(list.status).toBe(200)
      expect(listedIds(list).sort()).toEqual([id('oppSubLive'), id('oppSubSuppressed')].sort())
      for (const opp of hidden) expect(list.raw, opp).not.toContain(id(opp))
      const card = await get(`/${id('oppSubLive')}`, 'hrS')
      expect(card.status).toBe(200)
      expect(card.json['opportunityId']).toBe(id('oppSubLive'))
    })

    it.each(hidden)(
      '%s: absent from every tab and the same 404 as a missing opportunity on every read',
      async (opp) => {
        expect(await inAnyTab('hrS', opp)).toBe(false)
        for (const url of [`/${id(opp)}`, `/${id(opp)}/sources`, `/${id(opp)}/seniors`]) {
          const a = await get(url, 'hrS')
          expect(a.status, url).toBe(404)
          expect(a.json['code']).toBe(NOT_FOUND)
        }
      },
    )

    it("another team's subscription shows its match to that team only", async () => {
      const foreign = await get(`?${search}`, 'hrS2')
      expect(foreign.status).toBe(200)
      expect(listedIds(foreign)).toEqual([id('oppSubForeign')])
      expect(foreign.raw).not.toContain(id('oppSubLive'))
      expect((await get(`/${id('oppSubForeign')}`, 'hrS2')).status).toBe(200)
      const live404 = await get(`/${id('oppSubLive')}`, 'hrS2')
      expect(live404.status).toBe(404)
      expect(live404.json['code']).toBe(NOT_FOUND)
    })

    it('a team with no subscription sees neither, and ?teamId of the subscriber is a 404', async () => {
      for (const who of ['hrA', 'hrB', 'hrNone']) {
        const list = await get(`?${search}`, who)
        expect(list.raw, who).not.toContain(id('oppSubLive'))
        expect(list.raw, who).not.toContain(id('oppSubForeign'))
        expect((await get(`/${id('oppSubLive')}`, who)).status, who).toBe(404)
      }
      const viaTeam = await get(`/${id('oppSubLive')}?teamId=${id('teamS')}`, 'hrA')
      expect(viaTeam.status).toBe(404)
      expect(viaTeam.json['code']).toBe(NOT_FOUND)
    })

    it('ADMIN (studio) still sees every one of them', async () => {
      for (const opp of ['oppSubLive', ...hidden]) {
        expect((await get(`/${id(opp)}`, 'admin')).status, opp).toBe(200)
      }
    })

    it('an ADMIN suppression takes a subscription-only item off the list and the card', async () => {
      const opp = id('oppSubSuppressed')
      expect((await get(`/${opp}`, 'hrS')).status).toBe(200)
      const suppressed = await post(`/${opp}/suppress`, 'admin', { idempotencyKey: randomUUID() })
      expect(suppressed.status).toBe(204)
      const list = await get(`?${search}`, 'hrS')
      expect(list.status).toBe(200)
      expect(listedIds(list)).toEqual([id('oppSubLive')])
      expect(list.raw).not.toContain(opp)
      const card = await get(`/${opp}`, 'hrS')
      expect(card.status).toBe(404)
      expect(card.json['code']).toBe(NOT_FOUND)
    })
  })

  describe('suppression takes the opportunity down for every team (in order)', () => {
    let generation: string[]
    let totalBefore: number
    let submissionId: string

    it('before: listed, carded, a duplicate of its copy, submitted and dismissed by team A', async () => {
      const list = await get(`?${search}`, 'hrA')
      expect(list.status).toBe(200)
      expect(listedIds(list)).toContain(id('oppSup'))
      totalBefore = total(list)
      generation = await publishedGenerations('teamA')
      expect(generation).toHaveLength(1)
      const host = await get(`/${id('oppDupHost')}`, 'hrA')
      const dups = host.json['possibleDuplicates'] as { items: Array<{ opportunityId: string }> }
      expect(dups.items.map((d) => d.opportunityId)).toEqual([id('oppSup')])

      const submitted = await post(`/${id('oppSup')}/submissions`, 'hrA', {
        seniorId: id('senA'),
        idempotencyKey: randomUUID(),
        expectedOpportunityRevision: 1,
      })
      expect(submitted.status).toBe(201)
      submissionId = String((submitted.json['submission'] as { id: string }).id)
      const dismissed = await post(`/${id('oppSup')}/dismiss`, 'hrA', {
        scope: 'TEAM',
        reason: 'NOT_RELEVANT',
        idempotencyKey: randomUUID(),
      })
      expect(dismissed.status).toBe(200)
      expect(dismissed.json['version']).toBe(1)
    })

    it('ADMIN suppresses: 204, one action row; a retry with the key writes nothing more', async () => {
      const key = randomUUID()
      const first = await post(`/${id('oppSup')}/suppress`, 'admin', { idempotencyKey: key })
      expect(first.status).toBe(204)
      expect(first.raw).toBe('')
      expect(
        (await post(`/${id('oppSup')}/suppress`, 'admin', { idempotencyKey: key })).status,
      ).toBe(204)
      expect(await suppressedRows('oppSup')).toEqual([{ actor_id: id('admin') }])
    })

    it('team list: absent from every tab of the SAME generation, and from its counts', async () => {
      expect(await inAnyTab('hrA', 'oppSup')).toBe(false)
      expect(await publishedGenerations('teamA')).toEqual(generation)
      expect(total(await get(`?${search}`, 'hrA'))).toBe(totalBefore - 1)
      expect(await inAnyTab('hrA', 'oppOnlyA')).toBe(true)
    })

    it('team card, sources and seniors: the same 404 as a missing opportunity', async () => {
      for (const url of [
        `/${id('oppSup')}`,
        `/${id('oppSup')}/sources`,
        `/${id('oppSup')}/seniors`,
      ]) {
        const a = await get(url, 'hrA')
        expect(a.status, url).toBe(404)
        expect(a.json['code']).toBe(NOT_FOUND)
      }
      const viaAdminTeam = await get(`/${id('oppSup')}?teamId=${id('teamA')}`, 'admin')
      expect(viaAdminTeam.status).toBe(404)
    })

    it('team card of its copy: no longer a possible duplicate', async () => {
      const host = await get(`/${id('oppDupHost')}`, 'hrA')
      expect(host.status).toBe(200)
      expect(host.json['possibleDuplicates']).toBeNull()
      expect(host.raw).not.toContain(id('oppSup'))
    })

    it('team submit, dismiss and opened: 404, and nothing is written', async () => {
      const before = (
        await sqlq(`SELECT count(*)::int AS n FROM job_queue_actions WHERE opportunity_id = $1`, [
          id('oppSup'),
        ])
      ).rows[0].n as number
      const submit = await post(`/${id('oppSup')}/submissions`, 'hrA', {
        seniorId: id('senShared'),
        idempotencyKey: randomUUID(),
        expectedOpportunityRevision: 1,
      })
      const dismiss = await post(`/${id('oppSup')}/dismiss`, 'hrA', {
        scope: 'TEAM',
        reason: 'SPAM',
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      const opened = await post(`/${id('oppSup')}/opened`, 'hrA', {
        sourceRecordId: records['oppSup'],
      })
      for (const a of [submit, dismiss, opened]) {
        expect(a.status).toBe(404)
        expect(a.json['code']).toBe(NOT_FOUND)
      }
      const after = (
        await sqlq(`SELECT count(*)::int AS n FROM job_queue_actions WHERE opportunity_id = $1`, [
          id('oppSup'),
        ])
      ).rows[0].n as number
      expect(after).toBe(before)
    })

    it('A1: team A may still cancel its own submission and undo its own dismissal', async () => {
      const cancel = await post(`/${id('oppSup')}/submissions/${submissionId}/cancel`, 'hrA', {
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      expect(cancel.status).toBe(200)
      expect((cancel.json['submission'] as { state: string }).state).toBe('RELEASED')
      const undo = await post(`/${id('oppSup')}/undo`, 'hrA', {
        scope: 'TEAM',
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
      })
      expect(undo.status).toBe(200)
      expect(undo.json['hidden']).toBe(false)
      // Corrected, it is still taken down.
      expect(await inAnyTab('hrA', 'oppSup')).toBe(false)
    })

    it('ADMIN (studio): opens it by id; the studio list does not show it (A1)', async () => {
      const card = await get(`/${id('oppSup')}`, 'admin')
      expect(card.status).toBe(200)
      expect(card.json['opportunityId']).toBe(id('oppSup'))
      expect(await inAnyTab('admin', 'oppSup')).toBe(false)
      expect(await inAnyTab('admin', 'oppOnlyA')).toBe(true)
    })
  })

  /**
   * r5 Task 6.4 — POST /recompute: an ADMIN enqueues a run (202 + run id), nothing runs inline.
   * LAST in the file, and over its own opportunities: they are made here so no list above sees
   * them. The run also enqueues every other OPEN / UNKNOWN opportunity in the scratch database, so
   * every assertion is narrowed to this file's opportunities; afterAll removes the run by cycle.
   */
  describe('recompute (ADMIN)', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const runRows = async (runId: string) =>
      (
        await sqlq(
          `SELECT entity_id, target_version::int AS target_version, reason, status FROM job_dirty_work
            WHERE cycle_id = $1 AND entity_id = ANY($2::uuid[]) ORDER BY entity_id`,
          [runId, ['oppRc', 'oppRcUnknown', 'oppRcClosed', 'oppRcBusy'].map(id)],
        )
      ).rows
    const cycle = async (runId: string) =>
      (
        await sqlq(
          `SELECT trigger, starts_with(trigger_key, $2) AS recompute, requested_by, status
             FROM job_collection_cycles WHERE id = $1`,
          [runId, RECOMPUTE_TRIGGER_PREFIX],
        )
      ).rows[0]
    let firstRun = ''

    beforeAll(async () => {
      // A recompute run left OPEN by an earlier crashed run would be answered instead of a new one:
      // close every open recompute cycle (cycles only, test DB) so this block starts from none.
      await sqlq(
        `UPDATE job_collection_cycles SET status = 'CLOSED', closed_at = clock_timestamp()
          WHERE trigger = 'MANUAL' AND status = 'OPEN' AND starts_with(trigger_key, $1)`,
        [RECOMPUTE_TRIGGER_PREFIX],
      )
      await mkOpp('oppRc')
      await mkOpp('oppRcUnknown')
      await sqlq(`UPDATE job_opportunities SET availability = 'UNKNOWN' WHERE id = $1`, [
        id('oppRcUnknown'),
      ])
      await mkOpp('oppRcClosed')
      await sqlq(`UPDATE job_opportunities SET availability = 'CLOSED' WHERE id = $1`, [
        id('oppRcClosed'),
      ])
      // A MATCH row already in flight at its revision recomputes it anyway: the run skips it.
      await mkOpp('oppRcBusy')
      await sqlq(
        `INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
         VALUES ('OPPORTUNITY', $1, 1, $2)`,
        [id('oppRcBusy'), `${TAG}-busy`],
      )
    })

    it('202 + a run id: a MANUAL cycle by the ADMIN, one PENDING row per OPEN/UNKNOWN opportunity', async () => {
      const a = await post('/recompute', 'admin')
      expect(a.status).toBe(202)
      expect(Object.keys(a.json)).toEqual(['runId'])
      firstRun = a.json['runId'] as string
      expect(firstRun).toMatch(UUID)
      expect(await cycle(firstRun)).toEqual({
        trigger: 'MANUAL',
        recompute: true,
        requested_by: id('admin'),
        status: 'OPEN',
      })
      const expected = [
        {
          entity_id: id('oppRc'),
          target_version: 1,
          reason: `${RECOMPUTE_REASON_PREFIX}${firstRun}`,
          status: 'PENDING',
        },
        {
          entity_id: id('oppRcUnknown'),
          target_version: 1,
          reason: `${RECOMPUTE_REASON_PREFIX}${firstRun}`,
          status: 'PENDING',
        },
      ].sort((x, y) => (x.entity_id < y.entity_id ? -1 : 1)) // the uuid order of ORDER BY
      expect(await runRows(firstRun)).toEqual(expected)
    })

    it('a repeat while the run has work in flight: the SAME run id, nothing more enqueued', async () => {
      const before = await sqlq(
        `SELECT count(*)::int AS n FROM job_dirty_work WHERE cycle_id = $1`,
        [firstRun],
      )
      const a = await post('/recompute', 'admin')
      expect(a.status).toBe(202)
      expect(a.json).toEqual({ runId: firstRun })
      const after = await sqlq(
        `SELECT count(*)::int AS n FROM job_dirty_work WHERE cycle_id = $1`,
        [firstRun],
      )
      expect(after.rows[0].n).toBe(before.rows[0].n)
      expect((await recomputeRuns()).length).toBe(1)
    })

    it('once the run is drained: it is CLOSED and a new run opens at the same revisions', async () => {
      // Stands in for the worker: every row of the run reaches a terminal state.
      await sqlq(
        `UPDATE job_dirty_work SET status = 'DONE', completed_at = now() WHERE cycle_id = $1`,
        [firstRun],
      )
      const a = await post('/recompute', 'admin')
      expect(a.status).toBe(202)
      const second = a.json['runId'] as string
      expect(second).toMatch(UUID)
      expect(second).not.toBe(firstRun)
      expect((await cycle(firstRun))?.status).toBe('CLOSED')
      expect(await cycle(second)).toEqual({
        trigger: 'MANUAL',
        recompute: true,
        requested_by: id('admin'),
        status: 'OPEN',
      })
      // The reason carries the run id, so the same revision is a fresh key, not a conflict.
      expect((await runRows(second)).map((r: { reason: string }) => r.reason)).toEqual([
        `${RECOMPUTE_REASON_PREFIX}${second}`,
        `${RECOMPUTE_REASON_PREFIX}${second}`,
      ])
    })
  })

  /**
   * r5 Phase 6 — POST /job-queue/manual: a card for a vacancy found outside the sources, created
   * with its one submission (senior + existing resume) in ONE transaction. Placed AFTER the
   * recompute cases, whose per-opportunity counts would otherwise include these cards. Teams M and
   * M2 are fresh, so the first list request of team M publishes a generation that holds its card.
   */
  describe('manual card (r5 Phase 6)', () => {
    const resumes: Record<string, string> = {}
    const titleOf = (n: string) => `${TAG} manual ${n}`
    const body = (n: string, team: string, senior: string, resume: string) => ({
      title: titleOf(n),
      companyName: 'Acme Inc',
      applicationUrl: 'https://jobs.example.test/manual',
      descriptionMd: `${TAG} manual description ${n}`,
      idempotencyKey: randomUUID(),
      submission: { teamId: id(team), seniorId: id(senior), resumeId: resume },
    })
    const cards = async (n: string) =>
      (
        await sqlq(`SELECT id, manual_team_id FROM job_opportunities WHERE title = $1`, [
          titleOf(n),
        ])
      ).rows as Array<{ id: string; manual_team_id: string }>
    const blobs = async (n: string) =>
      (
        await sqlq(`SELECT sha256 FROM job_text_blobs WHERE text = $1`, [
          `${TAG} manual description ${n}`,
        ])
      ).rows
    const mkResume = async (senior: string, status: string) => {
      const { rows } = await sqlq(
        `INSERT INTO senior_resumes (user_id, status) VALUES ($1, $2) RETURNING id`,
        [id(senior), status],
      )
      resumes[senior] = rows[0].id as string
    }

    beforeAll(async () => {
      for (const t of ['teamM', 'teamM2']) await mkTeam(t)
      for (const hr of ['hrM', 'hrM2']) await mkUser(hr, 'HR')
      for (const s of ['senM', 'senM2', 'senArch', 'senQ']) await mkUser(s, 'SENIOR')
      await mkUser('junM', 'JUNIOR')
      for (const m of ['hrM', 'senM', 'senArch', 'senQ', 'junM']) await join('teamM', m)
      for (const m of ['hrM2', 'senM2']) await join('teamM2', m)
      await mkResume('senM', 'READY')
      await mkResume('senM2', 'READY')
      await mkResume('senArch', 'READY')
      await mkResume('senQ', 'QUEUED')
      await sqlq(`UPDATE users SET archived_at = now() WHERE id = $1`, [id('senArch')])
    })

    it('HR of the team: 201, one card of its team, one live submission, the resume audited', async () => {
      const a = await post('/manual', 'hrM', body('hr', 'teamM', 'senM', resumes['senM'] as string))
      expect(a.status).toBe(201)
      const [card] = await cards('hr')
      expect(card?.manual_team_id).toBe(id('teamM'))
      const submission = a.json['submission'] as Record<string, unknown>
      expect(submission['opportunityId']).toBe(card?.id)
      expect(submission['seniorId']).toBe(id('senM'))
      expect(submission['state']).toBe('TAKEN')
      expect(submission['version']).toBe(1)
      expect(submission['cancelledAt']).toBeNull()
      expect(submission['submittedByName']).toBe(`${TAG} name hrM`)
      ids['cardHr'] = card?.id as string
      const assigned = await sqlq(
        `SELECT senior_id, team_id, assignee_id, state FROM job_queue_assignments
          WHERE opportunity_id = $1`,
        [id('cardHr')],
      )
      expect(assigned.rows).toEqual([
        { senior_id: id('senM'), team_id: id('teamM'), assignee_id: id('hrM'), state: 'TAKEN' },
      ])
      const audit = await sqlq(
        `SELECT kind, actor_id, team_id, before_version, after_version,
                (reason::jsonb)->>'resumeId' AS resume
           FROM job_queue_actions WHERE opportunity_id = $1`,
        [id('cardHr')],
      )
      expect(audit.rows).toEqual([
        {
          kind: 'TAKEN',
          actor_id: id('hrM'),
          team_id: id('teamM'),
          before_version: 0,
          after_version: 1,
          resume: resumes['senM'],
        },
      ])
    })

    it('a retry with the same key answers the same submission and writes nothing more', async () => {
      const request = body('retry', 'teamM', 'senM', resumes['senM'] as string)
      const first = await post('/manual', 'hrM', request)
      const again = await post('/manual', 'hrM', request)
      expect(first.status).toBe(201)
      expect(again.status).toBe(201)
      expect(again.json).toEqual(first.json)
      expect(await cards('retry')).toHaveLength(1)
    })

    it('ADMIN: 201 for the team it names', async () => {
      const a = await post(
        '/manual',
        'admin',
        body('admin', 'teamM2', 'senM2', resumes['senM2'] as string),
      )
      expect(a.status).toBe(201)
      const [card] = await cards('admin')
      expect(card?.manual_team_id).toBe(id('teamM2'))
      expect((a.json['submission'] as Record<string, unknown>)['seniorId']).toBe(id('senM2'))
    })

    it('HR for a team it is not in: the scope 404, and no card', async () => {
      const a = await post(
        '/manual',
        'hrM',
        body('foreignTeam', 'teamM2', 'senM2', resumes['senM2'] as string),
      )
      expect(a.status).toBe(404)
      expect(a.json['code']).toBe(NOT_FOUND)
      expect(await cards('foreignTeam')).toEqual([])
    })

    it.each([
      ['a senior of another team', 'senM2', 'senM'],
      ['an archived senior', 'senArch', 'senArch'],
      ['a member who is not a SENIOR', 'junM', 'senM'],
    ])('%s: 422 JOB_QUEUE_SENIOR_INELIGIBLE, the card rolled back', async (_, senior, owner) => {
      const n = `senior-${senior}`
      const a = await post('/manual', 'hrM', body(n, 'teamM', senior, resumes[owner] as string))
      expect(a.status).toBe(422)
      expect(a.json['code']).toBe('JOB_QUEUE_SENIOR_INELIGIBLE')
      expect(await cards(n)).toEqual([])
      expect(await blobs(n)).toEqual([])
    })

    it.each([
      ['an unknown resume', () => randomUUID()],
      ["another senior's resume", () => resumes['senM2'] as string],
    ])('%s: 422 JOB_QUEUE_RESUME_UNUSABLE, the card rolled back', async (label, resume) => {
      const n = `resume-${label.length}`
      const a = await post('/manual', 'hrM', body(n, 'teamM', 'senM', resume()))
      expect(a.status).toBe(422)
      expect(a.json['code']).toBe('JOB_QUEUE_RESUME_UNUSABLE')
      expect(await cards(n)).toEqual([])
      expect(await blobs(n)).toEqual([])
    })

    it('a resume that is not READY: 422 JOB_QUEUE_RESUME_UNUSABLE, the card rolled back', async () => {
      const a = await post(
        '/manual',
        'hrM',
        body('queued', 'teamM', 'senQ', resumes['senQ'] as string),
      )
      expect(a.status).toBe(422)
      expect(a.json['code']).toBe('JOB_QUEUE_RESUME_UNUSABLE')
      expect(await cards('queued')).toEqual([])
    })

    it('no submission, or a submission without a resume: 400 before the service, nothing written', async () => {
      const full = body('noSubmission', 'teamM', 'senM', resumes['senM'] as string)
      const { submission, ...withoutSubmission } = full
      expect((await post('/manual', 'hrM', withoutSubmission)).status).toBe(400)
      const { resumeId: _, ...withoutResume } = submission
      expect((await post('/manual', 'hrM', { ...full, submission: withoutResume })).status).toBe(
        400,
      )
      expect(await cards('noSubmission')).toEqual([])
    })

    it("the card is its team's only: carded and listed for team M, a 404 and absent for team M2", async () => {
      const own = await get(`/${id('cardHr')}`, 'hrM')
      expect(own.status).toBe(200)
      expect(own.json['title']).toBe(titleOf('hr'))
      expect(own.json['companyName']).toBe('Acme Inc')
      expect(own.json['applicationUrl']).toBe('https://jobs.example.test/manual')
      expect(own.json['primarySource']).toBeNull()
      expect(await inAnyTab('hrM', 'cardHr')).toBe(true)
      const foreign = await get(`/${id('cardHr')}`, 'hrM2')
      expect(foreign.status).toBe(404)
      expect(foreign.json['code']).toBe(NOT_FOUND)
      expect(await inAnyTab('hrM2', 'cardHr')).toBe(false)
      expect(await inAnyTab('hrA', 'cardHr')).toBe(false)
    })
  })
})
