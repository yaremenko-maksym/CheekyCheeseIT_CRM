import {
  Body,
  Controller,
  Get,
  Global,
  Header,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common'
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
import { updateCredentialSchema, type SessionUser } from '@crm/shared'

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
import { hasDatabaseUrl } from '../test/require-real-db'

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
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED). A DATABASE_URL that IS set but unreachable, or
 * a missing `project_credentials` table, throws in beforeAll (reports
 * FAILED) — neither case can look like "passed" with zero assertions.
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

/** Senior of Project B — a SEPARATE team, NOT shared with HR_X. */
const S2: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000008',
  email: 'usercred-s2@test.spec',
  displayName: 'UserCred Senior2',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** JUNIOR member of Project B only — a DIFFERENT target than J1. */
const J2: SessionUser = {
  id: 'b1c2d3e4-0000-4000-bc00-000000000009',
  email: 'usercred-j2@test.spec',
  displayName: 'UserCred Junior2',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const PROJ_A_ID = 'b1c2d3e4-0000-4000-bd00-000000000010'
const CRED_A_ID = 'b1c2d3e4-0000-4000-bd00-000000000020'
const TEAM_X_ID = 'b1c2d3e4-0000-4000-bd00-000000000030'
const TEAM_Y_ID = 'b1c2d3e4-0000-4000-bd00-000000000031'
const PROJ_A_MEMBER_J1 = 'b1c2d3e4-0000-4000-bd00-000000000040'

// Project B — J1 is NOT a member; its credential CRED_B is OUT of J1's scope.
// Used for the cross-user IDOR regression (HIGH-1).
const PROJ_B_ID = 'b1c2d3e4-0000-4000-bd00-000000000011'
const CRED_B_ID = 'b1c2d3e4-0000-4000-bd00-000000000021'
const TEAM_Z_ID = 'b1c2d3e4-0000-4000-bd00-000000000032'
const PROJ_B_MEMBER_J2 = 'b1c2d3e4-0000-4000-bd00-000000000041'

const TEST_USER_IDS = [S1.id, S2.id, D1.id, J1.id, J2.id, HR_X.id, HR_Y.id, ACCOUNTANT.id, ADMIN.id]
const CREDENTIALS_SERVICE_TOKEN = 'USER_CREDENTIALS_SERVICE_TOKEN_RBAC'

// Mirror the REAL UserCredentialsController exactly: ParseUUIDPipe on every
// param + updateCredentialSchema.parse(body). Without these the param-validation
// layer (400-on-malformed-uuid) and DTO validation were never exercised (MED-5).
@Controller('users')
class SentinelUserCredentialsController {
  constructor(@Inject(CREDENTIALS_SERVICE_TOKEN) private readonly svc: CredentialsService) {}

  @Get(':userId/credentials')
  list(@CurrentUser() actor: SessionUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.svc.listForUser(actor, userId)
  }

  @Patch(':userId/credentials/:id')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const dto = updateCredentialSchema.parse(body)
    return this.svc.updateForUser(actor, userId, id, dto)
  }

  @Get(':userId/credentials/:id/reveal')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reveal(
    @CurrentUser() actor: SessionUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.revealForUser(actor, userId, id)
  }
}

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

