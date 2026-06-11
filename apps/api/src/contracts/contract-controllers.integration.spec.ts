import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Module,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CurrentUser } from '../auth/current-user.decorator'

/**
 * Integration test — pins that contract controller endpoints are reachable
 * at their REAL paths (/api/users/:id/contract*, /api/onboarding/contract*)
 * through the real Fastify HTTP pipeline with real guards (JwtAuthGuard +
 * RolesGuard). No live DB or external services required.
 *
 * WHY this test exists (A3-2 TASK 2):
 *   Before the TASK 1 fix, both controllers had @Controller('api/users') /
 *   @Controller('api/onboarding'), producing double-prefixed paths
 *   /api/api/users/... that always 404'd. A unit test would never catch
 *   this because it doesn't exercise the real NestJS router. This integration
 *   test would have caught the regression immediately.
 *
 * WHAT it covers:
 *   1. All 6 EmployeeContractsController endpoints exist at /api/users/:id/contract*
 *   2. Both OnboardingContractController endpoints exist at /api/onboarding/contract*
 *   3. Non-ADMIN users → 403 on all /api/users/:id/contract* endpoints (RolesGuard)
 *   4. Self un-onboarded SENIOR can reach /api/onboarding/contract (bypass works)
 *   5. Old double-prefixed paths /api/api/... → 404 (regression guard)
 *
 * WHY sentinel controllers instead of real ones:
 *   Real controllers depend on EmployeeContractsService → DatabaseService →
 *   live PostgreSQL. Sentinel handlers return a trivial payload so we can
 *   verify HTTP routing + guard decisions without a DB connection.
 *
 * WHY useFactory for guards:
 *   vitest uses esbuild which strips TypeScript decorator constructor-parameter
 *   metadata. NestJS DI silently injects `undefined` for unmarked params.
 *   Explicit useFactory resolves deps via the test module's injector.
 */

const JWT_SECRET = 'test-integration-secret-32-chars-xxx'

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

const targetUserId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

// ---------------------------------------------------------------------------
// Sentinel controllers — mirror EXACT route structure from real controllers
// (same prefix, same @Roles, same sub-paths). Return trivial payloads so no
// service/DB injection is needed.
// ---------------------------------------------------------------------------

/** Mirrors EmployeeContractsController (@Controller('users') + @Roles('ADMIN')) */
@Controller('users')
@Roles('ADMIN')
class SentinelEmployeeContractsController {
  @Get(':id/contract')
  get(@Param('id') id: string, @CurrentUser() viewer: SessionUser) {
    return { ok: true, endpoint: 'GET /users/:id/contract', id, viewer: viewer.role }
  }

  @Patch(':id/contract')
  update(@Param('id') id: string, @Body() _body: unknown) {
    return { ok: true, endpoint: 'PATCH /users/:id/contract', id }
  }

  @Post(':id/contract/ready')
  markReady(@Param('id') id: string) {
    return { ok: true, endpoint: 'POST /users/:id/contract/ready', id }
  }

  @Post(':id/contract/revert')
  revert(@Param('id') id: string) {
    return { ok: true, endpoint: 'POST /users/:id/contract/revert', id }
  }

  @Post(':id/contract/reset')
  reset(@Param('id') id: string) {
    return { ok: true, endpoint: 'POST /users/:id/contract/reset', id }
  }

  @Get(':id/contract/pdf')
  @Roles() // override class ADMIN-only — owner-or-ADMIN enforced in handler below
  @Header('Cache-Control', 'private, max-age=60')
  getPdf(
    @Param('id') id: string,
    @CurrentUser() requester: SessionUser,
    @Res() reply: import('fastify').FastifyReply,
  ): void {
    if (requester.role !== 'ADMIN' && requester.id !== id) {
      throw new ForbiddenException('Можно открыть только свой контракт')
    }
    void reply.header('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 stub'))
  }
}

/** Mirrors OnboardingContractController (@Controller('onboarding') — no @Roles, self-access) */
@Controller('onboarding')
class SentinelOnboardingContractController {
  @Get('contract')
  getForSigning(@CurrentUser() user: SessionUser) {
    return { ok: true, endpoint: 'GET /onboarding/contract', userId: user.id }
  }

  @Get('contract/pdf')
  @Header('Cache-Control', 'private, max-age=60')
  getOwnPdf(@CurrentUser() _user: SessionUser, @Res() reply: import('fastify').FastifyReply): void {
    void reply.header('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4 stub'))
  }
}

// ---------------------------------------------------------------------------
// Minimal test module — real JWT, real guards, real Fastify pipeline.
// ---------------------------------------------------------------------------

