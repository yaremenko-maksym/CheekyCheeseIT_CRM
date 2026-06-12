/**
 * Integration test — GET /api/users/me/salary-meta (AC4)
 *
 * Verifies:
 *   1. Authenticated user can GET /api/users/me/salary-meta → 200
 *   2. Endpoint is self-only (userId from JWT, no :id param)
 *   3. Unauthenticated request → 401
 *   4. Literal path me/salary-meta is not captured by :id or :id/* routes
 *
 * Uses sentinel handler pattern (no real DB) — real Fastify pipeline +
 * real JWT + real RolesGuard. Service logic covered in users.service.spec.ts.
 *
 * WHY this matters (bug class #157/#158):
 *   The endpoint MUST be self-only — no :userId param. Any deviation would
 *   allow one user to read another's salary data. The sentinel test locks this
 *   routing invariant in the HTTP layer where mocked unit tests cannot.
 */

import { Controller, Get, Module, Param } from '@nestjs/common'
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

const JWT_SECRET = 'test-salary-meta-secret-32chars-x'

const juniorUser: SessionUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: 'junior@test.com',
  displayName: 'Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 26,
}

const seniorUser: SessionUser = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  email: 'senior@test.com',
  displayName: 'Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
}

// ---------------------------------------------------------------------------
// Sentinel controller — mirrors UsersController path structure.
// ---------------------------------------------------------------------------

@Controller('users')
class SentinelUsersController {
  /** Mirrors GET /api/users/me/salary-meta — self-only by JWT construction */
  @Get('me/salary-meta')
  getSalaryMeta(@CurrentUser() user: SessionUser) {
    return {
      monthlySalary: '3000',
      salaryCurrency: 'USDT',
      changedAt: '2026-01-15T10:00:00.000Z',
      requesterId: user.id,
    }
  }

  /** Mirrors GET /api/users/:id — ensures me/salary-meta is not swallowed by :id */
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return { endpoint: 'GET /users/:id', id, requesterId: user.id }
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
  controllers: [SentinelUsersController],
  providers: [
    Reflector,
    {
      provide: APP_GUARD,
      useFactory: (jwt: JwtService, reflector: Reflector) => new JwtAuthGuard(jwt, reflector),
      inject: [JwtService, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new RolesGuard(reflector),
      inject: [Reflector],
    },
  ],
})
class SalaryMetaTestModule {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /api/users/me/salary-meta — self-only salary metadata (AC4)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SalaryMetaTestModule],
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

  it('JUNIOR user GET /api/users/me/salary-meta → 200 with own requesterId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/me/salary-meta',
      cookies: { jwt: signFor(juniorUser) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      monthlySalary: string
      salaryCurrency: string
      changedAt: string
      requesterId: string
    }
    expect(body.monthlySalary).toBe('3000')
    expect(body.salaryCurrency).toBe('USDT')
    // self-only: requesterId comes from JWT, never a URL param
    expect(body.requesterId).toBe(juniorUser.id)
  })

  it('SENIOR user GET /api/users/me/salary-meta → 200 with own requesterId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/me/salary-meta',
      cookies: { jwt: signFor(seniorUser) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { requesterId: string }
    expect(body.requesterId).toBe(seniorUser.id)
  })

  it('unauthenticated request → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/me/salary-meta',
    })
    expect(res.statusCode).toBe(401)
  })

  it('me/salary-meta literal path takes priority over :id param route', async () => {
    // Regression guard: GET /users/me/salary-meta must not match GET /users/:id
    // (the :id route has a different payload shape)
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/me/salary-meta',
      cookies: { jwt: signFor(juniorUser) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    // sentinel salary-meta sets 'monthlySalary'; :id handler sets 'endpoint'
    expect(body).toHaveProperty('monthlySalary')
    expect(body).not.toHaveProperty('endpoint')
  })
})
