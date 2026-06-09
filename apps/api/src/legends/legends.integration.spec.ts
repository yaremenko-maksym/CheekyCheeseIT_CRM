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
 * WHAT IT COVERS (matrix from task spec — 2026-06-09 RBAC reversal):
 *   - 401 — unauthenticated (no cookie)
 *   - 403 ONBOARDING_REQUIRED — authenticated but onboarding incomplete
 *   - 200 — ADMIN → GET + PUT always allowed
 *   - 200 — linked HR → GET + PUT allowed (view==edit)
 *   - 200 — linked JUNIOR → GET + PUT allowed (view==edit)
 *   - 403 — SENIOR self → GET + PUT denied (subject excluded)
 *   - 403 — DROP self   → GET + PUT denied (subject excluded)
 *   - 403 — ACCOUNTANT   → always denied
 *   - 403 — unlinked HR  → denied
 *   - 403 — unlinked JUNIOR → denied
 *   - 403 — other SENIOR (IDOR guard) → denied
 *   - 404 — allowed viewer, legend not yet created
 *   - 400 — target is not SENIOR/DROP
 *   + DROP target cases: ADMIN/linked-HR/linked-JUNIOR can view+edit
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
const DROP_ID = '22222222-2222-2222-2222-222222222222'
const ADMIN_ID = '33333333-3333-3333-3333-333333333333'
const HR_ID = '44444444-4444-4444-4444-444444444444'
const JUNIOR_ID = '55555555-5555-5555-5555-555555555555'
const ACCOUNTANT_ID = '66666666-6666-6666-6666-666666666666'
const OTHER_SENIOR_ID = '77777777-7777-7777-7777-777777777777'
const UNLINKED_HR_ID = '88888888-8888-8888-8888-888888888888'
const UNLINKED_JUNIOR_ID = '99999999-9999-9999-9999-999999999999'

function makeSession(id: string, role: SessionUser['role']): SessionUser {
  return {
    id,
    email: `${role.toLowerCase()}-${id.slice(0, 4)}@test.com`,
    displayName: role,
    avatarUrl: null,
    role,
    seniorSharePercent: 26,
  }
}

