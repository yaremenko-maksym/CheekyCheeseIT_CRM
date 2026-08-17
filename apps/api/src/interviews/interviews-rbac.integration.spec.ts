import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Global,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import {
  createInterviewSchema,
  moveInterviewSchema,
  updateInterviewSchema,
  type SessionUser,
} from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { DatabaseService } from '../database/database.service'
import { InterviewsService } from './interviews.service'
import { ProjectsService } from '../projects/projects.service'
import { interviews, teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Interviews RBAC — real-backend integration spec (HR-2 hardening).
 *
 * WHY this exists (HR audit gap + feedback_mocked_e2e_guards, recurred 3×):
 *   InterviewsController carries NO @Roles decorator — every access decision
 *   lives in InterviewsService (assertNotDrop at the controller boundary +
 *   team-scope via getAccessibleSeniorIds / assertUpdateAccess in the service).
 *   Before this spec there were ZERO tests pinning that contract, and HR is
 *   the primary kanban actor. A mocked-service test cannot prove that real SQL
 *   enforces the "own team-seniors only" / "DROP fully blocked" rules — the
 *   exact data-leak class that bit us 3×. This drives the REAL InterviewsService
 *   over a Fastify app against real PostgreSQL, so a regression that re-opens
 *   cross-team / DROP / role access fails loudly.
 *
 * COVERED (HTTP status assertions, real 200/403/401):
 *   GET    /api/interviews            (findBySenior)
 *   POST   /api/interviews            (create)
 *   PATCH  /api/interviews/:id        (update)
 *   PATCH  /api/interviews/:id/move   (move — non-HIRED stages only, no project side-effect)
 *   DELETE /api/interviews/:id        (remove)
 *
 *   Roles exercised: ADMIN, SENIOR (own board + active-team guard), HR
 *   (own team-seniors + cross-team 403), JUNIOR (403), ACCOUNTANT, DROP (403),
 *   plus unauthenticated (401).
 *
 * SEED namespace: c1d2e3f4-0a1b-4c2d-** (distinct from existing groups).
 *
 * WHY a sentinel controller (not the real InterviewsController):
 *   vitest transpiles via esbuild, which STRIPS TS `emitDecoratorMetadata`
 *   constructor-param type metadata. Importing the real controller makes Nest
 *   inject `undefined` for InterviewsService → 500s, not RBAC results. Every
 *   other integration spec in this repo (teams.drop.rbac, legends.rbac,
 *   credentials.rbac, …) uses a sentinel with `@Inject(TOKEN)` to bypass this.
 *   SentinelInterviewsController mirrors the REAL controller boundary
 *   byte-for-byte (assertNotDrop + ParseUUIDPipe + the exact Zod `.parse()`
 *   calls + delegation order) and delegates into the REAL InterviewsService —
 *   so the RBAC contract under test (DROP→403, team-scope, role-set) is the
 *   real one. Keep this mirror in sync with interviews.controller.ts.
 *
 * ProjectsService: a thin stub — its only method reachable from the routes
 * under test is createFromInterview, which fires ONLY when a card is moved
 * INTO 'HIRED'. Every move case here uses non-HIRED stages, so the stub is
 * never invoked. This keeps the DI graph minimal (the real ProjectsService
 * needs 4 collaborators incl. a forwardRef to UsersService) while still
 * exercising the real move() RBAC path (assertUpdateAccess).
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job)
 *   → every test returns early, suite stays green in no-DB environments.
 */

const JWT_SECRET = 'interviews-rbac-integration-secret-32chars'
const INTERVIEWS_SERVICE_TOKEN = 'INTERVIEWS_SERVICE_TOKEN_RBAC'

