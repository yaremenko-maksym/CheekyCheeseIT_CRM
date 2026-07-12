import {
  Body,
  Controller,
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
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { updateProjectSchema } from '@crm/shared'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { ProjectsService } from './projects.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { UsersService } from '../users/users.service'
import { projectMembers, projects, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * dropId update RBAC integration spec — real DB.
 *
 * WHY this test exists:
 *   `projects.dropId` is the money-routing field for DROP_INCOME distribution.
 *   mocked E2E cannot catch backend guard failures (feedback_mocked_e2e_guards —
 *   lesson repeated 3×). Security review on PR #359 found 0 assertions on the
 *   dropId validation branches in projects.service.ts update(). This spec
 *   closes that gap with a real PostgreSQL DB (crm_qa when DATABASE_URL set).
 *
 * WHAT it covers:
 *   DROP-UPD-1  ADMIN: PATCH {dropId: validActiveDrop} → 200, column written
 *   DROP-UPD-2  PATCH {dropId: nonExistentUUID} → 404 'Drop not found'
 *   DROP-UPD-3  PATCH {dropId: userId with role≠DROP (JUNIOR)} → 400 'User is not a DROP'
 *   DROP-UPD-4  PATCH {dropId: archivedDrop (archivedAt set)} → 400 'Drop is archived'
 *   DROP-UPD-5  PATCH {dropId: null} on project with existing dropId → 200, column cleared
 *   DROP-UPD-6  RBAC denials: ACCOUNTANT (dropId in payload) → 403
 *               SENIOR → 403; JUNIOR → 403; DROP → 403;
 *               HR of foreign team (doesn't contain project's senior) → 403
 *   DROP-UPD-7  RBAC positive: HR of project's own team + {dropId: validDrop} → 200
 *               (proves DROP-UPD-6 denials are real and not a false-positive from outer gate)
 *
 * SEED namespace: a9b8c7d6-e5f4-4020-**
 *   (distinct from 4000/4002/4003/4010 used by other integration specs)
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job).
 */

const JWT_SECRET = 'drop-id-update-rbac-secret-32c'

// ---------------------------------------------------------------------------
// Personas — all in SEED namespace 4020
// ---------------------------------------------------------------------------

/** ADMIN from canonical seed — always in DB */
const ADMIN: SessionUser = {
  id: 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21',
  email: 'yaremenkomaksym99@gmail.com',
  displayName: 'Maksym Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** Test SENIOR — seniorId of the test project */
const SENIOR1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4020-aa00-000000000001',
  email: 'drop-upd-s1@test.spec',
  displayName: 'DropUpd Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** Test JUNIOR — to verify that a non-DROP user is rejected as dropId */
const JUNIOR1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4020-aa00-000000000002',
  email: 'drop-upd-j1@test.spec',
  displayName: 'DropUpd Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** Valid active DROP user */
const DROP1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4020-aa00-000000000003',
  email: 'drop-upd-d1@test.spec',
  displayName: 'DropUpd Drop1',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** Archived DROP user — archivedAt will be set in seed */
const DROP2_ARCHIVED: SessionUser = {
  id: 'a9b8c7d6-e5f4-4020-aa00-000000000004',
  email: 'drop-upd-d2-arch@test.spec',
  displayName: 'DropUpd Drop2 Archived',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** ACCOUNTANT from canonical seed */
const ACCOUNTANT: SessionUser = {
  id: 'c7e8d9a0-b1c2-4d3e-8f5a-6b7c8d9e0fbb',
  email: 'mykola.savchenko@cheekycheese.dev',
  displayName: 'Mykola Savchenko',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** HR in the same team as SENIOR1 — should be ALLOWED to update the project */
const HR_OWN: SessionUser = {
  id: 'a9b8c7d6-e5f4-4020-aa00-000000000005',
  email: 'drop-upd-hr-own@test.spec',
  displayName: 'DropUpd HR Own Team',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR in a different team — should be DENIED (403) */
const HR_FOREIGN: SessionUser = {
  id: 'a9b8c7d6-e5f4-4020-aa00-000000000006',
  email: 'drop-upd-hr-foreign@test.spec',
  displayName: 'DropUpd HR Foreign Team',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// DB row IDs (all in namespace 4020)
// ---------------------------------------------------------------------------

/** Project owned by SENIOR1 — main fixture for update tests */
const TEST_PROJ_ID = 'a9b8c7d6-e5f4-4020-bb00-000000000010'

/** Team that contains HR_OWN + SENIOR1 — grants HR_OWN access to TEST_PROJ */
const OWN_TEAM_ID = 'a9b8c7d6-e5f4-4020-bb00-000000000020'

/** Team that contains only HR_FOREIGN — no seniors from TEST_PROJ */
const FOREIGN_TEAM_ID = 'a9b8c7d6-e5f4-4020-bb00-000000000021'

/** Non-existent UUID used for "drop not found" test.
 * Must be a valid RFC 4122 UUID (4th group starts with 8-9ab per variant bits)
 * but must not exist in the DB — seeded with a distinctive prefix.
 */
const NONEXISTENT_UUID = 'a9b8c7d6-e5f4-4020-8c00-000000000099'

const ALL_TEST_USER_IDS = [
  SENIOR1.id,
  JUNIOR1.id,
  DROP1.id,
  DROP2_ARCHIVED.id,
  HR_OWN.id,
  HR_FOREIGN.id,
]

// ---------------------------------------------------------------------------
// Sentinel controller — mirrors ProjectsController.update HTTP surface
// ---------------------------------------------------------------------------

const PROJECTS_SERVICE_TOKEN = 'PROJECTS_SERVICE_TOKEN_DROP_UPD'

@Controller('projects')
class SentinelProjectsController {
  constructor(@Inject(PROJECTS_SERVICE_TOKEN) private readonly svc: ProjectsService) {}

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const data = updateProjectSchema.parse(body)
    return this.svc.update(id, data, user)
  }
}

// ---------------------------------------------------------------------------
// TestDatabaseModule
// ---------------------------------------------------------------------------

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
        new ProjectsService(db, auditLog, usersSvc, new HrAccessService(db)),
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
class DropIdUpdateTestModule {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ProjectsService.update dropId validation — real DB integration', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    // DB availability probe — graceful skip when DATABASE_URL is unset/unreachable
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      console.warn(
        '[drop-id-update integration] SKIPPED — no DB at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DropIdUpdateTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'drop-upd-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // ── Seed test data ────────────────────────────────────────────────────────

    // 1. Test users
    await db
      .insert(users)
      .values([
        {
          id: SENIOR1.id,
          email: SENIOR1.email,
          displayName: SENIOR1.displayName,
          role: 'SENIOR',
          googleId: `test-drop-upd-${SENIOR1.id}`,
          seniorSharePercent: 26,
        },
        {
          id: JUNIOR1.id,
          email: JUNIOR1.email,
          displayName: JUNIOR1.displayName,
          role: 'JUNIOR',
          googleId: `test-drop-upd-${JUNIOR1.id}`,
        },
        {
          id: DROP1.id,
          email: DROP1.email,
          displayName: DROP1.displayName,
          role: 'DROP',
          googleId: `test-drop-upd-${DROP1.id}`,
        },
        {
          id: DROP2_ARCHIVED.id,
          email: DROP2_ARCHIVED.email,
          displayName: DROP2_ARCHIVED.displayName,
          role: 'DROP',
          googleId: `test-drop-upd-${DROP2_ARCHIVED.id}`,
          // archivedAt set → this user is archived
          archivedAt: new Date('2025-01-01'),
        },
        {
          id: HR_OWN.id,
          email: HR_OWN.email,
          displayName: HR_OWN.displayName,
          role: 'HR',
          googleId: `test-drop-upd-${HR_OWN.id}`,
        },
        {
          id: HR_FOREIGN.id,
          email: HR_FOREIGN.email,
          displayName: HR_FOREIGN.displayName,
          role: 'HR',
          googleId: `test-drop-upd-${HR_FOREIGN.id}`,
        },
      ])
      .onConflictDoNothing()

    // 2. Test project — owned by SENIOR1, no dropId initially
    await db
      .insert(projects)
      .values([
        {
          id: TEST_PROJ_ID,
          name: 'DropUpd Test Project',
          companyName: 'DropUpd Corp',
          domain: 'dropupd-test.io',
          startDate: new Date('2026-01-01'),
          seniorId: SENIOR1.id,
          currency: 'USDT',
          rate: 5000,
        },
      ])
      .onConflictDoNothing()

    // 3. Teams: OWN_TEAM (SENIOR1 + HR_OWN), FOREIGN_TEAM (HR_FOREIGN only)
    await db
      .insert(teams)
      .values([
        { id: OWN_TEAM_ID, name: 'DropUpd Own Team' },
        { id: FOREIGN_TEAM_ID, name: 'DropUpd Foreign Team' },
      ])
      .onConflictDoNothing()

    await db
      .insert(teamMembers)
      .values([
        { teamId: OWN_TEAM_ID, userId: SENIOR1.id, joinedAt: new Date() },
        { teamId: OWN_TEAM_ID, userId: HR_OWN.id, joinedAt: new Date() },
        { teamId: FOREIGN_TEAM_ID, userId: HR_FOREIGN.id, joinedAt: new Date() },
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      // FK-safe cleanup order: members → project → teams → users
      await db.delete(projectMembers).where(inArray(projectMembers.projectId, [TEST_PROJ_ID]))
      await db.delete(projects).where(inArray(projects.id, [TEST_PROJ_ID]))
      await db
        .delete(teamMembers)
        .where(inArray(teamMembers.teamId, [OWN_TEAM_ID, FOREIGN_TEAM_ID]))
      await db.delete(teams).where(inArray(teams.id, [OWN_TEAM_ID, FOREIGN_TEAM_ID]))
      await db.delete(users).where(inArray(users.id, ALL_TEST_USER_IDS))
    } catch {
      // Non-fatal cleanup — don't mask test failures
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  // Helper: reset the project's dropId to a given value between tests
  async function resetDropId(value: string | null): Promise<void> {
    const { eq: drizzleEq } = await import('drizzle-orm')
    await dbSvc.db
      .update(projects)
      .set({ dropId: value, updatedAt: new Date() })
      .where(drizzleEq(projects.id, TEST_PROJ_ID))
  }

  // ── DROP-UPD-1: ADMIN sets valid active DROP → 200, column written ──────────

  it('DROP-UPD-1. ADMIN PATCH {dropId: validActiveDrop} → 200, projects.dropId written to DB', async () => {
    if (!dbAvailable) return

    // Ensure the project starts without a dropId
    await resetDropId(null)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { dropId: DROP1.id },
    })
    expect(res.statusCode, 'ADMIN PATCH with valid dropId must return 200').toBe(200)

    // Verify the column was actually written in the DB
    const { eq: drizzleEq } = await import('drizzle-orm')
    const row = await dbSvc.db.query.projects.findFirst({
      where: drizzleEq(projects.id, TEST_PROJ_ID),
    })
    expect(row?.dropId, 'projects.dropId must be set to DROP1.id in DB after 200').toBe(DROP1.id)
  })

  // ── DROP-UPD-2: Non-existent UUID → 404 'Drop not found' ───────────────────

  it('DROP-UPD-2. ADMIN PATCH {dropId: nonExistentUUID} → 404 Drop not found', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { dropId: NONEXISTENT_UUID },
    })
    expect(res.statusCode, 'Non-existent dropId UUID must return 404').toBe(404)

    const body = res.json() as { message?: string }
    expect(body.message, "404 body must contain 'Drop not found'").toContain('Drop not found')
  })

  // ── DROP-UPD-3: User with role≠DROP (JUNIOR) → 400 'User is not a DROP' ────

  it('DROP-UPD-3. ADMIN PATCH {dropId: JUNIOR.id} → 400 User is not a DROP', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { dropId: JUNIOR1.id },
    })
    expect(res.statusCode, 'dropId pointing to a non-DROP user must return 400').toBe(400)

    const body = res.json() as { message?: string }
    expect(body.message, "400 body must contain 'User is not a DROP'").toContain(
      'User is not a DROP',
    )
  })

  // ── DROP-UPD-4: Archived DROP user → 400 'Drop is archived' ─────────────────

  it('DROP-UPD-4. ADMIN PATCH {dropId: archivedDrop} → 400 Drop is archived', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { dropId: DROP2_ARCHIVED.id },
    })
    expect(res.statusCode, 'Archived DROP user as dropId must return 400').toBe(400)

    const body = res.json() as { message?: string }
    expect(body.message, "400 body must contain 'Drop is archived'").toContain('Drop is archived')
  })

  // ── DROP-UPD-5: dropId: null on project with existing dropId → 200, cleared ──

  it('DROP-UPD-5. ADMIN PATCH {dropId: null} → 200, projects.dropId cleared (null in DB)', async () => {
    if (!dbAvailable) return

    // Ensure the project has a dropId to clear
    await resetDropId(DROP1.id)

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(ADMIN) },
      payload: { dropId: null },
    })
    expect(res.statusCode, 'PATCH {dropId: null} must return 200').toBe(200)

    // Verify the column is null in the DB
    const { eq: drizzleEq } = await import('drizzle-orm')
    const row = await dbSvc.db.query.projects.findFirst({
      where: drizzleEq(projects.id, TEST_PROJ_ID),
    })
    expect(row?.dropId, 'projects.dropId must be null in DB after clearing').toBeNull()
  })

  // ── DROP-UPD-6: RBAC denials ─────────────────────────────────────────────────

  it('DROP-UPD-6a. ACCOUNTANT PATCH {dropId: validDrop} → 403 (hasOnlyOverride=false, outer RBAC gate)', async () => {
    if (!dbAvailable) return

    // ACCOUNTANT is only allowed when the payload contains ONLY seniorSharePercentOverride.
    // Including dropId means hasOnlyOverride=false → outer gate denies.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(ACCOUNTANT) },
      payload: { dropId: DROP1.id },
    })
    expect(
      res.statusCode,
      'ACCOUNTANT with dropId in payload must be denied (hasOnlyOverride=false → 403)',
    ).toBe(403)
  })

  it('DROP-UPD-6b. SENIOR PATCH {dropId: validDrop} → 403', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(SENIOR1) },
      payload: { dropId: DROP1.id },
    })
    expect(res.statusCode, 'SENIOR must be denied (403) when trying to set dropId').toBe(403)
  })

  it('DROP-UPD-6c. JUNIOR PATCH {dropId: validDrop} → 403', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(JUNIOR1) },
      payload: { dropId: DROP1.id },
    })
    expect(res.statusCode, 'JUNIOR must be denied (403) when trying to set dropId').toBe(403)
  })

  it('DROP-UPD-6d. DROP PATCH {dropId: validDrop} → 403', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(DROP1) },
      payload: { dropId: DROP1.id },
    })
    expect(res.statusCode, 'DROP role must be denied (403) when trying to set dropId').toBe(403)
  })

  it('DROP-UPD-6e. HR of foreign team PATCH {dropId: validDrop} → 403 (assertHrCanManageProject)', async () => {
    if (!dbAvailable) return

    // HR_FOREIGN is in FOREIGN_TEAM which has no senior = SENIOR1,
    // so assertHrCanManageProject rejects with 403.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(HR_FOREIGN) },
      payload: { dropId: DROP1.id },
    })
    expect(
      res.statusCode,
      'HR of a foreign team must be denied (403) — project senior not in their teams',
    ).toBe(403)
  })

  // ── DROP-UPD-7: HR of own team → 200 (proves 403 cases are real, not false-positive) ──

  it('DROP-UPD-7. HR of own team PATCH {dropId: validDrop} → 200 (assertHrCanManageProject passes)', async () => {
    if (!dbAvailable) return

    // Reset to no dropId so the update is meaningful
    await resetDropId(null)

    // HR_OWN is in OWN_TEAM which contains SENIOR1 (project.seniorId),
    // so assertHrCanManageProject must pass.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${TEST_PROJ_ID}`,
      cookies: { jwt: tokenFor(HR_OWN) },
      payload: { dropId: DROP1.id },
    })
    expect(
      res.statusCode,
      'HR of project own team must be allowed (200) to set a valid dropId',
    ).toBe(200)

    // Confirm column was written
    const { eq: drizzleEq } = await import('drizzle-orm')
    const row = await dbSvc.db.query.projects.findFirst({
      where: drizzleEq(projects.id, TEST_PROJ_ID),
    })
    expect(
      row?.dropId,
      'projects.dropId must be written to DROP1.id when HR of own team patches it',
    ).toBe(DROP1.id)
  })
})
