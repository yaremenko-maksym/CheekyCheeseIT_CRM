import { Controller, Get, Global, Inject, Module, Query } from '@nestjs/common'
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
 * Teams HR RBAC — real-backend integration spec.
 *
 * WHY this test exists (task-hr-team-exclude-drop):
 *   HR on /crm/team was seeing DROP-type teams (payment-routing internals)
 *   mixed with real recruiting (SENIOR-type) teams. This spec verifies:
 *     1. HR findAll returns ZERO DROP-type teams (even if HR is a member of a DROP team).
 *     2. HR findAll returns their own SENIOR-type teams.
 *     3. ADMIN findAll still returns ALL teams (including DROP) — regression guard.
 *
 * SEED: isolated rows in beforeAll (namespace b1c2d3e4-f5a6-4007-bb00-<seq>),
 *       cleaned up in afterAll.
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * Pattern from teams.drop.rbac.integration.spec.ts.
 */

const JWT_SECRET = 'teams-hr-rbac-integration-secret-32c'

// ── Test personas — namespace b1c2d3e4-f5a6-4007-bb00-<seq> ──────────────────

/** HR user — member of SENIOR_TEAM, also inserted into DROP_TEAM */
const HR_USER: SessionUser = {
  id: 'b1c2d3e4-f5a6-4007-bb00-000000000001',
  email: 'hr-rbac-test@test.spec',
  displayName: 'HR Test',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** SENIOR user — member of SENIOR_TEAM */
const SENIOR_USER: SessionUser = {
  id: 'b1c2d3e4-f5a6-4007-bb00-000000000002',
  email: 'senior-rbac-test@test.spec',
  displayName: 'Senior Test',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** ADMIN user (test-only, not the real seed admin) */
const ADMIN: SessionUser = {
  id: 'b1c2d3e4-f5a6-4007-bb00-000000000003',
  email: 'admin-hr-rbac-test@test.spec',
  displayName: 'Admin HR Test',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

// UUIDs for teams created in beforeAll
const SENIOR_TEAM_ID = 'b1c2d3e4-f5a6-4007-bb00-000000000010'
const DROP_TEAM_ID = 'b1c2d3e4-f5a6-4007-bb00-000000000011'

// ── Sentinel controller — mirrors only findAll route ──────────────────────────

const TEAMS_SERVICE_TOKEN = 'TEAMS_SERVICE_TOKEN_HR_RBAC'

@Controller('teams')
class SentinelTeamsController {
  constructor(@Inject(TEAMS_SERVICE_TOKEN) private readonly svc: TeamsService) {}

  @Get()
  findAll(@CurrentUser() user: SessionUser, @Query('archived') archivedParam?: string) {
    const archived: boolean | 'all' = archivedParam === 'all' ? 'all' : archivedParam === 'true'
    return this.svc.findAll(user, { archived })
  }
}

// ── TestDatabaseModule ────────────────────────────────────────────────────────

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

// ── Test module ───────────────────────────────────────────────────────────────

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
      // UsersService is NOT exercised in findAll — pass null stub.
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
class TeamsHrRbacTestModule {}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenFor(jwt: JwtService, user: SessionUser): string {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, { secret: JWT_SECRET })
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(!hasDatabaseUrl())(
  'Teams HR RBAC — real backend integration (real DB, no mocks)',
  () => {
    let app: NestFastifyApplication
    let jwt: JwtService
    let dbSvc: DatabaseService

    const allTestUserIds = [HR_USER.id, SENIOR_USER.id, ADMIN.id]
    const allTestTeamIds = [SENIOR_TEAM_ID, DROP_TEAM_ID]

    beforeAll(async () => {
      // DB availability probe
      try {
        const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probePool.query('SELECT 1')
        await probePool.end()
      } catch {
        throw new Error(
          '[teams-hr-rbac integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      const moduleRef = await Test.createTestingModule({
        imports: [TeamsHrRbacTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'teams-hr-rbac-integration-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      dbSvc = app.get(DatabaseService)
      const db = dbSvc.db

      // ── Seed ──────────────────────────────────────────────────────────────────

      // Users
      await db.insert(users).values([
        {
          id: HR_USER.id,
          email: HR_USER.email,
          displayName: HR_USER.displayName,
          role: 'HR',
          googleId: `test-google-${HR_USER.id}`,
        },
        {
          id: SENIOR_USER.id,
          email: SENIOR_USER.email,
          displayName: SENIOR_USER.displayName,
          role: 'SENIOR',
          googleId: `test-google-${SENIOR_USER.id}`,
        },
        {
          id: ADMIN.id,
          email: ADMIN.email,
          displayName: ADMIN.displayName,
          role: 'ADMIN',
          googleId: `test-google-${ADMIN.id}`,
        },
      ])

      // Teams: one SENIOR-type, one DROP-type
      await db.insert(teams).values([
        { id: SENIOR_TEAM_ID, name: 'HR RBAC Test — Senior Team', type: 'SENIOR' },
        { id: DROP_TEAM_ID, name: 'HR RBAC Test — Drop Team', type: 'DROP' },
      ])

      // Memberships: HR in BOTH teams (simulates real scenario); SENIOR in SENIOR_TEAM
      await db.insert(teamMembers).values([
        { teamId: SENIOR_TEAM_ID, userId: HR_USER.id },
        { teamId: SENIOR_TEAM_ID, userId: SENIOR_USER.id },
        // HR is also a member of the DROP team — must be excluded from HR's view
        { teamId: DROP_TEAM_ID, userId: HR_USER.id },
      ])
    })

    afterAll(async () => {
      const db = dbSvc.db

      // Clean up: team_members → teams → users (FK order)
      await db.delete(teamMembers).where(inArray(teamMembers.teamId, allTestTeamIds))
      await db.delete(teams).where(inArray(teams.id, allTestTeamIds))
      await db.delete(users).where(inArray(users.id, allTestUserIds))

      await app?.close()
    })

    it('LIST 1. HR sees ONLY SENIOR-type teams — DROP-type excluded even if member', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams',
        cookies: { jwt: tokenFor(jwt, HR_USER) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string; type: string }>
      // No DROP-type teams at all
      const dropTeams = body.filter((t) => t.type === 'DROP')
      expect(dropTeams).toHaveLength(0)
    })

    it('LIST 2. HR sees their own SENIOR-type team (isHrOfTeam membership preserved)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams',
        cookies: { jwt: tokenFor(jwt, HR_USER) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      const ids = body.map((t) => t.id)
      // SENIOR team is visible
      expect(ids).toContain(SENIOR_TEAM_ID)
      // DROP team is not visible — even though HR is a member
      expect(ids).not.toContain(DROP_TEAM_ID)
    })

    it('LIST 3. ADMIN sees ALL teams including DROP-type (regression guard)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/teams',
        cookies: { jwt: tokenFor(jwt, ADMIN) },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string; type: string }>
      const ids = body.map((t) => t.id)
      // ADMIN must see both test teams
      expect(ids).toContain(SENIOR_TEAM_ID)
      expect(ids).toContain(DROP_TEAM_ID)
      // Specifically the DROP team is visible to ADMIN with type='DROP'
      expect(body.some((t) => t.id === DROP_TEAM_ID && t.type === 'DROP')).toBe(true)
    })

    it('LIST 4. No JWT → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/teams' })
      expect(res.statusCode).toBe(401)
    })
  },
)
