import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { User } from '../database/schema'
import * as schema from '../database/schema'
import { users } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { UsersService } from '../users/users.service'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { JwtAuthGuard } from './jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'

/**
 * Admin impersonation — security invariants integration spec.
 *
 * All 8 security invariants are tested against the real DB (crm_qa):
 *
 *   I1  non-ADMIN → POST /impersonate = 403
 *   I2  ADMIN → impersonate non-admin = 200, cookie set, decoded token correct
 *   I3  ADMIN → impersonate ADMIN = 403
 *   I4  ADMIN → impersonate self = 400
 *   I5  token with impersonatorId → POST /impersonate = 403 (no nesting)
 *   I6  token with impersonatorId → POST /stop-impersonating = 200, admin session restored
 *   I7  token without impersonatorId → POST /stop-impersonating = 400
 *   I8  GET /me during impersonation → impersonating:true, id=target
 *
 * DB-SKIP-GUARD: dbAvailable=false when DATABASE_URL unreachable (CI unit job).
 *
 * SEED namespace: a9e10001-**** (distinct from all other integration suites).
 */

const JWT_SECRET = 'test-secret-impersonation-32-chars-xx'
const FRONTEND_URL = 'http://localhost:3000'

// ── Personas ────────────────────────────────────────────────────────────────
// UUIDs must be RFC-4122 v4 (version nibble = 4, variant nibble = 8/9/a/b)
// because both impersonateSchema.userId and jwtPayloadSchema.impersonatorId
// use z.string().uuid() which enforces the strict pattern.
const ADMIN_ID = 'a9e10001-0000-4000-8000-000000000001'
const ADMIN_EMAIL = 'admin-impersonation@test.spec'

const SENIOR_ID = 'a9e10001-0000-4000-8000-000000000002'
const SENIOR_EMAIL = 'senior-impersonation@test.spec'

const JUNIOR_ID = 'a9e10001-0000-4000-8000-000000000003'
const JUNIOR_EMAIL = 'junior-impersonation@test.spec'

const ADMIN2_ID = 'a9e10001-0000-4000-8000-000000000004'
const ADMIN2_EMAIL = 'admin2-impersonation@test.spec'

const TEST_USER_IDS = [ADMIN_ID, SENIOR_ID, JUNIOR_ID, ADMIN2_ID]

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
    seniorSharePercent: 26,
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
          GOOGLE_CLIENT_ID: 'test-client-id',
          GOOGLE_CALLBACK_URL: 'http://localhost/callback',
        }) as Record<string, string>
      )[key],
  } as unknown as ConfigService
}

/** Sign a JWT with impersonatorId for testing I5/I6/I7. */
function signImpersonationToken(
  jwtSvc: JwtService,
  opts: { id: string; email: string; role: string; impersonatorId?: string },
): string {
  return jwtSvc.sign(opts)
}

