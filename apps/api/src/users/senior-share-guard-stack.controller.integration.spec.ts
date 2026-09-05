import { Controller, Get, Module, Post, Body, Param, Inject } from '@nestjs/common'
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

/**
 * task-648-fix-round-1 (SR-M-4). Exercises the REAL Fastify + NestJS guard
 * stack (JwtAuthGuard → OnboardingGuard) for the senior-share
 * approve/reject/cancel routes on BOTH controllers that carry them
 * (`UsersController` — base-share, `ProjectsController` — project-override),
 * plus the exception→HTTP-status mapping the real services rely on. No real
 * DB: mocked `UsersService`/`ProjectsService` (same SENTINEL pattern as
 * `legends.controller.integration.spec.ts` — see that file's own doc for
 * why a mocked-service guard-stack test is still a real integration test:
 * `JwtAuthGuard`/`OnboardingGuard` are the REAL classes, wired through the
 * REAL Nest/Fastify request pipeline, not stubbed).
 *
 * What this closes, specifically (task file, SR-M-4):
 *   1. A caller who was never the invited approver gets 404, not 200 on
 *      someone else's proposal — proven here as "the real service's
 *      NotFoundException reaches the caller as an HTTP 404", the missing
 *      half of what unit tests (`users.pending-share.spec.ts` /
 *      `projects.pending-share.spec.ts`) already prove at the SERVICE
 *      layer (that `ApprovalsService` throws in the first place).
 *   2. A repeat response (already APPROVED/REJECTED) gets 409, same
 *      HTTP-layer half as #1.
 *   3. `OnboardingGuard`'s bypass-prefix list does NOT include
 *      `/api/users/:id/senior-share/*` or `/api/projects/:id/senior-share/*`
 *      — a non-onboarded, non-ADMIN caller gets 403 ONBOARDING_REQUIRED
 *      (the class's own hard-coded prefix list, unit-tested in isolation by
 *      `onboarding.guard.spec.ts`, is proven here to actually apply to
 *      THESE specific paths — the thing #110/`feedback_mocked_e2e_guards`
 *      keeps recurring on: a global guard sitting in front of a new
 *      endpoint, never proven to still apply to it).
 */

const JWT_SECRET = 'test-senior-share-integration-secret-xxxx'

const ADMIN_ID = 'b1c2d3e4-f5a6-4bbb-8ccc-000000000001'
const SENIOR_ID = 'b1c2d3e4-f5a6-4bbb-8ccc-000000000002'
const ACCOUNTANT_ID = 'b1c2d3e4-f5a6-4bbb-8ccc-000000000003'
const PROJECT_ID = 'b1c2d3e4-f5a6-4bbb-8ccc-000000000010'
const TARGET_USER_ID = 'b1c2d3e4-f5a6-4bbb-8ccc-000000000011'

function makeSession(id: string, role: SessionUser['role']): SessionUser {
  return {
    id,
    email: `${role.toLowerCase()}@test.com`,
    displayName: role,
    avatarUrl: null,
    avatarDocumentId: null,
    role,
    seniorSharePercent: 26,
  }
}

const USERS = {
  admin: makeSession(ADMIN_ID, 'ADMIN'),
  senior: makeSession(SENIOR_ID, 'SENIOR'),
  accountant: makeSession(ACCOUNTANT_ID, 'ACCOUNTANT'),
}

const onboardingServiceMock = { getStatus: vi.fn() }

