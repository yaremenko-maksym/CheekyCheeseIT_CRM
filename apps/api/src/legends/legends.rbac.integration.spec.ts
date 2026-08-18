import { Controller, Get, Global, Inject, Module, Post, Put, Body, Param } from '@nestjs/common'
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
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { LegendsService } from './legends.service'
import {
  legends,
  legendEntries,
  projects,
  projectMembers,
  teamMembers,
  teams,
  users,
} from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Legends RBAC — real-backend integration spec.
 *
 * WHY this test exists (feedback_mocked_e2e_guards lesson, 2026-06-09):
 *   The controller integration spec (legends.controller.integration.spec.ts)
 *   mocks LegendsService entirely — it proves guard-stack wiring (JwtAuthGuard +
 *   OnboardingGuard) but CANNOT verify that the actual canAccess() logic,
 *   which executes real SQL against the real DB, enforces RBAC correctly.
 *
 *   This spec uses the REAL LegendsService + real PostgreSQL.
 *   It catches the class of IDOR/data-leak bugs that mocked tests miss
 *   (see project memory: #157 getProfile, #158 getSummary real data-leaks
 *   found post-merge).
 *
 * WHAT it covers:
 *   GET /api/projects/:projectId/legend:
 *     ADMIN → 200 access
 *     S1 (seniorId of project A) → 403 subject-excluded
 *     D1 (dropId of project A)  → 403 subject-excluded
 *     J1 (active project_member of A) → 200 access
 *     J2 (member of B, NOT A)   → 403 IDOR guard
 *     HR_X (same team as S1)    → 200 access
 *     HR_Y (different team, no S1) → 403 cross-team scope
 *     ACCOUNTANT                → 403
 *
 *   PUT /api/projects/:projectId/legend (view==edit):
 *     J1 → 200 success (edit == view)
 *     S1 → 403 subject excluded
 *
 *   POST /api/projects/:projectId/legend/entries:
 *     J1 → 201 success; authorId saved = J1 (not from request body)
 *
 * SEED: creates isolated test rows in beforeAll, cleans up in afterAll.
 * Uses globally-unique IDs namespaced to this spec run (no collision with
 * other integration specs or seed data).
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * WHY sentinel controller (not real ProjectsController):
 *   Real controller depends on ProjectsModule (which has its own deps tree).
 *   Sentinel mirrors only the 3 legend routes — minimal surface, maximum
 *   isolation. Pattern from documents-unified.integration.spec.ts.
 *
 * WHY useFactory for all providers:
 *   vitest uses esbuild which strips TS decorator constructor-parameter
 *   metadata. useFactory + explicit inject[] resolves deps correctly.
 */

const JWT_SECRET = 'legends-rbac-integration-secret-32c'

// ---------------------------------------------------------------------------
// Test personas — stable IDs namespaced to THIS spec (no collision).
// Real user UUIDs are used for ADMIN/ACCOUNTANT (seed data) to avoid needing
// to insert extra users. Test-specific users (S1, D1, HR_X, HR_Y, J1, J2) get
// fresh UUIDs inserted in beforeAll and deleted in afterAll.
// ---------------------------------------------------------------------------

/** ADMIN from seed — always exists, no insert needed */
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

// Test-specific users (inserted in beforeAll, deleted in afterAll).
// IDs use a stable namespace: a9b8c7d6-e5f4-4000-<group>-<seq>
// All chars are valid hex → PostgreSQL uuid type accepts them.
const S1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4000-aa00-000000000001',
  email: 'leg-rbac-s1@test.spec',
  displayName: 'Legend RBAC Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const D1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4000-aa00-000000000002',
  email: 'leg-rbac-d1@test.spec',
  displayName: 'Legend RBAC Drop1',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const J1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4000-aa00-000000000003',
  email: 'leg-rbac-j1@test.spec',
  displayName: 'Legend RBAC Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** Junior on Project B — must NOT access Project A legend (IDOR guard) */
