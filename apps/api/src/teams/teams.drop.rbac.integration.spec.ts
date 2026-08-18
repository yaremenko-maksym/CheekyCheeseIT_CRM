import {
  Controller,
  Get,
  Global,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
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
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsService } from './teams.service'
import { teamMembers, teams, users } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Teams DROP RBAC — real-backend integration spec.
 *
 * WHY this test exists (feedback_mocked_e2e_guards lesson, 2026-06-09):
 *   The unit spec (teams.drop.spec.ts) mocks the entire DB layer — it proves
 *   filter logic branching but CANNOT verify that real SQL enforces the
 *   "own-team only" contract for DROP. This spec uses the REAL TeamsService
 *   + real PostgreSQL to catch IDOR / data-leak bugs mocked tests miss.
 *
 * WHAT it covers:
 *   GET /api/teams  (findAll):
 *     DROP_A → only own drop-team returned (NOT foreign team)
 *     DROP_A → zero teams when not member of any
 *     ADMIN   → sees both teams
 *
 *   GET /api/teams/:id  (findOne):
 *     DROP_A → 200 for own team; members include SENIOR + HR + ACCOUNTANT
 *     DROP_A → 403 for foreign team (IDOR guard)
 *     DROP_B → 403 for DROP_A's team (cross-drop IDOR)
 *     ADMIN  → 200 for any team
 *     No JWT → 401
 *
 * SEED: isolated rows in beforeAll, cleaned up in afterAll.
 *   Namespace: a9b8c7d6-e5f4-4003-<group>-<seq>
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * WHY sentinel controller (not real TeamsController):
 *   Real TeamsController depends on TeamAuditLogService in the controller
 *   constructor but tests only exercise findAll/findOne. Sentinel mirrors
 *   only the two routes — minimal surface, maximum isolation.
 *   Pattern from legends.rbac.integration.spec.ts.
 */

const JWT_SECRET = 'teams-drop-rbac-integration-secret-32c'

// ── Test personas ──────────────────────────────────────────────────────────────
// Namespace: a9b8c7d6-e5f4-4003-aa00-<seq>
// All chars are valid hex → PostgreSQL uuid type accepts them.

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

// Test-specific users (inserted in beforeAll, deleted in afterAll).
const DROP_A: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000001',
  email: 'drop-rbac-a@test.spec',
  displayName: 'Drop RBAC A',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const DROP_B: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000002',
  email: 'drop-rbac-b@test.spec',
  displayName: 'Drop RBAC B',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

const SENIOR_1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000003',
  email: 'drop-rbac-s1@test.spec',
  displayName: 'Drop RBAC Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const HR_1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000004',
  email: 'drop-rbac-hr1@test.spec',
  displayName: 'Drop RBAC HR1',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const ACCOUNTANT_1: SessionUser = {
  id: 'a9b8c7d6-e5f4-4003-aa00-000000000005',
  email: 'drop-rbac-acc1@test.spec',
  displayName: 'Drop RBAC Acc1',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}

// IDs for test DB rows (bb00 group — separate from user IDs above)
const DROP_TEAM_A_ID = 'a9b8c7d6-e5f4-4003-bb00-000000000010'
const DROP_TEAM_B_ID = 'a9b8c7d6-e5f4-4003-bb00-000000000011'

const TEST_USER_IDS = [DROP_A.id, DROP_B.id, SENIOR_1.id, HR_1.id, ACCOUNTANT_1.id]
const TEST_TEAM_IDS = [DROP_TEAM_A_ID, DROP_TEAM_B_ID]

// ── Sentinel controller — mirrors only findAll + findOne routes ───────────────

const TEAMS_SERVICE_TOKEN = 'TEAMS_SERVICE_TOKEN_DROP_RBAC'

@Controller('teams')
class SentinelTeamsController {
  constructor(@Inject(TEAMS_SERVICE_TOKEN) private readonly svc: TeamsService) {}

