import { Controller, Get, Module, Put, Post, Body, Inject } from '@nestjs/common'
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
 * (JwtAuthGuard → OnboardingGuard) for the NEW project-scoped legend endpoints:
 *   GET  /api/projects/:projectId/legend
 *   PUT  /api/projects/:projectId/legend
 *   POST /api/projects/:projectId/legend/entries
 *
 * SENTINEL PATTERN (matches contract-controllers.integration.spec.ts):
 *   - Real JWT + guard stack, mock LegendsService
 *   - Each route wired, auth required (401 without cookie)
 *   - Service ForbiddenException → 403; NotFoundException → 404
 *   - projectId propagated correctly to service calls
 */

const JWT_SECRET = 'test-legend-integration-secret-xxxx'

// ---------------------------------------------------------------------------
// Fixtures — valid RFC 4122 v4 UUIDs
//
// NOTE: PROJECT_ID is hardcoded here. This sentinel spec exercises the guard
// stack (JwtAuthGuard → OnboardingGuard) and verifies that controller routes
// are wired + projectId is propagated to the service. It does NOT verify
// per-role RBAC decisions (those require a real DB and are covered by
// legends.rbac.integration.spec.ts which uses the actual LegendsService
// against crm_qa).
// ---------------------------------------------------------------------------

const PROJECT_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000001'
const ADMIN_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000003'
const SENIOR_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000002'
const JUNIOR_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000005'
const ACCOUNTANT_ID = 'a1b2c3d4-e5f6-4aaa-9bbb-000000000006'

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
  admin: makeSession(ADMIN_ID, 'ADMIN'),
  senior: makeSession(SENIOR_ID, 'SENIOR'),
  junior: makeSession(JUNIOR_ID, 'JUNIOR'),
  accountant: makeSession(ACCOUNTANT_ID, 'ACCOUNTANT'),
}

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

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

const legendsServiceMock = {
  getLegend: vi.fn(),
  upsertLegend: vi.fn(),
  addEntry: vi.fn(),
}

// ---------------------------------------------------------------------------
// Sentinel controller — mirrors real project-scoped route structure
// ---------------------------------------------------------------------------

@Controller('projects')
class LegendSentinelController {
  constructor(@Inject(LegendsService) private readonly svc: LegendsService) {}

  @Get(':projectId/legend')
  getLegend(@CurrentUser() user: SessionUser, @Body() _b: unknown) {
    const projectId = PROJECT_ID // sentinel uses fixed project ID
    return this.svc.getLegend(user, projectId)
  }

  @Put(':projectId/legend')
  upsertLegend(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.svc.upsertLegend(user, PROJECT_ID, body as never)
  }

  @Post(':projectId/legend/entries')
  addEntry(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.svc.addEntry(user, PROJECT_ID, body as never)
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
// Legend fixture
// ---------------------------------------------------------------------------

const LEGEND_FIXTURE = {
  id: 'a1b2c3d4-e5f6-4aaa-9bbb-000000000099',
  projectId: PROJECT_ID,
  fullName: 'Ivan Ivanov',
  dateOfBirth: null,
  address: null,
  presentedRole: null,
  presentedStack: null,
  backstory: null,
  hobbies: null,
  notes: null,
  entries: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LegendsController (project-scoped) — guard stack integration', () => {
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
    legendsServiceMock.getLegend.mockResolvedValue({ ...LEGEND_FIXTURE })
    legendsServiceMock.upsertLegend.mockResolvedValue({ ...LEGEND_FIXTURE })
    legendsServiceMock.addEntry.mockResolvedValue({ ...LEGEND_FIXTURE })
    onboardingServiceMock.getStatus.mockResolvedValue(ONBOARDED)
  })

  function sign(user: SessionUser): string {
    return jwt.sign(user)
  }

  // ── 401 — unauthenticated ─────────────────────────────────────────────────