describe('AuthController — impersonation security invariants (real DB)', () => {
  let dbAvailable = true
  let pool: Pool
  let dbSvc: DatabaseService
  let app: NestFastifyApplication
  let jwtSvc: JwtService

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      await probe.end()
    } catch {
      console.warn('[auth.impersonation integration] SKIPPED — no DB at DATABASE_URL (CI unit job)')
      dbAvailable = false
      return
    }

    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })

    const usersService = Object.assign(Object.create(UsersService.prototype) as UsersService, {
      db: dbSvc,
    })

    const authService = Object.assign(Object.create(AuthService.prototype) as AuthService, {
      config: makeConfig(),
    })

    // Re-declare design:paramtypes — vitest esbuild drops decorator metadata
    // (same pattern as auth.oauth-callback.integration.spec.ts).
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
          useFactory: (jwt: JwtService, reflector: Reflector) =>
            new JwtAuthGuard(jwt, reflector, usersService),
          inject: [JwtService, Reflector],
        },
      ],
    })
    class TestImpersonationModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [TestImpersonationModule],
    })
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'integration-test-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwtSvc = moduleRef.get<JwtService>(JwtService)

    // ── Seed ──────────────────────────────────────────────────────────────
    await db
      .insert(users)
      .values([
        makeRow({ id: ADMIN_ID, email: ADMIN_EMAIL, displayName: 'Admin Imp', role: 'ADMIN' }),
        makeRow({ id: SENIOR_ID, email: SENIOR_EMAIL, displayName: 'Senior Imp', role: 'SENIOR' }),
        makeRow({ id: JUNIOR_ID, email: JUNIOR_EMAIL, displayName: 'Junior Imp', role: 'JUNIOR' }),
        makeRow({ id: ADMIN2_ID, email: ADMIN2_EMAIL, displayName: 'Admin2 Imp', role: 'ADMIN' }),
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
      // Non-fatal cleanup failure.
    }
    await pool?.end()
  }, 15_000)

  // ── Helpers ──────────────────────────────────────────────────────────────

  function jwtCookie(token: string): string {
    return `jwt=${token}`
  }

  function adminToken(): string {
    return signImpersonationToken(jwtSvc, {
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      role: 'ADMIN',
    })
  }

  function seniorToken(): string {
    return signImpersonationToken(jwtSvc, {
      id: SENIOR_ID,
      email: SENIOR_EMAIL,
      role: 'SENIOR',
    })
  }

  function impersonatingToken(targetId: string, targetEmail: string, targetRole: string): string {
    return signImpersonationToken(jwtSvc, {
      id: targetId,
      email: targetEmail,
      role: targetRole,
      impersonatorId: ADMIN_ID,
    })
  }

  // ── I1: non-ADMIN → POST /impersonate = 403 ──────────────────────────────

  it('I1: non-ADMIN (SENIOR) → POST /impersonate = 403', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/impersonate',
      headers: { cookie: jwtCookie(seniorToken()) },
      payload: { userId: JUNIOR_ID },
    })

    expect(res.statusCode).toBe(403)
  })

  // ── I2: ADMIN → impersonate non-admin = 200, cookie set, token correct ───

  it('I2: ADMIN → impersonate SENIOR = 200, cookie set, decoded token contains impersonatorId', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/impersonate',
      headers: { cookie: jwtCookie(adminToken()) },
      payload: { userId: SENIOR_ID },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true })

    // Cookie must be set.
    const cookieHeader = res.headers['set-cookie']
    const cookieStr = Array.isArray(cookieHeader) ? cookieHeader.join(';') : (cookieHeader ?? '')
    expect(cookieStr).toContain('jwt=')

    // Decode the issued token and verify the payload.
    const rawCookieValue = cookieStr.match(/jwt=([^;]+)/)?.[1]
    expect(rawCookieValue).toBeTruthy()
    const decoded = jwtSvc.verify<{
      id: string
      role: string
      impersonatorId?: string
    }>(rawCookieValue!)
    expect(decoded.id).toBe(SENIOR_ID)
    expect(decoded.role).toBe('SENIOR')
    expect(decoded.impersonatorId).toBe(ADMIN_ID)
  })

  // ── I3: ADMIN → impersonate ADMIN = 403 ──────────────────────────────────

  it('I3: ADMIN → impersonate another ADMIN = 403', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/impersonate',
      headers: { cookie: jwtCookie(adminToken()) },
      payload: { userId: ADMIN2_ID },
    })

    expect(res.statusCode).toBe(403)
  })

  // ── I4: ADMIN → impersonate self = 400 ───────────────────────────────────

  it('I4: ADMIN → impersonate self = 400', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/impersonate',
      headers: { cookie: jwtCookie(adminToken()) },
      payload: { userId: ADMIN_ID },
    })

    expect(res.statusCode).toBe(400)
  })

  // ── I5: token with impersonatorId → POST /impersonate = 403 (no nesting) ─

  it('I5: token with impersonatorId → POST /impersonate = 403 (nesting blocked)', async () => {
    if (!dbAvailable) return

    const nestedToken = impersonatingToken(SENIOR_ID, SENIOR_EMAIL, 'SENIOR')

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/impersonate',
      headers: { cookie: jwtCookie(nestedToken) },
      payload: { userId: JUNIOR_ID },
    })

    // RolesGuard blocks at ADMIN role check — returns 403.
    expect(res.statusCode).toBe(403)
  })

  // ── I6: token with impersonatorId → POST /stop-impersonating = 200 ───────

  it('I6: token with impersonatorId → POST /stop-impersonating = 200, admin session restored', async () => {
    if (!dbAvailable) return

    const token = impersonatingToken(SENIOR_ID, SENIOR_EMAIL, 'SENIOR')

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/stop-impersonating',
      headers: { cookie: jwtCookie(token) },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true })

    // Cookie must be set with admin's JWT (no impersonatorId).
    const cookieHeader = res.headers['set-cookie']
    const cookieStr = Array.isArray(cookieHeader) ? cookieHeader.join(';') : (cookieHeader ?? '')
    expect(cookieStr).toContain('jwt=')

    const rawCookieValue = cookieStr.match(/jwt=([^;]+)/)?.[1]
    expect(rawCookieValue).toBeTruthy()
    const decoded = jwtSvc.verify<{
      id: string
      role: string
      impersonatorId?: string
    }>(rawCookieValue!)
    // Restored to the original admin.
    expect(decoded.id).toBe(ADMIN_ID)
    expect(decoded.role).toBe('ADMIN')
    expect(decoded.impersonatorId).toBeUndefined()
  })

  // ── I7: token without impersonatorId → POST /stop-impersonating = 400 ────

  it('I7: regular token (no impersonatorId) → POST /stop-impersonating = 400', async () => {
    if (!dbAvailable) return

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/stop-impersonating',
      headers: { cookie: jwtCookie(seniorToken()) },
    })

    expect(res.statusCode).toBe(400)
  })

  // ── I8: GET /me during impersonation → impersonating:true, id=target ──────

  it('I8: GET /me with impersonating token → impersonating:true, id=target', async () => {
    if (!dbAvailable) return

    const token = impersonatingToken(SENIOR_ID, SENIOR_EMAIL, 'SENIOR')

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: jwtCookie(token) },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { id: string; impersonating?: boolean }
    expect(body.id).toBe(SENIOR_ID)
    expect(body.impersonating).toBe(true)
  })

  // ── Extra: jwt.guard preserves impersonatorId in decoded payload ──────────

  it('guard: impersonatorId passes through Zod jwtPayloadSchema validation', async () => {
    if (!dbAvailable) return

    // Any authenticated endpoint — /me is convenient.
    const token = impersonatingToken(SENIOR_ID, SENIOR_EMAIL, 'SENIOR')
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: jwtCookie(token) },
    })
    // 200 means the guard accepted the token — did NOT reject it despite extra impersonatorId field.
    expect(res.statusCode).toBe(200)
  })
})
