import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  Body,
  Controller,
  Get,
  Global,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  linkMeetingRecorderRecordingSchema,
  meetingRecorderWebhookEventSchema,
  sanitizeMeetingRecorderRecording,
  updateInterviewSchema,
  type MeetingRecorderSnapshotEvent,
  type SessionUser,
} from '@crm/shared'

import { JwtAuthGuard } from '../../auth/jwt.guard'
import { OnboardingGuard } from '../../auth/onboarding.guard'
import { CurrentUser } from '../../auth/current-user.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import { RolesGuard } from '../../common/guards/roles.guard'
import { DatabaseService } from '../../database/database.service'
import * as schema from '../../database/schema'
import { InterviewAccessPolicyService } from '../../interviews/interview-access-policy.service'
import { InterviewsService } from '../../interviews/interviews.service'
import type { OnboardingService } from '../../onboarding/onboarding.service'
import type { ProjectsService } from '../../projects/projects.service'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { MeetingRecorderMatcher } from './meeting-recorder-matcher'
import type { MeetingRecorderSecretCryptoService } from './meeting-recorder-secret-crypto.service'
import { MeetingRecorderService } from './meeting-recorder.service'

/**
 * Interview recordings — real-DB RBAC + guard-chain spec (SR-865-M-2, CR-865-H-3,
 * SR-865-H-1).
 *
 * WHY: before this spec the recording read paths (`assertRecordingReadAccess` →
 * `InterviewAccessPolicyService.assertUpdateAccess`) had no behavioural test —
 * the service specs mock Drizzle chains and the E2E stubs every API call. A
 * candidate transcript is personal data, so a regression in who may read it must
 * fail loudly. This drives the REAL `MeetingRecorderService`, the REAL
 * `InterviewsService` and the REAL access policy over a Fastify app against a
 * real Postgres, behind the production global guards `JwtAuthGuard` →
 * `OnboardingGuard` → `RolesGuard`.
 *
 * NOT COVERED: the throttler guard (no behaviour here depends on it) and the
 * webhook HTTP route (its auth hook is exercised by its own specs); ingestion is
 * driven through `MeetingRecorderService.ingestWebhookEvent` directly.
 *
 * WHY sentinel controllers: vitest transpiles with esbuild, which strips
 * `emitDecoratorMetadata`, so the real controllers would get `undefined`
 * injected. Each sentinel mirrors its real controller's boundary (route,
 * `@Roles`, `ParseUUIDPipe`, Zod `.parse()`, delegation) and injects the real
 * service through a string token — the same pattern as
 * `interviews-rbac.integration.spec.ts`. Keep them in sync with
 * `interview-recordings.controller.ts` and `interviews.controller.ts`.
 *
 * OnboardingGuard runs for real; only its `OnboardingService` dependency is a
 * stub that reports "onboarded" for everyone except NOT_ONBOARDED.
 *
 * DB-SKIP-GUARD: `describe.skipIf(!hasDatabaseUrl())`; a set-but-unreachable
 * DATABASE_URL fails in beforeAll.
 */

const JWT_SECRET = 'interview-recordings-rbac-integration-secret-32c'
const RECORDINGS_SERVICE_TOKEN = 'MEETING_RECORDER_SERVICE_TOKEN_RBAC'
const INTERVIEWS_SERVICE_TOKEN = 'INTERVIEWS_SERVICE_TOKEN_RECORDINGS_RBAC'

// ── Sentinel controllers ──────────────────────────────────────────────────────

@Controller('interviews')
class SentinelInterviewMeetingRecordingsController {
  constructor(
    @Inject(RECORDINGS_SERVICE_TOKEN) private readonly service: MeetingRecorderService,
    @Inject(INTERVIEWS_SERVICE_TOKEN) private readonly interviewsService: InterviewsService,
  ) {}