// ── Sentinel controller — mirrors the REAL InterviewsController boundary ───────
//    (assertNotDrop + ParseUUIDPipe + Zod .parse()) and delegates into the
//    REAL InterviewsService via @Inject(token). Bypasses esbuild metadata strip.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// RolesGuard is applied globally (APP_GUARD in the test module) — exactly the
// way the real app wires it via AppModule. No @UseGuards here; @Roles metadata
// on each handler drives the global guard. (The real InterviewsController uses
// @UseGuards(RolesGuard), which is equivalent — class-level guard + class-level
// global guard both read the same @Roles metadata; global is used in the test
// to dodge esbuild's constructor-metadata stripping on @UseGuards(ClassRef).)
@Controller('interviews')
class SentinelInterviewsController {
  constructor(@Inject(INTERVIEWS_SERVICE_TOKEN) private readonly svc: InterviewsService) {}

  // Mirror of InterviewsController.assertNotDrop (private in the real controller).
  private assertNotDrop(user: SessionUser): void {
    if (user.role === 'DROP') {
      throw new ForbiddenException('Дроп не имеет доступа к собеседованиям')
    }
  }

  @Get()
  @Roles('ADMIN', 'SENIOR', 'HR')
  findBySenior(@Query('seniorId') seniorId: string | undefined, @CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    if (seniorId !== undefined && !UUID_RE.test(seniorId)) {
      throw new BadRequestException('seniorId must be a valid UUID')
    }
    return this.svc.findBySenior(seniorId, user)
  }

  @Post()
  @Roles('ADMIN', 'SENIOR', 'HR')
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    const data = createInterviewSchema.parse(body)
    return this.svc.create(data, user)
  }

  @Patch(':id')
  @Roles('ADMIN', 'SENIOR', 'HR')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    this.assertNotDrop(user)
    const data = updateInterviewSchema.parse(body)
    return this.svc.update(id, data, user)
  }

  @Patch(':id/move')
  @Roles('ADMIN', 'SENIOR', 'HR')
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    this.assertNotDrop(user)
    const data = moveInterviewSchema.parse(body)
    return this.svc.move(id, data, user)
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    this.assertNotDrop(user)
    return this.svc.remove(id, user)
  }
}

// ── Personas ─────────────────────────────────────────────────────────────────
// Namespace: c1d2e3f4-0a1b-4c2d-aa00-<seq> (users), bb00-<seq> (teams).

const ADMIN: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000001',
  email: 'iv-rbac-admin@test.spec',
  displayName: 'IV RBAC Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** SENIOR_A — has an active team shared with HR_A. Owns the seeded cards. */
const SENIOR_A: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000002',
  email: 'iv-rbac-senior-a@test.spec',
  displayName: 'IV RBAC Senior A',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** SENIOR_B — different team, used for cross-team checks. */
const SENIOR_B: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000003',
  email: 'iv-rbac-senior-b@test.spec',
  displayName: 'IV RBAC Senior B',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** HR_A — in TEAM_A together with SENIOR_A (accessible). NOT in TEAM_B. */
const HR_A: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000004',
  email: 'iv-rbac-hr-a@test.spec',
  displayName: 'IV RBAC HR A',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/**
 * HR_LEFT — audit (MEDIUM): an ex-HR who WAS in TEAM_A with SENIOR_A but has
 * left (teamMembers.leftAt set). Must NOT retain access to SENIOR_A's board —
 * getAccessibleSeniorIds filters out left memberships.
 */
const HR_LEFT: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000009',
  email: 'iv-rbac-hr-left@test.spec',
  displayName: 'IV RBAC HR Left',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** SENIOR_C — has NO active team membership (teamless) → blocked by assertSeniorHasActiveTeam. */
const SENIOR_C: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000005',
  email: 'iv-rbac-senior-c@test.spec',
  displayName: 'IV RBAC Senior C (teamless)',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const JUNIOR: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000006',
  email: 'iv-rbac-junior@test.spec',
  displayName: 'IV RBAC Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const ACCOUNTANT: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000007',
  email: 'iv-rbac-accountant@test.spec',
  displayName: 'IV RBAC Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}

