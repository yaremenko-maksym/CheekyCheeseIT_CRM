import { Controller, Get, Global, Inject, Module, Param } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { ProjectsService } from './projects.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { UsersService } from '../users/users.service'
import { projectMembers, projects, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * Projects JUNIOR finance-masking — real-backend integration spec.
 *
 * WHY this test exists:
 *   JUNIOR was granted access to /crm/projects/:id (for the legend feature).
 *   The project DTO contains financial fields (rate, currency, seniorSharePercent*,
 *   effectiveSeniorShare*) that JUNIOR must NOT see — "джун не видит ставку/выплаты".
 *   This spec proves that the backend DTO emitted to JUNIOR has these fields
 *   nulled out at the service layer, regardless of any UI-level gating.
 *
 *   Mocked-service tests cannot catch this class of leak (feedback_mocked_e2e_guards,
 *   2026-06-09 — incidents #157 + #158 were real data-leaks behind guards).
 *
 * WHAT it covers (GET /api/projects/:id):
 *   J1 (active member of Project A) → rate === null, currency === null,
 *     seniorSharePercentOverride === null, effectiveSeniorSharePercent === null,
 *     effectiveSeniorShareSource === null.
 *   ADMIN → real rate (non-null), real currency, real share values.
 *   SENIOR (S1, project owner) → real rate, real currency.
 *   HR_X (same team as S1) → real rate, real currency.
 *   ACCOUNTANT → real rate, real currency.
 *   J2 (not a member of Project A) → 403 IDOR guard (no finance leak via error).
 *
 * SEED:
 *   Isolated rows created in beforeAll, cleaned in afterAll.
 *   Namespace: a9b8c7d6-e5f4-4001-** (distinct from legends-rbac 4000 group).
 *
 * DB-SKIP-GUARD:
 *   dbAvailable=false when DATABASE_URL unreachable (CI unit job). Every test
 *   returns early — stays green in no-DB environments.
 */

const JWT_SECRET = 'projects-junior-finance-rbac-secret-32c'

// ── Test personas ─────────────────────────────────────────────────────────────
// Namespace: a9b8c7d6-e5f4-4001-<group>-<seq>

/** ADMIN from seed — always exists */
const ADMIN: SessionUser = {
  id: 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21',
  email: 'yaremenkomaksym99@gmail.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** ACCOUNTANT from seed */
const ACCOUNTANT: SessionUser = {
  id: 'c7e8d9a0-b1c2-4d3e-8f5a-6b7c8d9e0fbb',
  email: 'mykola.savchenko@cheekycheese.dev',
  displayName: 'Mykola Savchenko',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
  legalFullName: null,
}

const S1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4001-aa00-000000000001',
  email: 'fin-rbac-s1@test.spec',
  displayName: 'Finance RBAC Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** J1: active member of Project A — must NOT receive finance data */
const J1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4001-aa00-000000000002',
  email: 'fin-rbac-j1@test.spec',
  displayName: 'Finance RBAC Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** J2: member of Project B — must get 403 on Project A (IDOR) */
const J2: SessionUser = {
  id: 'a9b8c7d6-e5f4-4001-aa00-000000000003',
  email: 'fin-rbac-j2@test.spec',
  displayName: 'Finance RBAC Junior2',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const S2: SessionUser = {
  id: 'a9b8c7d6-e5f4-4001-aa00-000000000004',
  email: 'fin-rbac-s2@test.spec',
  displayName: 'Finance RBAC Senior2',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const HR_X: SessionUser = {
  id: 'a9b8c7d6-e5f4-4001-aa00-000000000005',
  email: 'fin-rbac-hrx@test.spec',
  displayName: 'Finance RBAC HR-X',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ── DB row IDs (bb00 group) ────────────────────────────────────────────────────
const PROJ_A_ID = 'a9b8c7d6-e5f4-4001-bb00-000000000010'
const PROJ_B_ID = 'a9b8c7d6-e5f4-4001-bb00-000000000011'
const TEAM_X_ID = 'a9b8c7d6-e5f4-4001-bb00-000000000020'
const PROJ_A_MEMBER_J1 = 'a9b8c7d6-e5f4-4001-bb00-000000000030'
const PROJ_B_MEMBER_J2 = 'a9b8c7d6-e5f4-4001-bb00-000000000031'

const TEST_USER_IDS = [S1.id, J1.id, J2.id, S2.id, HR_X.id]

/** The real rate stored in DB — JUNIOR must NOT see this */
const REAL_RATE = 3500

// ── Sentinel controller ────────────────────────────────────────────────────────

const PROJECTS_SERVICE_TOKEN = 'PROJECTS_SERVICE_TOKEN_FIN_RBAC'

@Controller('projects')
class SentinelProjectsController {
  constructor(@Inject(PROJECTS_SERVICE_TOKEN) private readonly svc: ProjectsService) {}

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findOne(id, user)
  }
}

// ── TestDatabaseModule ────────────────────────────────────────────────────────

let _testPool: Pool | null = null
let dbAvailable = true

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

// ── Test module ───────────────────────────────────────────────────────────────

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [SentinelProjectsController],
  providers: [
    Reflector,
    {
      provide: ProjectAuditLogService,
      useFactory: (db: DatabaseService) => new ProjectAuditLogService(db),
      inject: [DatabaseService],
    },
    {
      provide: UsersService,
      useFactory: (db: DatabaseService) => {
        // Minimal stub — ProjectsService only uses UsersService.findAll
        // in addMember, not in findOne. Safe to provide real instance.
        const svc = Object.create(UsersService.prototype) as UsersService
        Object.assign(svc, { db })
        return svc
      },
      inject: [DatabaseService],
    },
    {
      provide: ProjectsService,
      useFactory: (db: DatabaseService, auditLog: ProjectAuditLogService, usersSvc: UsersService) =>
        new ProjectsService(db, auditLog, usersSvc),
      inject: [DatabaseService, ProjectAuditLogService, UsersService],
    },
    {
      provide: PROJECTS_SERVICE_TOKEN,
      useExisting: ProjectsService,
    },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class ProjectsFinanceRbacTestModule {}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Projects JUNIOR finance-masking — real DB integration', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    // DB availability probe
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      console.warn(
        '[projects-junior-finance integration] SKIPPED — no DB at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ProjectsFinanceRbacTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'fin-rbac-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // ── Seed ─────────────────────────────────────────────────────────────────

    // 1. Users
    await db
      .insert(users)
      .values([
        {
          id: S1.id,
          email: S1.email,
          displayName: S1.displayName,
          role: 'SENIOR',
          googleId: `test-fin-${S1.id}`,
        },
        {
          id: J1.id,
          email: J1.email,
          displayName: J1.displayName,
          role: 'JUNIOR',
          googleId: `test-fin-${J1.id}`,
        },
        {
          id: J2.id,
          email: J2.email,
          displayName: J2.displayName,
          role: 'JUNIOR',
          googleId: `test-fin-${J2.id}`,
        },
        {
          id: S2.id,
          email: S2.email,
          displayName: S2.displayName,
          role: 'SENIOR',
          googleId: `test-fin-${S2.id}`,
        },
        {
          id: HR_X.id,
          email: HR_X.email,
          displayName: HR_X.displayName,
          role: 'HR',
          googleId: `test-fin-${HR_X.id}`,
        },
      ])
      .onConflictDoNothing()

    // 2. Projects — real rate = REAL_RATE (3500 USDT)
    await db
      .insert(projects)
      .values([
        {
          id: PROJ_A_ID,
          name: 'Finance RBAC Project A',
          companyName: 'Finance Corp A',
          domain: 'fintech',
          startDate: new Date('2025-03-01'),
          seniorId: S1.id,
          currency: 'USDT',
          rate: String(REAL_RATE),
        },
        {
          id: PROJ_B_ID,
          name: 'Finance RBAC Project B',
          companyName: 'Finance Corp B',
          domain: 'saas',
          startDate: new Date('2025-03-01'),
          seniorId: S2.id,
          currency: 'USD',
          rate: '5000',
        },
      ])
      .onConflictDoNothing()

    // 3. Project members
    await db
      .insert(projectMembers)
      .values([
        { id: PROJ_A_MEMBER_J1, projectId: PROJ_A_ID, userId: J1.id, joinedAt: new Date() },
        { id: PROJ_B_MEMBER_J2, projectId: PROJ_B_ID, userId: J2.id, joinedAt: new Date() },
      ])
      .onConflictDoNothing()

    // 4. Team X: HR_X + S1 (so HR_X can access Project A)
    await db
      .insert(teams)
      .values([{ id: TEAM_X_ID, name: 'Finance RBAC Team X' }])
      .onConflictDoNothing()
    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_X_ID, userId: HR_X.id, joinedAt: new Date() },
        { teamId: TEAM_X_ID, userId: S1.id, joinedAt: new Date() },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db
        .delete(projectMembers)
        .where(inArray(projectMembers.id, [PROJ_A_MEMBER_J1, PROJ_B_MEMBER_J2]))
      await db.delete(teamMembers).where(inArray(teamMembers.teamId, [TEAM_X_ID]))
      await db.delete(projects).where(inArray(projects.id, [PROJ_A_ID, PROJ_B_ID]))
      await db.delete(teams).where(inArray(teams.id, [TEAM_X_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // Non-fatal cleanup failure — do not mask test results
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── JUNIOR finance masking ────────────────────────────────────────────────

  it('FIN-1. JUNIOR (active member of Project A) → rate === null, currency === null', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(J1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      rate: number | null
      currency: string | null
      seniorSharePercentOverride: number | null
      effectiveSeniorSharePercent: number | null
      effectiveSeniorShareSource: string | null
    }
    // KEY assertions — finance data must be null in the DTO sent to JUNIOR
    expect(body.rate, 'rate must be null for JUNIOR').toBeNull()
    expect(body.currency, 'currency must be null for JUNIOR').toBeNull()
    expect(
      body.seniorSharePercentOverride,
      'seniorSharePercentOverride must be null for JUNIOR',
    ).toBeNull()
    expect(
      body.effectiveSeniorSharePercent,
      'effectiveSeniorSharePercent must be null for JUNIOR',
    ).toBeNull()
    expect(
      body.effectiveSeniorShareSource,
      'effectiveSeniorShareSource must be null for JUNIOR',
    ).toBeNull()
  })

  it('FIN-2. JUNIOR must NOT receive the real rate value (3500)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(J1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rate: number | null }
    // The real rate is 3500 — JUNIOR must not receive it
    expect(body.rate).not.toBe(REAL_RATE)
    expect(body.rate).toBeNull()
  })

  it('FIN-3. ADMIN → receives real rate and currency (non-null)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rate: number | null; currency: string | null }
    expect(body.rate).toBe(REAL_RATE)
    expect(body.currency).toBe('USDT')
  })

  it('FIN-4. SENIOR (S1, project owner) → receives real rate and currency', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(S1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rate: number | null; currency: string | null }
    expect(body.rate).toBe(REAL_RATE)
    expect(body.currency).toBe('USDT')
  })

  it('FIN-5. HR_X (same team as S1) → receives real rate and currency', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(HR_X) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rate: number | null; currency: string | null }
    expect(body.rate).toBe(REAL_RATE)
    expect(body.currency).toBe('USDT')
  })

  it('FIN-6. ACCOUNTANT → receives real rate and currency', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rate: number | null; currency: string | null }
    expect(body.rate).toBe(REAL_RATE)
    expect(body.currency).toBe('USDT')
  })

  it('FIN-7. J2 (member of Project B only) → 403 IDOR on Project A (no finance leak)', async () => {
    if (!dbAvailable) return
    // IDOR guard: J2 is not a member of Project A — must be denied entirely.
    // This also means no finance data can leak even via error body.
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(J2) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('FIN-8. JUNIOR (list via ProjectsService.findAll) → rate === null for all returned projects', async () => {
    if (!dbAvailable) return
    // Sentinel only exposes GET :id. Verify the list path via the service
    // directly — same mapProject codepath as the HTTP route.
    const svc = app.get(ProjectsService)
    const list = await svc.findAll(J1)
    // J1 should see only Project A (active project_member)
    expect(list.length).toBeGreaterThanOrEqual(1)
    const projA = list.find((p) => p.id === PROJ_A_ID)
    expect(projA, 'J1 must see their own project in list').toBeDefined()
    // KEY assertions: finance fields nulled at service layer for JUNIOR
    expect(projA!.rate, 'rate must be null for JUNIOR in list').toBeNull()
    expect(projA!.currency, 'currency must be null for JUNIOR in list').toBeNull()
    // Also check all returned projects have null finance — JUNIOR must never
    // receive finance data regardless of which project is returned.
    for (const p of list) {
      expect(p.rate, `rate must be null for JUNIOR in every list item`).toBeNull()
      expect(p.currency, `currency must be null for JUNIOR in every list item`).toBeNull()
    }
  })
})
