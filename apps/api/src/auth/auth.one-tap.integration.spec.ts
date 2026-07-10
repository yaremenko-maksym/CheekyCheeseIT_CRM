import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../database/schema'
import * as schema from '../database/schema'
import { users } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { UsersService } from '../users/users.service'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { JwtAuthGuard } from './jwt.guard'

/**
 * Pre-deploy security audit — One-Tap auth, real-Postgres integration.
 *
 * Drives the REAL AuthController.googleOneTap through the real Fastify request
 * lifecycle (app.inject) + real DB lookups (UsersService.findByEmail /
 * updateGoogleId). Only the external Google boundary
 * (AuthService.verifyGoogleIdToken) is mocked — guards are NOT mocked
 * (lesson: feedback_mocked_e2e_guards).
 *
 * COVERED:
 *   I1  verified + allowlisted user                  → 200 + jwt cookie set
 *   I2  email_verified=false (verifier throws)       → 401, NO cookie
 *   I3  email NOT in allowlist                        → 401, NO cookie
 *   I4  googleId mismatch (bound to a different sub)  → 401, NO cookie (audit LOW #3)
 *   I5  first login binds googleId for a fresh user   → 200 + DB googleId persisted
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job)
 *   → every test returns early, suite stays green in no-DB environments.
 *
 * SEED namespace: a17a0001-**** (distinct from other suites).
 */

const JWT_SECRET = 'test-secret-32-chars-minimum-xxxxxx'
const GOOGLE_CLIENT_ID = 'integration-client-id'

// ── Personas ───────────────────────────────────────────────────────────────
const VERIFIED_USER_ID = 'a17a0001-0000-0000-0000-000000000001'
const VERIFIED_EMAIL = 'auth-onetap-verified@test.spec'
const VERIFIED_SUB = 'google-sub-verified-001'

const MISMATCH_USER_ID = 'a17a0001-0000-0000-0000-000000000002'
const MISMATCH_EMAIL = 'auth-onetap-mismatch@test.spec'
const MISMATCH_BOUND_SUB = 'google-sub-already-bound-XYZ'
const MISMATCH_INCOMING_SUB = 'google-sub-attacker-ABC'

const FRESH_USER_ID = 'a17a0001-0000-0000-0000-000000000003'
const FRESH_EMAIL = 'auth-onetap-fresh@test.spec'
const FRESH_SUB = 'google-sub-fresh-003'

const TEST_USER_IDS = [VERIFIED_USER_ID, MISMATCH_USER_ID, FRESH_USER_ID]

function makeRow(overrides: Partial<User>): User {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'x@y.z',
    displayName: 'X',
    role: 'JUNIOR',
    googleId: null,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    legalFullName: null,
    registrationAddress: null,
    adminNote: null,
    monthlySalary: null,
    salaryCurrency: null,
    seniorSharePercent: 0,
    dropSharePercent: null,
    paymentMethod: null,
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User
}

/** Identity shape returned by the (mocked) verifier — mirrors verifyGoogleIdToken. */
type GoogleIdentity = { sub: string; email: string; name: string; picture: string }

function makeConfig(): ConfigService {
  return {
    get: (key: string) =>
      (
        ({
          NODE_ENV: 'test',
          FRONTEND_URL: 'http://localhost:3000',
          GOOGLE_CLIENT_ID,
          GOOGLE_CALLBACK_URL: 'http://localhost/callback',
        }) as Record<string, string>
      )[key],
  } as unknown as ConfigService
}