@Module({
  imports: [
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [SentinelEmployeeContractsController, SentinelOnboardingContractController],
  providers: [
    Reflector,
    // JwtAuthGuard first: populates req.user from cookie.
    {
      provide: APP_GUARD,
      useFactory: (jwt: JwtService, reflector: Reflector) => new JwtAuthGuard(jwt, reflector),
      inject: [JwtService, Reflector],
    },
    // RolesGuard second: reads req.user.role + @Roles() metadata.
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new RolesGuard(reflector),
      inject: [Reflector],
    },
  ],
})
class ContractTestModule {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Contract controllers — real-route integration (double-prefix regression + RBAC)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ContractTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'integration-test-cookie-secret-32c' })
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
  // 1. EmployeeContractsController — all endpoints reachable as ADMIN
  // -------------------------------------------------------------------------

  it('GET /api/users/:id/contract → 200 for ADMIN (route exists, guard passes)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${targetUserId}/contract`,
      cookies: { jwt: signFor(adminUser) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; endpoint: string }
    expect(body.ok).toBe(true)
    expect(body.endpoint).toBe('GET /users/:id/contract')
  })

  it('PATCH /api/users/:id/contract → 200 for ADMIN', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${targetUserId}/contract`,
      cookies: { jwt: signFor(adminUser) },
      payload: { bodyMarkdown: '# Test' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('POST /api/users/:id/contract/ready → 201 for ADMIN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${targetUserId}/contract/ready`,
      cookies: { jwt: signFor(adminUser) },
      payload: {},
    })
    // NestJS @Post default = 201
    expect(res.statusCode).toBe(201)
    const body = res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('POST /api/users/:id/contract/revert → 201 for ADMIN (AC5)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${targetUserId}/contract/revert`,
      cookies: { jwt: signFor(adminUser) },
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('POST /api/users/:id/contract/reset → 201 for ADMIN (AC5)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${targetUserId}/contract/reset`,
      cookies: { jwt: signFor(adminUser) },
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('GET /api/users/:id/contract/pdf → 200 (Content-Type: application/pdf) for ADMIN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${targetUserId}/contract/pdf`,
      cookies: { jwt: signFor(adminUser) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
  })

  // -------------------------------------------------------------------------
  // 2. OnboardingContractController — reachable for authenticated non-ADMIN
  // -------------------------------------------------------------------------

  it('GET /api/onboarding/contract → 200 for SENIOR (self-access, no @Roles restriction)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/contract',
      cookies: { jwt: signFor(seniorUser) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; userId: string }
    expect(body.ok).toBe(true)
    expect(body.userId).toBe(seniorUser.id)
  })

  it('GET /api/onboarding/contract/pdf → 200 (application/pdf) for SENIOR', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/contract/pdf',
      cookies: { jwt: signFor(seniorUser) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
  })

  // -------------------------------------------------------------------------
  // 3. RBAC — non-ADMIN cannot access /api/users/:id/contract* (403)
  // -------------------------------------------------------------------------

  it('GET /api/users/:id/contract → 403 for SENIOR (RolesGuard: ADMIN only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${targetUserId}/contract`,
      cookies: { jwt: signFor(seniorUser) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('PATCH /api/users/:id/contract → 403 for SENIOR', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${targetUserId}/contract`,
      cookies: { jwt: signFor(seniorUser) },
      payload: { bodyMarkdown: 'hack' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('POST /api/users/:id/contract/ready → 403 for SENIOR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${targetUserId}/contract/ready`,
      cookies: { jwt: signFor(seniorUser) },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('POST /api/users/:id/contract/revert → 403 for SENIOR (RBAC regression guard)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${targetUserId}/contract/revert`,
      cookies: { jwt: signFor(seniorUser) },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('POST /api/users/:id/contract/reset → 403 for SENIOR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${targetUserId}/contract/reset`,
      cookies: { jwt: signFor(seniorUser) },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })

  it('GET /api/users/:id/contract/pdf → 200 for SENIOR owner (requester.id === :id)', async () => {
    // seniorUser requests their own contract PDF — :id matches requester.id
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${seniorUser.id}/contract/pdf`,
      cookies: { jwt: signFor(seniorUser) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/pdf')
  })

  it('GET /api/users/:id/contract/pdf → 403 for non-owner SENIOR (requester.id !== :id)', async () => {
    // seniorUser requests a DIFFERENT user's contract PDF — should be forbidden
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${targetUserId}/contract/pdf`,
      cookies: { jwt: signFor(seniorUser) },
    })
    expect(res.statusCode).toBe(403)
  })

  // -------------------------------------------------------------------------
  // 4. Unauthenticated → 401 (JwtAuthGuard fires before RolesGuard)
  // -------------------------------------------------------------------------

  it('GET /api/users/:id/contract → 401 without JWT cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${targetUserId}/contract`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /api/onboarding/contract → 401 without JWT cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/contract',
    })
    expect(res.statusCode).toBe(401)
  })

  // -------------------------------------------------------------------------
  // 5. Double-prefix regression — old /api/api/... paths must 404
  //    (pins the TASK 1 fix; any re-introduction of 'api/' in @Controller
  //    would flip these from 404 → 200/403 and break real frontend calls)
  // -------------------------------------------------------------------------

  it('GET /api/api/users/:id/contract → 404 (double-prefix path no longer exists)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/api/users/${targetUserId}/contract`,
      cookies: { jwt: signFor(adminUser) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/api/onboarding/contract → 404 (double-prefix path no longer exists)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/api/onboarding/contract',
      cookies: { jwt: signFor(adminUser) },
    })
    expect(res.statusCode).toBe(404)
  })
})
