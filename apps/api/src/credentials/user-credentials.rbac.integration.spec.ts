import { Body, Controller, Get, Global, Header, Inject, Module, Param, Patch } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { ConfigService } from '@nestjs/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { HrAccessService } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
import { CredentialsService } from './credentials.service'
import { CredentialsCryptoService } from './credentials-crypto.service'
import {
  projectCredentials,
  projects,
  projectMembers,
  teamMembers,
  teams,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-junior-ut-round2 §6 — user-scoped credentials RBAC (real DB, no mocks).
 *
 * Surface: ADMIN / HR view + edit + reveal a JUNIOR's project credentials from
 * the JUNIOR's profile. Routes: GET/PATCH /api/users/:userId/credentials[/:id[/reveal]].
 *
 * Matrix (viewer → target JUNIOR J1, member of Project A with SENIOR S1):
 *   ADMIN                       → 200 (list/reveal/edit)
 *   HR_X (shares team with S1)  → 200
 *   HR_Y (different team)       → 403
 *   S1 (SENIOR)                 → 403
 *   ACCOUNTANT                  → 403
 *   D1 (DROP)                   → 403
 *   J1 (the junior themselves)  → 403 (no self-surface)
 *   + list body contains NO password / ciphertext.
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable OR
 * project_credentials table absent → every test returns early and stays green.
 */

const JWT_SECRET = 'user-cred-rbac-integration-secret-32char'
const ENC_KEY = 'user-cred-rbac-integration-enc-key-deadbeef-02'
const KNOWN_PASSWORD = 'u53r-cr3d-p4ss!-2026'

const ADMIN: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000001',
  email: 'usercred-admin@test.spec',
  displayName: 'UserCred Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const S1: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000002',
  email: 'usercred-s1@test.spec',
  displayName: 'UserCred Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const D1: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000003',
  email: 'usercred-d1@test.spec',
  displayName: 'UserCred Drop1',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** JUNIOR active member of Project A — the target whose credentials are viewed. */
const J1: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000004',
  email: 'usercred-j1@test.spec',
  displayName: 'UserCred Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR in same team as S1 → access to J1's credentials via S1's project. */
const HR_X: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000005',
  email: 'usercred-hrx@test.spec',
  displayName: 'UserCred HR-X',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR in a DIFFERENT team (no S1) → denied. */
const HR_Y: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000006',
  email: 'usercred-hry@test.spec',
  displayName: 'UserCred HR-Y',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const ACCOUNTANT: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000007',
  email: 'usercred-acc@test.spec',
  displayName: 'UserCred Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}

const PROJ_A_ID = 'b1c2d3e4-0000-4000-bd00-000000000010'
const CRED_A_ID = 'b1c2d3e4-0000-4000-bd00-000000000020'
const TEAM_X_ID = 'b1c2d3e4-0000-4000-bd00-000000000030'
const TEAM_Y_ID = 'b1c2d3e4-0000-4000-bd00-000000000031'
const PROJ_A_MEMBER_J1 = 'b1c2d3e4-0000-4000-bd00-000000000040'

const TEST_USER_IDS = [S1.id, D1.id, J1.id, S1.id, HR_X.id, HR_Y.id, ACCOUNTANT.id, ADMIN.id]
const CREDENTIALS_SERVICE_TOKEN = 'USER_CREDENTIALS_SERVICE_TOKEN_RBAC'

@Controller('users')
class SentinelUserCredentialsController {
  constructor(@Inject(CREDENTIALS_SERVICE_TOKEN) private readonly svc: CredentialsService) {}

  @Get(':userId/credentials')
  list(@CurrentUser() actor: SessionUser, @Param('userId') userId: string) {
    return this.svc.listForUser(actor, userId)
  }

  @Patch(':userId/credentials/:id')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('userId') userId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.svc.updateForUser(actor, userId, id, body as never)
  }

  @Get(':userId/credentials/:id/reveal')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reveal(
    @CurrentUser() actor: SessionUser,
    @Param('userId') userId: string,
    @Param('id') id: string,
  ) {
    return this.svc.revealForUser(actor, userId, id)
  }
}

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

