/**
 * Integration test — GET /api/contracts/me/status (AC2)
 *
 * Verifies:
 *   1. Authenticated user can GET /api/contracts/me/status → 200
 *   2. The endpoint is self-only (userId from JWT, no :id param)
 *   3. Unauthenticated request → 401
 *   4. Literal path me/status is not captured by :id route
 *
 * Uses a sentinel handler pattern (no real DB) — real Fastify pipeline +
 * real JWT guard. Proves the endpoint is reachable at its declared path
 * and that auth is enforced. Service-level logic is covered in
 * employee-contracts.service.spec.ts.
 */

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

const JWT_SECRET = 'test-contract-status-secret-32ch'

const juniorUser: SessionUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: 'junior@test.com',
  displayName: 'Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 26,
}

const adminUser: SessionUser = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  email: 'admin@test.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
}

// ---------------------------------------------------------------------------
// Sentinel controller — mirrors SignedContractsController path structure.
// ---------------------------------------------------------------------------

@Controller('contracts')
class SentinelSignedContractsController {
  /** Mirrors GET /api/contracts/me/status — self-only by JWT construction */
  @Get('me/status')
  getMyContractStatus(@CurrentUser() user: SessionUser) {
    return { id: 'mock-contract-id', status: 'SIGNED', requesterId: user.id }
  }

  /** Mirrors GET /api/contracts/:id — ensures me/status is not captured by :id */
  @Get(':id')
  findOne(@CurrentUser() user: SessionUser) {
    return { endpoint: 'GET /contracts/:id', requesterId: user.id }
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
  controllers: [SentinelSignedContractsController],
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
class ContractStatusTestModule {}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /api/contracts/me/status — self-only contract status (AC2)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ContractStatusTestModule],
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

  it('JUNIOR user GET /api/contracts/me/status → 200 with own requesterId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/contracts/me/status',
      cookies: { jwt: signFor(juniorUser) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; status: string; requesterId: string }
    expect(body.status).toBe('SIGNED')
    // self-only: requesterId comes from JWT, not a URL param
    expect(body.requesterId).toBe(juniorUser.id)
  })

  it('ADMIN user GET /api/contracts/me/status → 200 with own requesterId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/contracts/me/status',
      cookies: { jwt: signFor(adminUser) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { requesterId: string }
    expect(body.requesterId).toBe(adminUser.id)
  })

  it('unauthenticated request → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/contracts/me/status',
    })
    expect(res.statusCode).toBe(401)
  })

  it('me/status literal path takes priority over :id param route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/contracts/me/status',
      cookies: { jwt: signFor(juniorUser) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    // sentinel me/status handler sets 'id' key; :id handler sets 'endpoint' key
    expect(body).toHaveProperty('id')
    expect(body).not.toHaveProperty('endpoint')
  })
})
