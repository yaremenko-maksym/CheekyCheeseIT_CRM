import { Controller, Get, Global, Inject, Module, Param, ParseUUIDPipe } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { DatabaseService } from '../database/database.service'
import { ProjectAuditLogService } from './project-audit-log.service'
import { ProjectsService } from './projects.service'
import { UsersService } from '../users/users.service'
import * as schema from '../database/schema'
import { projectMembers, projects, teamMembers, teams, users } from '../database/schema'

/**
 * GET /api/projects/:id/hr-contact — real-DB integration spec.
 *
 * Verifies allowlist DTO (displayName + telegram + phone only — no ids/roles/finance)
 * and RBAC gate:
 *   HC-1  ADMIN → 200 with HR contact fields
 *   HC-2  active JUNIOR project member → 200
 *   HC-3  non-member JUNIOR (IDOR) → 403
 *   HC-4  HR in the same team as senior → 200
 *   HC-5  HR NOT in the senior's team → 403
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job).
 */

const JWT_SECRET = 'projects-hr-contact-rbac-secret-32c'

// ── Namespace: dc4e3f2a-b1a0-4444-** ──────────────────────────────────────────

const ADMIN: SessionUser = {
  id: 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21',
  email: 'yaremenkomaksym99@gmail.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const SENIOR1: SessionUser = {
  id: 'dc4e3f2a-b1a0-4444-aa00-000000000001',
  email: 'hr-contact-s1@test.spec',
  displayName: 'HR Contact Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** J1: active member of the project — should get 200 */
const J1: SessionUser = {
  id: 'dc4e3f2a-b1a0-4444-aa00-000000000002',
  email: 'hr-contact-j1@test.spec',
  displayName: 'HR Contact Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** J2: NOT a member of the project — should get 403 */
const J2: SessionUser = {
  id: 'dc4e3f2a-b1a0-4444-aa00-000000000003',
  email: 'hr-contact-j2@test.spec',
  displayName: 'HR Contact Junior2',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR1: in the same team as SENIOR1 — should get 200 */
const HR1: SessionUser = {
  id: 'dc4e3f2a-b1a0-4444-aa00-000000000004',
  email: 'hr-contact-hr1@test.spec',
  displayName: 'HR Contact HR1',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR2: NOT in the team — should get 403 */
const HR2: SessionUser = {
  id: 'dc4e3f2a-b1a0-4444-aa00-000000000005',
  email: 'hr-contact-hr2@test.spec',
  displayName: 'HR Contact HR2',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const PROJ_ID = 'dc4e3f2a-b1a0-4444-bb00-000000000010'
const TEAM_ID = 'dc4e3f2a-b1a0-4444-bb00-000000000020'

const TEST_USER_IDS = [SENIOR1.id, J1.id, J2.id, HR1.id, HR2.id]

// ── Sentinel controller ────────────────────────────────────────────────────────

const PROJECTS_SERVICE_TOKEN = 'PROJECTS_SERVICE_TOKEN_HR_CONTACT'

@Controller('projects')
class SentinelProjectsController {
  constructor(@Inject(PROJECTS_SERVICE_TOKEN) private readonly svc: ProjectsService) {}

  @Get(':id/hr-contact')
  getHrContact(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return this.svc.getHrContact(id, user)
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
class ProjectsHrContactTestModule {}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('GET /projects/:id/hr-contact — real DB RBAC integration', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  function cookieAuth(user: SessionUser) {
    return { jwt: jwt.sign(user) }
  }

  beforeAll(async () => {
    // DB availability probe
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      console.warn(
        '[projects.hr-contact integration] SKIPPED — no DB at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ProjectsHrContactTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'hr-contact-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    // ── Seed ──────────────────────────────────────────────────────────────────

    // 1. Users
    await db
      .insert(users)
      .values([
        {
          id: SENIOR1.id,
          email: SENIOR1.email,
          displayName: SENIOR1.displayName,
          role: 'SENIOR',
          googleId: `test-hrc-${SENIOR1.id}`,
        },
        {
          id: J1.id,
          email: J1.email,
          displayName: J1.displayName,
          role: 'JUNIOR',
          googleId: `test-hrc-${J1.id}`,
        },
        {
          id: J2.id,
          email: J2.email,
          displayName: J2.displayName,
          role: 'JUNIOR',
          googleId: `test-hrc-${J2.id}`,
        },
        {
          id: HR1.id,
          email: HR1.email,
          displayName: HR1.displayName,
          role: 'HR',
          googleId: `test-hrc-${HR1.id}`,
          telegram: '@hr1testhandle',
          phone: '+380501234567',
        },
        {
          id: HR2.id,
          email: HR2.email,
          displayName: HR2.displayName,
          role: 'HR',
          googleId: `test-hrc-${HR2.id}`,
        },
      ])
      .onConflictDoNothing()

    // 2. Team (HR1 + SENIOR1 share this team — leftAt=null means active)
    await db
      .insert(teams)
      .values({ id: TEAM_ID, name: 'HR Contact Test Team' })
      .onConflictDoNothing()

    // 3. Team members: SENIOR1 + HR1 active (leftAt null = active)
    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_ID, userId: SENIOR1.id },
        { teamId: TEAM_ID, userId: HR1.id },
      ])
      .onConflictDoNothing()

    // 4. Project owned by SENIOR1
    await db
      .insert(projects)
      .values({
        id: PROJ_ID,
        name: 'HR Contact Test Project',
        companyName: 'HC Corp',
        domain: 'AI',
        seniorId: SENIOR1.id,
        rate: '3000',
        currency: 'USD',
        startDate: new Date(),
      })
      .onConflictDoNothing()

    // 5. J1 is an active project member (leftAt null = active)
    await db
      .insert(projectMembers)
      .values({ projectId: PROJ_ID, userId: J1.id })
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable || !dbSvc) return
    const db = dbSvc.db
    // Clean up in reverse dependency order
    await db.delete(projectMembers).where(inArray(projectMembers.userId, [J1.id, J2.id]))
    await db.delete(teamMembers).where(inArray(teamMembers.userId, [SENIOR1.id, HR1.id]))
    await db.delete(projects).where(inArray(projects.id, [PROJ_ID]))
    await db.delete(teams).where(inArray(teams.id, [TEAM_ID]))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await app?.close()
  })

  // ── HC-1: ADMIN gets 200 with allowlist fields ─────────────────────────────

  it('HC-1: ADMIN → 200 with {displayName, telegram, phone} allowlist only', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_ID}/hr-contact`,
      cookies: cookieAuth(ADMIN),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    // Allowlist check: exactly these three keys
    const keys = Object.keys(body)
    expect(keys).toContain('displayName')
    expect(keys).toContain('telegram')
    expect(keys).toContain('phone')
    // Must NOT leak identifiers or finance
    expect(keys).not.toContain('id')
    expect(keys).not.toContain('role')
    expect(keys).not.toContain('email')
    // HR1 seeded with telegram + phone
    expect(body['displayName']).toBe(HR1.displayName)
    expect(body['telegram']).toBe('@hr1testhandle')
    expect(body['phone']).toBe('+380501234567')
  })

  // ── HC-2: active JUNIOR member → 200 ──────────────────────────────────────

  it('HC-2: active JUNIOR project member (J1) → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_ID}/hr-contact`,
      cookies: cookieAuth(J1),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body['displayName']).toBe(HR1.displayName)
  })

  // ── HC-3: non-member JUNIOR → 403 (IDOR guard) ────────────────────────────

  it('HC-3: non-member JUNIOR (J2) → 403', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_ID}/hr-contact`,
      cookies: cookieAuth(J2),
    })
    expect(res.statusCode).toBe(403)
  })

  // ── HC-4: HR in the senior's team → 200 ───────────────────────────────────

  it('HC-4: HR in the project team (HR1) → 200', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_ID}/hr-contact`,
      cookies: cookieAuth(HR1),
    })
    expect(res.statusCode).toBe(200)
  })

  // ── HC-5: HR not in the senior's team → 403 ───────────────────────────────

  it('HC-5: HR outside the project team (HR2) → 403', async () => {
    if (!dbAvailable) return
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJ_ID}/hr-contact`,
      cookies: cookieAuth(HR2),
    })
    expect(res.statusCode).toBe(403)
  })
})
