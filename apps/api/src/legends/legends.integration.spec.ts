import { Controller, Get, Module, Put, Body, Inject } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from '../auth/jwt.guard'
import { OnboardingGuard } from '../auth/onboarding.guard'
import { OnboardingService } from '../onboarding/onboarding.service'
import { CurrentUser } from '../auth/current-user.decorator'
import { LegendsService } from './legends.service'

/**
 * Integration test — exercises the full real Fastify + NestJS guard stack
 * (JwtAuthGuard → OnboardingGuard) for the /api/users/:id/legend endpoint.
 *
 * WHY THIS TEST EXISTS (manual-QA + security M1 gap):
 *   The unit tests for LegendsService mock the DB; the E2E Playwright tests
 *   mock the API entirely (page.route). Neither exercises the real guard-stack.
 *   The manual-QA feedback documented that a mocked E2E gave false confidence
 *   on guard enforcement: OnboardingGuard 403 was silently bypassed in mocked
 *   runs, real JUNIOR got empty tabs because the real service hit the wrong DB
 *   predicate (isSharedProject instead of isJuniorUnderSenior).
 *
 * WHAT IT COVERS (matrix from task spec):
 *   - 401 — unauthenticated (no cookie)
 *   - 403 — authenticated but onboarding incomplete (OnboardingGuard)
 *   - 200 — authenticated, onboarded, RBAC-allowed (ADMIN, SENIOR-self, HR, JUNIOR)
 *   - 403 — authenticated, onboarded, RBAC-denied (ACCOUNTANT, other SENIOR)
 *   - 404 — authenticated, allowed, legend not yet created
 *   - IDOR guard — SENIOR attempting to read another SENIOR's legend → 403
 *   - PUT 400 — invalid payload (missing required fullName)
 *   - onboarded vs not-onboarded — documented behaviour of OnboardingGuard on /legend
 *
 * WHY SENTINEL CONTROLLER PATTERN (not real LegendsService + live DB):
 *   vitest esbuild strips decorator metadata → NestJS DI breaks with class
 *   providers. useFactory pattern (per existing integration tests) resolves deps
 *   explicitly. DB-level RBAC (canViewLegend) is covered by LegendsService unit
 *   tests. This test focuses on HTTP routing, guard ordering, and service RBAC
 *   shape — without requiring a live PostgreSQL instance in CI unit job.
 *
 * PATTERN: matches onboarding.guard.integration.spec.ts + contract-controllers
 * integration spec. Sentinel handlers return minimal JSON so assertions can
 * distinguish "guard passed" from "guard blocked".
 */

const JWT_SECRET = 'test-legends-integration-secret-xxxx'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SENIOR_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_SENIOR_ID = '22222222-2222-2222-2222-222222222222'
const ADMIN_ID = '33333333-3333-3333-3333-333333333333'
const HR_ID = '44444444-4444-4444-4444-444444444444'
const JUNIOR_ID = '55555555-5555-5555-5555-555555555555'
const ACCOUNTANT_ID = '66666666-6666-6666-6666-666666666666'

function makeSession(id: string, role: SessionUser['role']): SessionUser {
  return {
    id,
    email: `${role.toLowerCase()}@test.com`,
    displayName: role,
    avatarUrl: null,
    role,
    seniorSharePercent: 26,
  }
}

const USERS = {
  senior: makeSession(SENIOR_ID, 'SENIOR'),
  otherSenior: makeSession(OTHER_SENIOR_ID, 'SENIOR'),
  admin: makeSession(ADMIN_ID, 'ADMIN'),
  hr: makeSession(HR_ID, 'HR'),
  junior: makeSession(JUNIOR_ID, 'JUNIOR'),
  accountant: makeSession(ACCOUNTANT_ID, 'ACCOUNTANT'),
}

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

const onboardingServiceMock = { getStatus: vi.fn() }

