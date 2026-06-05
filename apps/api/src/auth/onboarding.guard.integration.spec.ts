import { Controller, Get, Module, Post } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { JwtModule, JwtService } from '@nestjs/jwt'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import cookie from '@fastify/cookie'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { JwtAuthGuard } from './jwt.guard'
import { OnboardingGuard } from './onboarding.guard'
import { Public } from './public.decorator'
import { OnboardingService } from '../onboarding/onboarding.service'

/**
 * Integration test — exercises the real Fastify request lifecycle with both
 * guards registered as APP_GUARD in `providers[]`. The original unit-test
 * (`onboarding.guard.spec.ts`) mocked `ExecutionContext` with `req.user`
 * already populated, masking the actual guard-execution-order bug that
 * Reviewer #4415687659 flagged.
 *
 * Before the fix, `OnboardingGuard` was the only APP_GUARD; `JwtAuthGuard`
 * lived as a controller decorator. Per NestJS request lifecycle, global
 * guards run BEFORE controller guards → `req.user` is `undefined` when the
 * OnboardingGuard's pre-check `if (!user) return true` fires → the entire
 * onboarding gate becomes a no-op in production.
 *
 * The fix wires both as APP_GUARD in the documented order
 * (JwtAuthGuard first → populates `req.user`; OnboardingGuard second →
 * reads it). This test pins that wiring against a real `app.inject()`
 * dispatch so any regression flips the assertion immediately.
 *
 * Why factory providers (not class providers): vitest uses esbuild, which
 * does NOT emit TypeScript decorator constructor-parameter metadata. NestJS
 * DI silently injects `undefined` for unmarked params → `this.jwt.verify`
 * blows up. Explicit `useFactory` resolves the dependency via the test
 * module's injector instead of relying on metadata.
 */

const JWT_SECRET = 'test-secret-32-chars-minimum-xxxxxx'

const seniorPayload: SessionUser = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'senior@cc.com',
  displayName: 'Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
}

const adminPayload: SessionUser = {
  id: '22222222-2222-2222-2222-222222222222',
  email: 'admin@cc.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
}

const onboardingServiceMock = {
  getStatus: vi.fn(),
}

// ---------------------------------------------------------------------------
// Minimal test controllers — each route is a sentinel handler. We only care
// about the guard's verdict (status + body), not the route's payload.
// ---------------------------------------------------------------------------

@Controller()
class TestController {
  @Get('teams')
  teams() {
    return { ok: true, scope: 'teams' }
  }

  @Get('onboarding/status')
  status() {
    return { ok: true, scope: 'onboarding-status' }
  }

  @Post('contracts/sign')
  sign() {
    return { ok: true, scope: 'contracts-sign' }
  }

  @Get('contracts/templates/preview-rendered/:templateId')
  previewRendered() {
    return { ok: true, scope: 'preview-rendered' }
  }

  // A3-1: /api/contracts/preview-pdf REMOVED; /api/onboarding/contract added instead.
  @Get('onboarding/contract')
  onboardingContract() {
    return { ok: true, scope: 'onboarding-contract' }
  }

  @Get('onboarding/contract/pdf')
  onboardingContractPdf() {
    return { ok: true, scope: 'onboarding-contract-pdf' }
  }

  @Get('health')
  @Public()
  health() {
    return { ok: true, scope: 'health' }
  }
}

