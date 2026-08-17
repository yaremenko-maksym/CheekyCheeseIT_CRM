import { Body, Controller, Global, Inject, Module, Post } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { createProjectSchema } from '@crm/shared'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { HrAccessService } from '../common/hr-access.service'
import { ZodExceptionFilter } from '../zod-exception.filter'
import { DatabaseService } from '../database/database.service'
import { ProjectsService } from './projects.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { UsersService } from '../users/users.service'
import { projectMembers, projects, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * dropId create RBAC integration spec — real DB.
 *
 * WHY this test exists (mirrors PR #362 for update()):
 *   `projects.dropId` is the money-routing field for DROP_INCOME distribution.
 *   mocked E2E cannot catch backend guard failures (feedback_mocked_e2e_guards —
 *   lesson repeated 3×). The `dropId` validation branch inside
 *   `ProjectsService.create()` (Drop role - phase 2, PR #186) has existed since
 *   PR #186 but had ZERO test coverage — every create-fixture across the repo
 *   passes `dropId: null`. This spec closes that gap with a real PostgreSQL DB
 *   (crm_qa when DATABASE_URL is set).
 *
 * WHAT it covers:
 *   DROP-CRT-1   ADMIN POST {dropId: validActiveDrop} → 201/200, column written
 *   DROP-CRT-2   POST {dropId: nonExistentUUID} → 404 'Drop not found'
 *   DROP-CRT-3   POST {dropId: userId with role≠DROP (JUNIOR)} → 400 'User is not a DROP'
 *   DROP-CRT-4   POST {dropId: archivedDrop (archivedAt set)} → 400 'Drop is archived'
 *   DROP-CRT-5a  POST {dropId: null} → 201/200, column NULL (explicit null)
 *   DROP-CRT-5b  POST without dropId key → 201/200, column NULL (absent = no drop)
 *   DROP-CRT-6   POST {dropId: 'invalid-uuid'} → 400 from createProjectSchema.parse (Zod)
 *   DROP-CRT-7   RBAC denials: SENIOR / JUNIOR / DROP / ACCOUNTANT POST with a
 *                valid dropId → 403 (outer role gate — `role !== 'ADMIN' && role !== 'HR'`)
 *   DROP-CRT-8   RBAC positive: HR of project senior's own team → 201/200;
 *                HR of a foreign team → 403 (assertHrCanManageProject)
 *
 * SEED namespace: a9b8c7d6-e5f4-4030-**
 *   (distinct from 4000/4002/4003/4010/4020 used by other integration specs —
 *   verified via `grep -rho a9b8c7d6-e5f4-[0-9a-f]\{4\} apps/api/src` at write time)
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * CLEANUP NOTE: unlike the update() spec (single PATCH target, reset between
 * tests), create() inserts a brand-new `projects` row on every successful
 * call. Each success test pushes the returned `id` into `createdProjectIds`
 * and afterAll deletes exactly those rows (no wildcard/name-based cleanup).
 */

const JWT_SECRET = 'drop-id-create-rbac-secret-32c'

// ---------------------------------------------------------------------------
// Personas — all in SEED namespace 4030
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

/** Test SENIOR — used as the target `seniorId` for created projects */
const SENIOR1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4030-aa00-000000000001',
  email: 'drop-crt-s1@test.spec',
  displayName: 'DropCrt Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** Test JUNIOR — to verify that a non-DROP user is rejected as dropId */
const JUNIOR1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4030-aa00-000000000002',
  email: 'drop-crt-j1@test.spec',
  displayName: 'DropCrt Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** Valid active DROP user */
const DROP1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4030-aa00-000000000003',
  email: 'drop-crt-d1@test.spec',
  displayName: 'DropCrt Drop1',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** Archived DROP user — archivedAt will be set in seed */
const DROP2_ARCHIVED: SessionUser = {
  id: 'a9b8c7d6-e5f4-4030-aa00-000000000004',
  email: 'drop-crt-d2-arch@test.spec',
  displayName: 'DropCrt Drop2 Archived',
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

/** HR in the same team as SENIOR1 — should be ALLOWED to create for SENIOR1 */
const HR_OWN: SessionUser = {
  id: 'a9b8c7d6-e5f4-4030-aa00-000000000005',
  email: 'drop-crt-hr-own@test.spec',
  displayName: 'DropCrt HR Own Team',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR in a different team — should be DENIED (403) */
const HR_FOREIGN: SessionUser = {
  id: 'a9b8c7d6-e5f4-4030-aa00-000000000006',
  email: 'drop-crt-hr-foreign@test.spec',
  displayName: 'DropCrt HR Foreign Team',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// DB row IDs (all in namespace 4030)
// ---------------------------------------------------------------------------

/** Team that contains HR_OWN + SENIOR1 — grants HR_OWN access to SENIOR1 */
const OWN_TEAM_ID = 'a9b8c7d6-e5f4-4030-bb00-000000000020'

/** Team that contains only HR_FOREIGN — no seniors from this spec */
const FOREIGN_TEAM_ID = 'a9b8c7d6-e5f4-4030-bb00-000000000021'

/** Non-existent UUID used for "drop not found" test.
 * Must be a valid RFC 4122 UUID (4th group starts with 8-9ab per variant bits)
 * but must not exist in the DB — seeded with a distinctive prefix.
 */
const NONEXISTENT_UUID = 'a9b8c7d6-e5f4-4030-8c00-000000000099'

const ALL_TEST_USER_IDS = [
  SENIOR1.id,
  JUNIOR1.id,
  DROP1.id,
  DROP2_ARCHIVED.id,
  HR_OWN.id,
  HR_FOREIGN.id,
]

// ---------------------------------------------------------------------------
// Sentinel controller — mirrors ProjectsController.create HTTP surface
// ---------------------------------------------------------------------------

const PROJECTS_SERVICE_TOKEN = 'PROJECTS_SERVICE_TOKEN_DROP_CRT'

@Controller('projects')
class SentinelProjectsController {
  constructor(@Inject(PROJECTS_SERVICE_TOKEN) private readonly svc: ProjectsService) {}

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = createProjectSchema.parse(body)
    return this.svc.create(data, user)
  }
}

// ---------------------------------------------------------------------------
// TestDatabaseModule
// ---------------------------------------------------------------------------

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
class DropIdCreateTestModule {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasDatabaseUrl())(
  'ProjectsService.create dropId validation — real DB integration',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let dbSvc: DatabaseService

    /** Every successfully-created project id — deleted in afterAll. */
    const createdProjectIds: string[] = []

    beforeAll(async () => {
      // DB availability probe — graceful skip when DATABASE_URL is unset/unreachable
      try {
        const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probePool.query('SELECT 1')
        await probePool.end()
      } catch {
        throw new Error(
          '[drop-id-create integration] FAILED — no DB at DATABASE_URL (expected in CI unit job)',
        )
      }

      const moduleRef = await Test.createTestingModule({
        imports: [DropIdCreateTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'drop-crt-integration-cookie-secret' })
      app.setGlobalPrefix('api')
      app.useGlobalFilters(new ZodExceptionFilter())
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
            googleId: `test-drop-crt-${SENIOR1.id}`,
            seniorSharePercent: 26,
          },
          {
            id: JUNIOR1.id,
            email: JUNIOR1.email,
            displayName: JUNIOR1.displayName,
            role: 'JUNIOR',
            googleId: `test-drop-crt-${JUNIOR1.id}`,
          },
          {
            id: DROP1.id,
            email: DROP1.email,
            displayName: DROP1.displayName,
            role: 'DROP',
            googleId: `test-drop-crt-${DROP1.id}`,
          },
          {
            id: DROP2_ARCHIVED.id,
            email: DROP2_ARCHIVED.email,
            displayName: DROP2_ARCHIVED.displayName,
            role: 'DROP',
            googleId: `test-drop-crt-${DROP2_ARCHIVED.id}`,
            // archivedAt set → this user is archived
            archivedAt: new Date('2025-01-01'),
          },
          {
            id: HR_OWN.id,
            email: HR_OWN.email,
            displayName: HR_OWN.displayName,
            role: 'HR',
            googleId: `test-drop-crt-${HR_OWN.id}`,
          },
          {
            id: HR_FOREIGN.id,
            email: HR_FOREIGN.email,
            displayName: HR_FOREIGN.displayName,
            role: 'HR',
            googleId: `test-drop-crt-${HR_FOREIGN.id}`,
          },
        ])
        .onConflictDoNothing()

      // 2. Teams: OWN_TEAM (SENIOR1 + HR_OWN), FOREIGN_TEAM (HR_FOREIGN only)
      await db
        .insert(teams)
        .values([
          { id: OWN_TEAM_ID, name: 'DropCrt Own Team' },
          { id: FOREIGN_TEAM_ID, name: 'DropCrt Foreign Team' },
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
      try {
        const db = dbSvc.db
        // FK-safe cleanup order: members → projects (created by tests) → teams → users
        if (createdProjectIds.length) {
          await db
            .delete(projectMembers)
            .where(inArray(projectMembers.projectId, createdProjectIds))
          await db.delete(projects).where(inArray(projects.id, createdProjectIds))
        }
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

    /**
     * Builds a valid `createProjectSchema` payload. `dropId`:
     *   - omitted (undefined arg) → key absent from the payload (regular project)
     *   - `null` → explicit null (regular project)
     *   - string → drop reference under test
     */
    function buildPayload(dropId?: string | null): Record<string, unknown> {
      const base: Record<string, unknown> = {
        name: 'DropCrt Test Project',
        companyName: 'DropCrt Corp',
        domain: 'AI / ML',
        startDate: '2026-01-01T00:00:00.000Z',
        seniorId: SENIOR1.id,
        rate: 5000,
        currency: 'USDT',
      }
      if (dropId !== undefined) {
        base['dropId'] = dropId
      }
      return base
    }

    // ── DROP-CRT-1: ADMIN sets valid active DROP → 201/200, column written ──────

    it('DROP-CRT-1. ADMIN POST {dropId: validActiveDrop} → 201/200, projects.dropId written to DB', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: buildPayload(DROP1.id),
      })
      expect([200, 201], 'ADMIN POST with valid dropId must return 200/201').toContain(
        res.statusCode,
      )

      const body = res.json() as { id: string; dropId: string | null }
      createdProjectIds.push(body.id)
      expect(body.dropId, 'response dropId must equal DROP1.id').toBe(DROP1.id)

      // Verify the column was actually written in the DB
      const row = await dbSvc.db.query.projects.findFirst({ where: eq(projects.id, body.id) })
      expect(row?.dropId, 'projects.dropId must be set to DROP1.id in DB after 200/201').toBe(
        DROP1.id,
      )
    })

    // ── DROP-CRT-2: Non-existent UUID → 404 'Drop not found' ────────────────────

    it('DROP-CRT-2. ADMIN POST {dropId: nonExistentUUID} → 404 Drop not found', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: buildPayload(NONEXISTENT_UUID),
      })
      expect(res.statusCode, 'Non-existent dropId UUID must return 404').toBe(404)

      const body = res.json() as { message?: string }
      expect(body.message, "404 body must contain 'Drop not found'").toContain('Drop not found')
    })

    // ── DROP-CRT-3: User with role≠DROP (JUNIOR) → 400 'User is not a DROP' ─────

    it('DROP-CRT-3. ADMIN POST {dropId: JUNIOR.id} → 400 User is not a DROP', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: buildPayload(JUNIOR1.id),
      })
      expect(res.statusCode, 'dropId pointing to a non-DROP user must return 400').toBe(400)

      const body = res.json() as { message?: string }
      expect(body.message, "400 body must contain 'User is not a DROP'").toContain(
        'User is not a DROP',
      )
    })

    // ── DROP-CRT-4: Archived DROP user → 400 'Drop is archived' ──────────────────

    it('DROP-CRT-4. ADMIN POST {dropId: archivedDrop} → 400 Drop is archived', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: buildPayload(DROP2_ARCHIVED.id),
      })
      expect(res.statusCode, 'Archived DROP user as dropId must return 400').toBe(400)

      const body = res.json() as { message?: string }
      expect(body.message, "400 body must contain 'Drop is archived'").toContain('Drop is archived')
    })

    // ── DROP-CRT-5a: dropId: null → 201/200, column NULL ─────────────────────────

    it('DROP-CRT-5a. ADMIN POST {dropId: null} → 201/200, projects.dropId is NULL in DB', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: buildPayload(null),
      })
      expect([200, 201], 'ADMIN POST {dropId: null} must return 200/201').toContain(res.statusCode)

      const body = res.json() as { id: string; dropId: string | null }
      createdProjectIds.push(body.id)
      expect(body.dropId, 'response dropId must be null').toBeNull()

      const row = await dbSvc.db.query.projects.findFirst({ where: eq(projects.id, body.id) })
      expect(
        row?.dropId,
        'projects.dropId must be null in DB when payload.dropId is null',
      ).toBeNull()
    })

    // ── DROP-CRT-5b: absent dropId key → 201/200, column NULL ────────────────────

    it('DROP-CRT-5b. ADMIN POST without dropId key → 201/200, projects.dropId is NULL in DB', async () => {
      const payload = buildPayload()
      expect('dropId' in payload, 'sanity: payload must NOT contain a dropId key').toBe(false)

      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(ADMIN) },
        payload,
      })
      expect([200, 201], 'ADMIN POST without dropId key must return 200/201').toContain(
        res.statusCode,
      )

      const body = res.json() as { id: string; dropId: string | null }
      createdProjectIds.push(body.id)
      expect(body.dropId, 'response dropId must be null when key is absent').toBeNull()

      const row = await dbSvc.db.query.projects.findFirst({ where: eq(projects.id, body.id) })
      expect(
        row?.dropId,
        'projects.dropId must be null in DB when the dropId key is absent from payload',
      ).toBeNull()
    })

    // ── DROP-CRT-6: invalid (non-RFC-4122) UUID string → 400 from Zod schema ────
    //
    // Zod v4 enforces strict RFC 4122 UUID format on dropId before the service
    // layer is reached — pinned as a regression guard (see DROP-UPD-9 in the
    // sibling update() spec, PR #362, for the identical contract on that path).

    it('DROP-CRT-6. ADMIN POST {dropId: "invalid-uuid"} → 400 from createProjectSchema.parse (Zod v4 UUID validation)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(ADMIN) },
        payload: buildPayload('invalid-uuid'),
      })
      expect(
        res.statusCode,
        'Non-RFC-4122 dropId string must be rejected by Zod schema with 400',
      ).toBe(400)

      // ZodExceptionFilter (registered via app.useGlobalFilters) handles ZodError on
      // non-finance routes: { statusCode: 400, message: 'Validation failed', errors: [...] }
      const body = res.json() as { message?: string; errors?: unknown[] }
      expect(body.message, "400 body message must be 'Validation failed'").toBe('Validation failed')
      expect(Array.isArray(body.errors), '400 body must contain errors array from Zod').toBe(true)
    })

    // ── DROP-CRT-7: RBAC denials — outer role gate ──────────────────────────────
    //
    // `create()` rejects any caller whose role is not ADMIN/HR BEFORE the dropId
    // branch is ever reached (`role !== 'ADMIN' && role !== 'HR'` → 403 with the
    // NestJS default ForbiddenException message).

    it('DROP-CRT-7a. SENIOR POST {dropId: validDrop} → 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(SENIOR1) },
        payload: buildPayload(DROP1.id),
      })
      expect(res.statusCode, 'SENIOR must be denied (403) when trying to create with dropId').toBe(
        403,
      )
      const body = res.json() as { message?: string }
      expect(body.message, "SENIOR 403 body must contain 'Forbidden'").toContain('Forbidden')
    })

    it('DROP-CRT-7b. JUNIOR POST {dropId: validDrop} → 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(JUNIOR1) },
        payload: buildPayload(DROP1.id),
      })
      expect(res.statusCode, 'JUNIOR must be denied (403) when trying to create with dropId').toBe(
        403,
      )
      // Same outer role gate as DROP-CRT-7a (`role !== 'ADMIN' && role !== 'HR'`) —
      // pin the body so a 403 from a *different* layer (e.g. a future per-field
      // check with its own message) cannot silently satisfy this assertion.
      const body = res.json() as { message?: string }
      expect(body.message, "JUNIOR 403 body must contain 'Forbidden'").toContain('Forbidden')
    })

    it('DROP-CRT-7c. DROP POST {dropId: validDrop} → 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(DROP1) },
        payload: buildPayload(DROP1.id),
      })
      expect(
        res.statusCode,
        'DROP role must be denied (403) when trying to create with dropId',
      ).toBe(403)
      const body = res.json() as { message?: string }
      expect(body.message, "DROP 403 body must contain 'Forbidden'").toContain('Forbidden')
    })

    it('DROP-CRT-7d. ACCOUNTANT POST {dropId: validDrop} → 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(ACCOUNTANT) },
        payload: buildPayload(DROP1.id),
      })
      expect(
        res.statusCode,
        'ACCOUNTANT must be denied (403) when trying to create with dropId',
      ).toBe(403)
      const body = res.json() as { message?: string }
      expect(body.message, "ACCOUNTANT 403 body must contain 'Forbidden'").toContain('Forbidden')
    })

    // ── DROP-CRT-8: RBAC positive — HR scoping via assertHrCanManageProject ─────

    it('DROP-CRT-8a. HR of senior own team POST {dropId: validDrop} → 201/200 (assertHrCanManageProject passes)', async () => {
      // HR_OWN is in OWN_TEAM which contains SENIOR1 (the target seniorId),
      // so assertHrCanManageProject must pass.
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(HR_OWN) },
        payload: buildPayload(DROP1.id),
      })
      expect(
        res.statusCode,
        'HR of the target senior own team must be allowed (200/201) to create with a valid dropId',
      ).toBeGreaterThanOrEqual(200)
      expect([200, 201]).toContain(res.statusCode)

      const body = res.json() as { id: string; dropId: string | null }
      createdProjectIds.push(body.id)
      expect(body.dropId, 'response dropId must be DROP1.id when HR of own team creates it').toBe(
        DROP1.id,
      )
    })

    it('DROP-CRT-8b. HR of foreign team POST {dropId: validDrop} → 403 (assertHrCanManageProject)', async () => {
      // HR_FOREIGN is in FOREIGN_TEAM which does not contain SENIOR1 (the target
      // seniorId), so assertHrCanManageProject rejects with 403.
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        cookies: { jwt: tokenFor(HR_FOREIGN) },
        payload: buildPayload(DROP1.id),
      })
      expect(
        res.statusCode,
        'HR of a foreign team must be denied (403) — target senior not in their teams',
      ).toBe(403)
      // Distinct from the DROP-CRT-7a-d outer role gate: this 403 comes from
      // `assertHrCanManageProject`'s own message, NOT the bare ForbiddenException()
      // default. Pinning it proves the rejection is really the HR-scoping branch
      // and not a false-positive from some other 403 path with the same status.
      const body = res.json() as { message?: string }
      expect(
        body.message,
        "HR-foreign 403 body must contain 'Проект не в ваших командах' (assertHrCanManageProject)",
      ).toContain('Проект не в ваших командах')
    })
  },
)
