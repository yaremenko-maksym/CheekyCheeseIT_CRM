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
 * Pre-deploy security audit — OAuth callback auth, real-Postgres integration.
 *
 * Drives the REAL AuthController.googleCallback through the real Fastify
 * request lifecycle (app.inject) + real DB lookups. Only the external Google
 * boundary (exchangeGoogleCode / getGoogleUserInfo) is mocked — guards and
 * DB are NOT mocked (lesson: feedback_mocked_e2e_guards).
 *
 * COVERED:
 *   C1  valid OAuth flow, no prior googleId → 302 to /, jwt cookie set, binding persisted
 *   C2  valid OAuth flow, googleId already matches → 302 to /, jwt cookie set
 *   C3  googleId mismatch (email bound to a different sub) → 302 to /login?error=account_mismatch,
 *       NO jwt cookie, DB binding unchanged (MED code-review #297)
 *   C4  invalid state cookie → 302 to /login?error=invalid_state, no cookie
 *   C5  email not in DB → 302 to /login?error=unauthorized, no cookie
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job)
 *   → every test returns early, suite stays green in no-DB environments.
 *
 * SEED namespace: a17a0002-**** (distinct from one-tap suite a17a0001-****).
 */

const JWT_SECRET = 'test-secret-32-chars-minimum-xxxxxx'
const GOOGLE_CLIENT_ID = 'integration-client-id'
const FRONTEND_URL = 'http://localhost:3000'

// ── Personas ────────────────────────────────────────────────────────────────
const FRESH_USER_ID = 'a17a0002-0000-0000-0000-000000000001'
const FRESH_EMAIL = 'auth-oauth-fresh@test.spec'
const FRESH_GOOGLE_SUB = 'google-sub-oauth-fresh-001'

const BOUND_USER_ID = 'a17a0002-0000-0000-0000-000000000002'
const BOUND_EMAIL = 'auth-oauth-bound@test.spec'
const BOUND_GOOGLE_SUB = 'google-sub-oauth-bound-002'

const MISMATCH_USER_ID = 'a17a0002-0000-0000-0000-000000000003'
const MISMATCH_EMAIL = 'auth-oauth-mismatch@test.spec'
const MISMATCH_BOUND_SUB = 'google-sub-oauth-already-bound-XYZ'
const MISMATCH_INCOMING_SUB = 'google-sub-oauth-attacker-ABC'

const TEST_USER_IDS = [FRESH_USER_ID, BOUND_USER_ID, MISMATCH_USER_ID]

// Shared valid state token injected as cookie by tests that need it.
const VALID_STATE = 'deadbeefcafe0123deadbeefcafe0123'

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
    usrRecord: null,
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

function makeConfig(): ConfigService {
  return {
    get: (key: string) =>
      (
        ({
          NODE_ENV: 'test',
          FRONTEND_URL,
          GOOGLE_CLIENT_ID,
          GOOGLE_CALLBACK_URL: 'http://localhost/callback',
        }) as Record<string, string>
      )[key],
  } as unknown as ConfigService
}

/** Serialize a Set-Cookie-style string for a single cookie value (no signing). */
function stateCookieHeader(state: string): string {
  return `oauth_state=${state}`
}

