import { Controller, Get, Global, Inject, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser, BoardSeniorDto } from '@crm/shared'
import { boardSeniorSchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { InterviewsService } from './interviews.service'
import { teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'

/**
 * task-hr-drop-team-senior-board — real-backend integration spec (real
 * Postgres, no mocks) for GET /api/interviews/seniors (AC1 + AC2 + AC3).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): a mocked-guard test gives
 * false confidence for anything behind RBAC. This spec exercises the REAL
 * InterviewsService.getBoardSeniors through a Fastify request with the REAL
 * JwtAuthGuard + RolesGuard against REAL PostgreSQL, so the RBAC gate
 * (ADMIN/SENIOR/HR → 200, JUNIOR/ACCOUNTANT/DROP → 403) is proven against an
 * actual JWT request, not a unit stub — AND, the actual reported bug (a
 * SENIOR whose only team is a DROP-type team) is reproduced against a REAL
 * `teams.type = 'DROP'` row, not a mocked membership graph.
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED). A DATABASE_URL that IS set but unusable/
 * unmigrated throws in beforeAll (reports FAILED). Neither case can look
 * like "passed" with zero assertions.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa_hrboard \
 *     pnpm --filter @crm/api test -- board-seniors.integration
 */

const JWT_SECRET = 'board-seniors-integration-secret-32-chars'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000001',
  email: 'bs-admin@test.spec',
  displayName: 'BS Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
// HR — active member of the DROP-type team, alongside an active SENIOR.
// This is the reported bug's exact repro shape.
const HR_DROP: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000002',
  email: 'bs-hr-drop@test.spec',
  displayName: 'BS HR Drop',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
// HR in an UNRELATED team — must never see SENIOR_DROP's board.
const HR_OTHER: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000003',
  email: 'bs-hr-other@test.spec',
  displayName: 'BS HR Other',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
// HR who LEFT the drop-team (their own team_members.leftAt is set).
const HR_LEFT: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000004',
  email: 'bs-hr-left@test.spec',
  displayName: 'BS HR Left',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR_DROP: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000005',
  email: 'bs-senior-drop@test.spec',
  displayName: 'BS Senior DropTeam',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
// Was in the drop-team, left it — must not surface for HR_DROP any more.
const SENIOR_LEFT: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000006',
  email: 'bs-senior-left@test.spec',
  displayName: 'BS Senior Left',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
// Active SENIOR, not on ANY team in this fixture — visible to ADMIN only.
const SENIOR_PLAIN: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000007',
  email: 'bs-senior-plain@test.spec',
  displayName: 'BS Senior Plain',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000008',
  email: 'bs-junior@test.spec',
  displayName: 'BS Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000009',
  email: 'bs-accountant@test.spec',
  displayName: 'BS Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: 'c2000000-0000-4000-aa00-000000000010',
  email: 'bs-drop@test.spec',
  displayName: 'BS Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEAM_DROP = 'c2000000-0000-4000-bb00-000000000001' // type='DROP' — the repro team
const TEAM_OTHER = 'c2000000-0000-4000-bb00-000000000002' // type='SENIOR' — unrelated team

const ALL_USERS = [
  ADMIN,
  HR_DROP,
  HR_OTHER,
  HR_LEFT,
  SENIOR_DROP,
  SENIOR_LEFT,
  SENIOR_PLAIN,
  JUNIOR,
  ACCOUNTANT,
  DROP,
]
const TEST_USER_IDS = ALL_USERS.map((u) => u.id)
// SENIOR_ARCHIVED is a plain row (not a full SessionUser — never logs in).
const SENIOR_ARCHIVED_ID = 'c2000000-0000-4000-aa00-000000000011'

// ── Sentinel controller — mirrors the real /interviews/seniors route ───────
const IV_SERVICE = 'IV_SERVICE_BOARD_SENIORS'

@Controller('interviews')
class SentinelInterviewsController {
  constructor(@Inject(IV_SERVICE) private readonly svc: InterviewsService) {}

  @Get('seniors')
  @Roles('ADMIN', 'SENIOR', 'HR')
  async boardSeniors(@CurrentUser() user: SessionUser) {
    const rows = await this.svc.getBoardSeniors(user)
    return boardSeniorSchema.array().parse(rows)
  }
}

// ── TestDatabaseModule (real Pool) ──────────────────────────────────────────
let _testPool: Pool | null = null

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _testPool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_testPool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _testPool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _testPool?.end() ?? Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [SentinelInterviewsController],
  providers: [
    Reflector,
    // ProjectsService collaborator is stubbed — getBoardSeniors never touches
    // it (read-only over users/teamMembers).
    {
      provide: InterviewsService,
      useFactory: (db: DatabaseService) => new InterviewsService(db, {} as never),
      inject: [DatabaseService],
    },
    { provide: IV_SERVICE, useExisting: InterviewsService },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new RolesGuard(reflector),
      inject: [Reflector],
    },
  ],
})
class BoardSeniorsTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe.skipIf(!hasDatabaseUrl())(
  'GET /interviews/seniors — real backend integration (real DB, no mocks)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let dbSvc: DatabaseService

    beforeAll(async () => {
      // Deliberately no local try/catch — a connectivity failure propagates
      // as-is and fails `beforeAll` loudly. `teams.type` is the one column
      // THIS spec's repro depends on.
      await assertRealDbSchema([
        { table: 'teams', column: 'type' },
        { table: 'users', column: 'avatar_document_id' },
      ])

      const moduleRef = await Test.createTestingModule({
        imports: [BoardSeniorsTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'board-seniors-integration-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      dbSvc = app.get(DatabaseService)
      const db = dbSvc.db

      // Surgical cleanup of any leftover rows BEFORE seeding (deterministic).
      await db.delete(teamMembers).where(inArray(teamMembers.userId, TEST_USER_IDS))
      await db.delete(teams).where(inArray(teams.id, [TEAM_DROP, TEAM_OTHER]))
      await db.delete(users).where(inArray(users.id, [...TEST_USER_IDS, SENIOR_ARCHIVED_ID]))

      // ── Seed users ────────────────────────────────────────────────────────
      await db
        .insert(users)
        .values(
          ALL_USERS.map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            googleId: `test-google-${u.id}`,
          })),
        )
        .onConflictDoNothing()
      await db
        .insert(users)
        .values({
          id: SENIOR_ARCHIVED_ID,
          email: 'bs-senior-archived@test.spec',
          displayName: 'BS Senior Archived',
          role: 'SENIOR',
          googleId: `test-google-${SENIOR_ARCHIVED_ID}`,
          archivedAt: new Date(),
        })
        .onConflictDoNothing()

      // ── Seed teams: TEAM_DROP is type='DROP' — the actual repro shape ──────
      await db
        .insert(teams)
        .values([
          { id: TEAM_DROP, name: 'BS Drop Team', type: 'DROP' },
          { id: TEAM_OTHER, name: 'BS Other Team', type: 'SENIOR' },
        ])
        .onConflictDoNothing()

      await db.insert(teamMembers).values([
        { teamId: TEAM_DROP, userId: HR_DROP.id },
        { teamId: TEAM_DROP, userId: SENIOR_DROP.id },
        { teamId: TEAM_DROP, userId: SENIOR_LEFT.id, leftAt: new Date('2026-01-15') },
        { teamId: TEAM_DROP, userId: HR_LEFT.id, leftAt: new Date('2026-01-20') },
        { teamId: TEAM_OTHER, userId: HR_OTHER.id },
      ])
    }, 30_000)

    afterAll(async () => {
      try {
        const db = dbSvc.db
        await db.delete(teamMembers).where(inArray(teamMembers.userId, TEST_USER_IDS))
        await db.delete(teams).where(inArray(teams.id, [TEAM_DROP, TEAM_OTHER]))
        await db.delete(users).where(inArray(users.id, [...TEST_USER_IDS, SENIOR_ARCHIVED_ID]))
      } catch {
        // non-fatal
      }
      await app.close()
    }, 15_000)

    function tokenFor(user: SessionUser): string {
      return jwt.sign(user)
    }

    async function seniorsAs(user: SessionUser) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/interviews/seniors',
        cookies: { jwt: tokenFor(user) },
      })
      return res
    }

    // ── RBAC (AC2) ───────────────────────────────────────────────────────────
    const forbidden: Array<[string, SessionUser]> = [
      ['JUNIOR', JUNIOR],
      ['ACCOUNTANT', ACCOUNTANT],
      ['DROP', DROP],
    ]
    for (const [label, persona] of forbidden) {
      it(`RBAC: ${label} → 403`, async () => {
        const res = await seniorsAs(persona)
        expect(res.statusCode).toBe(403)
      })
    }

    it('RBAC: ADMIN → 200', async () => {
      const res = await seniorsAs(ADMIN)
      expect(res.statusCode).toBe(200)
    })
    it('RBAC: HR → 200', async () => {
      const res = await seniorsAs(HR_DROP)
      expect(res.statusCode).toBe(200)
    })
    it('RBAC: SENIOR → 200', async () => {
      const res = await seniorsAs(SENIOR_DROP)
      expect(res.statusCode).toBe(200)
    })

    // ── AC1 — the reported bug: HR in a DROP-type team sees its SENIOR ──────
    it('HR in a DROP-type team sees the active senior of that team (reported bug repro)', async () => {
      const res = await seniorsAs(HR_DROP)
      const body = boardSeniorSchema.array().parse(res.json()) as BoardSeniorDto[]
      expect(body.map((s) => s.id)).toEqual([SENIOR_DROP.id])
    })

    it('HR NOT in the senior team gets no seniors', async () => {
      const res = await seniorsAs(HR_OTHER)
      const body = boardSeniorSchema.array().parse(res.json())
      expect(body).toEqual([])
    })

    it('a senior who left the drop-team is not returned to that team’s HR', async () => {
      const res = await seniorsAs(HR_DROP)
      const body = boardSeniorSchema.array().parse(res.json())
      expect(body.some((s) => s.id === SENIOR_LEFT.id)).toBe(false)
    })

    it('HR who left the team gets no seniors', async () => {
      const res = await seniorsAs(HR_LEFT)
      const body = boardSeniorSchema.array().parse(res.json())
      expect(body).toEqual([])
    })

    it('ADMIN sees every active senior, including the drop-team one, excluding the archived one', async () => {
      const res = await seniorsAs(ADMIN)
      const body = boardSeniorSchema.array().parse(res.json())
      const ids = body.map((s) => s.id)
      expect(ids).toEqual(expect.arrayContaining([SENIOR_DROP.id, SENIOR_LEFT.id, SENIOR_PLAIN.id]))
      expect(ids).not.toContain(SENIOR_ARCHIVED_ID)
    })

    it('SENIOR sees only themselves', async () => {
      const res = await seniorsAs(SENIOR_DROP)
      const body = boardSeniorSchema.array().parse(res.json())
      expect(body.map((s) => s.id)).toEqual([SENIOR_DROP.id])
    })

    // ── AC3 — masking ────────────────────────────────────────────────────────
    it('AC3: response has no email/phone/techStack/finance fields', async () => {
      const res = await seniorsAs(ADMIN)
      const raw = res.json() as Array<Record<string, unknown>>
      const droppy = raw.find((r) => r['id'] === SENIOR_DROP.id)
      expect(droppy).toBeDefined()
      expect(Object.keys(droppy!).sort()).toEqual(
        ['avatarDocumentId', 'avatarUrl', 'displayName', 'id'].sort(),
      )
      for (const forbiddenField of [
        'email',
        'phone',
        'techStack',
        'walletUsdtErc20',
        'monthlySalary',
        'legalFullName',
      ]) {
        expect(droppy).not.toHaveProperty(forbiddenField)
      }
    })
  },
)