  // Mirror of InterviewMeetingRecordingsController.list
  @Get(':interviewId/recordings')
  @Roles('ADMIN', 'SENIOR', 'HR')
  list(@Param('interviewId', ParseUUIDPipe) interviewId: string, @CurrentUser() user: SessionUser) {
    return this.service.listInterviewRecordings(interviewId, user)
  }

  // Mirror of InterviewsController.update (the SR-865-H-1 attack vector).
  @Patch(':id')
  @Roles('ADMIN', 'SENIOR', 'HR')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.interviewsService.update(id, updateInterviewSchema.parse(body), user)
  }
}

@Controller('interview-recordings')
class SentinelInterviewRecordingsController {
  constructor(@Inject(RECORDINGS_SERVICE_TOKEN) private readonly service: MeetingRecorderService) {}

  @Get('unmatched')
  @Roles('ADMIN')
  listUnmatched() {
    return this.service.listUnmatchedRecordings()
  }

  @Get(':recordingId')
  @Roles('ADMIN', 'SENIOR', 'HR')
  detail(
    @Param('recordingId', ParseUUIDPipe) recordingId: string,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.getRecordingDetail(recordingId, user)
  }

  @Patch(':id/link')
  @Roles('ADMIN')
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.linkRecording(id, linkMeetingRecorderRecordingSchema.parse(body), user)
  }
}

// ── Personas (namespace d7e8f9a0-1b2c-4d3e-*) ────────────────────────────────

function persona(seq: string, role: SessionUser['role'], label: string): SessionUser {
  return {
    id: `d7e8f9a0-1b2c-4d3e-aa00-0000000000${seq}`,
    email: `mr-rbac-${label}@test.spec`,
    displayName: `MR RBAC ${label}`,
    avatarUrl: null,
    role,
    seniorSharePercent: role === 'SENIOR' || role === 'ADMIN' ? 26 : 0,
    locale: 'en',
    legalFullName: null,
  }
}

const ADMIN = persona('01', 'ADMIN', 'admin')
/** Owns INTERVIEW_A; shares TEAM_A with HR_A. */
const SENIOR_A = persona('02', 'SENIOR', 'senior-a')
/** Owns INTERVIEW_B; TEAM_B only. */
const SENIOR_B = persona('03', 'SENIOR', 'senior-b')
/** In TEAM_A → may read SENIOR_A's interviews. */
const HR_A = persona('04', 'HR', 'hr-a')
/** In TEAM_B only → off-team for SENIOR_A. */
const HR_B = persona('05', 'HR', 'hr-b')
/** No active team; owns INTERVIEW_C. */
const SENIOR_TEAMLESS = persona('06', 'SENIOR', 'senior-teamless')
const JUNIOR = persona('07', 'JUNIOR', 'junior')
const ACCOUNTANT = persona('08', 'ACCOUNTANT', 'accountant')
/** TEAM_A senior whose onboarding is incomplete → OnboardingGuard 403. */
const NOT_ONBOARDED = persona('09', 'SENIOR', 'not-onboarded')

const ALL_USERS = [
  ADMIN,
  SENIOR_A,
  SENIOR_B,
  HR_A,
  HR_B,
  SENIOR_TEAMLESS,
  JUNIOR,
  ACCOUNTANT,
  NOT_ONBOARDED,
]

const TEAM_A_ID = 'd7e8f9a0-1b2c-4d3e-bb00-000000000001'
const TEAM_B_ID = 'd7e8f9a0-1b2c-4d3e-bb00-000000000002'
const INTERVIEW_A_ID = 'd7e8f9a0-1b2c-4d3e-a100-000000000001'
const INTERVIEW_B_ID = 'd7e8f9a0-1b2c-4d3e-a100-000000000002'
const INTERVIEW_C_ID = 'd7e8f9a0-1b2c-4d3e-a100-000000000003'
const INTERVIEW_NOT_ONBOARDED_ID = 'd7e8f9a0-1b2c-4d3e-a100-000000000004'
const CONNECTION_ID = 'd7e8f9a0-1b2c-4d3e-a200-000000000001'
const RECORDING_A_ID = 'd7e8f9a0-1b2c-4d3e-a300-000000000001'
const RECORDING_UNMATCHED_ID = 'd7e8f9a0-1b2c-4d3e-a300-000000000002'
const RECORDING_C_ID = 'd7e8f9a0-1b2c-4d3e-a300-000000000003'
const MISSING_ID = 'd7e8f9a0-1b2c-4d3e-a400-000000000099'
const CIPHERTEXT = 'mr-rbac-signing-secret-ciphertext'