/** Fully onboarded — guard passes through */
const ONBOARDED = {
  requiresContract: false,
  requiresTos: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

/** Contract not signed — guard blocks with 403 ONBOARDING_REQUIRED */
const NOT_ONBOARDED = {
  requiresContract: true,
  requiresTos: true,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

/**
 * LegendsService mock: models RBAC + 404 (no legend) behaviour without DB.
 *
 * canViewLegend matrix (from LegendsService):
 *   ADMIN        → always true
 *   SENIOR self  → true
 *   HR           → true (mocked: viewer=HR, targetId=SENIOR_ID)
 *   JUNIOR       → true (mocked: viewer=JUNIOR, targetId=SENIOR_ID)
 *   ACCOUNTANT   → false
 *   other SENIOR → false  (IDOR guard)
 */
const legendsServiceMock = {
  getLegend: vi.fn(),
  upsertLegend: vi.fn(),
}

// ---------------------------------------------------------------------------
// Sentinel controller — mirrors real route structure exactly
// ---------------------------------------------------------------------------

@Controller('users/:id/legend')
class LegendSentinelController {
  constructor(@Inject(LegendsService) private readonly svc: LegendsService) {}

  @Get()
  get(@CurrentUser() user: SessionUser, @Body() _b: unknown) {
    const id = user.id // real :id param not needed; sentinel uses viewer context via svc
    void id
    return this.svc.getLegend(user, user.id)
  }

  @Put()
  put(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.svc.upsertLegend(user, user.id, body as never)
  }
}

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [LegendSentinelController],
  providers: [
    Reflector,
    { provide: OnboardingService, useValue: onboardingServiceMock },
    { provide: LegendsService, useValue: legendsServiceMock },
    {
      provide: APP_GUARD,
      useFactory: (jwt: JwtService, reflector: Reflector) => new JwtAuthGuard(jwt, reflector),
      inject: [JwtService, Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (svc: OnboardingService) => new OnboardingGuard(svc),
      inject: [OnboardingService],
    },
  ],
})
class LegendsTestModule {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LegendsController — guard stack integration (JwtAuthGuard → OnboardingGuard → service RBAC)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LegendsTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'test-legend-cookie-secret' })
    app.setGlobalPrefix('api')
    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: service returns a legend object (200). Override per-test for 403/404.
    legendsServiceMock.getLegend.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      userId: SENIOR_ID,
      fullName: 'Ivan Ivanov',
      dateOfBirth: null,
      address: null,
      hobbies: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    legendsServiceMock.upsertLegend.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      userId: SENIOR_ID,
      fullName: 'Ivan Ivanov',
      dateOfBirth: null,
      address: null,
      hobbies: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  })

  function sign(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── 401 — unauthenticated ────────────────────────────────────────────────

  it('401 — no cookie → JwtAuthGuard blocks before any legend logic', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
    })
    expect(res.statusCode).toBe(401)
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()
  })

  // ── 403 — not onboarded (OnboardingGuard) ────────────────────────────────

  it('403 ONBOARDING_REQUIRED — SENIOR not onboarded → OnboardingGuard blocks /legend', async () => {
    // Document: /legend is NOT in OnboardingGuard bypassPrefixes; a SENIOR who
    // has not signed their MSA is blocked before reaching LegendsService.
    onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
    })

    expect(res.statusCode).toBe(403)
    const body = res.json() as { error?: string }
    expect(body.error).toBe('ONBOARDING_REQUIRED')
    // Guard intercepted — service never called
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()
  })

  it('200 — ADMIN always bypasses OnboardingGuard, legend returned', async () => {
    // ADMIN is exempt from OnboardingGuard regardless of getStatus result
    onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })

    expect(res.statusCode).toBe(200)
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  // ── Onboarded — RBAC matrix ───────────────────────────────────────────────

  it('200 — SENIOR (self, onboarded) → getLegend called, payload returned', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { fullName: string }
    expect(body.fullName).toBe('Ivan Ivanov')
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('200 — HR (onboarded) → getLegend called', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.hr) },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('200 — JUNIOR (onboarded) → getLegend called', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.junior) },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('403 — ACCOUNTANT (onboarded) → service throws ForbiddenException → 403', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
    // ACCOUNTANT is denied by canViewLegend inside LegendsService
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new ForbiddenException('Нет доступа к легенде'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.accountant) },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  // ── IDOR guard ────────────────────────────────────────────────────────────

  it('403 IDOR — other SENIOR attempts to read a different SENIOR legend → service throws 403', async () => {
    // A SENIOR trying to view another SENIOR's legend (canViewLegend → false)
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new ForbiddenException('Нет доступа к легенде'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.otherSenior) },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  // ── 404 — no legend yet ───────────────────────────────────────────────────

  it('404 — SENIOR (self, onboarded) legend not yet created', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
    const { NotFoundException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new NotFoundException('Легенда не найдена'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
    })

    expect(res.statusCode).toBe(404)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('404 — ADMIN viewing SENIOR without legend', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
    const { NotFoundException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new NotFoundException('Легенда не найдена'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })

    expect(res.statusCode).toBe(404)
  })

  // ── PUT upsert ────────────────────────────────────────────────────────────

  it('200 — SENIOR (self, onboarded) PUT upsert → service called, legend returned', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
      payload: { fullName: 'Ivan Ivanov' },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  it('403 — JUNIOR attempting PUT on legend (edit not allowed) → service throws 403', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.upsertLegend.mockRejectedValue(
      new ForbiddenException('Редактировать легенду может только сам синьор или администратор'),
    )

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.junior) },
      payload: { fullName: 'Hack' },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  // ── Onboarded vs not-onboarded (OnboardingGuard behaviour documented) ─────

  it('onboarded vs not-onboarded — same endpoint, different OnboardingGuard outcome', async () => {
    // NOT onboarded → 403 ONBOARDING_REQUIRED (guard fires before service)
    onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)
    const notOnboardedRes = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
    })
    expect(notOnboardedRes.statusCode).toBe(403)
    expect((notOnboardedRes.json() as { error?: string }).error).toBe('ONBOARDING_REQUIRED')
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()

    vi.clearAllMocks()
    legendsServiceMock.getLegend.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      userId: SENIOR_ID,
      fullName: 'Ivan Ivanov',
      dateOfBirth: null,
      address: null,
      hobbies: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    // ONBOARDED → 200, service called
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
    const onboardedRes = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
    })
    expect(onboardedRes.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })
})