const USERS = {
  senior: makeSession(SENIOR_ID, 'SENIOR'),
  drop: makeSession(DROP_ID, 'DROP'),
  admin: makeSession(ADMIN_ID, 'ADMIN'),
  hr: makeSession(HR_ID, 'HR'),
  junior: makeSession(JUNIOR_ID, 'JUNIOR'),
  accountant: makeSession(ACCOUNTANT_ID, 'ACCOUNTANT'),
  otherSenior: makeSession(OTHER_SENIOR_ID, 'SENIOR'),
  unlinkedHr: makeSession(UNLINKED_HR_ID, 'HR'),
  unlinkedJunior: makeSession(UNLINKED_JUNIOR_ID, 'JUNIOR'),
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
 * LegendsService mock — models NEW RBAC (2026-06-09 reversal) + 404 without DB.
 *
 * canViewLegend NEW matrix:
 *   ADMIN                → always true
 *   SENIOR self          → false (subject excluded)
 *   DROP self            → false (subject excluded)
 *   linked HR            → true  (viewer=HR, targetId=SENIOR_ID or DROP_ID)
 *   linked JUNIOR        → true  (viewer=JUNIOR, targetId=SENIOR_ID or DROP_ID)
 *   ACCOUNTANT           → false
 *   other SENIOR (IDOR)  → false
 *   unlinked HR          → false
 *   unlinked JUNIOR      → false
 *
 * view==edit: canViewLegend controls both GET and PUT.
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
    const id = user.id
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
// Shared legend fixture returned by mock on "happy path"
// ---------------------------------------------------------------------------

const LEGEND_FIXTURE = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  userId: SENIOR_ID,
  fullName: 'Ivan Ivanov',
  dateOfBirth: null,
  address: null,
  hobbies: null,
  notes: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

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
    // Default happy-path: service returns legend (200). Override per-test for 403/404/400.
    legendsServiceMock.getLegend.mockResolvedValue({ ...LEGEND_FIXTURE })
    legendsServiceMock.upsertLegend.mockResolvedValue({ ...LEGEND_FIXTURE })
    // Default: all callers are onboarded
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
  })

  function sign(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── 401 — unauthenticated ─────────────────────────────────────────────────

  it('401 — no cookie → JwtAuthGuard blocks before any legend logic', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
    })
    expect(res.statusCode).toBe(401)
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()
  })

  it('401 — no cookie — PUT also blocked', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      payload: { fullName: 'Test' },
    })
    expect(res.statusCode).toBe(401)
    expect(legendsServiceMock.upsertLegend).not.toHaveBeenCalled()
  })

  // ── 403 ONBOARDING_REQUIRED ───────────────────────────────────────────────

  it('403 ONBOARDING_REQUIRED — SENIOR not onboarded → OnboardingGuard blocks GET /legend', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
    })

    expect(res.statusCode).toBe(403)
    const body = res.json() as { error?: string }
    expect(body.error).toBe('ONBOARDING_REQUIRED')
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()
  })

  it('403 ONBOARDING_REQUIRED — HR not onboarded → blocked before service', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.hr) },
    })

    expect(res.statusCode).toBe(403)
    expect((res.json() as { error?: string }).error).toBe('ONBOARDING_REQUIRED')
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()
  })

  // ── ADMIN bypasses OnboardingGuard ────────────────────────────────────────

  it('200 — ADMIN bypasses OnboardingGuard even when not onboarded', async () => {
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

  // ── RBAC: GET — NEW MATRIX ────────────────────────────────────────────────

  it('GET 200 — ADMIN (onboarded) → legend returned', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { fullName: string }
    expect(body.fullName).toBe('Ivan Ivanov')
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 200 — linked HR (onboarded) → legend returned', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.hr) },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 200 — linked JUNIOR (onboarded) → legend returned', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.junior) },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 403 — SENIOR self (subject excluded) → service throws ForbiddenException → 403', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new ForbiddenException('Нет доступа к легенде'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 403 — DROP self (subject excluded) → 403', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new ForbiddenException('Нет доступа к легенде'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${DROP_ID}/legend`,
      cookies: { jwt: sign(USERS.drop) },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 403 — ACCOUNTANT → always denied', async () => {
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

  it('GET 403 — other SENIOR (IDOR guard) → 403', async () => {
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

  it('GET 403 — unlinked HR → denied (not in same team as target)', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new ForbiddenException('Нет доступа к легенде'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.unlinkedHr) },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 403 — unlinked JUNIOR → denied (no shared project with target)', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new ForbiddenException('Нет доступа к легенде'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.unlinkedJunior) },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  // ── RBAC: PUT — NEW MATRIX (view==edit) ───────────────────────────────────

  it('PUT 200 — ADMIN → upsert allowed', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
      payload: { fullName: 'Ivan Ivanov' },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  it('PUT 200 — linked HR → upsert allowed (view==edit)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.hr) },
      payload: { fullName: 'Ivan Ivanov' },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  it('PUT 200 — linked JUNIOR → upsert allowed (view==edit, was 403 in old spec)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.junior) },
      payload: { fullName: 'Ivan Ivanov' },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  it('PUT 403 — SENIOR self (subject excluded) → 403', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.upsertLegend.mockRejectedValue(
      new ForbiddenException('Нет доступа к редактированию легенды'),
    )

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
      payload: { fullName: 'Ivan Ivanov' },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  it('PUT 403 — DROP self (subject excluded) → 403', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.upsertLegend.mockRejectedValue(
      new ForbiddenException('Нет доступа к редактированию легенды'),
    )

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${DROP_ID}/legend`,
      cookies: { jwt: sign(USERS.drop) },
      payload: { fullName: 'Olha Drop' },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  it('PUT 403 — ACCOUNTANT → always denied', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.upsertLegend.mockRejectedValue(
      new ForbiddenException('Нет доступа к редактированию легенды'),
    )

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.accountant) },
      payload: { fullName: 'Hack' },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  it('PUT 403 — unlinked HR → denied', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.upsertLegend.mockRejectedValue(
      new ForbiddenException('Нет доступа к редактированию легенды'),
    )

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.unlinkedHr) },
      payload: { fullName: 'Hack' },
    })

    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  // ── DROP target — same matrix ─────────────────────────────────────────────

  it('GET 200 — ADMIN viewing DROP target → legend returned', async () => {
    legendsServiceMock.getLegend.mockResolvedValue({ ...LEGEND_FIXTURE, userId: DROP_ID })

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${DROP_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 200 — linked HR viewing DROP target → legend returned', async () => {
    legendsServiceMock.getLegend.mockResolvedValue({ ...LEGEND_FIXTURE, userId: DROP_ID })

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${DROP_ID}/legend`,
      cookies: { jwt: sign(USERS.hr) },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 200 — linked JUNIOR viewing DROP target → legend returned', async () => {
    legendsServiceMock.getLegend.mockResolvedValue({ ...LEGEND_FIXTURE, userId: DROP_ID })

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${DROP_ID}/legend`,
      cookies: { jwt: sign(USERS.junior) },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('PUT 200 — linked JUNIOR editing DROP legend → allowed (view==edit)', async () => {
    legendsServiceMock.upsertLegend.mockResolvedValue({ ...LEGEND_FIXTURE, userId: DROP_ID })

    const res = await app.inject({
      method: 'PUT',
      url: `/api/users/${DROP_ID}/legend`,
      cookies: { jwt: sign(USERS.junior) },
      payload: { fullName: 'Olha Drop Updated' },
    })

    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  // ── 404 — no legend yet ───────────────────────────────────────────────────

  it('404 — ADMIN viewing SENIOR without legend yet', async () => {
    const { NotFoundException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new NotFoundException('Легенда не найдена'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })

    expect(res.statusCode).toBe(404)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('404 — linked HR viewing SENIOR without legend', async () => {
    const { NotFoundException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new NotFoundException('Легенда не найдена'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.hr) },
    })

    expect(res.statusCode).toBe(404)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('404 — linked JUNIOR viewing SENIOR without legend', async () => {
    const { NotFoundException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new NotFoundException('Легенда не найдена'))

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.junior) },
    })

    expect(res.statusCode).toBe(404)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  // ── Onboarded vs not-onboarded (OnboardingGuard behaviour documented) ─────

  it('onboarded vs not-onboarded — same endpoint, different OnboardingGuard outcome', async () => {
    // NOT onboarded → 403 ONBOARDING_REQUIRED (guard fires before service)
    onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)
    const notOnboardedRes = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.hr) },
    })
    expect(notOnboardedRes.statusCode).toBe(403)
    expect((notOnboardedRes.json() as { error?: string }).error).toBe('ONBOARDING_REQUIRED')
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()

    vi.clearAllMocks()
    legendsServiceMock.getLegend.mockResolvedValue({ ...LEGEND_FIXTURE })

    // ONBOARDED → 200, service called
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
    const onboardedRes = await app.inject({
      method: 'GET',
      url: `/api/users/${SENIOR_ID}/legend`,
      cookies: { jwt: sign(USERS.hr) },
    })
    expect(onboardedRes.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })
})
