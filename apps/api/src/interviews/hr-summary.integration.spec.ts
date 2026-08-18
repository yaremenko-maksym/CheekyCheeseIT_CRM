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
import type { SessionUser, HrSummaryDto as HrSummaryDtoT } from '@crm/shared'
import { hrSummarySchema } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { InterviewsService } from './interviews.service'
import { interviews, projects, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * HR dashboard — hr-summary real-backend integration spec (real Postgres, no
 * mocks). AC1 + AC2 + AC4.
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. This spec exercises the REAL
 * InterviewsService.getHrSummary through a Fastify request with a real
 * JwtAuthGuard + RolesGuard against REAL PostgreSQL so:
 *   - the RBAC gate (HR/ADMIN → 200, everyone else → 403) is enforced against an
 *     actual JWT request, not a unit stub, and
 *   - the KPI aggregation + team-scope run over real rows (proving the SQL path).
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_hr_dash \
 *     pnpm --filter @crm/api test -- hr-summary.integration
 */

const JWT_SECRET = 'hr-summary-integration-secret-32-chars'

// ── Personas — stable IDs namespaced to THIS spec ───────────────────────────
const ADMIN: SessionUser = {
  id: 'b0000000-0000-4000-aa00-000000000001',
  email: 'hr-sum-admin@test.spec',
  displayName: 'HR Sum Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
// HR in a team WITH senior1 → can see senior1's board.
const HR: SessionUser = {
  id: 'b0000000-0000-4000-aa00-000000000002',
  email: 'hr-sum-hr@test.spec',
  displayName: 'HR Sum HR',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
// HR in NO team → empty team-scope → both interview KPI = 0.
const HR_NO_TEAM: SessionUser = {
  id: 'b0000000-0000-4000-aa00-000000000008',
  email: 'hr-sum-hr-noteam@test.spec',
  displayName: 'HR Sum HR NoTeam',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR_IN_TEAM: SessionUser = {
  id: 'b0000000-0000-4000-aa00-000000000003',
  email: 'hr-sum-senior1@test.spec',
  displayName: 'HR Sum Senior In Team',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
// Senior NOT in HR's team → his interviews must NOT count for HR (but DO for ADMIN).
const SENIOR_OUT_TEAM: SessionUser = {
  id: 'b0000000-0000-4000-aa00-000000000004',
  email: 'hr-sum-senior2@test.spec',
  displayName: 'HR Sum Senior Out Team',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  id: 'b0000000-0000-4000-aa00-000000000005',
  email: 'hr-sum-junior@test.spec',
  displayName: 'HR Sum Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'b0000000-0000-4000-aa00-000000000006',
  email: 'hr-sum-accountant@test.spec',
  displayName: 'HR Sum Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}
const DROP: SessionUser = {
  id: 'b0000000-0000-4000-aa00-000000000007',
  email: 'hr-sum-drop@test.spec',
  displayName: 'HR Sum Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEAM_ID = 'b0000000-0000-4000-bb00-000000000001'

// Spec-namespaced interview IDs so cleanup is surgical.
const IV_IN_ACTIVE_1 = 'b0000000-0000-4000-cc00-000000000001' // senior-in-team, TECH_INTERVIEW (active)
const IV_IN_ACTIVE_2 = 'b0000000-0000-4000-cc00-000000000002' // senior-in-team, HR_SCREEN (active)
const IV_IN_HIRED_THIS = 'b0000000-0000-4000-cc00-000000000003' // senior-in-team, HIRED this month
const IV_IN_HIRED_OLD = 'b0000000-0000-4000-cc00-000000000004' // senior-in-team, HIRED last month → excluded from hiredThisMonth
const IV_IN_REJECTED = 'b0000000-0000-4000-cc00-000000000005' // senior-in-team, REJECTED → excluded from openInterviews
const IV_IN_ARCHIVED = 'b0000000-0000-4000-cc00-000000000006' // senior-in-team, ARCHIVED → excluded from openInterviews
const IV_OUT_ACTIVE = 'b0000000-0000-4000-cc00-000000000007' // senior-OUT-team, FINAL_INTERVIEW (active) → NOT in HR scope
const IV_OUT_HIRED_THIS = 'b0000000-0000-4000-cc00-000000000008' // senior-OUT-team, HIRED this month → NOT in HR scope

const TEST_USER_IDS = [
  ADMIN.id,
  HR.id,
  HR_NO_TEAM.id,
  SENIOR_IN_TEAM.id,
  SENIOR_OUT_TEAM.id,
  JUNIOR.id,
  ACCOUNTANT.id,
  DROP.id,
]
const TEST_IV_IDS = [
  IV_IN_ACTIVE_1,
  IV_IN_ACTIVE_2,
  IV_IN_HIRED_THIS,
  IV_IN_HIRED_OLD,
  IV_IN_REJECTED,
  IV_IN_ARCHIVED,
  IV_OUT_ACTIVE,
  IV_OUT_HIRED_THIS,
]

// Project IDs for activeProjects KPI test
const PROJ_IN_ACTIVE_1 = 'b0000000-0000-4000-ee00-000000000001' // seniorId=SENIOR_IN_TEAM, no archivedAt → in HR scope
const PROJ_IN_ACTIVE_2 = 'b0000000-0000-4000-ee00-000000000002' // seniorId=SENIOR_IN_TEAM, no archivedAt → in HR scope
const PROJ_IN_ARCHIVED = 'b0000000-0000-4000-ee00-000000000003' // seniorId=SENIOR_IN_TEAM, archivedAt set → excluded
const PROJ_OUT_ACTIVE = 'b0000000-0000-4000-ee00-000000000004' // seniorId=SENIOR_OUT_TEAM, active → NOT in HR scope

const TEST_PROJ_IDS = [PROJ_IN_ACTIVE_1, PROJ_IN_ACTIVE_2, PROJ_IN_ARCHIVED, PROJ_OUT_ACTIVE]

// ── Sentinel controller — mirrors the real /interviews/hr-summary route ──────
const IV_SERVICE = 'IV_SERVICE_HR_SUM'

@Controller('interviews')
class SentinelInterviewsController {
  constructor(@Inject(IV_SERVICE) private readonly svc: InterviewsService) {}

  @Get('hr-summary')
  @Roles('ADMIN', 'HR')
  hrSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getHrSummary(user)
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
    // ProjectsService collaborator is stubbed — getHrSummary never touches it
    // (read-only aggregate over interviews + projects).
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
class HrSummaryTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe.skipIf(!hasDatabaseUrl())(
  'hr-summary — real backend integration (real DB, no mocks)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let dbSvc: DatabaseService

    // Baseline KPI captured BEFORE this spec inserts its own rows, so deltas hold
    // on a seeded crm_db AND on an empty scratch DB alike. ADMIN baseline (sees
    // all boards) is used for the global interview KPI; the HR baseline isolates
    // the team-scoped figures.
    let adminBaseline: HrSummaryDtoT | null = null
    let hrBaseline: HrSummaryDtoT | null = null

    const now = new Date()
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))

    beforeAll(async () => {
      try {
        const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probePool.query('SELECT 1')
        const schemaCheck = await probePool.query(
          `SELECT table_name FROM information_schema.tables
         WHERE table_name='interviews' LIMIT 1`,
        )
        await probePool.end()
        if (schemaCheck.rowCount === 0) {
          throw new Error('[hr-summary integration] FAILED — interviews table not found')
        }
      } catch {
        throw new Error(
          '[hr-summary integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      const moduleRef = await Test.createTestingModule({
        imports: [HrSummaryTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'hr-summary-integration-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      dbSvc = app.get(DatabaseService)
      const db = dbSvc.db

      // Surgical cleanup of any leftover rows BEFORE seeding (deterministic counts).
      await db.delete(projects).where(inArray(projects.id, TEST_PROJ_IDS))
      await db.delete(interviews).where(inArray(interviews.id, TEST_IV_IDS))
      await db.delete(teamMembers).where(inArray(teamMembers.userId, TEST_USER_IDS))
      await db.delete(teams).where(inArray(teams.id, [TEAM_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))

      // ── Seed users ──────────────────────────────────────────────────────────
      await db
        .insert(users)
        .values(
          [ADMIN, HR, HR_NO_TEAM, SENIOR_IN_TEAM, SENIOR_OUT_TEAM, JUNIOR, ACCOUNTANT, DROP].map(
            (u) => ({
              id: u.id,
              email: u.email,
              displayName: u.displayName,
              role: u.role,
              googleId: `test-google-${u.id}`,
            }),
          ),
        )
        .onConflictDoNothing()

      // ── Seed team: HR + SENIOR_IN_TEAM are members (active) ───────────────────
      await db
        .insert(teams)
        .values({ id: TEAM_ID, name: 'HR Sum Team', type: 'SENIOR' })
        .onConflictDoNothing()
      await db.insert(teamMembers).values([
        { teamId: TEAM_ID, userId: HR.id },
        { teamId: TEAM_ID, userId: SENIOR_IN_TEAM.id },
      ])

      // ── Capture baseline KPI BEFORE inserting this spec's interview rows ───────
      {
        const adminRes = await app.inject({
          method: 'GET',
          url: '/api/interviews/hr-summary',
          cookies: { jwt: jwt.sign(ADMIN) },
        })
        adminBaseline = hrSummarySchema.parse(adminRes.json())
        const hrRes = await app.inject({
          method: 'GET',
          url: '/api/interviews/hr-summary',
          cookies: { jwt: jwt.sign(HR) },
        })
        hrBaseline = hrSummarySchema.parse(hrRes.json())
      }

      // ── Seed interviews (deterministic KPI fixtures) ──────────────────────────
      // For SENIOR_IN_TEAM (in HR scope):
      //   2 active (TECH_INTERVIEW, HR_SCREEN), 1 HIRED-this-month, 1 HIRED-last-month
      //   (excluded), 1 REJECTED (excluded from open), 1 ARCHIVED (excluded from open).
      // For SENIOR_OUT_TEAM (NOT in HR scope, but in ADMIN's all-board view):
      //   1 active (FINAL_INTERVIEW), 1 HIRED-this-month.
      await db.insert(interviews).values([
        {
          id: IV_IN_ACTIVE_1,
          seniorId: SENIOR_IN_TEAM.id,
          companyName: 'In Active 1',
          stage: 'TECH_INTERVIEW',
          position: 0,
          createdAt: thisMonth,
          updatedAt: thisMonth,
        },
        {
          id: IV_IN_ACTIVE_2,
          seniorId: SENIOR_IN_TEAM.id,
          companyName: 'In Active 2',
          stage: 'HR_SCREEN',
          position: 1,
          createdAt: thisMonth,
          updatedAt: thisMonth,
        },
        {
          id: IV_IN_HIRED_THIS,
          seniorId: SENIOR_IN_TEAM.id,
          companyName: 'In Hired This',
          stage: 'HIRED',
          position: 0,
          createdAt: thisMonth,
          updatedAt: thisMonth,
        },
        {
          id: IV_IN_HIRED_OLD,
          seniorId: SENIOR_IN_TEAM.id,
          companyName: 'In Hired Old',
          stage: 'HIRED',
          position: 1,
          createdAt: lastMonth,
          updatedAt: lastMonth,
        },
        {
          id: IV_IN_REJECTED,
          seniorId: SENIOR_IN_TEAM.id,
          companyName: 'In Rejected',
          stage: 'REJECTED',
          position: 0,
          createdAt: thisMonth,
          updatedAt: thisMonth,
        },
        {
          id: IV_IN_ARCHIVED,
          seniorId: SENIOR_IN_TEAM.id,
          companyName: 'In Archived',
          stage: 'ARCHIVED',
          position: 0,
          createdAt: thisMonth,
          updatedAt: thisMonth,
        },
        {
          id: IV_OUT_ACTIVE,
          seniorId: SENIOR_OUT_TEAM.id,
          companyName: 'Out Active',
          stage: 'FINAL_INTERVIEW',
          position: 0,
          createdAt: thisMonth,
          updatedAt: thisMonth,
        },
        {
          id: IV_OUT_HIRED_THIS,
          seniorId: SENIOR_OUT_TEAM.id,
          companyName: 'Out Hired This',
          stage: 'HIRED',
          position: 0,
          createdAt: thisMonth,
          updatedAt: thisMonth,
        },
      ])

      // ── Seed projects for activeProjects KPI ──────────────────────────────────
      // PROJ_IN_ACTIVE_1 + PROJ_IN_ACTIVE_2 — in HR scope (SENIOR_IN_TEAM), active → +2 for HR.
      // PROJ_IN_ARCHIVED — in HR scope but archived → excluded from activeProjects.
      // PROJ_OUT_ACTIVE  — SENIOR_OUT_TEAM (not HR scope), active → +0 for HR, +1 for ADMIN.
      await db.insert(projects).values([
        {
          id: PROJ_IN_ACTIVE_1,
          name: 'HR Proj Active 1',
          companyName: 'TestCo',
          domain: 'AI',
          seniorId: SENIOR_IN_TEAM.id,
          startDate: thisMonth,
          rate: 1000,
          currency: 'USD',
        },
        {
          id: PROJ_IN_ACTIVE_2,
          name: 'HR Proj Active 2',
          companyName: 'TestCo',
          domain: 'AI',
          seniorId: SENIOR_IN_TEAM.id,
          startDate: thisMonth,
          rate: 1000,
          currency: 'USD',
        },
        {
          id: PROJ_IN_ARCHIVED,
          name: 'HR Proj Archived',
          companyName: 'TestCo',
          domain: 'AI',
          seniorId: SENIOR_IN_TEAM.id,
          startDate: thisMonth,
          rate: 1000,
          currency: 'USD',
          archivedAt: thisMonth,
        },
        {
          id: PROJ_OUT_ACTIVE,
          name: 'HR Proj Out Active',
          companyName: 'TestCo',
          domain: 'AI',
          seniorId: SENIOR_OUT_TEAM.id,
          startDate: thisMonth,
          rate: 1000,
          currency: 'USD',
        },
      ])
    }, 30_000)

    afterAll(async () => {
      try {
        const db = dbSvc.db
        await db.delete(projects).where(inArray(projects.id, TEST_PROJ_IDS))
        await db.delete(interviews).where(inArray(interviews.id, TEST_IV_IDS))
        await db.delete(teamMembers).where(inArray(teamMembers.userId, TEST_USER_IDS))
        await db.delete(teams).where(inArray(teams.id, [TEAM_ID]))
        await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // non-fatal
      }
      await app.close()
    }, 15_000)

    function tokenFor(user: SessionUser): string {
      return jwt.sign(user)
    }

    async function summaryAs(user: SessionUser): Promise<HrSummaryDtoT> {
      const res = await app.inject({
        method: 'GET',
        url: '/api/interviews/hr-summary',
        cookies: { jwt: tokenFor(user) },
      })
      return hrSummarySchema.parse(res.json())
    }

    // ── RBAC (AC2) ──────────────────────────────────────────────────────────────
    const forbidden: Array<[string, SessionUser]> = [
      ['SENIOR', SENIOR_IN_TEAM],
      ['JUNIOR', JUNIOR],
      ['ACCOUNTANT', ACCOUNTANT],
      ['DROP', DROP],
    ]
    for (const [label, persona] of forbidden) {
      it(`RBAC: ${label} → 403`, async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/interviews/hr-summary',
          cookies: { jwt: tokenFor(persona) },
        })
        expect(res.statusCode).toBe(403)
      })
    }

    it('RBAC: HR → 200', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/interviews/hr-summary',
        cookies: { jwt: tokenFor(HR) },
      })
      expect(res.statusCode).toBe(200)
    })

    it('RBAC: ADMIN → 200', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/interviews/hr-summary',
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
    })

    // ── KPI shape + correctness (AC1) ─────────────────────────────────────────────
    it('returns a schema-valid KPI payload for HR', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/interviews/hr-summary',
        cookies: { jwt: tokenFor(HR) },
      })
      expect(res.statusCode).toBe(200)
      const parsed = hrSummarySchema.parse(res.json())
      expect(parsed).toBeTruthy()
    })

    it('HR KPI deltas reflect ONLY the in-team senior board (team-scope)', async () => {
      expect(hrBaseline).not.toBeNull()
      const base = hrBaseline!
      const body = await summaryAs(HR)

      // Δ openInterviews for HR scope: IV_IN_ACTIVE_1 + IV_IN_ACTIVE_2 = +2.
      // HIRED/REJECTED/ARCHIVED rows excluded; SENIOR_OUT_TEAM rows NOT in scope.
      expect(body.openInterviews - base.openInterviews).toBe(2)

      // Δ hiredThisMonth for HR scope: IV_IN_HIRED_THIS = +1. HIRED-last-month
      // excluded; SENIOR_OUT_TEAM HIRED-this-month NOT in scope.
      expect(body.hiredThisMonth - base.hiredThisMonth).toBe(1)
    })

    it('ADMIN KPI deltas include ALL boards (no team-scope filter)', async () => {
      expect(adminBaseline).not.toBeNull()
      const base = adminBaseline!
      const body = await summaryAs(ADMIN)

      // Δ openInterviews for ADMIN: IV_IN_ACTIVE_1 + IV_IN_ACTIVE_2 + IV_OUT_ACTIVE = +3.
      expect(body.openInterviews - base.openInterviews).toBe(3)

      // Δ hiredThisMonth for ADMIN: IV_IN_HIRED_THIS + IV_OUT_HIRED_THIS = +2.
      expect(body.hiredThisMonth - base.hiredThisMonth).toBe(2)
    })

    it('team-scope: an out-of-team senior board NEVER leaks into HR figures', async () => {
      const base = hrBaseline!
      const body = await summaryAs(HR)
      // If team-scope regressed, HR would see SENIOR_OUT_TEAM's active (FINAL_INTERVIEW)
      // → delta 3, and his HIRED-this-month → delta 2. Both must stay at the in-team value.
      expect(body.openInterviews - base.openInterviews).toBe(2)
      expect(body.hiredThisMonth - base.hiredThisMonth).toBe(1)
    })

    it('HR with NO team gets 0 for both interview KPI (empty scope)', async () => {
      const body = await summaryAs(HR_NO_TEAM)
      expect(body.openInterviews).toBe(0)
      expect(body.hiredThisMonth).toBe(0)
    })

    // ── activeProjects (AC2) ─────────────────────────────────────────────────────
    it('HR activeProjects: only active non-archived projects of in-team seniors', async () => {
      expect(hrBaseline).not.toBeNull()
      const base = hrBaseline!
      const body = await summaryAs(HR)
      // Delta: PROJ_IN_ACTIVE_1 + PROJ_IN_ACTIVE_2 in HR scope, active → +2.
      // PROJ_IN_ARCHIVED is archived → excluded (delta 0).
      // PROJ_OUT_ACTIVE is SENIOR_OUT_TEAM → not in HR scope (delta 0).
      expect(body.activeProjects - base.activeProjects).toBe(2)
    })

    it('ADMIN activeProjects: sees all non-archived projects (no team-scope filter)', async () => {
      expect(adminBaseline).not.toBeNull()
      const base = adminBaseline!
      const body = await summaryAs(ADMIN)
      // Delta: PROJ_IN_ACTIVE_1 + PROJ_IN_ACTIVE_2 + PROJ_OUT_ACTIVE = +3.
      // PROJ_IN_ARCHIVED excluded (archived).
      expect(body.activeProjects - base.activeProjects).toBe(3)
    })

    it('team-scope: out-of-team project NEVER leaks into HR activeProjects', async () => {
      expect(hrBaseline).not.toBeNull()
      const base = hrBaseline!
      const body = await summaryAs(HR)
      // If team-scope regressed, HR would see PROJ_OUT_ACTIVE → delta 3. Must stay at 2.
      expect(body.activeProjects - base.activeProjects).toBe(2)
    })

    it('HR with NO team gets 0 activeProjects', async () => {
      const body = await summaryAs(HR_NO_TEAM)
      expect(body.activeProjects).toBe(0)
    })

    it('schema has no mySalaryStatus field', async () => {
      const body = await summaryAs(HR)
      // hrSummarySchema no longer contains mySalaryStatus — ensure it's absent.
      expect('mySalaryStatus' in body).toBe(false)
    })
  },
)