@Module({
  imports: [
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [TestController],
  providers: [
    Reflector,
    // OnboardingGuard depends on OnboardingService — mock it.
    {
      provide: OnboardingService,
      useValue: onboardingServiceMock,
    },
    // ORDER MATTERS — NestJS executes multiple APP_GUARD providers in
    // registration order. JwtAuthGuard must run first so it populates
    // `req.user` before OnboardingGuard's `if (!user) return true` short-circuit.
    //
    // We use `useFactory` because vitest's esbuild transform drops the
    // decorator metadata that NestJS's class-based DI relies on (see file
    // docstring).
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
class TestAppModule {}

describe('OnboardingGuard + JwtAuthGuard (integration / real request lifecycle)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())

    // Register cookie plugin BEFORE init so the onRequest hook is installed
    // ahead of the route handlers.
    await app.register(cookie, { secret: 'integration-test-cookie-secret' })

    app.setGlobalPrefix('api')

    await app.init()
    await app.getHttpAdapter().getInstance().ready()

    jwt = moduleRef.get(JwtService)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    onboardingServiceMock.getStatus.mockReset()
  })

  function signFor(user: SessionUser): string {
    return jwt.sign(user)
  }

  it('case 1: SENIOR без подписанного MSA/ToS → GET /api/teams → 403 ONBOARDING_REQUIRED + missing:[contract,tos]', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue({
      requiresContract: true,
      requiresTos: true,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/teams',
      cookies: { jwt: signFor(seniorPayload) },
    })

    expect(res.statusCode).toBe(403)
    const body = res.json() as { error?: string; missing?: string[] }
    expect(body.error).toBe('ONBOARDING_REQUIRED')
    expect(body.missing).toEqual(['contract', 'tos'])
    expect(onboardingServiceMock.getStatus).toHaveBeenCalledWith(
      seniorPayload.id,
      seniorPayload.role,
    )
  })

  it('case 2: SENIOR без подписанного MSA/ToS → GET /api/onboarding/status → 200 (bypass)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/status',
      cookies: { jwt: signFor(seniorPayload) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, scope: 'onboarding-status' })
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })

  it('case 3: SENIOR без подписанного MSA → POST /api/contracts/sign → 2xx (bypass)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/contracts/sign',
      cookies: { jwt: signFor(seniorPayload) },
      payload: {},
    })

    // NestJS @Post default is 201 — assertion is "not blocked by guard".
    expect(res.statusCode).toBeGreaterThanOrEqual(200)
    expect(res.statusCode).toBeLessThan(300)
    expect(res.json()).toEqual({ ok: true, scope: 'contracts-sign' })
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })

  it('case 4: ADMIN → GET /api/teams → 200 (ADMIN bypass — OnboardingGuard short-circuit)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/teams',
      cookies: { jwt: signFor(adminPayload) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, scope: 'teams' })
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })

  it('case 5: SENIOR after full onboarding (signed MSA + accepted ToS) → GET /api/teams → 200', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue({
      requiresContract: false,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/teams',
      cookies: { jwt: signFor(seniorPayload) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, scope: 'teams' })
    expect(onboardingServiceMock.getStatus).toHaveBeenCalledTimes(1)
  })

  it('case 6: public GET /api/health (no cookie) → 200 — @Public() bypasses JwtAuthGuard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, scope: 'health' })
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })

  it('case 7 (regression): unauthenticated request to a protected path → 401 (JwtAuthGuard first)', async () => {
    // This case nails the lifecycle fix: with JwtAuthGuard registered FIRST
    // as APP_GUARD, missing-cookie requests get 401 from auth — not 200 from
    // OnboardingGuard's `if (!user) return true` (the original bug).
    const res = await app.inject({
      method: 'GET',
      url: '/api/teams',
    })

    expect(res.statusCode).toBe(401)
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })

  it('case 8 (Bug #2 regression): pre-onboarding SENIOR → GET /api/contracts/templates/preview-rendered/:id → 200 (bypass)', async () => {
    // Regression guard for the bug where preview-rendered was NOT in
    // bypassPrefixes — OnboardingGuard blocked pre-onboarding non-ADMIN users
    // with 403, so the onboarding wizard showed raw {{employeeName}} tokens
    // instead of personalised content.
    //
    // The endpoint is safe to bypass: it resolves user data from req.user.id
    // (JWT), never from the URL path — no IDOR surface.
    onboardingServiceMock.getStatus.mockResolvedValue({
      requiresContract: true,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    })

    const templateId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const res = await app.inject({
      method: 'GET',
      url: `/api/contracts/templates/preview-rendered/${templateId}`,
      cookies: { jwt: signFor(seniorPayload) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, scope: 'preview-rendered' })
    // Guard must NOT call getStatus — the bypass fires before the auth check.
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })

  it('case 9 (AC6 A3-1): pre-onboarding SENIOR → GET /api/onboarding/contract → 200 (bypass)', async () => {
    // A3-1: /api/contracts/preview-pdf REMOVED and replaced with per-employee
    // contract endpoints. Un-onboarded users MUST reach /api/onboarding/contract
    // (and /api/onboarding/contract/pdf) before signing — these are bypass-listed.
    //
    // Without this bypass OnboardingGuard would 403 anyone who hasn't completed
    // onboarding yet → infinite onboarding loop. Lesson from
    // memory/feedback_mocked_e2e_guards.md.
    onboardingServiceMock.getStatus.mockResolvedValue({
      requiresContract: true,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/contract',
      cookies: { jwt: signFor(seniorPayload) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, scope: 'onboarding-contract' })
    // CRITICAL: getStatus must NOT be called — bypass must fire before any
    // OnboardingService work.
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })

  it('case 9b (A3-1): pre-onboarding SENIOR → GET /api/onboarding/contract/pdf → 200 (bypass)', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue({
      requiresContract: true,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/onboarding/contract/pdf',
      cookies: { jwt: signFor(seniorPayload) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, scope: 'onboarding-contract-pdf' })
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Bug-reproduction module — pins the PRE-FIX wiring (OnboardingGuard alone as
// APP_GUARD, JwtAuthGuard controller-level) and proves the guard becomes a
// no-op for authenticated non-ADMIN users without signed MSA / accepted ToS.
//
// This is the exact wiring Reviewer #4415687659 flagged. The test below
// would PASS the (buggy) "no-op" behaviour and is here as documentation of
// the bug surface — it does NOT depend on the fix being applied. Kept in the
// same spec so any future regression that re-introduces the wrong wiring
// surfaces as an obvious behavioural mismatch with the `fix` tests above.
// ---------------------------------------------------------------------------

@Controller()
class BuggyTestController {
  @Get('teams')
  teams(): { ok: boolean; scope: string } {
    return { ok: true, scope: 'teams' }
  }
}

@Module({
  imports: [
    JwtModule.register({
      secret: JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [BuggyTestController],
  providers: [
    Reflector,
    {
      provide: OnboardingService,
      useValue: onboardingServiceMock,
    },
    // Buggy wiring: OnboardingGuard alone as APP_GUARD; no JwtAuthGuard.
    {
      provide: APP_GUARD,
      useFactory: (svc: OnboardingService) => new OnboardingGuard(svc),
      inject: [OnboardingService],
    },
  ],
})
class BuggyAppModule {}

describe('OnboardingGuard ALONE as APP_GUARD — bug-state regression (PR #83 Reviewer review #4415687659)', () => {
  let buggyApp: NestFastifyApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BuggyAppModule],
    }).compile()

    buggyApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await buggyApp.register(cookie, { secret: 'integration-test-cookie-secret' })
    buggyApp.setGlobalPrefix('api')
    await buggyApp.init()
    await buggyApp.getHttpAdapter().getInstance().ready()
  })

  afterAll(async () => {
    await buggyApp.close()
  })

  beforeEach(() => {
    onboardingServiceMock.getStatus.mockReset()
    onboardingServiceMock.getStatus.mockResolvedValue({
      requiresContract: true,
      requiresTos: true,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    })
  })

  it('PROOF OF BUG: SENIOR without MSA + no JwtAuthGuard wiring → /api/teams returns 200 (gate is no-op)', async () => {
    // Without JwtAuthGuard as APP_GUARD, `req.user` is never populated.
    // OnboardingGuard's pre-check `if (!user) return true` fires for EVERY
    // authenticated request → entire onboarding gate is bypassed → 200.
    //
    // This is what would happen in production with the broken wiring even
    // if the caller HAD a valid JWT cookie — the OnboardingGuard runs first
    // (global), sees no user, returns true.
    const res = await buggyApp.inject({
      method: 'GET',
      url: '/api/teams',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, scope: 'teams' })
    // Critical: getStatus was never called → guard short-circuited on missing
    // user instead of reaching the ONBOARDING_REQUIRED check.
    expect(onboardingServiceMock.getStatus).not.toHaveBeenCalled()
  })
})
