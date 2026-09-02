/**
 * Integration tests — SENIOR drop identity masking (fix/senior-drop-identity-mask).
 *
 * WHY this test exists:
 *   PR #359 closed only the UI layer for SENIOR drop masking. This spec proves
 *   that the API layer itself (ProjectsService) masks drop identity from SENIOR
 *   viewers even when exercised against a real database.
 *
 *   Mocked-service tests (senior-drop-mask.unit.spec.ts) prove the logic;
 *   this integration spec proves it survives the full NestJS + Fastify + DB stack.
 *
 * Scenarios (AC1-AC5 from task-fix-senior-drop-identity-mask.md):
 *
 *   SI-1   GET /api/projects/:id as SENIOR (owner) on drop-project →
 *          200, effectiveTeam.drop === null, dropName === null, dropId !== null
 *   SI-2   GET /api/projects/:id as ADMIN on drop-project →
 *          200, effectiveTeam.drop present, dropName === real displayName
 *   SI-3   GET /api/projects/:id as DROP (own project) →
 *          200, effectiveTeam.drop present
 *   SI-4   GET /api/projects/:id as JUNIOR (project member) →
 *          200, dropId === null, dropName === null (regression)
 *   SI-5   GET /api/projects (list) as SENIOR → drop-project has dropName === null
 *
 * SEED:
 *   Namespace: a9b8c7d6-e5f4-5001-** (distinct from existing 4001/4002/4003 groups)
 *   DROP_PROJ_A: SENIOR S1 + DROP D1 attached; S1 active member via seniorId FK.
 *   One JUNIOR (J1) active member for regression path.
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED, CI unit job). A DATABASE_URL that IS set but unreachable throws
 *   in beforeAll (reports FAILED) — neither case can look like "passed"
 *   with zero assertions.
 */
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
import { ApprovalsService } from '../approvals/approvals.service'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { ProjectsService } from './projects.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { UsersService } from '../users/users.service'
import { projectMembers, projects, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { UsersAccessService } from '../users/users-access.service'
import { hasDatabaseUrl } from '../test/require-real-db'

const JWT_SECRET = 'senior-drop-mask-rbac-secret-32char'

// ── Namespace: a9b8c7d6-e5f4-5001-<group>-<seq> ───────────────────────────────

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

const S1: SessionUser = {
  id: 'a9b8c7d6-e5f4-5001-aa00-000000000001',
  email: 'srmask-s1@test.spec',
  displayName: 'SR Mask Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const J1: SessionUser = {
  id: 'a9b8c7d6-e5f4-5001-aa00-000000000002',
  email: 'srmask-j1@test.spec',
  displayName: 'SR Mask Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const D1: SessionUser = {
  id: 'a9b8c7d6-e5f4-5001-aa00-000000000003',
  email: 'srmask-d1@test.spec',
  displayName: 'SR Mask Drop1',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const DROP_PROJ_A_ID = 'a9b8c7d6-e5f4-5001-bb00-000000000010'
const TEAM_ID = 'a9b8c7d6-e5f4-5001-bb00-000000000020'
const MEMBER_J1_ID = 'a9b8c7d6-e5f4-5001-bb00-000000000030'

const TEST_USER_IDS = [S1.id, J1.id, D1.id]
const DROP_DISPLAY_NAME = D1.displayName

// ── Sentinel controller ────────────────────────────────────────────────────────

const PROJECTS_SERVICE_TOKEN = 'PROJECTS_SERVICE_TOKEN_SR_MASK'

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
      provide: UsersAccessService,
      useFactory: (db: DatabaseService) => {
        const svc = Object.create(UsersAccessService.prototype) as UsersAccessService
        Object.assign(svc, { db })
        return svc
      },
      inject: [DatabaseService],
    },
    {
      provide: ProjectsService,
      useFactory: (db: DatabaseService, auditLog: ProjectAuditLogService, usersSvc: UsersService) =>
        new ProjectsService(
          db,
          auditLog,
          usersSvc,
          new HrAccessService(db),
          // task-project-draft-status: real ApprovalsService against the same
          // real DB — this is an integration spec, not a mock.
          new ApprovalsService(db),
        ),
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
class SeniorDropMaskTestModule {}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe.skipIf(!hasDatabaseUrl())('SENIOR drop-identity masking — real DB integration', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      throw new Error(
        '[senior-drop-mask integration] FAILED — no DB at DATABASE_URL (expected in CI unit job)',
      )
    }

    const moduleRef = await Test.createTestingModule({
      imports: [SeniorDropMaskTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'senior-drop-mask-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // ── Seed ──────────────────────────────────────────────────────────────────

    // Users: S1 (SENIOR), J1 (JUNIOR), D1 (DROP)
    await db
      .insert(users)
      .values([
        {
          id: S1.id,
          email: S1.email,
          displayName: S1.displayName,
          role: 'SENIOR',
          googleId: `test-srmask-${S1.id}`,
        },
        {
          id: J1.id,
          email: J1.email,
          displayName: J1.displayName,
          role: 'JUNIOR',
          googleId: `test-srmask-${J1.id}`,
        },
        {
          id: D1.id,
          email: D1.email,
          displayName: D1.displayName,
          role: 'DROP',
          googleId: `test-srmask-${D1.id}`,
          dropSharePercent: 15,
        },
      ])
      .onConflictDoNothing()

    // DROP_PROJ_A: S1 senior + D1 drop attached
    await db
      .insert(projects)
      .values([
        {
          id: DROP_PROJ_A_ID,
          name: 'SR Mask Drop Project A',
          companyName: 'SR Mask Corp',
          domain: 'srmask.io',
          startDate: new Date('2026-01-01'),
          seniorId: S1.id,
          dropId: D1.id,
          currency: 'USDT',
          rate: '5500',
        },
      ])
      .onConflictDoNothing()

    // J1 active member of DROP_PROJ_A
    await db
      .insert(projectMembers)
      .values([
        { id: MEMBER_J1_ID, projectId: DROP_PROJ_A_ID, userId: J1.id, joinedAt: new Date() },
      ])
      .onConflictDoNothing()

    // Team for S1 (needed for effectiveTeam hrs/accountants queries to succeed)
    await db
      .insert(teams)
      .values([{ id: TEAM_ID, name: 'SR Mask Team' }])
      .onConflictDoNothing()
    await db
      .insert(teamMembers)
      .values([{ teamId: TEAM_ID, userId: S1.id, joinedAt: new Date() }])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    try {
      const db = dbSvc.db
      await db.delete(projectMembers).where(inArray(projectMembers.id, [MEMBER_J1_ID]))
      await db.delete(teamMembers).where(inArray(teamMembers.teamId, [TEAM_ID]))
      await db.delete(projects).where(inArray(projects.id, [DROP_PROJ_A_ID]))
      await db.delete(teams).where(inArray(teams.id, [TEAM_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // Non-fatal cleanup failure — do not mask test results
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── SI-1: SENIOR → drop identity masked ───────────────────────────────────

  it('SI-1. SENIOR (S1, project owner) → effectiveTeam.drop=null, dropName=null, dropId=present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${DROP_PROJ_A_ID}`,
      cookies: { jwt: tokenFor(S1) },
    })
    expect(res.statusCode, 'SENIOR must get 200').toBe(200)

    const body = res.json() as Record<string, unknown>

    // dropName: identity — must be null for SENIOR
    expect(body['dropName'], 'SENIOR: dropName must be null (identity)').toBeNull()

    // dropId: opaque uuid — must be present for SENIOR (FE uses it)
    expect(body['dropId'], 'SENIOR: dropId must be present').toBe(D1.id)

    // dropSharePercent: financial field — must be present for SENIOR
    expect(typeof body['dropSharePercent'], 'SENIOR: dropSharePercent must be a number').toBe(
      'number',
    )

    // effectiveTeam: drop sub-object must be null
    const et = body['effectiveTeam'] as { drop: unknown } | undefined
    expect(et, 'SENIOR: effectiveTeam must be present').toBeDefined()
    expect(et!.drop, 'SENIOR: effectiveTeam.drop must be null').toBeNull()
  })

  // ── SI-2: ADMIN → full visibility (positive control) ──────────────────────

  it('SI-2. ADMIN → effectiveTeam.drop present, dropName=real displayName', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${DROP_PROJ_A_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
    })
    expect(res.statusCode, 'ADMIN must get 200').toBe(200)

    const body = res.json() as Record<string, unknown>

    expect(body['dropName'], 'ADMIN: dropName must be real displayName').toBe(DROP_DISPLAY_NAME)
    expect(body['dropId'], 'ADMIN: dropId must be present').toBe(D1.id)

    const et = body['effectiveTeam'] as {
      drop: { id: string; displayName: string; email: string } | null
    }
    expect(et, 'ADMIN: effectiveTeam must be present').toBeDefined()
    expect(et.drop, 'ADMIN: effectiveTeam.drop must be non-null').not.toBeNull()
    expect(et.drop!.id, 'ADMIN: effectiveTeam.drop.id must match D1').toBe(D1.id)
    expect(et.drop!.displayName, 'ADMIN: effectiveTeam.drop.displayName must be real').toBe(
      DROP_DISPLAY_NAME,
    )
    expect(et.drop!.email, 'ADMIN: effectiveTeam.drop.email must be real').toBe(D1.email)
  })

  // ── SI-3: DROP viewer (own project) → full visibility ─────────────────────

  it('SI-3. DROP (D1, own project) → effectiveTeam.drop present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${DROP_PROJ_A_ID}`,
      cookies: { jwt: tokenFor(D1) },
    })
    expect(res.statusCode, 'DROP must get 200').toBe(200)

    const body = res.json() as Record<string, unknown>
    const et = body['effectiveTeam'] as { drop: { id: string } | null }
    expect(et, 'DROP: effectiveTeam must be present').toBeDefined()
    expect(et.drop, 'DROP: effectiveTeam.drop must be non-null (own project)').not.toBeNull()
    expect(et.drop!.id).toBe(D1.id)
  })

  // ── SI-4: JUNIOR → full mask (regression guard) ───────────────────────────

  it('SI-4. JUNIOR (J1, project member) → dropId=null, dropName=null (regression)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${DROP_PROJ_A_ID}`,
      cookies: { jwt: tokenFor(J1) },
    })
    expect(res.statusCode, 'JUNIOR must get 200').toBe(200)

    const body = res.json() as Record<string, unknown>
    expect(body['dropId'], 'JUNIOR: dropId must be null').toBeNull()
    expect(body['dropName'], 'JUNIOR: dropName must be null').toBeNull()
    expect(body['dropSharePercent'], 'JUNIOR: dropSharePercent must be null').toBeNull()
    expect(body['effectiveTeam'], 'JUNIOR: effectiveTeam must be absent').toBeUndefined()
  })

  // ── SI-5: SENIOR list path → dropName null ────────────────────────────────

  it('SI-5. GET /projects list as SENIOR → drop-project has dropName=null', async () => {
    const svc = app.get(ProjectsService)
    const list = await svc.findAll(S1)

    // S1 must see their own drop-project
    const projA = list.find((p) => p.id === DROP_PROJ_A_ID)
    expect(projA, 'S1 must see DROP_PROJ_A in their project list').toBeDefined()

    expect(projA!.dropName, 'SENIOR list: dropName must be null').toBeNull()
    expect(projA!.dropId, 'SENIOR list: dropId must be present').toBe(D1.id)
    expect(projA!.dropSharePercent, 'SENIOR list: dropSharePercent must be present').toBeDefined()
    expect(projA!.dropSharePercent).not.toBeNull()
  })
})