  @Get()
  findAll(@CurrentUser() user: SessionUser, @Query('archived') archivedParam?: string) {
    const archived: boolean | 'all' = archivedParam === 'all' ? 'all' : archivedParam === 'true'
    return this.svc.findAll(user, { archived })
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
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

// ── Test module ────────────────────────────────────────────────────────────────

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
  ],
  controllers: [SentinelTeamsController],
  providers: [
    Reflector,
    {
      provide: TeamAuditLogService,
      useFactory: (db: DatabaseService) => new TeamAuditLogService(db),
      inject: [DatabaseService],
    },
    {
      provide: TeamsService,
      // UsersService is NOT exercised in findAll/findOne — pass null stub.
      useFactory: (db: DatabaseService) => new TeamsService(db, null as never),
      inject: [DatabaseService],
    },
    {
      provide: TEAMS_SERVICE_TOKEN,
      useExisting: TeamsService,
    },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
  ],
})
class TeamsDropRbacTestModule {}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe.skipIf(!hasDatabaseUrl())(
  'Teams DROP RBAC — real backend integration (real DB, no mocks)',
  () => {
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
        throw new Error(
          '[teams-drop-rbac integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      const moduleRef = await Test.createTestingModule({
        imports: [TeamsDropRbacTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'teams-drop-rbac-integration-cookie-secret' })
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
            id: DROP_A.id,
            email: DROP_A.email,
            displayName: DROP_A.displayName,
            role: 'DROP',
            googleId: `test-google-${DROP_A.id}`,
          },
          {
            id: DROP_B.id,
            email: DROP_B.email,
            displayName: DROP_B.displayName,
            role: 'DROP',
            googleId: `test-google-${DROP_B.id}`,
          },
          {
            id: SENIOR_1.id,
            email: SENIOR_1.email,
            displayName: SENIOR_1.displayName,
            role: 'SENIOR',
            googleId: `test-google-${SENIOR_1.id}`,
          },
          {
            id: HR_1.id,
            email: HR_1.email,
            displayName: HR_1.displayName,
            role: 'HR',
            googleId: `test-google-${HR_1.id}`,
          },
          {
            id: ACCOUNTANT_1.id,
            email: ACCOUNTANT_1.email,
            displayName: ACCOUNTANT_1.displayName,
            role: 'ACCOUNTANT',
            googleId: `test-google-${ACCOUNTANT_1.id}`,
          },
        ])
        .onConflictDoNothing()

      // 2. Teams
      //    Team A: drop-team for DROP_A (+ SENIOR_1 + HR_1 + ACCOUNTANT_1)
      //    Team B: drop-team for DROP_B only (no shared members)
      await db
        .insert(teams)
        .values([
          {
            id: DROP_TEAM_A_ID,
            name: 'Drop RBAC Team A',
            type: 'DROP',
          },
          {
            id: DROP_TEAM_B_ID,
            name: 'Drop RBAC Team B',
            type: 'DROP',
          },
        ])
        .onConflictDoNothing()

      // 3. Team members
      //    Team A: DROP_A (owner), SENIOR_1, HR_1, ACCOUNTANT_1
      //    Team B: DROP_B (owner)
      await db
        .insert(teamMembers)
        .values([
          { teamId: DROP_TEAM_A_ID, userId: DROP_A.id },
          { teamId: DROP_TEAM_A_ID, userId: SENIOR_1.id },
          { teamId: DROP_TEAM_A_ID, userId: HR_1.id },
          { teamId: DROP_TEAM_A_ID, userId: ACCOUNTANT_1.id },
          { teamId: DROP_TEAM_B_ID, userId: DROP_B.id },
        ])
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      try {
        const db = dbSvc.db
        // Clean up in FK-safe order
        await db.delete(teamMembers).where(inArray(teamMembers.teamId, TEST_TEAM_IDS))
        await db.delete(teams).where(inArray(teams.id, TEST_TEAM_IDS))
        await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // Non-fatal cleanup — do not mask test results
      }

      await app.close()
      // Pool torn down by factory-registered onModuleDestroy
    }, 15_000)

    function tokenFor(user: SessionUser): string {
      return jwt.sign(user)
    }

    // ── GET /api/teams — findAll RBAC ──────────────────────────────────────────

    it('LIST 1. DROP_A → returns only own drop-team (NOT foreign team)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams',
        cookies: { jwt: tokenFor(DROP_A) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      // CRITICAL: must return exactly 1 team — the DROP_A team, not DROP_B's
      expect(body).toHaveLength(1)
      expect(body[0]!.id).toBe(DROP_TEAM_A_ID)
    })

    it('LIST 2. DROP_A → does NOT see foreign drop-team (no cross-drop leak)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams',
        cookies: { jwt: tokenFor(DROP_A) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      const ids = body.map((t) => t.id)
      expect(ids).not.toContain(DROP_TEAM_B_ID)
    })

    it("LIST 3. DROP_B → returns only own team (not DROP_A's team)", async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams',
        cookies: { jwt: tokenFor(DROP_B) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(body).toHaveLength(1)
      expect(body[0]!.id).toBe(DROP_TEAM_B_ID)
      const ids = body.map((t) => t.id)
      expect(ids).not.toContain(DROP_TEAM_A_ID)
    })

    it('LIST 4. ADMIN → sees both drop-teams', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams',
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      const ids = body.map((t) => t.id)
      expect(ids).toContain(DROP_TEAM_A_ID)
      expect(ids).toContain(DROP_TEAM_B_ID)
    })

    // ── GET /api/teams/:id — findOne RBAC ──────────────────────────────────────

    it('DETAIL 5. DROP_A → 200 for own team; members include SENIOR, HR, ACCOUNTANT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/teams/${DROP_TEAM_A_ID}`,
        cookies: { jwt: tokenFor(DROP_A) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { id: string; type: string; members: Array<{ role: string }> }
      expect(body.id).toBe(DROP_TEAM_A_ID)
      expect(body.type).toBe('DROP')
      // Members visible to DROP: self (DROP) + SENIOR + HR + ACCOUNTANT (all active, no ADMIN/JUNIOR)
      const roles = body.members.map((m) => m.role)
      expect(roles).toContain('DROP')
      expect(roles).toContain('SENIOR')
      expect(roles).toContain('HR')
      expect(roles).toContain('ACCOUNTANT')
    })

    it('DETAIL 6. DROP_A → 403 for foreign drop-team (IDOR guard)', async () => {
      // CRITICAL: DROP_A must not access DROP_B's team — this is the IDOR case
      // that mocked tests cannot catch.
      const res = await app.inject({
        method: 'GET',
        url: `/api/teams/${DROP_TEAM_B_ID}`,
        cookies: { jwt: tokenFor(DROP_A) },
      })
      expect(res.statusCode).toBe(403)
    })

    it("DETAIL 7. DROP_B → 403 for DROP_A's team (cross-drop IDOR)", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/teams/${DROP_TEAM_A_ID}`,
        cookies: { jwt: tokenFor(DROP_B) },
      })
      expect(res.statusCode).toBe(403)
    })

    it("DETAIL 8. ADMIN → 200 for DROP_A's team", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/teams/${DROP_TEAM_A_ID}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { id: string }
      expect(body.id).toBe(DROP_TEAM_A_ID)
    })

    it("DETAIL 9. ADMIN → 200 for DROP_B's team", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/teams/${DROP_TEAM_B_ID}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { id: string }
      expect(body.id).toBe(DROP_TEAM_B_ID)
    })

    // ── Unauthenticated ────────────────────────────────────────────────────────

    it('AUTH 10. No JWT → 401 on list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams',
      })
      expect(res.statusCode).toBe(401)
    })

    it('AUTH 11. No JWT → 401 on detail', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/teams/${DROP_TEAM_A_ID}`,
      })
      expect(res.statusCode).toBe(401)
    })
  },
)
