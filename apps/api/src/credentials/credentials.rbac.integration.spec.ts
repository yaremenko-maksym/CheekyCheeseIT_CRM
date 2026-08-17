import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Header,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
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
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Project Credentials RBAC — real-backend integration spec (real DB, no mocks).
 *
 * WHY (feedback_mocked_e2e_guards, recurred 3×): mocked E2E gives false
 * confidence for endpoints behind guards. This spec exercises the REAL
 * CredentialsService + REAL PostgreSQL so the canAccess() SQL is actually
 * enforced. Covers the IDOR / data-leak class mocked tests miss.
 *
 * COVERS (AC3, AC4, AC5):
 *   GET /api/projects/:id/credentials (list):
 *     ADMIN → 200 | own JUNIOR → 200 | foreign JUNIOR → 403 | HR same team → 200 |
 *     HR other team → 403 | SENIOR → 403 | DROP → 403 | ACCOUNTANT → 403
 *     + list body contains NO `password` and NO `ciphertext` key (AC3).
 *   GET /api/projects/:id/credentials/:cid/reveal:
 *     same RBAC matrix; allowed → correct plaintext; reveal → Cache-Control no-store (AC5).
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * Run against scratch DB:
 *   DATABASE_URL=postgres://crm_user:password@localhost:5432/crm_scratch_cred \
 *   CREDENTIALS_ENC_KEY=<hex32> pnpm --filter @crm/api test -- credentials.rbac
 */

const JWT_SECRET = 'credentials-rbac-integration-secret-32c'
const ENC_KEY = 'credentials-rbac-integration-enc-key-deadbeef-0001'
const KNOWN_PASSWORD = 'p4ssw0rd!-rbac-2026'

