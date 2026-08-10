import { Controller, Get, Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { UsersService } from '../users/users.service'
import type { User } from '../database/schema'

/**
 * Integration test — pins that the audit-journal endpoints are GONE (404)
 * after AuditModule removal.
 *
 * WHY this test exists (PR-1 Documents redesign):
 *   The user-facing audit journal (GET /api/me/audit-trail + GET /api/audit/all)
 *   is being removed. The server-side AuditInterceptor (logging) is KEPT.
 *   This spec ensures the HTTP endpoints no longer exist while the Fastify
 *   pipeline (guards, routing) still works correctly.
 *
 * PATTERN: sentinel-controller test (no live DB required).
 *   Mirrors contract-controllers.integration.spec.ts — only real Nest/Fastify
 *   stack, real JWT, real guards. Sentinel controllers stand in for any
 *   surviving routes so we know the app boots and routing works.
 *
 * RED phase: AuditModule is still registered → endpoints return 200/403, not 404.
 * GREEN phase: AuditModule removed → endpoints return 404.
 */

const JWT_SECRET = 'test-audit-removal-secret-32chars-x'

const adminUser: SessionUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: 'admin@test.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
}

const seniorUser: SessionUser = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  email: 'senior@test.com',
  displayName: 'Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
}

// ---------------------------------------------------------------------------
// Sentinel controller — represents a surviving route so we know the Fastify
// pipeline is up and routing works. If health returns 200, but audit returns
// 404, we know the audit module was actually removed (not the whole app).
// ---------------------------------------------------------------------------

@Controller('health')
class SentinelHealthController {
  @Get()
  check(@CurrentUser() _user: SessionUser) {
    return { ok: true }
  }
}

// ---------------------------------------------------------------------------
// UsersService stand-in for the guard's DB re-hydration path (jwt.guard.ts AC2:
// role + archivedAt are re-read per request instead of being trusted from the
// token). This spec is deliberately DB-less, so `findById` is served from the
// two sentinel personas above. Constructing the guard without a users service
// would pin a shape the application cannot have — bootstrap refuses to start
// when a DI-built guard lacks it (auth/jwt-guard-wiring.ts).
// ---------------------------------------------------------------------------

const USER_ROWS = new Map<string, Pick<User, 'role' | 'archivedAt'>>([
  [adminUser.id, { role: 'ADMIN', archivedAt: null }],
  [seniorUser.id, { role: 'SENIOR', archivedAt: null }],
])

function makeUsersServiceStub(): UsersService {
  return Object.assign(Object.create(UsersService.prototype) as UsersService, {
    findById: (id: string) => Promise.resolve(USER_ROWS.get(id)),
  })
}

// ---------------------------------------------------------------------------
// Minimal test module — real JWT, real guards, NO AuditModule.
// After AuditModule removal this accurately mirrors the production module.
// ---------------------------------------------------------------------------

@Module({
  imports: [
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [SentinelHealthController],
  providers: [
    Reflector,
    {
      provide: APP_GUARD,
      useFactory: (jwt: JwtService, reflector: Reflector) =>
        new JwtAuthGuard(jwt, reflector, makeUsersServiceStub()),
      inject: [JwtService, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new RolesGuard(reflector),
      inject: [Reflector],
    },
  ],
})
class AuditRemovalTestModule {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Audit journal removal — endpoints must return 404 (PR-1)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuditRemovalTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'audit-removal-cookie-secret-32cxx' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    jwt = moduleRef.get(JwtService)
  })

  afterAll(async () => {
    await app.close()
  })

  function signFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  // -------------------------------------------------------------------------
  // Sentinel — confirms the pipeline is alive (not the whole app is broken)
  // -------------------------------------------------------------------------

  it('GET /api/health → 200 (pipeline is alive, guards work)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      cookies: { jwt: signFor(adminUser) },
    })
    expect(res.statusCode).toBe(200)
  })

  // -------------------------------------------------------------------------
  // Audit journal endpoints must be 404 after module removal
  // -------------------------------------------------------------------------

  it('GET /api/me/audit-trail → 404 (audit journal endpoint removed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/audit-trail',
      cookies: { jwt: signFor(seniorUser) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/audit/all → 404 (audit journal endpoint removed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/all',
      cookies: { jwt: signFor(adminUser) },
    })
    expect(res.statusCode).toBe(404)
  })

  // -------------------------------------------------------------------------
  // Unauthenticated requests to removed endpoints must also 404
  // (not 401 — the route doesn't exist at all)
  // -------------------------------------------------------------------------

  it('GET /api/me/audit-trail → 404 without JWT (route gone, guard irrelevant)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me/audit-trail',
    })
    // 404 because route doesn't exist; 401 would mean guard fires = route exists
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/audit/all → 404 without JWT (route gone, guard irrelevant)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/all',
    })
    expect(res.statusCode).toBe(404)
  })
})