const DROP: SessionUser = {
  id: 'c1d2e3f4-0a1b-4c2d-aa00-000000000008',
  email: 'iv-rbac-drop@test.spec',
  displayName: 'IV RBAC Drop',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const TEAM_A_ID = 'c1d2e3f4-0a1b-4c2d-bb00-000000000010'
const TEAM_B_ID = 'c1d2e3f4-0a1b-4c2d-bb00-000000000011'

// Seeded interview cards (cc00 group).
const CARD_A_ID = 'c1d2e3f4-0a1b-4c2d-cc00-000000000020' // belongs to SENIOR_A board
const CARD_B_ID = 'c1d2e3f4-0a1b-4c2d-cc00-000000000021' // belongs to SENIOR_B board

const TEST_USER_IDS = [
  ADMIN.id,
  SENIOR_A.id,
  SENIOR_B.id,
  HR_A.id,
  HR_LEFT.id,
  SENIOR_C.id,
  JUNIOR.id,
  ACCOUNTANT.id,
  DROP.id,
]
const TEST_TEAM_IDS = [TEAM_A_ID, TEAM_B_ID]
const TEST_CARD_IDS = [CARD_A_ID, CARD_B_ID]

// ── Stub ProjectsService — createFromInterview is never reached (no HIRED moves) ──
const projectsServiceStub = {
  createFromInterview: () => Promise.resolve(null),
} as unknown as ProjectsService

// ── TestDatabaseModule — wraps a real Pool/drizzle as DatabaseService ──────────
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
    {
      provide: ProjectsService,
      useValue: projectsServiceStub,
    },
    {
      provide: InterviewsService,
      useFactory: (db: DatabaseService, projects: ProjectsService) =>
        new InterviewsService(db, projects),
      inject: [DatabaseService, ProjectsService],
    },
    {
      // String-token alias — SentinelInterviewsController injects via
      // @Inject(token) to dodge esbuild constructor-metadata stripping.
      provide: INTERVIEWS_SERVICE_TOKEN,
      useExisting: InterviewsService,
    },
    // JwtAuthGuard first: populates req.user from the cookie.
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
    // RolesGuard second: reads req.user.role + @Roles() metadata. Registered
    // globally (factory + explicit inject) to mirror AppModule and avoid the
    // esbuild metadata strip that breaks @UseGuards(RolesGuard) class-form.
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new RolesGuard(reflector),
      inject: [Reflector],
    },
  ],
})
class InterviewsRbacTestModule {}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe.skipIf(!hasDatabaseUrl())(
  'Interviews RBAC — real backend integration (real DB, no mocks)',
  () => {
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
          '[interviews-rbac integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      const moduleRef = await Test.createTestingModule({
        imports: [InterviewsRbacTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'interviews-rbac-integration-cookie-secret' })
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
            id: ADMIN.id,
            email: ADMIN.email,
            displayName: ADMIN.displayName,
            role: 'ADMIN',
            googleId: `test-iv-${ADMIN.id}`,
          },
          {
            id: SENIOR_A.id,
            email: SENIOR_A.email,
            displayName: SENIOR_A.displayName,
            role: 'SENIOR',
            googleId: `test-iv-${SENIOR_A.id}`,
          },
          {
            id: SENIOR_B.id,
            email: SENIOR_B.email,
            displayName: SENIOR_B.displayName,
            role: 'SENIOR',
            googleId: `test-iv-${SENIOR_B.id}`,
          },
          {
            id: HR_A.id,
            email: HR_A.email,
            displayName: HR_A.displayName,
            role: 'HR',
            googleId: `test-iv-${HR_A.id}`,
          },
          {
            id: HR_LEFT.id,
            email: HR_LEFT.email,
            displayName: HR_LEFT.displayName,
            role: 'HR',
            googleId: `test-iv-${HR_LEFT.id}`,
          },
          {
            id: SENIOR_C.id,
            email: SENIOR_C.email,
            displayName: SENIOR_C.displayName,
            role: 'SENIOR',
            googleId: `test-iv-${SENIOR_C.id}`,
          },
          {
            id: JUNIOR.id,
            email: JUNIOR.email,
            displayName: JUNIOR.displayName,
            role: 'JUNIOR',
            googleId: `test-iv-${JUNIOR.id}`,
          },
          {
            id: ACCOUNTANT.id,
            email: ACCOUNTANT.email,
            displayName: ACCOUNTANT.displayName,
            role: 'ACCOUNTANT',
            googleId: `test-iv-${ACCOUNTANT.id}`,
          },
          {
            id: DROP.id,
            email: DROP.email,
            displayName: DROP.displayName,
            role: 'DROP',
            googleId: `test-iv-${DROP.id}`,
          },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([
          { id: TEAM_A_ID, name: 'IV RBAC Team A' },
          { id: TEAM_B_ID, name: 'IV RBAC Team B' },
        ])
        .onConflictDoNothing()

      // TEAM_A: SENIOR_A + HR_A (HR_A's accessible senior = SENIOR_A)
      // TEAM_B: SENIOR_B only (HR_A has no access; cross-team)
      // SENIOR_C: deliberately NOT a member of any team (teamless guard)
      await db
        .insert(teamMembers)
        .values([
          { teamId: TEAM_A_ID, userId: SENIOR_A.id },
          { teamId: TEAM_A_ID, userId: HR_A.id },
          { teamId: TEAM_B_ID, userId: SENIOR_B.id },
          // Audit (MEDIUM): HR_LEFT was in TEAM_A with SENIOR_A but has LEFT
          // (leftAt set). getAccessibleSeniorIds must exclude this membership.
          { teamId: TEAM_A_ID, userId: HR_LEFT.id, leftAt: new Date('2025-01-01T00:00:00Z') },
        ])
        .onConflictDoNothing()

      // Cards: CARD_A on SENIOR_A board, CARD_B on SENIOR_B board.
      await db
        .insert(interviews)
        .values([
          {
            id: CARD_A_ID,
            seniorId: SENIOR_A.id,
            companyName: 'IV RBAC Co A',
            stage: 'HR_SCREEN',
            position: 0,
          },
          {
            id: CARD_B_ID,
            seniorId: SENIOR_B.id,
            companyName: 'IV RBAC Co B',
            stage: 'HR_SCREEN',
            position: 0,
          },
        ])
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      try {
        const db = dbSvc.db
        await db.delete(interviews).where(inArray(interviews.id, TEST_CARD_IDS))
        // Also remove any cards created by create-tests (seniorId-scoped cleanup).
        await db.delete(interviews).where(inArray(interviews.seniorId, [SENIOR_A.id, SENIOR_B.id]))
        await db.delete(teamMembers).where(inArray(teamMembers.teamId, TEST_TEAM_IDS))
        await db.delete(teams).where(inArray(teams.id, TEST_TEAM_IDS))
        await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // Non-fatal cleanup — do not mask test results.
      }
      await app.close()
    }, 15_000)

    function tokenFor(user: SessionUser): string {
      return jwt.sign(user)
    }

    // ════════════════════════════════════════════════════════════════════════════
    // GET /api/interviews — findBySenior
    // ════════════════════════════════════════════════════════════════════════════

    it('LIST 1. ADMIN → 200, can read any senior board', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews?seniorId=${SENIOR_A.id}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string; seniorId: string }>
      expect(body.every((c) => c.seniorId === SENIOR_A.id)).toBe(true)
      expect(body.map((c) => c.id)).toContain(CARD_A_ID)
    })

    it('LIST 2. SENIOR_A → 200, own board (seniorId ignored, scoped to self)', async () => {
      const res = await app.inject({
        method: 'GET',
        // even if SENIOR asks for SENIOR_B's board, service overrides to self
        url: `/api/interviews?seniorId=${SENIOR_B.id}`,
        cookies: { jwt: tokenFor(SENIOR_A) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ seniorId: string }>
      expect(body.every((c) => c.seniorId === SENIOR_A.id)).toBe(true)
    })

    it('LIST 3. HR_A → 200 for own team-senior (SENIOR_A)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews?seniorId=${SENIOR_A.id}`,
        cookies: { jwt: tokenFor(HR_A) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ seniorId: string }>
      expect(body.every((c) => c.seniorId === SENIOR_A.id)).toBe(true)
    })

    it('LIST 4. HR_A → 403 for cross-team senior (SENIOR_B, not in HR_A teams)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews?seniorId=${SENIOR_B.id}`,
        cookies: { jwt: tokenFor(HR_A) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('LIST 5. HR_A → 403 when seniorId omitted', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(HR_A) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('LIST 6. JUNIOR → 403 (juniors cannot access interviews)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews?seniorId=${SENIOR_A.id}`,
        cookies: { jwt: tokenFor(JUNIOR) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('LIST 7. DROP → 403 (assertNotDrop, no seniorId)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(DROP) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('LIST 8. DROP → 403 even with a valid seniorId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews?seniorId=${SENIOR_A.id}`,
        cookies: { jwt: tokenFor(DROP) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('LIST 9. SENIOR_C (teamless) → 403 (active-team guard)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(SENIOR_C) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('LIST 10. No JWT → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews?seniorId=${SENIOR_A.id}`,
      })
      expect(res.statusCode).toBe(401)
    })

    // ── ACCOUNTANT gap closure (HR-2): @Roles excludes ACCOUNTANT from boards ────
    // Before HR-2 the service had no else-branch for ACCOUNTANT, so an ACCOUNTANT
    // with a valid seniorId fell through to the query and got 200 (front-only
    // gating — the sidebar hid the link, the API did not). docs/business/modules/
    // interviews.md restricts boards to ADMIN/HR/SENIOR; @Roles now enforces it.

    it('LIST 11. ACCOUNTANT → 403 with a valid seniorId (closed gap; was 200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews?seniorId=${SENIOR_A.id}`,
        cookies: { jwt: tokenFor(ACCOUNTANT) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('LIST 12. ACCOUNTANT → 403 without seniorId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(ACCOUNTANT) },
      })
      expect(res.statusCode).toBe(403)
    })

    // ── ex-HR access revocation (audit MEDIUM) ───────────────────────────────────
    // HR_LEFT used to be in TEAM_A with SENIOR_A but left (teamMembers.leftAt set).
    // getAccessibleSeniorIds now filters left memberships, so SENIOR_A is no longer
    // accessible → 403 (same as a cross-team HR). Before the fix this returned 200.

    it('LIST 13. ex-HR (left team) → 403 for former team-senior (was 200 before fix)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/interviews?seniorId=${SENIOR_A.id}`,
        cookies: { jwt: tokenFor(HR_LEFT) },
      })
      expect(res.statusCode).toBe(403)
    })

    // ════════════════════════════════════════════════════════════════════════════
    // POST /api/interviews — create
    // ════════════════════════════════════════════════════════════════════════════

    it('CREATE 11. HR_A → 201/200 for own team-senior (SENIOR_A)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(HR_A) },
        payload: { seniorId: SENIOR_A.id, companyName: 'HR Created Co' },
      })
      expect([200, 201]).toContain(res.statusCode)
      const body = res.json() as { seniorId: string; hrId: string | null }
      expect(body.seniorId).toBe(SENIOR_A.id)
      expect(body.hrId).toBe(HR_A.id)
    })

    it('CREATE 12. HR_A → 403 for cross-team senior (SENIOR_B)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(HR_A) },
        payload: { seniorId: SENIOR_B.id, companyName: 'Cross Team Co' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('CREATE 13. SENIOR_A → 201/200, card lands on own board (seniorId overridden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(SENIOR_A) },
        // tries to plant on SENIOR_B's board; service forces own id
        payload: { seniorId: SENIOR_B.id, companyName: 'Senior Created Co' },
      })
      expect([200, 201]).toContain(res.statusCode)
      const body = res.json() as { seniorId: string }
      expect(body.seniorId).toBe(SENIOR_A.id)
    })

    it('CREATE 14. ADMIN → 201/200 for any senior', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { seniorId: SENIOR_B.id, companyName: 'Admin Created Co' },
      })
      expect([200, 201]).toContain(res.statusCode)
      const body = res.json() as { seniorId: string }
      expect(body.seniorId).toBe(SENIOR_B.id)
    })

    it('CREATE 15. JUNIOR → 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(JUNIOR) },
        payload: { seniorId: SENIOR_A.id, companyName: 'Junior Created Co' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('CREATE 16. ACCOUNTANT → 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(ACCOUNTANT) },
        payload: { seniorId: SENIOR_A.id, companyName: 'Acc Created Co' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('CREATE 17. DROP → 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/interviews`,
        cookies: { jwt: tokenFor(DROP) },
        payload: { seniorId: SENIOR_A.id, companyName: 'Drop Created Co' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('CREATE 18. No JWT → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/interviews`,
        payload: { seniorId: SENIOR_A.id, companyName: 'NoAuth Co' },
      })
      expect(res.statusCode).toBe(401)
    })

    // ════════════════════════════════════════════════════════════════════════════
    // PATCH /api/interviews/:id — update
    // ════════════════════════════════════════════════════════════════════════════

    it('UPDATE 19. ADMIN → 200 on any card', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_B_ID}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { companyName: 'Admin Updated' },
      })
      expect(res.statusCode).toBe(200)
    })

    it('UPDATE 20. SENIOR_A → 200 on own card (CARD_A)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(SENIOR_A) },
        payload: { companyName: 'Senior A Updated' },
      })
      expect(res.statusCode).toBe(200)
    })

    it("UPDATE 21. SENIOR_A → 403 on another senior's card (CARD_B)", async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_B_ID}`,
        cookies: { jwt: tokenFor(SENIOR_A) },
        payload: { companyName: 'Hijack Attempt' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('UPDATE 22. HR_A → 200 on own team-senior card (CARD_A)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(HR_A) },
        payload: { companyName: 'HR A Updated' },
      })
      expect(res.statusCode).toBe(200)
    })

    it('UPDATE 23. HR_A → 403 on cross-team card (CARD_B)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_B_ID}`,
        cookies: { jwt: tokenFor(HR_A) },
        payload: { companyName: 'HR Cross Update' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('UPDATE 24. JUNIOR → 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(JUNIOR) },
        payload: { companyName: 'Junior Update' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('UPDATE 25. ACCOUNTANT → 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(ACCOUNTANT) },
        payload: { companyName: 'Acc Update' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('UPDATE 26. DROP → 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(DROP) },
        payload: { companyName: 'Drop Update' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('UPDATE 26b. ex-HR (left team) → 403 on former team-senior card (CARD_A)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(HR_LEFT) },
        payload: { companyName: 'Ex-HR Update' },
      })
      expect(res.statusCode).toBe(403)
    })

    // ── stage cannot be changed via PATCH /:id (audit HIGH) ───────────────────────
    // `updateInterviewSchema` no longer carries `stage`; Zod strips the stray key,
    // so even an ADMIN PATCHing { stage: 'HIRED' } leaves the stage untouched.
    // Stage transitions are owned exclusively by PATCH /:id/move. This pins that a
    // client can never set HIRED (bypassing project creation) or roll back a
    // terminal stage through the plain update endpoint.

    it('UPDATE 26c. ADMIN PATCH { stage: HIRED } → 200 but stage UNCHANGED (stripped by Zod)', async () => {
      // Ensure a known starting stage on CARD_B.
      await dbSvc.db
        .update(interviews)
        .set({ stage: 'HR_SCREEN' })
        .where(inArray(interviews.id, [CARD_B_ID]))

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_B_ID}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { companyName: 'Stage Hijack Attempt', stage: 'HIRED' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { stage: string; companyName: string }
      // The legitimate field was applied…
      expect(body.companyName).toBe('Stage Hijack Attempt')
      // …but the smuggled stage was ignored — still HR_SCREEN, never HIRED.
      expect(body.stage).toBe('HR_SCREEN')

      // Confirm at the DB level too (no side-effect / no project created).
      const row = await dbSvc.db.query.interviews.findFirst({
        where: inArray(interviews.id, [CARD_B_ID]),
      })
      expect(row?.stage).toBe('HR_SCREEN')
    })

    // ════════════════════════════════════════════════════════════════════════════
    // PATCH /api/interviews/:id/move — move (non-HIRED stages only)
    // ════════════════════════════════════════════════════════════════════════════

    it('MOVE 27. SENIOR_A → 200 on own card (HR_SCREEN → TECH_INTERVIEW)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}/move`,
        cookies: { jwt: tokenFor(SENIOR_A) },
        payload: { stage: 'TECH_INTERVIEW', position: 0 },
      })
      expect(res.statusCode).toBe(200)
    })

    it('MOVE 28. HR_A → 403 on cross-team card (CARD_B)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_B_ID}/move`,
        cookies: { jwt: tokenFor(HR_A) },
        payload: { stage: 'TECH_INTERVIEW', position: 0 },
      })
      expect(res.statusCode).toBe(403)
    })

    it('MOVE 29. HR_A → 200 on own team-senior card (CARD_A)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}/move`,
        cookies: { jwt: tokenFor(HR_A) },
        payload: { stage: 'ENGLISH_CHECK', position: 0 },
      })
      expect(res.statusCode).toBe(200)
    })

    it('MOVE 30. JUNIOR → 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}/move`,
        cookies: { jwt: tokenFor(JUNIOR) },
        payload: { stage: 'TECH_INTERVIEW', position: 0 },
      })
      expect(res.statusCode).toBe(403)
    })

    it('MOVE 31. DROP → 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}/move`,
        cookies: { jwt: tokenFor(DROP) },
        payload: { stage: 'TECH_INTERVIEW', position: 0 },
      })
      expect(res.statusCode).toBe(403)
    })

    it('MOVE 32. No JWT → 401', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/interviews/${CARD_A_ID}/move`,
        payload: { stage: 'TECH_INTERVIEW', position: 0 },
      })
      expect(res.statusCode).toBe(401)
    })

    // ════════════════════════════════════════════════════════════════════════════
    // DELETE /api/interviews/:id — remove (ADMIN + HR only; SENIOR cannot)
    // ════════════════════════════════════════════════════════════════════════════

    it('REMOVE 33. SENIOR_A → 403 on own card (remove is ADMIN/HR only)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(SENIOR_A) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('REMOVE 34. HR_A → 403 on cross-team card (CARD_B)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/interviews/${CARD_B_ID}`,
        cookies: { jwt: tokenFor(HR_A) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('REMOVE 35. JUNIOR → 403', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(JUNIOR) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('REMOVE 36. ACCOUNTANT → 403', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(ACCOUNTANT) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('REMOVE 37. DROP → 403', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(DROP) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('REMOVE 38. HR_A → 200/204 on own team-senior card (CARD_A) — destructive, runs last', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/interviews/${CARD_A_ID}`,
        cookies: { jwt: tokenFor(HR_A) },
      })
      expect([200, 204]).toContain(res.statusCode)
    })

    it('REMOVE 39. ADMIN → 200/204 on any card (CARD_B) — destructive, runs last', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/interviews/${CARD_B_ID}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect([200, 204]).toContain(res.statusCode)
    })
  },
)