// ── Personas — stable IDs namespaced to THIS spec ──────────────────────────
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
  id: 'c1d2e3f4-0000-4000-aa00-000000000001',
  email: 'cred-rbac-s1@test.spec',
  displayName: 'Cred RBAC Senior1',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const D1: SessionUser = {
  id: 'c1d2e3f4-0000-4000-aa00-000000000002',
  email: 'cred-rbac-d1@test.spec',
  displayName: 'Cred RBAC Drop1',
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** JUNIOR active member of Project A */
const J1: SessionUser = {
  id: 'c1d2e3f4-0000-4000-aa00-000000000003',
  email: 'cred-rbac-j1@test.spec',
  displayName: 'Cred RBAC Junior1',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** JUNIOR on Project B — must NOT access Project A (IDOR guard) */
const J2: SessionUser = {
  id: 'c1d2e3f4-0000-4000-aa00-000000000004',
  email: 'cred-rbac-j2@test.spec',
  displayName: 'Cred RBAC Junior2',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const S2: SessionUser = {
  id: 'c1d2e3f4-0000-4000-aa00-000000000005',
  email: 'cred-rbac-s2@test.spec',
  displayName: 'Cred RBAC Senior2',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

/** HR in same team as S1 → access to Project A */
const HR_X: SessionUser = {
  id: 'c1d2e3f4-0000-4000-aa00-000000000006',
  email: 'cred-rbac-hrx@test.spec',
  displayName: 'Cred RBAC HR-X',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** HR in a DIFFERENT team (no S1) → denied Project A */
const HR_Y: SessionUser = {
  id: 'c1d2e3f4-0000-4000-aa00-000000000007',
  email: 'cred-rbac-hry@test.spec',
  displayName: 'Cred RBAC HR-Y',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

/** ACCOUNTANT — must be denied (allowlist is junior+hr+admin) */
const ACCOUNTANT: SessionUser = {
  id: 'c1d2e3f4-0000-4000-aa00-000000000008',
  email: 'cred-rbac-acc@test.spec',
  displayName: 'Cred RBAC Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}

const PROJ_A_ID = 'c1d2e3f4-0000-4000-bb00-000000000010'
const PROJ_B_ID = 'c1d2e3f4-0000-4000-bb00-000000000011'
const CRED_A_ID = 'c1d2e3f4-0000-4000-bb00-000000000020'
// Credential that belongs to Project B — used in IDOR cross-project tests.
const CRED_B_ID = 'c1d2e3f4-0000-4000-bb00-000000000021'
// Throw-away credential created in PATCH/DELETE tests so the seeded CRED_A_ID
// is never mutated and remains available for all later assertions.
const CRED_PATCH_ID = 'c1d2e3f4-0000-4000-bb00-000000000022'
const CRED_DELETE_ID = 'c1d2e3f4-0000-4000-bb00-000000000023'
const TEAM_X_ID = 'c1d2e3f4-0000-4000-bb00-000000000030'
const TEAM_Y_ID = 'c1d2e3f4-0000-4000-bb00-000000000031'
const PROJ_A_MEMBER_J1 = 'c1d2e3f4-0000-4000-bb00-000000000040'
const PROJ_B_MEMBER_J2 = 'c1d2e3f4-0000-4000-bb00-000000000041'

const TEST_USER_IDS = [S1.id, D1.id, J1.id, J2.id, S2.id, HR_X.id, HR_Y.id, ACCOUNTANT.id]

// ── Sentinel controller — mirrors the real credentials routes ───────────────
const CREDENTIALS_SERVICE_TOKEN = 'CREDENTIALS_SERVICE_TOKEN_RBAC'

@Controller('projects')
class SentinelCredentialsController {
  constructor(@Inject(CREDENTIALS_SERVICE_TOKEN) private readonly svc: CredentialsService) {}

  @Get(':projectId/credentials')
  list(@CurrentUser() actor: SessionUser, @Param('projectId') projectId: string) {
    return this.svc.list(actor, projectId)
  }

  @Post(':projectId/credentials')
  create(
    @CurrentUser() actor: SessionUser,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.svc.create(actor, projectId, body as never)
  }

  @Patch(':projectId/credentials/:id')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.svc.update(actor, projectId, id, body as never)
  }

  @Delete(':projectId/credentials/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() actor: SessionUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.svc.remove(actor, projectId, id)
  }

  @Get(':projectId/credentials/:id/reveal')
  @Header('Cache-Control', 'no-store, private')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reveal(
    @CurrentUser() actor: SessionUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.svc.reveal(actor, projectId, id)
  }
}

// ── TestDatabaseModule ──────────────────────────────────────────────────────
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

// Minimal ConfigService stub that only knows CREDENTIALS_ENC_KEY (for crypto).
const cryptoConfig = {
  get: (key: string) => (key === 'CREDENTIALS_ENC_KEY' ? ENC_KEY : undefined),
} as unknown as ConfigService

@Module({
  imports: [
    TestDatabaseModule,
    JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
  ],
  controllers: [SentinelCredentialsController],
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
    // Throttler guard so @Throttle is honored (and does not blow up the metadata).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class CredentialsRbacTestModule {}

// ── Suite ───────────────────────────────────────────────────────────────────
describe.skipIf(!hasDatabaseUrl())(
  'Credentials RBAC — real backend integration (real DB, no mocks)',
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
            '[credentials-rbac integration] FAILED — project_credentials table not found ' +
              '(apply migration 0011 to this DB, e.g. a scratch DB)',
          )
        }
      } catch {
        throw new Error(
          '[credentials-rbac integration] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      const moduleRef = await Test.createTestingModule({
        imports: [CredentialsRbacTestModule],
      }).compile()

      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      await app.register(cookie, { secret: 'credentials-rbac-integration-cookie-secret' })
      app.setGlobalPrefix('api')
      await app.init()
      await app.getHttpAdapter().getInstance().ready()

      jwt = moduleRef.get(JwtService)
      dbSvc = app.get(DatabaseService)
      const db = dbSvc.db

      // ── Seed ───────────────────────────────────────────────────────────────
      await db
        .insert(users)
        .values(
          [S1, D1, J1, J2, S2, HR_X, HR_Y, ACCOUNTANT].map((u) => ({
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
            name: 'Cred RBAC Project A',
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
            name: 'Cred RBAC Project B',
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

      await db
        .insert(projectMembers)
        .values([
          { id: PROJ_A_MEMBER_J1, projectId: PROJ_A_ID, userId: J1.id, joinedAt: new Date() },
          { id: PROJ_B_MEMBER_J2, projectId: PROJ_B_ID, userId: J2.id, joinedAt: new Date() },
        ])
        .onConflictDoNothing()

      await db
        .insert(teams)
        .values([
          { id: TEAM_X_ID, name: 'Cred RBAC Team X' },
          { id: TEAM_Y_ID, name: 'Cred RBAC Team Y' },
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

      // Seed one credential on Project A with a KNOWN encrypted password so
      // reveal can be asserted against the plaintext.
      const crypto = new CredentialsCryptoService(cryptoConfig)
      await db
        .insert(projectCredentials)
        .values({
          id: CRED_A_ID,
          projectId: PROJ_A_ID,
          label: 'GitHub',
          login: 'cred-rbac@example.com',
          passwordCiphertext: crypto.encrypt(KNOWN_PASSWORD),
          url: 'https://github.com',
          notes: null,
          createdBy: ADMIN.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing()

      // Seed a credential on Project B — used for IDOR cross-project assertions.
      await db
        .insert(projectCredentials)
        .values({
          id: CRED_B_ID,
          projectId: PROJ_B_ID,
          label: 'GitLab (Project B)',
          login: 'cred-rbac-b@example.com',
          passwordCiphertext: crypto.encrypt('proj-b-password-rbac'),
          url: null,
          notes: null,
          createdBy: ADMIN.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing()

      // Seed mutable credentials on Project A for PATCH / DELETE tests.
      // These are separate IDs so the main CRED_A_ID is never mutated.
      await db
        .insert(projectCredentials)
        .values([
          {
            id: CRED_PATCH_ID,
            projectId: PROJ_A_ID,
            label: 'Patch-Target',
            login: null,
            passwordCiphertext: crypto.encrypt('patch-orig-pass'),
            url: null,
            notes: null,
            createdBy: ADMIN.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: CRED_DELETE_ID,
            projectId: PROJ_A_ID,
            label: 'Delete-Target',
            login: null,
            passwordCiphertext: crypto.encrypt('delete-orig-pass'),
            url: null,
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
          .where(
            inArray(projectCredentials.id, [CRED_A_ID, CRED_B_ID, CRED_PATCH_ID, CRED_DELETE_ID]),
          )
        await db
          .delete(projectMembers)
          .where(inArray(projectMembers.id, [PROJ_A_MEMBER_J1, PROJ_B_MEMBER_J2]))
        await db.delete(teamMembers).where(inArray(teamMembers.teamId, [TEAM_X_ID, TEAM_Y_ID]))
        await db.delete(projects).where(inArray(projects.id, [PROJ_A_ID, PROJ_B_ID]))
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
        url: `/api/projects/${PROJ_A_ID}/credentials`,
        cookies: { jwt: tokenFor(user) },
      })
    }

    function revealReq(user: SessionUser) {
      return app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/credentials/${CRED_A_ID}/reveal`,
        cookies: { jwt: tokenFor(user) },
      })
    }

    // ── LIST — RBAC matrix (AC4) ───────────────────────────────────────────────

    it('LIST: ADMIN → 200', async () => {
      const res = await listReq(ADMIN)
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<{ id: string }>
      expect(Array.isArray(body)).toBe(true)
      expect(body.some((c) => c.id === CRED_A_ID)).toBe(true)
    })

    it('LIST: own JUNIOR (J1) → 200', async () => {
      expect((await listReq(J1)).statusCode).toBe(200)
    })

    it('LIST: foreign JUNIOR (J2, member of B) → 403 IDOR', async () => {
      expect((await listReq(J2)).statusCode).toBe(403)
    })

    it('LIST: HR same team (HR_X) → 200', async () => {
      expect((await listReq(HR_X)).statusCode).toBe(200)
    })

    it('LIST: HR other team (HR_Y) → 403', async () => {
      expect((await listReq(HR_Y)).statusCode).toBe(403)
    })

    it('LIST: SENIOR (S1) → 403 (allowlist excludes SENIOR)', async () => {
      expect((await listReq(S1)).statusCode).toBe(403)
    })

    it('LIST: DROP (D1) → 403', async () => {
      expect((await listReq(D1)).statusCode).toBe(403)
    })

    it('LIST: ACCOUNTANT → 403', async () => {
      expect((await listReq(ACCOUNTANT)).statusCode).toBe(403)
    })

    // ── LIST never leaks the password (AC3) ────────────────────────────────────

    it('LIST: response contains NO password and NO ciphertext key (AC3)', async () => {
      const res = await listReq(ADMIN)
      expect(res.statusCode).toBe(200)
      // Raw body string must not contain the secret nor a password/ciphertext field.
      const raw = res.body
      expect(raw).not.toContain(KNOWN_PASSWORD)
      expect(raw.toLowerCase()).not.toContain('ciphertext')
      expect(raw).not.toContain('password')
      const body = res.json() as Array<Record<string, unknown>>
      const item = body.find((c) => c['id'] === CRED_A_ID)
      expect(item).toBeDefined()
      expect(item).not.toHaveProperty('password')
      expect(item).not.toHaveProperty('passwordCiphertext')
      expect(item).not.toHaveProperty('ciphertext')
      // Sanity: the non-secret fields ARE present.
      expect(item).toHaveProperty('label', 'GitHub')
      expect(item).toHaveProperty('login', 'cred-rbac@example.com')
    })

    // ── REVEAL — RBAC matrix + correctness + no-store (AC5) ─────────────────────

    it('REVEAL: ADMIN → 200 with correct plaintext', async () => {
      const res = await revealReq(ADMIN)
      expect(res.statusCode).toBe(200)
      const body = res.json() as { password: string }
      expect(body.password).toBe(KNOWN_PASSWORD)
    })

    it('REVEAL: response sets Cache-Control no-store (AC5)', async () => {
      const res = await revealReq(ADMIN)
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toContain('no-store')
    })

    it('REVEAL: own JUNIOR (J1) → 200', async () => {
      const res = await revealReq(J1)
      expect(res.statusCode).toBe(200)
      expect((res.json() as { password: string }).password).toBe(KNOWN_PASSWORD)
    })

    it('REVEAL: foreign JUNIOR (J2) → 403 IDOR', async () => {
      expect((await revealReq(J2)).statusCode).toBe(403)
    })

    it('REVEAL: HR same team (HR_X) → 200', async () => {
      expect((await revealReq(HR_X)).statusCode).toBe(200)
    })

    it('REVEAL: HR other team (HR_Y) → 403', async () => {
      expect((await revealReq(HR_Y)).statusCode).toBe(403)
    })

    it('REVEAL: SENIOR (S1) → 403', async () => {
      expect((await revealReq(S1)).statusCode).toBe(403)
    })

    it('REVEAL: DROP (D1) → 403', async () => {
      expect((await revealReq(D1)).statusCode).toBe(403)
    })

    it('REVEAL: ACCOUNTANT → 403', async () => {
      expect((await revealReq(ACCOUNTANT)).statusCode).toBe(403)
    })

    // ── PATCH — RBAC matrix ───────────────────────────────────────────────────

    function patchReq(user: SessionUser, credId = CRED_PATCH_ID) {
      return app.inject({
        method: 'PATCH',
        url: `/api/projects/${PROJ_A_ID}/credentials/${credId}`,
        cookies: { jwt: tokenFor(user) },
        payload: { label: 'Updated Label' },
      })
    }

    it('PATCH: ADMIN → 200', async () => {
      const res = await patchReq(ADMIN)
      expect(res.statusCode).toBe(200)
    })

    it('PATCH: own JUNIOR (J1) → 200', async () => {
      const res = await patchReq(J1)
      expect(res.statusCode).toBe(200)
    })

    it('PATCH: foreign JUNIOR (J2, member of B) → 403', async () => {
      expect((await patchReq(J2)).statusCode).toBe(403)
    })

    it('PATCH: SENIOR (S1) → 403 (allowlist excludes SENIOR)', async () => {
      expect((await patchReq(S1)).statusCode).toBe(403)
    })

    // ── DELETE — RBAC matrix ──────────────────────────────────────────────────

    function deleteReq(user: SessionUser, credId = CRED_DELETE_ID) {
      return app.inject({
        method: 'DELETE',
        url: `/api/projects/${PROJ_A_ID}/credentials/${credId}`,
        cookies: { jwt: tokenFor(user) },
      })
    }

    it('DELETE: ADMIN → 204', async () => {
      // Re-seed before deleting so this test is not order-dependent.
      const crypto = new CredentialsCryptoService(cryptoConfig)
      await dbSvc.db
        .insert(projectCredentials)
        .values({
          id: CRED_DELETE_ID,
          projectId: PROJ_A_ID,
          label: 'Delete-Target',
          login: null,
          passwordCiphertext: crypto.encrypt('delete-orig-pass'),
          url: null,
          notes: null,
          createdBy: ADMIN.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
      const res = await deleteReq(ADMIN)
      expect(res.statusCode).toBe(204)
    })

    it('DELETE: foreign HR (HR_Y, different team) → 403', async () => {
      // Use CRED_PATCH_ID which still exists (not deleted by the ADMIN delete test above).
      expect((await deleteReq(HR_Y, CRED_PATCH_ID)).statusCode).toBe(403)
    })

    it('DELETE: ACCOUNTANT → 403', async () => {
      expect((await deleteReq(ACCOUNTANT, CRED_PATCH_ID)).statusCode).toBe(403)
    })

    // ── IDOR — cross-project credential ID ───────────────────────────────────
    //
    // The IDOR property: PROJ_A_ID is valid AND accessible for J1, but CRED_B_ID
    // belongs to PROJ_B. `loadOwnedCredentialId` checks the (credentialId,
    // projectId) pair — a mismatched pair must yield 404 (not 200 or 403).
    // This proves the ownership SQL runs and cannot be bypassed by guessing IDs.

    it('IDOR — PATCH with own projectId + foreign credentialId → 404 (not 200)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${PROJ_A_ID}/credentials/${CRED_B_ID}`,
        cookies: { jwt: tokenFor(ADMIN) },
        payload: { label: 'Injected' },
      })
      expect(res.statusCode).toBe(404)
    })

    it('IDOR — DELETE with own projectId + foreign credentialId → 404 (not 204)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${PROJ_A_ID}/credentials/${CRED_B_ID}`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(404)
    })

    it('IDOR — REVEAL with own projectId + foreign credentialId → 404 (not 200)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${PROJ_A_ID}/credentials/${CRED_B_ID}/reveal`,
        cookies: { jwt: tokenFor(ADMIN) },
      })
      expect(res.statusCode).toBe(404)
    })
  },
)