describe('AuthController.googleOneTap — real DB integration (audit HIGH/LOW)', () => {
  let dbAvailable = true
  let pool: Pool
  let dbSvc: DatabaseService
  let app: NestFastifyApplication
  // Mock ONLY the external Google verification boundary.
  const verifyGoogleIdToken = vi.fn<(credential: string) => Promise<GoogleIdentity>>()

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[auth.one-tap integration] SKIPPED — no DB at DATABASE_URL (CI unit job)')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })

    // Real UsersService bound to real DB; only findByEmail / updateGoogleId are
    // exercised by the One-Tap path — both use `this.db.db` exclusively.
    const usersService = Object.assign(Object.create(UsersService.prototype) as UsersService, {
      db: dbSvc,
    })

    // Real AuthService instance with the external verifier mocked.
    const authService = Object.assign(Object.create(AuthService.prototype) as AuthService, {
      config: makeConfig(),
      verifyGoogleIdToken,
    })

    // vitest's esbuild transform drops the TypeScript decorator
    // constructor-parameter metadata NestJS DI relies on, so class-based
    // injection silently passes `undefined` for AuthController's deps (same
    // root cause as onboarding.guard.integration.spec.ts). Re-declare the
    // `design:paramtypes` by hand so Nest's injector resolves each constructor
    // arg by token, matching AuthController's real signature:
    //   (AuthService, UsersService, JwtService, ConfigService)
    Reflect.defineMetadata(
      'design:paramtypes',
      [AuthService, UsersService, JwtService, ConfigService],
      AuthController,
    )

    @Module({
      imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '7d' } })],
      controllers: [AuthController],
      providers: [
        Reflector,
        { provide: AuthService, useValue: authService },
        { provide: UsersService, useValue: usersService },
        { provide: ConfigService, useValue: makeConfig() },
        {
          provide: APP_GUARD,
          useFactory: (jwt: JwtService, reflector: Reflector) => new JwtAuthGuard(jwt, reflector),
          inject: [JwtService, Reflector],
        },
      ],
    })
    class TestAuthModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestAuthModule] }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'integration-test-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    // ── Seed ────────────────────────────────────────────────────────────────
    await db
      .insert(users)
      .values([
        makeRow({
          id: VERIFIED_USER_ID,
          email: VERIFIED_EMAIL,
          displayName: 'OneTap Verified',
          role: 'SENIOR',
          googleId: VERIFIED_SUB,
        }),
        makeRow({
          id: MISMATCH_USER_ID,
          email: MISMATCH_EMAIL,
          displayName: 'OneTap Mismatch',
          role: 'SENIOR',
          googleId: MISMATCH_BOUND_SUB,
        }),
        makeRow({
          id: FRESH_USER_ID,
          email: FRESH_EMAIL,
          displayName: 'OneTap Fresh',
          role: 'SENIOR',
          googleId: null,
        }),
      ])
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await app?.close()
    } catch {
      // ignore
    }
    try {
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // Non-fatal cleanup failure — do not mask test results
    }
    await pool?.end()
  }, 15_000)

  beforeEach(() => {
    verifyGoogleIdToken.mockReset()
  })

  it('I1: verified + allowlisted user → 200 + jwt cookie set', async () => {
    if (!dbAvailable) return
    verifyGoogleIdToken.mockResolvedValue({
      sub: VERIFIED_SUB,
      email: VERIFIED_EMAIL,
      name: 'OneTap Verified',
      picture: 'p',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google/one-tap',
      payload: { credential: 'valid-credential' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    const setCookie = res.headers['set-cookie']
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '')
    expect(cookieStr).toContain('jwt=')
  })

  it('I2: email_verified=false (verifier throws) → 401, no cookie', async () => {
    if (!dbAvailable) return
    // The service rejects unverified emails — controller maps that to 401.
    verifyGoogleIdToken.mockRejectedValue(new Error('Google account email is not verified'))

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google/one-tap',
      payload: { credential: 'unverified-credential' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('I3: email not in allowlist → 401, no cookie', async () => {
    if (!dbAvailable) return
    verifyGoogleIdToken.mockResolvedValue({
      sub: 'google-sub-stranger',
      email: 'stranger-not-seeded@test.spec',
      name: 'Stranger',
      picture: 'p',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google/one-tap',
      payload: { credential: 'cred' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('I4: googleId mismatch (email bound to a different sub) → 401, no cookie (LOW #3)', async () => {
    if (!dbAvailable) return
    // The signature/email are valid, but the incoming `sub` differs from the
    // one already bound to this email in the DB — must be refused.
    verifyGoogleIdToken.mockResolvedValue({
      sub: MISMATCH_INCOMING_SUB,
      email: MISMATCH_EMAIL,
      name: 'OneTap Mismatch',
      picture: 'p',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google/one-tap',
      payload: { credential: 'cred' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()

    // The original binding must NOT have been overwritten.
    const row = await dbSvc.db
      .select()
      .from(users)
      .where(eq(users.id, MISMATCH_USER_ID))
      .then((rows) => rows[0])
    expect(row?.googleId).toBe(MISMATCH_BOUND_SUB)
  })

  it('I5: fresh user (no googleId yet) → 200 + googleId persisted', async () => {
    if (!dbAvailable) return
    verifyGoogleIdToken.mockResolvedValue({
      sub: FRESH_SUB,
      email: FRESH_EMAIL,
      name: 'OneTap Fresh',
      picture: 'p',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/google/one-tap',
      payload: { credential: 'cred' },
    })

    expect(res.statusCode).toBe(200)
    const row = await dbSvc.db
      .select()
      .from(users)
      .where(eq(users.id, FRESH_USER_ID))
      .then((rows) => rows[0])
    expect(row?.googleId).toBe(FRESH_SUB)
  })
})