describe.skipIf(!hasDatabaseUrl())(
  'User-scoped credentials RBAC — real backend integration (§6)',
  () => {
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
          throw new Error(
            '[user-cred-rbac integration] FAILED — project_credentials table not found',
          )
        }
      } catch {
        throw new Error('[user-cred-rbac integration] FAILED — no DB reachable at DATABASE_URL')
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
          [ADMIN, S1, S2, D1, J1, J2, HR_X, HR_Y, ACCOUNTANT].map((u) => ({
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
          {
            // Project B: senior S2 (separate team Z, NOT shared with HR_X).
            // J1 is NOT a member here → CRED_B is outside J1's allowed scope.
            id: PROJ_B_ID,
            name: 'UserCred Project B',
            companyName: 'Test Corp B',
            domain: 'e-commerce',
            startDate: new Date('2025-01-01'),
            seniorId: S2.id,
            dropId: null,
            currency: 'USDT',
            rate: '100',
          },
        ])
        .onConflictDoNothing()

      await db
        .insert(projectMembers)
        .values([
          { id: PROJ_A_MEMBER_J1, projectId: PROJ_A_ID, userId: J1.id, joinedAt: new Date() },
          // J2 is the member of Project B (not J1).
          { id: PROJ_B_MEMBER_J2, projectId: PROJ_B_ID, userId: J2.id, joinedAt: new Date() },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([
          { id: TEAM_X_ID, name: 'UserCred Team X' },
          { id: TEAM_Y_ID, name: 'UserCred Team Y' },
          { id: TEAM_Z_ID, name: 'UserCred Team Z' },
        ])
        .onConflictDoNothing()

      await db
        .insert(teamMembers)
        .values([
          { teamId: TEAM_X_ID, userId: HR_X.id, joinedAt: new Date() },
          { teamId: TEAM_X_ID, userId: S1.id, joinedAt: new Date() },
          { teamId: TEAM_Y_ID, userId: HR_Y.id, joinedAt: new Date() },
          // S2 lives in Team Z — HR_X is NOT a member, so Project B is unreachable
          // for HR_X (and J1 isn't a member of B regardless).
          { teamId: TEAM_Z_ID, userId: S2.id, joinedAt: new Date() },
        ])
        .onConflictDoNothing()

      const crypto = new CredentialsCryptoService(cryptoConfig)
      await db
        .insert(projectCredentials)
        .values([
          {
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
          },
          {
            // Credential of Project B — must be UNREACHABLE under J1's userId.
            id: CRED_B_ID,
            projectId: PROJ_B_ID,
            label: 'GitLab-B',
            login: 'usercred-b@example.com',
            passwordCiphertext: crypto.encrypt('proj-b-secret-do-not-leak'),
            url: 'https://gitlab.com',
            notes: null,
            createdBy: ADMIN.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ])
        .onConflictDoNothing()
    }, 30_000)

    afterAll(async () => {
      try {
        const db = dbSvc.db
        await db
          .delete(projectCredentials)
          .where(inArray(projectCredentials.id, [CRED_A_ID, CRED_B_ID]))
        await db
          .delete(projectMembers)
          .where(inArray(projectMembers.id, [PROJ_A_MEMBER_J1, PROJ_B_MEMBER_J2]))
        await db
          .delete(teamMembers)
          .where(inArray(teamMembers.teamId, [TEAM_X_ID, TEAM_Y_ID, TEAM_Z_ID]))
        await db.delete(projects).where(inArray(projects.id, [PROJ_A_ID, PROJ_B_ID]))
        await db.delete(teams).where(inArray(teams.id, [TEAM_X_ID, TEAM_Y_ID, TEAM_Z_ID]))
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
    // Cross-user IDOR probe: target = J1 (in URL), but credentialId belongs to
    // Project B (CRED_B), which J1 is NOT a member of. The viewer-allowed scope
    // for J1 is [Project A] only, so this credential is out of scope.
    function patchIdorReq(user: SessionUser, payload: unknown = { label: 'IDOR attempt' }) {
      return app.inject({
        method: 'PATCH',
        url: `/api/users/${J1.id}/credentials/${CRED_B_ID}`,
        cookies: { jwt: tokenFor(user) },
        payload,
      })
    }
    function revealIdorReq(user: SessionUser) {
      return app.inject({
        method: 'GET',
        url: `/api/users/${J1.id}/credentials/${CRED_B_ID}/reveal`,
        cookies: { jwt: tokenFor(user) },
      })
    }
    // Malformed-UUID probe (MED-5): ParseUUIDPipe must reject before any handler.
    function patchMalformedUuidReq(user: SessionUser) {
      return app.inject({
        method: 'PATCH',
        url: `/api/users/${J1.id}/credentials/not-a-uuid`,
        cookies: { jwt: tokenFor(user) },
        payload: { label: 'x' },
      })
    }

    // ── LIST ──────────────────────────────────────────────────────────────────
    it('LIST: ADMIN → 200, sees junior credentials', async () => {
      const res = await listReq(ADMIN)
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(body.some((c) => c.id === CRED_A_ID)).toBe(true)
    })

    it('LIST: HR same team as senior (HR_X) → 200', async () => {
      expect((await listReq(HR_X)).statusCode).toBe(200)
    })

    it('LIST: HR other team (HR_Y) → 403', async () => {
      expect((await listReq(HR_Y)).statusCode).toBe(403)
    })

    it('LIST: SENIOR (S1) → 403', async () => {
      expect((await listReq(S1)).statusCode).toBe(403)
    })

    it('LIST: ACCOUNTANT → 403', async () => {
      expect((await listReq(ACCOUNTANT)).statusCode).toBe(403)
    })

    it('LIST: DROP (D1) → 403', async () => {
      expect((await listReq(D1)).statusCode).toBe(403)
    })

    it('LIST: the JUNIOR themselves (J1) → 403 (no self-surface)', async () => {
      expect((await listReq(J1)).statusCode).toBe(403)
    })

    it('LIST: response contains NO password / ciphertext', async () => {
      const res = await listReq(ADMIN)
      const raw = res.body
      expect(raw).not.toContain(KNOWN_PASSWORD)
      expect(raw.toLowerCase()).not.toContain('ciphertext')
      expect(raw).not.toContain('password')
    })

    // ── REVEAL ────────────────────────────────────────────────────────────────
    it('REVEAL: ADMIN → 200 + correct plaintext + no-store', async () => {
      const res = await revealReq(ADMIN)
      expect(res.statusCode).toBe(200)
      expect((res.json() as { password: string }).password).toBe(KNOWN_PASSWORD)
      expect(res.headers['cache-control']).toContain('no-store')
    })

    it('REVEAL: HR_X → 200', async () => {
      expect((await revealReq(HR_X)).statusCode).toBe(200)
    })

    it('REVEAL: HR_Y → 403', async () => {
      expect((await revealReq(HR_Y)).statusCode).toBe(403)
    })

    it('REVEAL: SENIOR / ACCOUNTANT / DROP / self → 403', async () => {
      for (const u of [S1, ACCOUNTANT, D1, J1]) {
        expect((await revealReq(u)).statusCode).toBe(403)
      }
    })

    // ── EDIT ──────────────────────────────────────────────────────────────────
    it('PATCH: ADMIN → 200', async () => {
      expect((await patchReq(ADMIN)).statusCode).toBe(200)
    })

    it('PATCH: HR_X → 200', async () => {
      expect((await patchReq(HR_X)).statusCode).toBe(200)
    })

    it('PATCH: HR_Y / SENIOR / ACCOUNTANT / DROP / self → 403', async () => {
      for (const u of [HR_Y, S1, ACCOUNTANT, D1, J1]) {
        expect((await patchReq(u)).statusCode).toBe(403)
      }
    })

    // ── HIGH-1: cross-user IDOR (TOCTOU-safe scoped UPDATE) ──────────────────────
    // The credential id (CRED_B) belongs to Project B, which the TARGET (J1) is not
    // a member of. Even an authorized viewer (HR_X / ADMIN) must NOT be able to
    // mutate it via J1's userId — the scoped WHERE clause excludes it → 404
    // ("Запись не найдена"), never 200, never a leak of CRED_B's existence/content.
    it('PATCH IDOR: HR_X mutating out-of-scope credential under J1 → 404 (not 200)', async () => {
      const res = await patchIdorReq(HR_X)
      expect(res.statusCode).toBe(404)
      // No plaintext / ciphertext / Project-B label leaked in the error body.
      expect(res.body).not.toContain('proj-b-secret-do-not-leak')
      expect(res.body).not.toContain('GitLab-B')
    })

    it('PATCH IDOR: ADMIN mutating out-of-scope credential under J1 → 404 (scope, not role)', async () => {
      // ADMIN is fully authorized for J1, yet CRED_B is outside J1's project scope.
      // The scoped UPDATE (HIGH-1) must still reject it — defense-in-depth beyond
      // the `owned` pre-check.
      expect((await patchIdorReq(ADMIN)).statusCode).toBe(404)
    })

    it('PATCH IDOR: even with a password payload, out-of-scope credential is untouched (404)', async () => {
      // Confirm a password-bearing mutation cannot re-encrypt a drifted/out-of-scope
      // credential. After the rejected PATCH, CRED_B's plaintext is unchanged.
      const res = await patchIdorReq(HR_X, { label: 'pwn', password: 'attacker-set-pass' })
      expect(res.statusCode).toBe(404)
      const crypto = new CredentialsCryptoService(cryptoConfig)
      const stored = await dbSvc.db
        .select({ ct: projectCredentials.passwordCiphertext })
        .from(projectCredentials)
        .where(inArray(projectCredentials.id, [CRED_B_ID]))
      expect(crypto.decrypt(stored[0]!.ct)).toBe('proj-b-secret-do-not-leak')
    })

    it('REVEAL IDOR: HR_X revealing out-of-scope credential under J1 → 404', async () => {
      expect((await revealIdorReq(HR_X)).statusCode).toBe(404)
    })

    // ── MED-5: ParseUUIDPipe param validation ───────────────────────────────────
    it('PATCH malformed credentialId (not a uuid) → 400 (ParseUUIDPipe)', async () => {
      const res = await patchMalformedUuidReq(ADMIN)
      expect(res.statusCode).toBe(400)
    })
  },
)