describe('AuthController.googleCallback — real DB integration (audit MED)', () => {
  let dbAvailable = true
  let pool: Pool
  let dbSvc: DatabaseService
  let app: NestFastifyApplication

  // Mock ONLY the external Google token-exchange + userinfo boundaries.
  const exchangeGoogleCode =
    vi.fn<
      (code: string) => Promise<{ access_token: string; id_token: string; expires_in: number }>
    >()
  const getGoogleUserInfo =
    vi.fn<
      (accessToken: string) => Promise<{ id: string; email: string; name: string; picture: string }>
    >()

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn(
        '[auth.oauth-callback integration] SKIPPED — no DB at DATABASE_URL (CI unit job)',
      )
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })

    // Real UsersService bound to real DB.
    const usersService = Object.assign(Object.create(UsersService.prototype) as UsersService, {
      db: dbSvc,
    })

    // Real AuthService with only the external Google boundaries mocked.
    const authService = Object.assign(Object.create(AuthService.prototype) as AuthService, {
      config: makeConfig(),
      exchangeGoogleCode,
      getGoogleUserInfo,
    })

    // Re-declare design:paramtypes — vitest esbuild drops decorator metadata
    // (same pattern as auth.one-tap.integration.spec.ts).
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
          id: FRESH_USER_ID,
          email: FRESH_EMAIL,
          displayName: 'OAuth Fresh',
          role: 'SENIOR',
          googleId: null,
        }),
        makeRow({
          id: BOUND_USER_ID,
          email: BOUND_EMAIL,
          displayName: 'OAuth Bound',
          role: 'SENIOR',
          googleId: BOUND_GOOGLE_SUB,
        }),
        makeRow({
          id: MISMATCH_USER_ID,
          email: MISMATCH_EMAIL,
          displayName: 'OAuth Mismatch',
          role: 'SENIOR',
          googleId: MISMATCH_BOUND_SUB,
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
      // Non-fatal cleanup failure — do not mask test results.
    }
    await pool?.end()
  }, 15_000)

  beforeEach(() => {
    exchangeGoogleCode.mockReset()
    getGoogleUserInfo.mockReset()
  })

  // Helper: perform GET /api/auth/google/callback with a pre-set state cookie.
  function callCallback(params: {
    code: string
    state: string
    stateCookie?: string
  }): ReturnType<typeof app.inject> {
    return app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?code=${encodeURIComponent(params.code)}&state=${encodeURIComponent(params.state)}`,
      headers: {
        cookie: stateCookieHeader(params.stateCookie ?? params.state),
      },
    })
  }

  it('C1: fresh user (no googleId) → 302 to /, jwt cookie set, binding persisted', async () => {
    if (!dbAvailable) return

    exchangeGoogleCode.mockResolvedValue({
      access_token: 'access-token-fresh',
      id_token: 'id-token',
      expires_in: 3600,
    })
    getGoogleUserInfo.mockResolvedValue({
      id: FRESH_GOOGLE_SUB,
      email: FRESH_EMAIL,
      name: 'OAuth Fresh',
      picture: 'p',
    })

    const res = await callCallback({ code: 'auth-code-fresh', state: VALID_STATE })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe(`${FRONTEND_URL}/`)
    const setCookie = res.headers['set-cookie']
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '')
    expect(cookieStr).toContain('jwt=')

    // Verify binding was persisted in DB.
    const row = await dbSvc.db
      .select()
      .from(users)
      .where(eq(users.id, FRESH_USER_ID))
      .then((rows) => rows[0])
    expect(row?.googleId).toBe(FRESH_GOOGLE_SUB)
  })

  it('C2: user already has matching googleId → 302 to /, jwt cookie set', async () => {
    if (!dbAvailable) return

    exchangeGoogleCode.mockResolvedValue({
      access_token: 'access-token-bound',
      id_token: 'id-token',
      expires_in: 3600,
    })
    getGoogleUserInfo.mockResolvedValue({
      id: BOUND_GOOGLE_SUB,
      email: BOUND_EMAIL,
      name: 'OAuth Bound',
      picture: 'p',
    })

    const res = await callCallback({ code: 'auth-code-bound', state: VALID_STATE })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe(`${FRONTEND_URL}/`)
    const setCookie = res.headers['set-cookie']
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '')
    expect(cookieStr).toContain('jwt=')
  })

  it('C3: googleId mismatch → 302 to /login?error=account_mismatch, NO jwt cookie, DB binding unchanged', async () => {
    if (!dbAvailable) return

    // The attacker authenticates with a valid Google account whose email
    // matches an existing user, but whose `sub` differs from the one bound.
    exchangeGoogleCode.mockResolvedValue({
      access_token: 'access-token-attacker',
      id_token: 'id-token',
      expires_in: 3600,
    })
    getGoogleUserInfo.mockResolvedValue({
      id: MISMATCH_INCOMING_SUB,
      email: MISMATCH_EMAIL,
      name: 'OAuth Mismatch',
      picture: 'p',
    })

    const res = await callCallback({ code: 'auth-code-mismatch', state: VALID_STATE })

    // Must redirect to error page — no session issued.
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe(`${FRONTEND_URL}/login?error=account_mismatch`)

    // No jwt cookie must be set.
    const setCookie = res.headers['set-cookie']
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '')
    expect(cookieStr).not.toContain('jwt=')

    // The original binding in the DB must remain intact (attacker did not overwrite).
    const row = await dbSvc.db
      .select()
      .from(users)
      .where(eq(users.id, MISMATCH_USER_ID))
      .then((rows) => rows[0])
    expect(row?.googleId).toBe(MISMATCH_BOUND_SUB)
  })

  it('C4: invalid state cookie → 302 to /login?error=invalid_state, no cookie', async () => {
    if (!dbAvailable) return

    // State in URL differs from the one stored in the cookie.
    const res = await callCallback({
      code: 'auth-code-x',
      state: 'url-state-value',
      stateCookie: 'different-cookie-state',
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe(`${FRONTEND_URL}/login?error=invalid_state`)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('C5: email not in DB → 302 to /login?error=unauthorized, no cookie', async () => {
    if (!dbAvailable) return

    exchangeGoogleCode.mockResolvedValue({
      access_token: 'access-token-unknown',
      id_token: 'id-token',
      expires_in: 3600,
    })
    getGoogleUserInfo.mockResolvedValue({
      id: 'google-sub-unknown',
      email: 'unknown-not-seeded@test.spec',
      name: 'Unknown',
      picture: 'p',
    })

    const res = await callCallback({ code: 'auth-code-unknown', state: VALID_STATE })

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe(`${FRONTEND_URL}/login?error=unauthorized`)
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})