const READY_FIXTURE = meetingRecorderWebhookEventSchema.parse(
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'recording-ready-v1.json'), 'utf8')),
) as MeetingRecorderSnapshotEvent

/** A meeting recorded by the admin's extension that SENIOR_A was never cleared for. */
const FOREIGN_MEET_CODE = 'frn-mtng-cde'

function foreignMeetingEvent(externalId: string, revision: number): MeetingRecorderSnapshotEvent {
  const event = structuredClone(READY_FIXTURE)
  event.id = `mr-rbac-${externalId}-r${revision}`
  event.subject = `recording/${externalId}`
  event.data.revision = revision
  event.data.recording.id = externalId
  event.data.recording.source.meetingId = FOREIGN_MEET_CODE
  event.data.recording.source.meetingUrl = `https://meet.google.com/${FOREIGN_MEET_CODE}`
  return event
}

// ── Test DB module (real Pool wrapped as DatabaseService) ───────────────────

let testPool: Pool | null = null

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        testPool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(testPool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: testPool, db })
        // The real hooks build their own pool from ConfigService; this module owns the pool.
        Object.defineProperty(instance, 'onModuleInit', { value: () => Promise.resolve() })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => testPool?.end() ?? Promise.resolve(),
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

const onboardingStub = {
  getStatus: (userId: string) =>
    Promise.resolve(
      userId === NOT_ONBOARDED.id
        ? { requiresContract: true, requiresTos: false }
        : { requiresContract: false, requiresTos: false },
    ),
} as unknown as OnboardingService

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [
    SentinelInterviewMeetingRecordingsController,
    SentinelInterviewRecordingsController,
  ],
  providers: [
    Reflector,
    {
      provide: InterviewAccessPolicyService,
      useFactory: (db: DatabaseService) => new InterviewAccessPolicyService(db),
      inject: [DatabaseService],
    },
    {
      provide: RECORDINGS_SERVICE_TOKEN,
      useFactory: (db: DatabaseService, access: InterviewAccessPolicyService) =>
        new MeetingRecorderService(
          db,
          {} as MeetingRecorderSecretCryptoService,
          new MeetingRecorderMatcher(),
          access,
        ),
      inject: [DatabaseService, InterviewAccessPolicyService],
    },
    {
      provide: INTERVIEWS_SERVICE_TOKEN,
      useFactory: (db: DatabaseService, access: InterviewAccessPolicyService) =>
        new InterviewsService(db, {} as ProjectsService, access),
      inject: [DatabaseService, InterviewAccessPolicyService],
    },
    // Production order: JwtAuthGuard → OnboardingGuard → RolesGuard.
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
    { provide: APP_GUARD, useFactory: () => new OnboardingGuard(onboardingStub) },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new RolesGuard(reflector),
      inject: [Reflector],
    },
  ],
})
class InterviewRecordingsRbacTestModule {}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe.skipIf(!hasDatabaseUrl())(
  'Interview recordings RBAC — real backend integration (real DB, real guards)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let pool: Pool
    let recordings: MeetingRecorderService

    async function cleanup(): Promise<void> {
      await pool.query(
        'DELETE FROM meeting_recorder_audit_log WHERE connection_id = $1 OR actor_user_id = ANY($2)',
        [CONNECTION_ID, ALL_USERS.map((u) => u.id)],
      )
      await pool.query('DELETE FROM meeting_recorder_webhook_receipts WHERE connection_id = $1', [
        CONNECTION_ID,
      ])
      await pool.query('DELETE FROM interview_recordings WHERE connection_id = $1', [CONNECTION_ID])
      await pool.query('DELETE FROM meeting_recorder_connections WHERE id = $1', [CONNECTION_ID])
      await pool.query('DELETE FROM interviews WHERE senior_id = ANY($1)', [
        ALL_USERS.map((u) => u.id),
      ])
      await pool.query('DELETE FROM team_members WHERE team_id = ANY($1)', [[TEAM_A_ID, TEAM_B_ID]])
      await pool.query('DELETE FROM teams WHERE id = ANY($1)', [[TEAM_A_ID, TEAM_B_ID]])
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [ALL_USERS.map((u) => u.id)])
    }

    const AUTO_MATCH_KEY = 'MEETING_RECORDER_AUTO_MATCH_ENABLED'
    const autoMatchOriginal = process.env[AUTO_MATCH_KEY]

    beforeAll(async () => {
      // Auto-match ships OFF (SR-M-1). The SR-865-H-1 attack cases below assert
      // that a *running* matcher refuses to link a foreign recording, so they must
      // run with it ON — otherwise they would pass for the trivial reason that
      // nothing matches at all, and would stop guarding the predicates.
      process.env[AUTO_MATCH_KEY] = 'true'
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      try {
        await pool.query('SELECT 1')
      } catch {
        throw new Error('[interview-recordings rbac] FAILED — no DB reachable at DATABASE_URL')
      }
      await cleanup()

      for (const user of ALL_USERS) {
        await pool.query(
          `INSERT INTO users (id, email, display_name, role, locale) VALUES ($1, $2, $3, $4, 'en')`,
          [user.id, user.email, user.displayName, user.role],
        )
      }
      await pool.query(`INSERT INTO teams (id, name) VALUES ($1, 'MR RBAC A'), ($2, 'MR RBAC B')`, [
        TEAM_A_ID,
        TEAM_B_ID,
      ])
      await pool.query(
        `INSERT INTO team_members (team_id, user_id) VALUES
           ($1, $3), ($1, $4), ($1, $7), ($2, $5), ($2, $6)`,
        [TEAM_A_ID, TEAM_B_ID, SENIOR_A.id, HR_A.id, SENIOR_B.id, HR_B.id, NOT_ONBOARDED.id],
      )
      await pool.query(
        `INSERT INTO interviews (id, senior_id, company_name, stage) VALUES
           ($1, $5, 'MR RBAC Co A', 'TECH_INTERVIEW'),
           ($2, $6, 'MR RBAC Co B', 'TECH_INTERVIEW'),
           ($3, $7, 'MR RBAC Co C', 'TECH_INTERVIEW'),
           ($4, $8, 'MR RBAC Co D', 'TECH_INTERVIEW')`,
        [
          INTERVIEW_A_ID,
          INTERVIEW_B_ID,
          INTERVIEW_C_ID,
          INTERVIEW_NOT_ONBOARDED_ID,
          SENIOR_A.id,
          SENIOR_B.id,
          SENIOR_TEAMLESS.id,
          NOT_ONBOARDED.id,
        ],
      )
      await pool.query(
        `INSERT INTO meeting_recorder_connections (id, name, enabled, signing_secret_ciphertext)
         VALUES ($1, 'MR RBAC spec', true, $2)`,
        [CONNECTION_ID, CIPHERTEXT],
      )
      await pool.query(
        `INSERT INTO interview_recordings
           (id, interview_id, connection_id, external_recording_id, revision, source, title,
            started_at, matched_by, readiness, snapshot, last_event_at)
         VALUES
           ($1, $4, $7, 'mr-rbac-linked-a', 1, 'urn:test', 'Linked A', now(), 'manual', $9, $10, now()),
           ($2, NULL, $7, 'mr-rbac-unmatched', 1, 'urn:test', 'Unmatched', now(), 'unmatched', $9, $10, now()),
           ($3, $5, $7, 'mr-rbac-linked-c', 1, 'urn:test', 'Linked C', now(), 'manual', $9, $10, now()),
           ($6, $8, $7, 'mr-rbac-linked-d', 1, 'urn:test', 'Linked D', now(), 'manual', $9, $10, now())`,
        [
          RECORDING_A_ID,
          RECORDING_UNMATCHED_ID,
          RECORDING_C_ID,
          INTERVIEW_A_ID,
          INTERVIEW_C_ID,
          'd7e8f9a0-1b2c-4d3e-a300-000000000004',
          CONNECTION_ID,
          INTERVIEW_NOT_ONBOARDED_ID,
          JSON.stringify(READY_FIXTURE.data.readiness),
          JSON.stringify(sanitizeMeetingRecorderRecording(READY_FIXTURE.data.recording)),
        ],
      )

      const moduleRef = await Test.createTestingModule({
        imports: [InterviewRecordingsRbacTestModule],
      }).compile()
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'interview-recordings-rbac-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      recordings = moduleRef.get<MeetingRecorderService>(RECORDINGS_SERVICE_TOKEN)
    }, 30_000)

    afterAll(async () => {
      if (autoMatchOriginal === undefined) delete process.env[AUTO_MATCH_KEY]
      else process.env[AUTO_MATCH_KEY] = autoMatchOriginal
      if (!pool) return
      await cleanup()
      await app?.close()
      await pool.end()
    }, 20_000)

    function request(
      method: 'GET' | 'PATCH',
      url: string,
      user: SessionUser | null,
      payload?: unknown,
    ) {
      return app.inject({
        method,
        url,
        ...(user ? { cookies: { jwt: jwt.sign(user) } } : {}),
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      })
    }

    type Case = [label: string, user: SessionUser | null, status: number]

    // ── GET /api/interviews/:id/recordings ─────────────────────────────────────
    describe('GET /api/interviews/:interviewId/recordings', () => {
      const cases: Case[] = [
        ['ADMIN reads any interview', ADMIN, 200],
        ['SENIOR reads own interview', SENIOR_A, 200],
        ['HR reads an interview of a senior in their team', HR_A, 200],
        ['SENIOR is denied a foreign interview', SENIOR_B, 403],
        ['HR is denied an interview of a senior off their team', HR_B, 403],
        ['teamless SENIOR is denied (foreign interview)', SENIOR_TEAMLESS, 403],
        ['JUNIOR is denied by role', JUNIOR, 403],
        ['ACCOUNTANT is denied by role', ACCOUNTANT, 403],
        ['anonymous is rejected', null, 401],
      ]
      it.each(cases)('%s', async (_label, user, status) => {
        const res = await request('GET', `/api/interviews/${INTERVIEW_A_ID}/recordings`, user)
        const ids =
          res.statusCode === 200 ? (res.json() as Array<{ id: string }>).map((r) => r.id) : null
        expect({ status: res.statusCode, ids }).toEqual({
          status,
          ids: status === 200 ? [RECORDING_A_ID] : null,
        })
      })

      it('teamless SENIOR is denied even on their own interview', async () => {
        const res = await request(
          'GET',
          `/api/interviews/${INTERVIEW_C_ID}/recordings`,
          SENIOR_TEAMLESS,
        )
        expect(res.statusCode).toBe(403)
      })

      it('a SENIOR with incomplete onboarding is stopped by OnboardingGuard', async () => {
        const res = await request(
          'GET',
          `/api/interviews/${INTERVIEW_NOT_ONBOARDED_ID}/recordings`,
          NOT_ONBOARDED,
        )
        expect(res.statusCode).toBe(403)
        expect(res.json()).toEqual(expect.objectContaining({ error: 'ONBOARDING_REQUIRED' }))
      })

      it('unknown interview → 404 for ADMIN', async () => {
        const res = await request('GET', `/api/interviews/${MISSING_ID}/recordings`, ADMIN)
        expect(res.statusCode).toBe(404)
      })
    })

    // ── GET /api/interview-recordings/:id ─────────────────────────────────────
    describe('GET /api/interview-recordings/:recordingId', () => {
      const linkedCases: Case[] = [
        ['ADMIN reads a linked recording', ADMIN, 200],
        ['SENIOR reads a recording of own interview', SENIOR_A, 200],
        ['HR in team reads it', HR_A, 200],
        ['foreign SENIOR is denied', SENIOR_B, 403],
        ['off-team HR is denied', HR_B, 403],
        ['teamless SENIOR is denied', SENIOR_TEAMLESS, 403],
        ['JUNIOR is denied by role', JUNIOR, 403],
        ['ACCOUNTANT is denied by role', ACCOUNTANT, 403],
        ['anonymous is rejected', null, 401],
      ]
      it.each(linkedCases)('%s', async (_label, user, status) => {
        const res = await request('GET', `/api/interview-recordings/${RECORDING_A_ID}`, user)
        const body = res.json() as { id?: string; code?: string }
        // The service-level denial carries its own code; a RolesGuard denial does not.
        const deniedByService =
          status === 403 && user !== null && user.role !== 'JUNIOR' && user.role !== 'ACCOUNTANT'
        expect({
          status: res.statusCode,
          id: status === 200 ? body.id : undefined,
          code: deniedByService ? body.code : undefined,
        }).toEqual({
          status,
          id: status === 200 ? RECORDING_A_ID : undefined,
          code: deniedByService ? 'MEETING_RECORDER_RECORDING_ACCESS_DENIED' : undefined,
        })
      })

      it('teamless SENIOR is denied a recording of their own interview', async () => {
        const res = await request(
          'GET',
          `/api/interview-recordings/${RECORDING_C_ID}`,
          SENIOR_TEAMLESS,
        )
        expect(res.statusCode).toBe(403)
      })

      const unmatchedCases: Case[] = [
        ['ADMIN reads an unmatched recording', ADMIN, 200],
        ['SENIOR is denied an unmatched recording', SENIOR_A, 403],
        ['HR is denied an unmatched recording', HR_A, 403],
      ]
      it.each(unmatchedCases)('%s', async (_label, user, status) => {
        const res = await request(
          'GET',
          `/api/interview-recordings/${RECORDING_UNMATCHED_ID}`,
          user,
        )
        expect(res.statusCode).toBe(status)
      })

      it('unknown recording → 404', async () => {
        const res = await request('GET', `/api/interview-recordings/${MISSING_ID}`, ADMIN)
        expect(res.statusCode).toBe(404)
      })
    })

    // ── GET /api/interview-recordings/unmatched ───────────────────────────────
    describe('GET /api/interview-recordings/unmatched', () => {
      const cases: Case[] = [
        ['ADMIN lists the unmatched queue', ADMIN, 200],
        ['SENIOR is denied', SENIOR_A, 403],
        ['HR is denied', HR_A, 403],
        ['JUNIOR is denied', JUNIOR, 403],
        ['ACCOUNTANT is denied', ACCOUNTANT, 403],
        ['anonymous is rejected', null, 401],
      ]
      it.each(cases)('%s', async (_label, user, status) => {
        const res = await request('GET', '/api/interview-recordings/unmatched', user)
        const ids =
          res.statusCode === 200 ? (res.json() as Array<{ id: string }>).map((r) => r.id) : []
        expect({
          status: res.statusCode,
          listsUnmatched: ids.includes(RECORDING_UNMATCHED_ID),
          listsLinked: ids.includes(RECORDING_A_ID),
        }).toEqual({ status, listsUnmatched: status === 200, listsLinked: false })
      })
    })

    // ── PATCH /api/interview-recordings/:id/link ──────────────────────────────
    describe('PATCH /api/interview-recordings/:id/link', () => {
      const deniedCases: Case[] = [
        ['SENIOR is denied (even onto own interview)', SENIOR_A, 403],
        ['HR is denied', HR_A, 403],
        ['JUNIOR is denied', JUNIOR, 403],
        ['ACCOUNTANT is denied', ACCOUNTANT, 403],
        ['anonymous is rejected', null, 401],
      ]
      it.each(deniedCases)('%s', async (_label, user, status) => {
        const res = await request(
          'PATCH',
          `/api/interview-recordings/${RECORDING_UNMATCHED_ID}/link`,
          user,
          { interviewId: INTERVIEW_A_ID },
        )
        expect(res.statusCode).toBe(status)
        const row = await pool.query<{ interview_id: string | null }>(
          'SELECT interview_id FROM interview_recordings WHERE id = $1',
          [RECORDING_UNMATCHED_ID],
        )
        expect(row.rows[0]?.interview_id).toBeNull()
      })

      it('ADMIN → 404 for an unknown interview, nothing linked', async () => {
        const res = await request(
          'PATCH',
          `/api/interview-recordings/${RECORDING_UNMATCHED_ID}/link`,
          ADMIN,
          { interviewId: MISSING_ID },
        )
        expect(res.statusCode).toBe(404)
      })

      it('ADMIN links and unlinks; the linked SENIOR gains and then loses read access', async () => {
        const linked = await request(
          'PATCH',
          `/api/interview-recordings/${RECORDING_UNMATCHED_ID}/link`,
          ADMIN,
          { interviewId: INTERVIEW_B_ID },
        )
        expect(linked.statusCode).toBe(200)
        expect(
          (await request('GET', `/api/interview-recordings/${RECORDING_UNMATCHED_ID}`, SENIOR_B))
            .statusCode,
        ).toBe(200)

        const unlinked = await request(
          'PATCH',
          `/api/interview-recordings/${RECORDING_UNMATCHED_ID}/link`,
          ADMIN,
          { interviewId: null },
        )
        expect(unlinked.statusCode).toBe(200)
        expect(
          (await request('GET', `/api/interview-recordings/${RECORDING_UNMATCHED_ID}`, SENIOR_B))
            .statusCode,
        ).toBe(403)
      })
    })

    // ── SR-865-H-1: a user-controlled callUrl must not pull a foreign transcript ─
    describe('SR-865-H-1 — auto-match cannot be steered through callUrl', () => {
      beforeEach(async () => {
        await pool.query(`UPDATE interviews SET call_url = NULL WHERE senior_id = ANY($1)`, [
          ALL_USERS.map((u) => u.id),
        ])
      })

      async function recordingByExternalId(externalId: string) {
        const res = await pool.query<{ id: string; interview_id: string | null }>(
          `SELECT id, interview_id FROM interview_recordings
           WHERE connection_id = $1 AND external_recording_id = $2`,
          [CONNECTION_ID, externalId],
        )
        return res.rows[0]
      }

      it('SENIOR pre-sets a foreign Meet code as callUrl → the recording stays unmatched and unreadable', async () => {
        const patched = await request('PATCH', `/api/interviews/${INTERVIEW_A_ID}`, SENIOR_A, {
          callUrl: `https://meet.google.com/${FOREIGN_MEET_CODE}`,
        })
        expect(patched.statusCode).toBe(200)

        await recordings.ingestWebhookEvent(
          CONNECTION_ID,
          foreignMeetingEvent('mr-rbac-attack-preset', 1),
          CIPHERTEXT,
        )

        const row = await recordingByExternalId('mr-rbac-attack-preset')
        expect(row).toBeDefined()
        expect(row!.interview_id).toBeNull()
        const read = await request('GET', `/api/interview-recordings/${row!.id}`, SENIOR_A)
        expect(read.statusCode).toBe(403)
        const readHr = await request('GET', `/api/interview-recordings/${row!.id}`, HR_A)
        expect(readHr.statusCode).toBe(403)
      })

      it('SENIOR sets callUrl AND scheduledAt to the foreign meeting after it started → not linked', async () => {
        const event = foreignMeetingEvent('mr-rbac-attack-code-and-time', 1)
        const patched = await request('PATCH', `/api/interviews/${INTERVIEW_A_ID}`, SENIOR_A, {
          callUrl: `https://meet.google.com/${FOREIGN_MEET_CODE}`,
          scheduledAt: event.data.recording.startedAt,
        })
        expect(patched.statusCode).toBe(200)
        expect((patched.json() as { scheduledAt: string | null }).scheduledAt).toBe(
          event.data.recording.startedAt,
        )

        await recordings.ingestWebhookEvent(CONNECTION_ID, event, CIPHERTEXT)

        const row = await recordingByExternalId('mr-rbac-attack-code-and-time')
        expect(row!.interview_id).toBeNull()
        const read = await request('GET', `/api/interview-recordings/${row!.id}`, SENIOR_A)
        expect(read.statusCode).toBe(403)
      })

      it('audits every callUrl / scheduledAt change, and only those', async () => {
        const auditRows = async () =>
          (
            await pool.query<{ action: string; actor_user_id: string }>(
              `SELECT action, actor_user_id FROM meeting_recorder_audit_log
               WHERE interview_id = $1 ORDER BY created_at`,
              [INTERVIEW_B_ID],
            )
          ).rows
        const before = (await auditRows()).length

        await request('PATCH', `/api/interviews/${INTERVIEW_B_ID}`, SENIOR_B, {
          companyName: 'MR RBAC Co B renamed',
        })
        expect(await auditRows()).toHaveLength(before)

        await request('PATCH', `/api/interviews/${INTERVIEW_B_ID}`, SENIOR_B, {
          callUrl: 'https://meet.google.com/bbbb-bbbb-bbb',
        })
        await request('PATCH', `/api/interviews/${INTERVIEW_B_ID}`, ADMIN, {
          scheduledAt: '2026-11-01T10:00:00.000Z',
        })
        // Re-sending the same value is not a change.
        await request('PATCH', `/api/interviews/${INTERVIEW_B_ID}`, ADMIN, {
          scheduledAt: '2026-11-01T10:00:00.000Z',
        })

        expect((await auditRows()).slice(before)).toEqual([
          { action: 'interview-call-changed', actor_user_id: SENIOR_B.id },
          { action: 'interview-call-changed', actor_user_id: ADMIN.id },
        ])
      })

      it('SENIOR sets the code after the recording arrived → a later revision does not link it', async () => {
        await recordings.ingestWebhookEvent(
          CONNECTION_ID,
          foreignMeetingEvent('mr-rbac-attack-posthoc', 1),
          CIPHERTEXT,
        )
        const patched = await request('PATCH', `/api/interviews/${INTERVIEW_A_ID}`, SENIOR_A, {
          callUrl: `https://meet.google.com/${FOREIGN_MEET_CODE.toUpperCase()}`,
        })
        expect(patched.statusCode).toBe(200)

        await recordings.ingestWebhookEvent(
          CONNECTION_ID,
          foreignMeetingEvent('mr-rbac-attack-posthoc', 2),
          CIPHERTEXT,
        )

        const row = await recordingByExternalId('mr-rbac-attack-posthoc')
        expect(row!.interview_id).toBeNull()
        const read = await request('GET', `/api/interview-recordings/${row!.id}`, SENIOR_A)
        expect(read.statusCode).toBe(403)
      })
    })
  },
)
