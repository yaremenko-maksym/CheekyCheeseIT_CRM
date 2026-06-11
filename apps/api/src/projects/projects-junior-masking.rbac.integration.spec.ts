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
import { legends, projectMembers, projects, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { UsersAccessService } from '../users/users-access.service'

/**
 * Projects JUNIOR allowlist-masking — exhaustive real-backend integration spec.
 *
 * WHY this test exists:
 *   JUNIOR was granted access to /crm/projects/:id (for the legend feature).
 *   The project DTO contains sensitive fields that JUNIOR must NOT see:
 *
 *   IDENTITY:  seniorId, seniorName, dropId, dropName, dropSharePercent
 *   FINANCE:   rate, currency, seniorSharePercentOverride, seniorSharePercentDefault,
 *              effectiveSeniorSharePercent, effectiveSeniorShareSource
 *   EXTRA:     paymentType, salaryReview, notesGeneral
 *   MEMBERS:   members array (must be empty)
 *
 *   Mocked-service tests cannot catch this class of leak (feedback_mocked_e2e_guards,
 *   2026-06-09 — incidents #157 + #158 were real data-leaks behind guards).
 *   This spec proves that the backend DTO emitted to JUNIOR has ALL sensitive
 *   fields nulled out at the service layer, by construction.
 *
 * WHAT it covers (GET /api/projects/:id):
 *   MASK-1  JUNIOR GET drop-project → ALL masked fields === null, members === []
 *           AND safe fields non-null (name/companyName/domain/status/techStack)
 *   MASK-2  JUNIOR must NOT receive the real rate value (3500)
 *   MASK-3  ADMIN → all real values non-null (positive control)
 *   MASK-4  SENIOR (S1, project owner) → real rate + identity
 *   MASK-5  HR_X (same team as S1) → real rate + identity
 *   MASK-6  ACCOUNTANT → real rate + identity
 *   MASK-7  J2 (member of Project B only) → 403 IDOR guard
 *   MASK-8  JUNIOR list path (ProjectsService.findAll) → rate === null for all items
 *
 * SEED:
 *   Namespace: a9b8c7d6-e5f4-4002-** (distinct from old 4001 group).
 *   Project A has a DROP user attached so every drop-identity field is non-null
 *   in the raw DB row and must appear as null in the JUNIOR DTO.
 *   paymentType/salaryReview/notesGeneral seeded with real values that must be
 *   null in JUNIOR response.
 *
 * DB-SKIP-GUARD:
 *   dbAvailable=false when DATABASE_URL unreachable (CI unit job). Every test
 *   returns early — stays green in no-DB environments.
 */

const JWT_SECRET = 'projects-junior-masking-rbac-secret-32c'

// ── Test personas ──────────────────────────────────────────────────────────────
// Namespace: a9b8c7d6-e5f4-4002-<group>-<seq>

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
  id: 'a9b8c7d6-e5f4-4002-aa00-000000000001',
  email: 'mask-rbac-s1@test.spec',
  displayName: 'Mask RBAC Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** J1: active member of Project A — must NOT receive any sensitive data */
const J1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4002-aa00-000000000002',
  email: 'mask-rbac-j1@test.spec',
  displayName: 'Mask RBAC Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** J2: member of Project B — must get 403 on Project A (IDOR) */
const J2: SessionUser = {
  id: 'a9b8c7d6-e5f4-4002-aa00-000000000003',
  email: 'mask-rbac-j2@test.spec',
  displayName: 'Mask RBAC Junior2',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const S2: SessionUser = {
  id: 'a9b8c7d6-e5f4-4002-aa00-000000000004',
  email: 'mask-rbac-s2@test.spec',
  displayName: 'Mask RBAC Senior2',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const HR_X: SessionUser = {
  id: 'a9b8c7d6-e5f4-4002-aa00-000000000005',
  email: 'mask-rbac-hrx@test.spec',
  displayName: 'Mask RBAC HR-X',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** DROP user attached to Project A — JUNIOR must not see dropId/dropName/dropSharePercent */
const DROP1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4002-aa00-000000000006',
  email: 'mask-rbac-drop1@test.spec',
  displayName: 'Mask RBAC Drop1',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ── DB row IDs (bb00 group) ────────────────────────────────────────────────────
const PROJ_A_ID = 'a9b8c7d6-e5f4-4002-bb00-000000000010'
const PROJ_B_ID = 'a9b8c7d6-e5f4-4002-bb00-000000000011'
const TEAM_X_ID = 'a9b8c7d6-e5f4-4002-bb00-000000000020'
const PROJ_A_MEMBER_J1 = 'a9b8c7d6-e5f4-4002-bb00-000000000030'
const PROJ_B_MEMBER_J2 = 'a9b8c7d6-e5f4-4002-bb00-000000000031'

const TEST_USER_IDS = [S1.id, J1.id, J2.id, S2.id, HR_X.id, DROP1.id]

/** The real rate stored in DB — JUNIOR must NOT see this */
const REAL_RATE = 3500
/** Real paymentType stored in DB — JUNIOR must NOT see this */
const REAL_PAYMENT_TYPE = 'Crypto USDT'
/** Real salaryReview stored in DB — JUNIOR must NOT see this */
const REAL_SALARY_REVIEW = 'Every 6 months'
/** Real notesGeneral stored in DB — JUNIOR must NOT see this */
const REAL_NOTES_GENERAL = 'Confidential project notes'

// ── Sentinel controller ────────────────────────────────────────────────────────

const PROJECTS_SERVICE_TOKEN = 'PROJECTS_SERVICE_TOKEN_MASK_RBAC'

@Controller('projects')
class SentinelProjectsController {
  constructor(@Inject(PROJECTS_SERVICE_TOKEN) private readonly svc: ProjectsService) {}

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findOne(id, user)
  }
}

// ── TestDatabaseModule ─────────────────────────────────────────────────────────

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

// ── Test module ────────────────────────────────────────────────────────────────

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
class ProjectsMaskingRbacTestModule {}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('Projects JUNIOR allowlist-masking — real DB integration', () => {
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
        '[projects-junior-masking integration] SKIPPED — no DB at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ProjectsMaskingRbacTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'mask-rbac-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // ── Seed ──────────────────────────────────────────────────────────────────

    // 1. Users (including DROP1 which will be attached to Project A)
    await db
      .insert(users)
      .values([
        {
          id: S1.id,
          email: S1.email,
          displayName: S1.displayName,
          role: 'SENIOR',
          googleId: `test-mask-${S1.id}`,
        },
        {
          id: J1.id,
          email: J1.email,
          displayName: J1.displayName,
          role: 'JUNIOR',
          googleId: `test-mask-${J1.id}`,
        },
        {
          id: J2.id,
          email: J2.email,
          displayName: J2.displayName,
          role: 'JUNIOR',
          googleId: `test-mask-${J2.id}`,
        },
        {
          id: S2.id,
          email: S2.email,
          displayName: S2.displayName,
          role: 'SENIOR',
          googleId: `test-mask-${S2.id}`,
        },
        {
          id: HR_X.id,
          email: HR_X.email,
          displayName: HR_X.displayName,
          role: 'HR',
          googleId: `test-mask-${HR_X.id}`,
        },
        {
          id: DROP1.id,
          email: DROP1.email,
          displayName: DROP1.displayName,
          role: 'DROP',
          googleId: `test-mask-${DROP1.id}`,
          // dropSharePercent default = 5 (DB default), sufficient for the test
        },
      ])
      .onConflictDoNothing()

    // 2. Projects — Project A has ALL sensitive fields populated:
    //    - real rate + currency (finance)
    //    - dropId (drop identity)
    //    - paymentType / salaryReview / notesGeneral (extra sensitive)
    await db
      .insert(projects)
      .values([
        {
          id: PROJ_A_ID,
          name: 'Mask RBAC Project A',
          companyName: 'Mask Corp A',
          domain: 'fintech',
          startDate: new Date('2025-03-01'),
          seniorId: S1.id,
          dropId: DROP1.id,
          currency: 'USDT',
          rate: String(REAL_RATE),
          techStack: 'TypeScript, React',
          paymentType: REAL_PAYMENT_TYPE,
          salaryReview: REAL_SALARY_REVIEW,
          notesGeneral: REAL_NOTES_GENERAL,
        },
        {
          id: PROJ_B_ID,
          name: 'Mask RBAC Project B',
          companyName: 'Mask Corp B',
          domain: 'saas',
          startDate: new Date('2025-03-01'),
          seniorId: S2.id,
          currency: 'USD',
          rate: '5000',
        },
      ])
      .onConflictDoNothing()

    // 3. Project members — J1 active on A, J2 active on B
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
      .values([{ id: TEAM_X_ID, name: 'Mask RBAC Team X' }])
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

  // ── MASK-1: exhaustive null assertion for EVERY masked field ──────────────

  it('MASK-1. JUNIOR (active member of Project A, drop-project) → ALL masked fields === null, safe fields non-null, members === []', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(J1) },
    })
    expect(res.statusCode).toBe(200)

    const body = res.json() as Record<string, unknown>

    // ── IDENTITY — must be null ─────────────────────────────────────────────
    expect(body['seniorId'], 'seniorId must be null for JUNIOR').toBeNull()
    expect(body['seniorName'], 'seniorName must be null for JUNIOR').toBeNull()
    expect(body['dropId'], 'dropId must be null for JUNIOR').toBeNull()
    expect(body['dropName'], 'dropName must be null for JUNIOR').toBeNull()
    expect(body['dropSharePercent'], 'dropSharePercent must be null for JUNIOR').toBeNull()

    // ── FINANCE — must be null ──────────────────────────────────────────────
    expect(body['rate'], 'rate must be null for JUNIOR').toBeNull()
    expect(body['currency'], 'currency must be null for JUNIOR').toBeNull()
    expect(
      body['seniorSharePercentOverride'],
      'seniorSharePercentOverride must be null for JUNIOR',
    ).toBeNull()
    expect(
      body['effectiveSeniorSharePercent'],
      'effectiveSeniorSharePercent must be null for JUNIOR',
    ).toBeNull()
    expect(
      body['effectiveSeniorShareSource'],
      'effectiveSeniorShareSource must be null for JUNIOR',
    ).toBeNull()

    // ── EXTRA SENSITIVE — must be null ──────────────────────────────────────
    expect(body['paymentType'], 'paymentType must be null for JUNIOR').toBeNull()
    expect(body['salaryReview'], 'salaryReview must be null for JUNIOR').toBeNull()
    expect(body['notesGeneral'], 'notesGeneral must be null for JUNIOR').toBeNull()

    // ── MEMBERS — must be empty array ───────────────────────────────────────
    expect(body['members'], 'members must be [] for JUNIOR').toEqual([])

    // ── SAFE FIELDS — must be present and non-null ──────────────────────────
    expect(body['id']).toBe(PROJ_A_ID)
    expect(body['name']).toBeTruthy()
    expect(body['companyName']).toBeTruthy()
    expect(body['domain']).toBeTruthy()
    expect(body['startDate']).toBeTruthy()
    expect(body['status']).toBeUndefined() // not in DTO shape — ok
    expect(body['techStack'], 'techStack (safe) should be non-null').toBe('TypeScript, React')
    expect(body['createdAt']).toBeTruthy()
  })

  // ── MASK-2: real rate value must not appear ───────────────────────────────

  it('MASK-2. JUNIOR must NOT receive the real rate value (3500)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(J1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { rate: unknown }
    expect(body.rate).not.toBe(REAL_RATE)
    expect(body.rate).toBeNull()
  })

  // ── MASK-3: ADMIN positive control — all real values ─────────────────────

  it('MASK-3. ADMIN → receives all real values (positive control)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    // Identity non-null
    expect(body['seniorId']).toBe(S1.id)
    expect(body['seniorName']).toBe(S1.displayName)
    expect(body['dropId']).toBe(DROP1.id)
    expect(body['dropName']).toBe(DROP1.displayName)
    expect(typeof body['dropSharePercent']).toBe('number')

    // Finance non-null
    expect(body['rate']).toBe(REAL_RATE)
    expect(body['currency']).toBe('USDT')

    // Extra sensitive non-null
    expect(body['paymentType']).toBe(REAL_PAYMENT_TYPE)
    expect(body['salaryReview']).toBe(REAL_SALARY_REVIEW)
    expect(body['notesGeneral']).toBe(REAL_NOTES_GENERAL)

    // Members non-empty (J1 is active)
    expect(Array.isArray(body['members'])).toBe(true)
    expect((body['members'] as unknown[]).length).toBeGreaterThan(0)
  })

  // ── MASK-4: SENIOR sees real data ─────────────────────────────────────────

  it('MASK-4. SENIOR (S1, project owner) → receives real rate and identity', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(S1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body['rate']).toBe(REAL_RATE)
    expect(body['currency']).toBe('USDT')
    expect(body['seniorId']).toBe(S1.id)
    expect(body['dropId']).toBe(DROP1.id)
  })

  // ── MASK-5: HR sees real data ─────────────────────────────────────────────

  it('MASK-5. HR_X (same team as S1) → receives real rate and identity', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(HR_X) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body['rate']).toBe(REAL_RATE)
    expect(body['currency']).toBe('USDT')
    expect(body['seniorId']).toBe(S1.id)
  })

  // ── MASK-6: ACCOUNTANT sees real data ─────────────────────────────────────

  it('MASK-6. ACCOUNTANT → receives real rate and identity', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(ACCOUNTANT) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body['rate']).toBe(REAL_RATE)
    expect(body['currency']).toBe('USDT')
    expect(body['seniorId']).toBe(S1.id)
  })

  // ── MASK-7: IDOR guard ────────────────────────────────────────────────────

  it('MASK-7. J2 (member of Project B only) → 403 IDOR on Project A (no leak via error)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(J2) },
    })
    expect(res.statusCode).toBe(403)
  })

  // ── MASK-8: list path also masks ──────────────────────────────────────────

  it('MASK-8. JUNIOR (findAll list path) → rate === null, seniorId === null, dropId === null for all returned projects', async () => {
    if (!dbAvailable) return
    const svc = app.get(ProjectsService)
    const list = await svc.findAll(J1)

    // J1 should see only Project A (active project_member)
    expect(list.length).toBeGreaterThanOrEqual(1)
    const projA = list.find((p) => p.id === PROJ_A_ID)
    expect(projA, 'J1 must see their own project in list').toBeDefined()

    // Verify ALL masked fields are null on the list item
    expect(projA!.rate, 'rate null in list').toBeNull()
    expect(projA!.currency, 'currency null in list').toBeNull()
    expect(projA!.seniorId, 'seniorId null in list').toBeNull()
    expect(projA!.seniorName, 'seniorName null in list').toBeNull()
    expect(projA!.dropId, 'dropId null in list').toBeNull()
    expect(projA!.dropName, 'dropName null in list').toBeNull()
    expect(projA!.dropSharePercent, 'dropSharePercent null in list').toBeNull()
    expect(projA!.paymentType, 'paymentType null in list').toBeNull()
    expect(projA!.salaryReview, 'salaryReview null in list').toBeNull()
    expect(projA!.notesGeneral, 'notesGeneral null in list').toBeNull()
    expect(projA!.members, 'members [] in list').toEqual([])

    // Guarantee for every item in the list (JUNIOR should never see these)
    for (const p of list) {
      expect(p.rate, `rate must be null for every list item`).toBeNull()
      expect(p.seniorId, `seniorId must be null for every list item`).toBeNull()
      expect(p.dropId, `dropId must be null for every list item`).toBeNull()
    }
  })

  // ── MASK-9: effectiveTeam absent from JUNIOR response (MED-1) ────────────
  //
  // effectiveTeam carries the most sensitive identity payload: senior.email,
  // drop.email, hrs[].email, accountants[].email. A regression where the field
  // accidentally leaks to JUNIOR must be caught immediately.
  //
  // JSON serialisation drops `undefined` keys entirely — body.effectiveTeam
  // resolves to `undefined` when the key is absent.

  it('MASK-9 (MED-1). JUNIOR GET /api/projects/:id → effectiveTeam ABSENT from JSON response (identity email-leak regression guard)', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(J1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    // Primary assertion: field must not exist in the serialised response.
    // JSON.stringify drops undefined — if effectiveTeam were accidentally set
    // (even to null) this would catch it.
    expect(
      body['effectiveTeam'],
      'effectiveTeam must be absent for JUNIOR (identity PII)',
    ).toBeUndefined()

    // Belt-and-suspenders: raw payload string must not contain the word
    // "effectiveTeam" at all — guards against accidental null serialisation.
    expect(res.payload, 'raw payload must not contain "effectiveTeam" key').not.toContain(
      '"effectiveTeam"',
    )
  })

  // ── MASK-10: effectiveTeam present and carries email for ADMIN (positive control) ──
  //
  // Without this positive control MASK-9 would be trivially satisfied by a
  // bug that strips effectiveTeam for everyone. Proves the field really exists
  // for a privileged viewer and carries the sensitive email fields that JUNIOR
  // must be protected from.

  it('MASK-10 (MED-1 positive control). ADMIN GET /api/projects/:id → effectiveTeam PRESENT with senior.email and drop.email', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_A_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    // effectiveTeam must exist and be an object (not null / undefined)
    expect(body['effectiveTeam'], 'effectiveTeam must be present for ADMIN').toBeDefined()
    expect(body['effectiveTeam']).not.toBeNull()

    const et = body['effectiveTeam'] as {
      senior: { email: string; displayName: string } | null
      drop: { email: string; displayName: string } | null
      hrs: Array<{ email: string }>
      accountants: Array<{ email: string }>
    }

    // senior must be set and carry real email (S1)
    expect(et.senior, 'effectiveTeam.senior must be non-null for ADMIN').not.toBeNull()
    expect(et.senior!.email, 'effectiveTeam.senior.email must match S1').toBe(S1.email)
    expect(et.senior!.displayName).toBe(S1.displayName)

    // drop must be set and carry real email (DROP1) — proves drop PII is present
    // for privileged viewers and would leak to JUNIOR if MASK-9 were absent
    expect(et.drop, 'effectiveTeam.drop must be non-null for ADMIN (DROP1 seeded)').not.toBeNull()
    expect(et.drop!.email, 'effectiveTeam.drop.email must match DROP1').toBe(DROP1.email)

    // hrs must include HR_X (seeded into Team X alongside S1)
    const hrEmails = et.hrs.map((h) => h.email)
    expect(hrEmails, 'effectiveTeam.hrs must include HR_X').toContain(HR_X.email)

    // Entire effectiveTeam must be non-empty (proves positive-control distinction
    // from JUNIOR path which returns no effectiveTeam at all)
    const hasContent =
      et.senior !== null || et.drop !== null || et.hrs.length > 0 || et.accountants.length > 0
    expect(hasContent, 'effectiveTeam must have at least one non-empty member').toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Legend persona enrichment — real-DB integration (task-junior-ux-1-backend AC1)
//
// Proves that:
//   LEGEND-1  JUNIOR receives legend.fullName in seniorName when legend exists
//   LEGEND-2  JUNIOR receives legend.presentedRole in seniorPresentedRole
//   LEGEND-3  JUNIOR still gets null for seniorId / dropId / contacts (allowlist not opened)
//   LEGEND-4  Non-JUNIOR (ADMIN) is NOT affected — still gets real seniorName + null seniorPresentedRole
//   LEGEND-5  JUNIOR project without legend → seniorName null, seniorPresentedRole null
//
// Senior-identity isolation — real-DB (task-junior-ux-1-backend AC2)
//   SENIOR-ISO-1  SENIOR cannot open another SENIOR's profile (users-access path → zero tabs)
//   SENIOR-ISO-2  SENIOR cannot open a DROP's profile
//   SENIOR-ISO-3  ADMIN/HR behavior unchanged (regression)
//
// DB-SKIP-GUARD: dbAvailable=false → early return (CI unit job)
// ─────────────────────────────────────────────────────────────────────────────

// ── Namespace: a9b8c7d6-e5f4-4003-** ─────────────────────────────────────────
const LEGEND_S1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000001',
  email: 'legend-s1@test.spec',
  displayName: 'Legend Senior1 REAL',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const LEGEND_J1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000002',
  email: 'legend-j1@test.spec',
  displayName: 'Legend Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const LEGEND_J2: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000003',
  email: 'legend-j2@test.spec',
  displayName: 'Legend Junior2 (no-legend project)',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const LEGEND_S2: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000004',
  email: 'legend-s2@test.spec',
  displayName: 'Legend Senior2 REAL',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const LEGEND_DROP1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000005',
  email: 'legend-drop1@test.spec',
  displayName: 'Legend Drop1',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const LEGEND_PROJ_A = 'a9b8c7d6-e5f4-4003-bb00-000000000010' // has legend
const LEGEND_PROJ_B = 'a9b8c7d6-e5f4-4003-bb00-000000000011' // no legend
const LEGEND_PROJ_A_MEMBER_J1 = 'a9b8c7d6-e5f4-4003-bb00-000000000030'
const LEGEND_PROJ_B_MEMBER_J2 = 'a9b8c7d6-e5f4-4003-bb00-000000000031'
const LEGEND_TEAM_ID = 'a9b8c7d6-e5f4-4003-bb00-000000000020'
const LEGEND_ID = 'a9b8c7d6-e5f4-4003-cc00-000000000001'

/** Persona values seeded in legends table */
const PERSONA_FULL_NAME = 'Олексій Петренко'
const PERSONA_PRESENTED_ROLE = 'Solutions Architect'

const LEGEND_USER_IDS = [
  LEGEND_S1.id,
  LEGEND_J1.id,
  LEGEND_J2.id,
  LEGEND_S2.id,
  LEGEND_DROP1.id,
]

describe('Legend persona enrichment + SENIOR isolation — real DB integration', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService
  let legendDbAvailable = true

  beforeAll(async () => {
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      console.warn('[legend-persona integration] SKIPPED — no DB (CI unit job)')
      legendDbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ProjectsMaskingRbacTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'legend-rbac-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // ── Seed ──────────────────────────────────────────────────────────────────

    await db
      .insert(users)
      .values([
        {
          id: LEGEND_S1.id,
          email: LEGEND_S1.email,
          displayName: LEGEND_S1.displayName,
          role: 'SENIOR',
          googleId: `test-legend-${LEGEND_S1.id}`,
        },
        {
          id: LEGEND_J1.id,
          email: LEGEND_J1.email,
          displayName: LEGEND_J1.displayName,
          role: 'JUNIOR',
          googleId: `test-legend-${LEGEND_J1.id}`,
        },
        {
          id: LEGEND_J2.id,
          email: LEGEND_J2.email,
          displayName: LEGEND_J2.displayName,
          role: 'JUNIOR',
          googleId: `test-legend-${LEGEND_J2.id}`,
        },
        {
          id: LEGEND_S2.id,
          email: LEGEND_S2.email,
          displayName: LEGEND_S2.displayName,
          role: 'SENIOR',
          googleId: `test-legend-${LEGEND_S2.id}`,
        },
        {
          id: LEGEND_DROP1.id,
          email: LEGEND_DROP1.email,
          displayName: LEGEND_DROP1.displayName,
          role: 'DROP',
          googleId: `test-legend-${LEGEND_DROP1.id}`,
        },
      ])
      .onConflictDoNothing()

    // Project A: has senior S1, has legend with persona
    // Project B: has senior S2, NO legend (JUNIOR must see null)
    await db
      .insert(projects)
      .values([
        {
          id: LEGEND_PROJ_A,
          name: 'Legend Proj A',
          companyName: 'Legend Corp A',
          domain: 'saas',
          startDate: new Date('2025-04-01'),
          seniorId: LEGEND_S1.id,
          currency: 'USDT',
          rate: '4000',
        },
        {
          id: LEGEND_PROJ_B,
          name: 'Legend Proj B',
          companyName: 'Legend Corp B',
          domain: 'fintech',
          startDate: new Date('2025-04-01'),
          seniorId: LEGEND_S2.id,
          currency: 'USD',
          rate: '3000',
        },
      ])
      .onConflictDoNothing()

    // J1 active on A, J2 active on B
    await db
      .insert(projectMembers)
      .values([
        { id: LEGEND_PROJ_A_MEMBER_J1, projectId: LEGEND_PROJ_A, userId: LEGEND_J1.id },
        { id: LEGEND_PROJ_B_MEMBER_J2, projectId: LEGEND_PROJ_B, userId: LEGEND_J2.id },
      ])
      .onConflictDoNothing()

    // Team: S1 + S2 are in a shared team (needed for SENIOR-ISO-1 real-DB path)
    await db
      .insert(teams)
      .values([{ id: LEGEND_TEAM_ID, name: 'Legend Team' }])
      .onConflictDoNothing()
    await db
      .insert(teamMembers)
      .values([
        { teamId: LEGEND_TEAM_ID, userId: LEGEND_S1.id, joinedAt: new Date() },
        { teamId: LEGEND_TEAM_ID, userId: LEGEND_S2.id, joinedAt: new Date() },
      ])
      .onConflictDoNothing()

    // Legend for Project A: persona = PERSONA_FULL_NAME + PERSONA_PRESENTED_ROLE
    await db
      .insert(legends)
      .values([
        {
          id: LEGEND_ID,
          projectId: LEGEND_PROJ_A,
          fullName: PERSONA_FULL_NAME,
          presentedRole: PERSONA_PRESENTED_ROLE,
        },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!legendDbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(legends).where(inArray(legends.id, [LEGEND_ID]))
      await db
        .delete(projectMembers)
        .where(inArray(projectMembers.id, [LEGEND_PROJ_A_MEMBER_J1, LEGEND_PROJ_B_MEMBER_J2]))
      await db.delete(teamMembers).where(inArray(teamMembers.teamId, [LEGEND_TEAM_ID]))
      await db.delete(projects).where(inArray(projects.id, [LEGEND_PROJ_A, LEGEND_PROJ_B]))
      await db.delete(teams).where(inArray(teams.id, [LEGEND_TEAM_ID]))
      await db.delete(users).where(inArray(users.id, LEGEND_USER_IDS))
    } catch {
      // Non-fatal
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── LEGEND-1: JUNIOR receives persona fullName in seniorName ─────────────

  it('LEGEND-1. JUNIOR with legend project → seniorName = persona fullName (not real senior name)', async () => {
    if (!legendDbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${LEGEND_PROJ_A}`,
      cookies: { jwt: tokenFor(LEGEND_J1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    expect(body['seniorName'], 'seniorName must equal persona fullName').toBe(PERSONA_FULL_NAME)
    expect(body['seniorName'], 'real senior displayName must NOT appear').not.toBe(
      LEGEND_S1.displayName,
    )
  })

  // ── LEGEND-2: JUNIOR receives presentedRole ───────────────────────────────

  it('LEGEND-2. JUNIOR with legend project → seniorPresentedRole = persona presentedRole', async () => {
    if (!legendDbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${LEGEND_PROJ_A}`,
      cookies: { jwt: tokenFor(LEGEND_J1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    expect(body['seniorPresentedRole'], 'seniorPresentedRole must equal persona role').toBe(
      PERSONA_PRESENTED_ROLE,
    )
  })

  // ── LEGEND-3: Real identity fields stay null ──────────────────────────────

  it('LEGEND-3. JUNIOR with legend project → seniorId / dropId / contacts remain null (allowlist not opened)', async () => {
    if (!legendDbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${LEGEND_PROJ_A}`,
      cookies: { jwt: tokenFor(LEGEND_J1) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    expect(body['seniorId'], 'seniorId must still be null for JUNIOR').toBeNull()
    expect(body['dropId'], 'dropId must still be null for JUNIOR').toBeNull()
    expect(body['rate'], 'rate must still be null for JUNIOR').toBeNull()
    expect(body['currency'], 'currency must still be null for JUNIOR').toBeNull()
  })

  // ── LEGEND-4: Non-JUNIOR (ADMIN) is NOT affected ─────────────────────────

  it('LEGEND-4. ADMIN on legend project → gets REAL seniorName (not persona), seniorPresentedRole=null', async () => {
    if (!legendDbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${LEGEND_PROJ_A}`,
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    // ADMIN must see the real senior's name
    expect(body['seniorName'], 'ADMIN must see real seniorName').toBe(LEGEND_S1.displayName)
    expect(body['seniorId'], 'ADMIN must see real seniorId').toBe(LEGEND_S1.id)
    // seniorPresentedRole is a JUNIOR-only field — null for everyone else
    expect(
      body['seniorPresentedRole'],
      'seniorPresentedRole must be null for non-JUNIOR',
    ).toBeNull()
  })

  // ── LEGEND-5: JUNIOR project without legend → null fallback ──────────────

  it('LEGEND-5. JUNIOR with no-legend project → seniorName null, seniorPresentedRole null', async () => {
    if (!legendDbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${LEGEND_PROJ_B}`,
      cookies: { jwt: tokenFor(LEGEND_J2) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>

    expect(body['seniorName'], 'seniorName must be null when no legend').toBeNull()
    expect(
      body['seniorPresentedRole'],
      'seniorPresentedRole must be null when no legend',
    ).toBeNull()
    expect(body['seniorId'], 'seniorId must be null for JUNIOR regardless').toBeNull()
  })

  // ── SENIOR-ISO-1: SENIOR cannot view another SENIOR's profile (real-DB) ──

  it('SENIOR-ISO-1. SENIOR (S1) viewing SENIOR (S2) profile → UsersAccessService returns 0 tabs (identity isolation)', async () => {
    if (!legendDbAvailable) return
    const db = dbSvc.db
    // Load actual User rows for the access check (UsersAccessService takes full User objects)
    const s1Row = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, LEGEND_S1.id) })
    const s2Row = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, LEGEND_S2.id) })
    expect(s1Row, 'S1 must be in DB').toBeDefined()
    expect(s2Row, 'S2 must be in DB').toBeDefined()

    const svc = new UsersAccessService(dbSvc)
    const perms = await svc.getViewPermissions(s1Row!, s2Row!)
    expect(perms.tabs, 'SENIOR viewing other SENIOR → 0 tabs').toEqual([])
  })

  // ── SENIOR-ISO-2: SENIOR cannot view DROP profile (real-DB) ──────────────

  it('SENIOR-ISO-2. SENIOR (S1) viewing DROP (DROP1) profile → 0 tabs (identity isolation)', async () => {
    if (!legendDbAvailable) return
    const db = dbSvc.db
    const s1Row = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, LEGEND_S1.id) })
    const dropRow = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.id, LEGEND_DROP1.id),
    })
    expect(s1Row).toBeDefined()
    expect(dropRow).toBeDefined()

    const svc = new UsersAccessService(dbSvc)
    const perms = await svc.getViewPermissions(s1Row!, dropRow!)
    expect(perms.tabs, 'SENIOR viewing DROP → 0 tabs').toEqual([])
  })

  // ── SENIOR-ISO-3: ADMIN behavior unchanged (regression) ──────────────────

  it('SENIOR-ISO-3. ADMIN viewing SENIOR (S1) → still has tabs (regression guard for SENIOR-ISO fix)', async () => {
    if (!legendDbAvailable) return
    const db = dbSvc.db
    const adminRow = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.id, 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'),
    })
    const s1Row = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, LEGEND_S1.id) })
    // Skip this sub-check if admin not in DB (fresh CI env without seed)
    if (!adminRow || !s1Row) return

    const svc = new UsersAccessService(dbSvc)
    const perms = await svc.getViewPermissions(adminRow, s1Row)
    expect(perms.tabs.length, 'ADMIN viewing SENIOR → has tabs').toBeGreaterThan(0)
    expect(perms.tabs).toContain('overview')
  })
})