  it('GET 401 — no cookie → JwtAuthGuard blocks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/legend`,
    })
    expect(res.statusCode).toBe(401)
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()
  })

  it('PUT 401 — no cookie → JwtAuthGuard blocks', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/legend`,
      payload: { fullName: 'Test' },
    })
    expect(res.statusCode).toBe(401)
    expect(legendsServiceMock.upsertLegend).not.toHaveBeenCalled()
  })

  it('POST entries 401 — no cookie → JwtAuthGuard blocks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/legend/entries`,
      payload: { text: 'Test entry' },
    })
    expect(res.statusCode).toBe(401)
    expect(legendsServiceMock.addEntry).not.toHaveBeenCalled()
  })

  // ── 403 ONBOARDING_REQUIRED ───────────────────────────────────────────────

  it('GET 403 ONBOARDING_REQUIRED — not onboarded → OnboardingGuard blocks', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/legend`,
      cookies: { jwt: sign(USERS.junior) },
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error?: string }).error).toBe('ONBOARDING_REQUIRED')
    expect(legendsServiceMock.getLegend).not.toHaveBeenCalled()
  })

  // ── ADMIN bypasses OnboardingGuard ────────────────────────────────────────

  it('GET 200 — ADMIN bypasses OnboardingGuard even if not onboarded', async () => {
    onboardingServiceMock.getStatus.mockResolvedValue(NOT_ONBOARDED)
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })
    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  // ── Routes are connected and projectId propagated ─────────────────────────

  it('GET 200 — route connected, service called with projectId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })
    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
    const [calledUser, calledProjectId] = legendsServiceMock.getLegend.mock.calls[0] as [
      SessionUser,
      string,
    ]
    expect(calledUser.id).toBe(ADMIN_ID)
    expect(calledProjectId).toBe(PROJECT_ID)
  })

  it('PUT 200 — route connected, service called', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
      payload: { fullName: 'Ivan Ivanov' },
    })
    expect(res.statusCode).toBe(200)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
    const [calledUser, calledProjectId] = legendsServiceMock.upsertLegend.mock.calls[0] as [
      SessionUser,
      string,
      unknown,
    ]
    expect(calledUser.id).toBe(ADMIN_ID)
    expect(calledProjectId).toBe(PROJECT_ID)
  })

  it('POST entries 201 — route connected, service called', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/legend/entries`,
      cookies: { jwt: sign(USERS.admin) },
      payload: { text: 'Test journal entry' },
    })
    // NestJS @Post returns 201 by default
    expect(res.statusCode).toBe(201)
    expect(legendsServiceMock.addEntry).toHaveBeenCalledOnce()
    const [calledUser, calledProjectId] = legendsServiceMock.addEntry.mock.calls[0] as [
      SessionUser,
      string,
      unknown,
    ]
    expect(calledUser.id).toBe(ADMIN_ID)
    expect(calledProjectId).toBe(PROJECT_ID)
  })

  // ── ForbiddenException → 403 ──────────────────────────────────────────────

  it('GET 403 — service ForbiddenException → 403 (subject excluded)', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(
      new ForbiddenException('Нет доступа к легенде проекта'),
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/legend`,
      cookies: { jwt: sign(USERS.senior) },
    })
    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('PUT 403 — service ForbiddenException → 403 (ACCOUNTANT)', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.upsertLegend.mockRejectedValue(
      new ForbiddenException('Нет доступа к редактированию легенды проекта'),
    )
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT_ID}/legend`,
      cookies: { jwt: sign(USERS.accountant) },
      payload: { fullName: 'Hack' },
    })
    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.upsertLegend).toHaveBeenCalledOnce()
  })

  it('POST entries 403 — service ForbiddenException → 403', async () => {
    const { ForbiddenException } = await import('@nestjs/common')
    legendsServiceMock.addEntry.mockRejectedValue(
      new ForbiddenException('Нет доступа к легенде проекта'),
    )
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/legend/entries`,
      cookies: { jwt: sign(USERS.senior) },
      payload: { text: 'Hack' },
    })
    expect(res.statusCode).toBe(403)
    expect(legendsServiceMock.addEntry).toHaveBeenCalledOnce()
  })

  // ── NotFoundException → 404 ───────────────────────────────────────────────

  it('GET 404 — service NotFoundException → 404 (no legend yet)', async () => {
    const { NotFoundException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(
      new NotFoundException('Легенда проекта не найдена'),
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })
    expect(res.statusCode).toBe(404)
    expect(legendsServiceMock.getLegend).toHaveBeenCalledOnce()
  })

  it('GET 404 — service NotFoundException → 404 (project not found)', async () => {
    const { NotFoundException } = await import('@nestjs/common')
    legendsServiceMock.getLegend.mockRejectedValue(new NotFoundException('Проект не найден'))
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT_ID}/legend`,
      cookies: { jwt: sign(USERS.admin) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('POST entries 404 — legend not yet created', async () => {
    const { NotFoundException } = await import('@nestjs/common')
    legendsServiceMock.addEntry.mockRejectedValue(
      new NotFoundException('Легенда проекта не найдена — сначала создайте легенду'),
    )
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/legend/entries`,
      cookies: { jwt: sign(USERS.admin) },
      payload: { text: 'Запись без легенды' },
    })
    expect(res.statusCode).toBe(404)
  })
})