const ONBOARDED = {
  requiresContract: false,
  requiresTos: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

const NOT_ONBOARDED = {
  requiresContract: true,
  requiresTos: true,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

// ---------------------------------------------------------------------------
// Mock services — real `NotFoundException`/`ConflictException`/
// `ForbiddenException` instances, exactly what `ApprovalsService.
// assertRespondable` / the controllers' own RBAC checks throw for real.
// ---------------------------------------------------------------------------

const usersServiceMock = {
  approveSeniorShareChange: vi.fn(),
  rejectSeniorShareChange: vi.fn(),
  cancelSeniorShareChange: vi.fn(),
}

const projectsServiceMock = {
  approveSeniorShareChange: vi.fn(),
  rejectSeniorShareChange: vi.fn(),
  cancelSeniorShareChange: vi.fn(),
}

// ---------------------------------------------------------------------------
// Sentinel controllers — mirror the real route structure of
// UsersController / ProjectsController's senior-share trio. Deliberately NOT
// the real controller classes (each drags in a large, unrelated dependency
// graph) — same trade-off `legends.controller.integration.spec.ts` documents
// for its own sentinel.
// ---------------------------------------------------------------------------

@Controller('users')
class UsersSentinelController {
  constructor(@Inject('UsersServiceMock') private readonly svc: typeof usersServiceMock) {}

  @Get(':id')
  getOne() {
    return { ok: true }
  }

  @Post(':id/senior-share/approve')
  approve(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.approveSeniorShareChange(id, user)
  }

  @Post(':id/senior-share/reject')
  reject(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.rejectSeniorShareChange(id, (body as { reason?: string })?.reason, user)
  }

  @Post(':id/senior-share/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.cancelSeniorShareChange(id, user)
  }
}

@Controller('projects')
class ProjectsSentinelController {
  constructor(@Inject('ProjectsServiceMock') private readonly svc: typeof projectsServiceMock) {}

  @Post(':id/senior-share/approve')
  approve(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.approveSeniorShareChange(id, user)
  }

  @Post(':id/senior-share/reject')
  reject(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.rejectSeniorShareChange(id, (body as { reason?: string })?.reason, user)
  }

  @Post(':id/senior-share/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.cancelSeniorShareChange(id, user)
  }
}

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } })],
  controllers: [UsersSentinelController, ProjectsSentinelController],
  providers: [
    Reflector,
    { provide: OnboardingService, useValue: onboardingServiceMock },
    { provide: 'UsersServiceMock', useValue: usersServiceMock },
    { provide: 'ProjectsServiceMock', useValue: projectsServiceMock },
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
class SeniorShareTestModule {}

describe('Senior-share approve/reject/cancel — guard-stack integration (SR-M-4)', () => {
  let app: NestFastifyApplication
  let jwt: JwtService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SeniorShareTestModule],
    }).compile()

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.register(cookie, { secret: 'test-senior-share-cookie-secret' })
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
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
  })

  function sign(user: SessionUser): string {
    return jwt.sign(user)
  }

  const ROUTES: Array<{
    label: string
    method: 'POST'
    path: string
    mock: typeof usersServiceMock.approveSeniorShareChange
    body?: Record<string, unknown>
  }> = [
    {
      label: 'users approve',
      method: 'POST',
      path: `/api/users/${TARGET_USER_ID}/senior-share/approve`,
      mock: usersServiceMock.approveSeniorShareChange,
    },
    {
      label: 'users reject',
      method: 'POST',
      path: `/api/users/${TARGET_USER_ID}/senior-share/reject`,
      mock: usersServiceMock.rejectSeniorShareChange,
      body: { reason: 'Не согласовано' },
    },
    {
      label: 'projects approve',
      method: 'POST',
      path: `/api/projects/${PROJECT_ID}/senior-share/approve`,
      mock: projectsServiceMock.approveSeniorShareChange,
    },
    {
      label: 'projects reject',
      method: 'POST',
      path: `/api/projects/${PROJECT_ID}/senior-share/reject`,
      mock: projectsServiceMock.rejectSeniorShareChange,
      body: { reason: 'Не согласовано' },
    },
  ]

  // ── 401 — unauthenticated (JwtAuthGuard) ──────────────────────────────────

  it.each(ROUTES)(
    '$label: 401 without a cookie — JwtAuthGuard blocks before the service is ever called',
    async (route) => {
      const res = await app.inject({ method: route.method, url: route.path, payload: route.body })
      expect(res.statusCode).toBe(401)
      expect(route.mock).not.toHaveBeenCalled()
    },
  )

  // ── 403 ONBOARDING_REQUIRED (OnboardingGuard) ─────────────────────────────
  //
  // task file SR-M-4: "OnboardingGuard (bypass-список не содержит новых
  // путей — проверить, что onboarded-only поведение верное, а не 403 для
  // всех)". This is exactly that check, on the REAL prefix list.

  it.each(ROUTES)(
    '$label: 403 ONBOARDING_REQUIRED for a non-onboarded, non-ADMIN caller (the bypass-list does NOT cover this path)',
    async (route) => {
      onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)
      const res = await app.inject({
        method: route.method,
        url: route.path,
        payload: route.body,
        cookies: { jwt: sign(USERS.senior) },
      })
      expect(res.statusCode).toBe(403)
      expect((res.json() as { error?: string }).error).toBe('ONBOARDING_REQUIRED')
      expect(route.mock).not.toHaveBeenCalled()
    },
  )

  it.each(ROUTES)(
    '$label: ADMIN bypasses OnboardingGuard even when not onboarded',
    async (route) => {
      onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)
      route.mock.mockResolvedValue({ ok: true })
      const res = await app.inject({
        method: route.method,
        url: route.path,
        payload: route.body,
        cookies: { jwt: sign(USERS.admin) },
      })
      expect(res.statusCode).not.toBe(403)
      expect(route.mock).toHaveBeenCalledOnce()
    },
  )

  // ── 404 — the real ApprovalsService.assertRespondable exception ──────────
  //
  // task file SR-M-4: "чужой пользователь → 404". The service throws this
  // for BOTH "no live row at all" (foreign user probing a random id) and
  // "live row exists but not for this approver" — ApprovalsService does not
  // distinguish the two (same reasoning as the 404-not-403 IDOR precedent
  // `transaction-visibility.util.ts` documents elsewhere in this codebase).

  it.each(ROUTES)(
    '$label: 404 when the real service throws NotFoundException (foreign user / no live proposal)',
    async (route) => {
      const { NotFoundException } = await import('@nestjs/common')
      route.mock.mockRejectedValue(
        new NotFoundException('Подтверждение не найдено или уже закрыто'),
      )
      const res = await app.inject({
        method: route.method,
        url: route.path,
        payload: route.body,
        cookies: { jwt: sign(USERS.senior) },
      })
      expect(res.statusCode).toBe(404)
      expect(route.mock).toHaveBeenCalledOnce()
    },
  )

  // ── 409 — repeat response ─────────────────────────────────────────────────
  //
  // task file SR-M-4: "повтор → 409".

  it.each(ROUTES)(
    '$label: 409 when the real service throws ConflictException (already answered)',
    async (route) => {
      const { ConflictException } = await import('@nestjs/common')
      route.mock.mockRejectedValue(new ConflictException('Подтверждение уже получило ответ'))
      const res = await app.inject({
        method: route.method,
        url: route.path,
        payload: route.body,
        cookies: { jwt: sign(USERS.senior) },
      })
      expect(res.statusCode).toBe(409)
      expect(route.mock).toHaveBeenCalledOnce()
    },
  )

  // ── cancel — ADMIN/ACCOUNTANT only (RBAC lives in the SERVICE, not a
  // controller @Roles decorator — see both controllers' own doc comments on
  // why) ─────────────────────────────────────────────────────────────────

  const CANCEL_ROUTES = [
    {
      label: 'users cancel',
      path: `/api/users/${TARGET_USER_ID}/senior-share/cancel`,
      mock: usersServiceMock.cancelSeniorShareChange,
    },
    {
      label: 'projects cancel',
      path: `/api/projects/${PROJECT_ID}/senior-share/cancel`,
      mock: projectsServiceMock.cancelSeniorShareChange,
    },
  ]

  it.each(CANCEL_ROUTES)(
    '$label: 403 when the real service throws ForbiddenException for a non-ADMIN(/ACCOUNTANT) caller',
    async (route) => {
      const { ForbiddenException } = await import('@nestjs/common')
      route.mock.mockRejectedValue(
        new ForbiddenException('Отменить предложение по доле может только ADMIN'),
      )
      const res = await app.inject({
        method: 'POST',
        url: route.path,
        cookies: { jwt: sign(USERS.senior) },
      })
      expect(res.statusCode).toBe(403)
    },
  )

  it.each(CANCEL_ROUTES)('$label: 201 for ADMIN when the service succeeds', async (route) => {
    route.mock.mockResolvedValue({ ok: true })
    const res = await app.inject({
      method: 'POST',
      url: route.path,
      cookies: { jwt: sign(USERS.admin) },
    })
    expect(res.statusCode).toBe(201)
    expect(route.mock).toHaveBeenCalledOnce()
  })
})