const cryptoConfig = {
  get: (key: string) => (key === 'CREDENTIALS_ENC_KEY' ? ENC_KEY : undefined),
} as unknown as ConfigService

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
  ],
  controllers: [SentinelUserCredentialsController],
  providers: [
    Reflector,
    {
      provide: CredentialsCryptoService,
      useFactory: () => new CredentialsCryptoService(cryptoConfig),
    },
    {
      provide: CredentialsService,
      useFactory: (db: DatabaseService, crypto: CredentialsCryptoService) =>
        new CredentialsService(db, crypto, new HrAccessService(db)),
      inject: [DatabaseService, CredentialsCryptoService],
    },
    { provide: CREDENTIALS_SERVICE_TOKEN, useExisting: CredentialsService },
    {
      provide: APP_GUARD,
      useFactory: (jwtSvc: JwtService, reflector: Reflector) => new JwtAuthGuard(jwtSvc, reflector),
      inject: [JwtService, Reflector],
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class UserCredentialsRbacTestModule {}

describe('User-scoped credentials RBAC — real backend integration (§6)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService
  let dbSvc: DatabaseService

  beforeAll(async () => {
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      const schemaCheck = await probePool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name='project_credentials' LIMIT 1`,
      )
      await probePool.end()
      if (schemaCheck.rowCount === 0) {
        console.warn('[user-cred-rbac integration] SKIPPED — project_credentials table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[user-cred-rbac integration] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [UserCredentialsRbacTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'user-cred-rbac-integration-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
    dbSvc = app.get(DatabaseService)
    const db = dbSvc.db

    await db
      .insert(users)
      .values(
        [ADMIN, S1, D1, J1, HR_X, HR_Y, ACCOUNTANT].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    await db
      .insert(projects)
      .values([
        {
          id: PROJ_A_ID,
          name: 'UserCred Project A',
          companyName: 'Test Corp A',
          domain: 'e-commerce',
          startDate: new Date('2025-01-01'),
          seniorId: S1.id,
          dropId: D1.id,
          currency: 'USDT',
          rate: '100',
        },
      ])
      .onConflictDoNothing()

    await db
      .insert(projectMembers)
      .values([{ id: PROJ_A_MEMBER_J1, projectId: PROJ_A_ID, userId: J1.id, joinedAt: new Date() }])
      .onConflictDoNothing()

    await db
      .insert(teams)
      .values([
        { id: TEAM_X_ID, name: 'UserCred Team X' },
        { id: TEAM_Y_ID, name: 'UserCred Team Y' },
      ])
      .onConflictDoNothing()

    await db
      .insert(teamMembers)
      .values([
        { teamId: TEAM_X_ID, userId: HR_X.id, joinedAt: new Date() },
        { teamId: TEAM_X_ID, userId: S1.id, joinedAt: new Date() },
        { teamId: TEAM_Y_ID, userId: HR_Y.id, joinedAt: new Date() },
      ])
      .onConflictDoNothing()

    const crypto = new CredentialsCryptoService(cryptoConfig)
    await db
      .insert(projectCredentials)
      .values({
        id: CRED_A_ID,
        projectId: PROJ_A_ID,
        label: 'GitHub',
        login: 'usercred@example.com',
        passwordCiphertext: crypto.encrypt(KNOWN_PASSWORD),
        url: 'https://github.com',
        notes: null,
        createdBy: ADMIN.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      const db = dbSvc.db
      await db.delete(projectCredentials).where(inArray(projectCredentials.id, [CRED_A_ID]))
      await db.delete(projectMembers).where(inArray(projectMembers.id, [PROJ_A_MEMBER_J1]))
      await db.delete(teamMembers).where(inArray(teamMembers.teamId, [TEAM_X_ID, TEAM_Y_ID]))
      await db.delete(projects).where(inArray(projects.id, [PROJ_A_ID]))
      await db.delete(teams).where(inArray(teams.id, [TEAM_X_ID, TEAM_Y_ID]))
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await app.close()
  }, 15_000)

  function tokenFor(user: SessionUser): string {
    return jwt.sign(user)
  }
  function listReq(user: SessionUser) {
    return app.inject({
      method: 'GET',
      url: `/api/users/${J1.id}/credentials`,
      cookies: { jwt: tokenFor(user) },
    })
  }
  function revealReq(user: SessionUser) {
    return app.inject({
      method: 'GET',
      url: `/api/users/${J1.id}/credentials/${CRED_A_ID}/reveal`,
      cookies: { jwt: tokenFor(user) },
    })
  }
  function patchReq(user: SessionUser) {
    return app.inject({
      method: 'PATCH',
      url: `/api/users/${J1.id}/credentials/${CRED_A_ID}`,
      cookies: { jwt: tokenFor(user) },
      payload: { label: 'Updated by viewer' },
    })
  }

  // ── LIST ──────────────────────────────────────────────────────────────────
  it('LIST: ADMIN → 200, sees junior credentials', async () => {
    if (!dbAvailable) return
    const res = await listReq(ADMIN)
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string }>
    expect(body.some((c) => c.id === CRED_A_ID)).toBe(true)
  })

  it('LIST: HR same team as senior (HR_X) → 200', async () => {
    if (!dbAvailable) return
    expect((await listReq(HR_X)).statusCode).toBe(200)
  })

  it('LIST: HR other team (HR_Y) → 403', async () => {
    if (!dbAvailable) return
    expect((await listReq(HR_Y)).statusCode).toBe(403)
  })

  it('LIST: SENIOR (S1) → 403', async () => {
    if (!dbAvailable) return
    expect((await listReq(S1)).statusCode).toBe(403)
  })

  it('LIST: ACCOUNTANT → 403', async () => {
    if (!dbAvailable) return
    expect((await listReq(ACCOUNTANT)).statusCode).toBe(403)
  })

  it('LIST: DROP (D1) → 403', async () => {
    if (!dbAvailable) return
    expect((await listReq(D1)).statusCode).toBe(403)
  })

  it('LIST: the JUNIOR themselves (J1) → 403 (no self-surface)', async () => {
    if (!dbAvailable) return
    expect((await listReq(J1)).statusCode).toBe(403)
  })

  it('LIST: response contains NO password / ciphertext', async () => {
    if (!dbAvailable) return
    const res = await listReq(ADMIN)
    const raw = res.body
    expect(raw).not.toContain(KNOWN_PASSWORD)
    expect(raw.toLowerCase()).not.toContain('ciphertext')
    expect(raw).not.toContain('password')
  })

  // ── REVEAL ────────────────────────────────────────────────────────────────
  it('REVEAL: ADMIN → 200 + correct plaintext + no-store', async () => {
    if (!dbAvailable) return
    const res = await revealReq(ADMIN)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { password: string }).password).toBe(KNOWN_PASSWORD)
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('REVEAL: HR_X → 200', async () => {
    if (!dbAvailable) return
    expect((await revealReq(HR_X)).statusCode).toBe(200)
  })

  it('REVEAL: HR_Y → 403', async () => {
    if (!dbAvailable) return
    expect((await revealReq(HR_Y)).statusCode).toBe(403)
  })

  it('REVEAL: SENIOR / ACCOUNTANT / DROP / self → 403', async () => {
    if (!dbAvailable) return
    for (const u of [S1, ACCOUNTANT, D1, J1]) {
      expect((await revealReq(u)).statusCode).toBe(403)
    }
  })

  // ── EDIT ──────────────────────────────────────────────────────────────────
  it('PATCH: ADMIN → 200', async () => {
    if (!dbAvailable) return
    expect((await patchReq(ADMIN)).statusCode).toBe(200)
  })

  it('PATCH: HR_X → 200', async () => {
    if (!dbAvailable) return
    expect((await patchReq(HR_X)).statusCode).toBe(200)
  })

  it('PATCH: HR_Y / SENIOR / ACCOUNTANT / DROP / self → 403', async () => {
    if (!dbAvailable) return
    for (const u of [HR_Y, S1, ACCOUNTANT, D1, J1]) {
      expect((await patchReq(u)).statusCode).toBe(403)
    }
  })
})