const J2: SessionUser = {
  id: 'a9b8c7d6-e5f4-4000-aa00-000000000004',
  email: 'leg-rbac-j2@test.spec',
  displayName: 'Legend RBAC Junior2',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const S2: SessionUser = {
  id: 'a9b8c7d6-e5f4-4000-aa00-000000000005',
  email: 'leg-rbac-s2@test.spec',
  displayName: 'Legend RBAC Senior2',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** HR in same team as S1 → should have access to Project A */
const HR_X: SessionUser = {
  id: 'a9b8c7d6-e5f4-4000-aa00-000000000006',
  email: 'leg-rbac-hrx@test.spec',
  displayName: 'Legend RBAC HR-X',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR in a DIFFERENT team (no S1) → should be denied Project A */
const HR_Y: SessionUser = {
  id: 'a9b8c7d6-e5f4-4000-aa00-000000000007',
  email: 'leg-rbac-hry@test.spec',
  displayName: 'Legend RBAC HR-Y',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

// IDs for test DB rows (bb00 group — separate from user IDs above)
const PROJ_A_ID = 'a9b8c7d6-e5f4-4000-bb00-000000000010'
const PROJ_B_ID = 'a9b8c7d6-e5f4-4000-bb00-000000000011'
const LEGEND_A_ID = 'a9b8c7d6-e5f4-4000-bb00-000000000020'
const LEGEND_B_ID = 'a9b8c7d6-e5f4-4000-bb00-000000000021'
const TEAM_X_ID = 'a9b8c7d6-e5f4-4000-bb00-000000000030'
const TEAM_Y_ID = 'a9b8c7d6-e5f4-4000-bb00-000000000031'
const PROJ_A_MEMBER_J1 = 'a9b8c7d6-e5f4-4000-bb00-000000000040'
const PROJ_B_MEMBER_J2 = 'a9b8c7d6-e5f4-4000-bb00-000000000041'

// All test user IDs (for cleanup)
const TEST_USER_IDS = [S1.id, D1.id, J1.id, J2.id, S2.id, HR_X.id, HR_Y.id]

// ---------------------------------------------------------------------------
// Sentinel controller — mirrors the real project-scoped legend routes.
// Uses @Inject string token to bypass esbuild metadata stripping.
// ---------------------------------------------------------------------------

const LEGENDS_SERVICE_TOKEN = 'LEGENDS_SERVICE_TOKEN_RBAC'

@Controller('projects')
class SentinelLegendsController {
  constructor(@Inject(LEGENDS_SERVICE_TOKEN) private readonly svc: LegendsService) {}

  @Get(':projectId/legend')
  getLegend(@CurrentUser() actor: SessionUser, @Param('projectId') projectId: string) {
    return this.svc.getLegend(actor, projectId)
  }

  @Put(':projectId/legend')
  upsertLegend(
    @CurrentUser() actor: SessionUser,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.svc.upsertLegend(actor, projectId, body as never)
  }

  @Post(':projectId/legend/entries')
  addEntry(
    @CurrentUser() actor: SessionUser,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.svc.addEntry(actor, projectId, body as never)
  }
}

// ---------------------------------------------------------------------------
// TestDatabaseModule — same pattern as onboarding-contract.integration.spec.ts
// and documents-unified.integration.spec.ts.
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

// ---------------------------------------------------------------------------
// Test module
// ---------------------------------------------------------------------------

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [SentinelLegendsController],
  providers: [
    Reflector,
    {
      provide: LegendsService,
      useFactory: (db: DatabaseService) => new LegendsService(db, new HrAccessService(db)),
      inject: [DatabaseService],
    },
    {
      provide: LEGENDS_SERVICE_TOKEN,
      useExisting: LegendsService,
    },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class LegendsRbacTestModule {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasDatabaseUrl())(
  'Legends RBAC — real backend integration (real DB, no mocks)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let dbSvc: DatabaseService

    beforeAll(async () => {
      // ── DB availability + schema probe ────────────────────────────────────
      // Two conditions required to run:
      //   1. DATABASE_URL is reachable (CI unit job without Postgres → skip).
      //   2. legends table has `project_id` column (per-project schema migration
      //      from this PR). crm_db still has the old `user_id` schema until the
      //      migration is applied — skip gracefully to avoid breaking the unit
      //      test job that runs against crm_db.
      try {
        const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probePool.query('SELECT 1')
        // Verify the per-project schema is present
        const schemaCheck = await probePool.query(
          `SELECT column_name FROM information_schema.columns
         WHERE table_name='legends' AND column_name='project_id' LIMIT 1`,
        )
        await probePool.end()
        if (schemaCheck.rowCount === 0) {
          throw new Error(
            '[legends-rbac integration] FAILED — legends.project_id column not found ' +
              '(run migration 0009 against this DB, or use DATABASE_URL pointing to crm_qa)',
          )
        }
      } catch {
        throw new Error(
          '[legends-rbac integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      const moduleRef = await Test.createTestingModule({
        imports: [LegendsRbacTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'legends-rbac-integration-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      dbSvc = app.get(DatabaseService)
      const db = dbSvc.db

      // ── Seed test data (idempotent via onConflictDoNothing) ────────────────

      // 1. Users
      await db
        .insert(users)
        .values([
          {
            id: S1.id,
            email: S1.email,
            displayName: S1.displayName,
            role: 'SENIOR',
            googleId: `test-google-${S1.id}`,
          },
          {
            id: D1.id,
            email: D1.email,
            displayName: D1.displayName,
            role: 'DROP',
            googleId: `test-google-${D1.id}`,
          },
          {
            id: J1.id,
            email: J1.email,
            displayName: J1.displayName,
            role: 'JUNIOR',
            googleId: `test-google-${J1.id}`,
          },
          {
            id: J2.id,
            email: J2.email,
            displayName: J2.displayName,
            role: 'JUNIOR',
            googleId: `test-google-${J2.id}`,
          },
          {
            id: S2.id,
            email: S2.email,
            displayName: S2.displayName,
            role: 'SENIOR',
            googleId: `test-google-${S2.id}`,
          },
          {
            id: HR_X.id,
            email: HR_X.email,
            displayName: HR_X.displayName,
            role: 'HR',
            googleId: `test-google-${HR_X.id}`,
          },
          {
            id: HR_Y.id,
            email: HR_Y.email,
            displayName: HR_Y.displayName,
            role: 'HR',
            googleId: `test-google-${HR_Y.id}`,
          },
        ])
        .onConflictDoNothing()

      // 2. Projects
      //    Project A: seniorId=S1, dropId=D1
      //    Project B: seniorId=S2, no drop
      await db
        .insert(projects)
        .values([
          {
            id: PROJ_A_ID,
            name: 'Legend RBAC Project A',
            companyName: 'Test Corp A',
            domain: 'e-commerce',
            startDate: new Date('2025-01-01'),
            seniorId: S1.id,
            dropId: D1.id,
            currency: 'USDT',
            rate: '100',
          },
          {
            id: PROJ_B_ID,
            name: 'Legend RBAC Project B',
            companyName: 'Test Corp B',
            domain: 'fintech',
            startDate: new Date('2025-01-01'),
            seniorId: S2.id,
            dropId: null,
            currency: 'USDT',
            rate: '100',
          },
        ])
        .onConflictDoNothing()

      // 3. Project members
      //    J1 is active member of Project A
      //    J2 is active member of Project B (NOT Project A)
      await db
        .insert(projectMembers)
        .values([
          {
            id: PROJ_A_MEMBER_J1,
            projectId: PROJ_A_ID,
            userId: J1.id,
            joinedAt: new Date(),
          },
          {
            id: PROJ_B_MEMBER_J2,
            projectId: PROJ_B_ID,
            userId: J2.id,
            joinedAt: new Date(),
          },
        ])
        .onConflictDoNothing()

      // 4. Teams
      //    Team X: HR_X + S1 (same team → HR_X can access Project A)
      //    Team Y: HR_Y only (no S1 → HR_Y cannot access Project A)
      await db
        .insert(teams)
        .values([
          { id: TEAM_X_ID, name: 'Legend RBAC Team X' },
          { id: TEAM_Y_ID, name: 'Legend RBAC Team Y' },
        ])
        .onConflictDoNothing()

      await db
        .insert(teamMembers)
        .values([
          { teamId: TEAM_X_ID, userId: HR_X.id, joinedAt: new Date() },
          { teamId: TEAM_X_ID, userId: S1.id, joinedAt: new Date() },
          { teamId: TEAM_Y_ID, userId: HR_Y.id, joinedAt: new Date() },
          // S1 is NOT in Team Y
        ])
        .onConflictDoNothing()

      // 5. Legends
      //    Legend A for Project A (exists — so GET can find it)
      //    Legend B for Project B
      await db
        .insert(legends)
        .values([
          {
            id: LEGEND_A_ID,
            projectId: PROJ_A_ID,
            fullName: 'Legend RBAC Persona A',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: LEGEND_B_ID,
            projectId: PROJ_B_ID,
            fullName: 'Legend RBAC Persona B',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ])
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      try {
        const db = dbSvc.db

        // Clean up in FK-safe order
        // legend_entries (FK→legends, FK→users) — delete by legendId
        await db
          .delete(legendEntries)
          .where(inArray(legendEntries.legendId, [LEGEND_A_ID, LEGEND_B_ID]))

        // legends (FK→projects)
        await db.delete(legends).where(inArray(legends.id, [LEGEND_A_ID, LEGEND_B_ID]))

        // project_members (FK→projects, FK→users)
        await db
          .delete(projectMembers)
          .where(inArray(projectMembers.id, [PROJ_A_MEMBER_J1, PROJ_B_MEMBER_J2]))

        // team_members (FK→teams, FK→users)
        await db.delete(teamMembers).where(inArray(teamMembers.teamId, [TEAM_X_ID, TEAM_Y_ID]))

        // projects (FK→users)
        await db.delete(projects).where(inArray(projects.id, [PROJ_A_ID, PROJ_B_ID]))

        // teams
        await db.delete(teams).where(inArray(teams.id, [TEAM_X_ID, TEAM_Y_ID]))

        // users (test-only — seed users are NOT deleted)
        await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // Non-fatal cleanup failure — do not mask test results
      }

      await app.close()
      // Pool torn down by factory-registered onModuleDestroy
    }, 15_000)

    function tokenFor(user: SessionUser): string {
      return jwt.sign(user)
    }

    // ── GET legend — RBAC matrix ──────────────────────────────────────────────

    it('GET 1. ADMIN → 200 (full access)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { projectId: string; fullName: string }
      expect(body.projectId).toBe(PROJ_A_ID)
      expect(body.fullName).toBe('Legend RBAC Persona A')
    })

    it('GET 2. S1 (seniorId of Project A) → 403 subject-excluded', async () => {
      // KEY assertion: the SENIOR who "owns" the project is explicitly excluded
      // from their own legend (RBAC: canAccess returns false for seniorId).
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(S1) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('GET 3. D1 (dropId of Project A) → 403 subject-excluded', async () => {
      // DROP persona is also excluded from their own legend.
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(D1) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('GET 4. J1 (active member of Project A) → 200 access', async () => {
      // JUNIOR who is active project_member can read the legend.
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(J1) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { projectId: string }
      expect(body.projectId).toBe(PROJ_A_ID)
    })

    it('GET 5. J2 (member of Project B, NOT Project A) → 403 IDOR guard', async () => {
      // CRITICAL: J2 is a member of Project B only. Accessing Project A legend
      // must be denied — this is the IDOR case mocked tests cannot catch.
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(J2) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('GET 6. HR_X (same team as S1) → 200 access', async () => {
      // HR who shares Team X with S1 can read Project A legend.
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(HR_X) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { projectId: string }
      expect(body.projectId).toBe(PROJ_A_ID)
    })

    it('GET 7. HR_Y (different team, no S1) → 403 cross-team scoping', async () => {
      // HR_Y is only in Team Y where S1 is NOT a member.
      // Must be denied → verifies cross-team scoping in SQL.
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(HR_Y) },
      })
      expect(res.statusCode).toBe(403)
    })

    it('GET 8. ACCOUNTANT → 403 (no legend access)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(ACCOUNTANT) },
      })
      expect(res.statusCode).toBe(403)
    })

    // ── PUT legend — view==edit ───────────────────────────────────────────────

    it('PUT 9. J1 (active member) → 200 (view==edit per spec)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(J1) },
        payload: { fullName: 'Legend RBAC Persona A (updated by J1)' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { projectId: string; fullName: string }
      expect(body.projectId).toBe(PROJ_A_ID)
      expect(body.fullName).toBe('Legend RBAC Persona A (updated by J1)')
    })

    it('PUT 10. S1 (seniorId) → 403 subject-excluded from edit', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${PROJ_A_ID}/legend`,
        cookies: { jwt: tokenFor(S1) },
        payload: { fullName: 'Hack attempt' },
      })
      expect(res.statusCode).toBe(403)
    })

    // ── POST entries — authorId from JWT, not body ────────────────────────────

    it('POST 11. J1 adds entry → 201; authorId saved = J1 (not from body)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${PROJ_A_ID}/legend/entries`,
        cookies: { jwt: tokenFor(J1) },
        payload: { text: 'Запис про персонажа від J1', authorId: 'should-be-ignored' },
      })
      // NestJS @Post returns 201 by default
      expect(res.statusCode).toBe(201)

      const body = res.json() as { entries: Array<{ authorId: string; text: string }> }
      expect(Array.isArray(body.entries)).toBe(true)

      const entry = body.entries.find((e) => e.text === 'Запис про персонажа від J1')
      expect(entry).toBeDefined()
      // authorId MUST be taken from JWT (viewer.id), not the request body
      expect(entry!.authorId).toBe(J1.id)
    })

    // ── Unauthenticated ───────────────────────────────────────────────────────

    it('GET 12. No JWT → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/legend`,
      })
      expect(res.statusCode).toBe(401)
    })
  },
)
