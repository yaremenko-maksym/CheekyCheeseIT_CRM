import { ForbiddenException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { OnboardingGuard } from './onboarding.guard'
import type { OnboardingService } from '../onboarding/onboarding.service'

const adminUser: SessionUser = {
  id: 'admin-1',
  email: 'admin@cc.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
}

const seniorUser: SessionUser = {
  id: 'senior-1',
  email: 'senior@cc.com',
  displayName: 'Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
}

function makeContext({
  url = '/api/teams',
  user,
}: { url?: string; user?: SessionUser } = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ url, user }),
    }),
  } as unknown as ExecutionContext
}

function makeOnboardingSvc(status: { requiresContract?: boolean; requiresTos?: boolean }) {
  return {
    getStatus: vi.fn().mockResolvedValue({
      requiresContract: false,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
      ...status,
    }),
  } as unknown as OnboardingService
}

describe('OnboardingGuard', () => {
  describe('bypass paths', () => {
    const bypassPaths = [
      '/api/auth/me',
      '/api/auth/google',
      '/api/auth/google/callback',
      '/api/auth/logout',
      '/api/auth/dev-login',
      '/api/onboarding/status',
      '/api/tos/current',
      '/api/tos/accept',
      '/api/contracts/templates/current/SENIOR',
      '/api/contracts/templates/current/HR',
      '/api/contracts/sign',
      // task-telemetry-api: must work even for un-onboarded users.
      '/api/telemetry/errors',
      '/api/telemetry/events',
    ]

    for (const url of bypassPaths) {
      it(`allows ${url} without checking onboarding status`, async () => {
        const svc = makeOnboardingSvc({ requiresContract: true, requiresTos: true })
        const guard = new OnboardingGuard(svc)
        const result = await guard.canActivate(makeContext({ url, user: seniorUser }))
        expect(result).toBe(true)
        expect(svc.getStatus).not.toHaveBeenCalled()
      })
    }
  })

  it('allows when req.user is undefined (JwtAuthGuard handles unauthenticated)', async () => {
    const svc = makeOnboardingSvc({ requiresContract: true })
    const guard = new OnboardingGuard(svc)
    const result = await guard.canActivate(makeContext({ url: '/api/teams', user: undefined }))
    expect(result).toBe(true)
    expect(svc.getStatus).not.toHaveBeenCalled()
  })

  it('ADMIN: passes without checking status', async () => {
    const svc = makeOnboardingSvc({ requiresContract: true, requiresTos: true })
    const guard = new OnboardingGuard(svc)
    const result = await guard.canActivate(makeContext({ url: '/api/teams', user: adminUser }))
    expect(result).toBe(true)
    expect(svc.getStatus).not.toHaveBeenCalled()
  })

  it('non-admin with requiresContract throws ONBOARDING_REQUIRED with missing:[contract]', async () => {
    const svc = makeOnboardingSvc({ requiresContract: true, requiresTos: false })
    const guard = new OnboardingGuard(svc)

    try {
      await guard.canActivate(makeContext({ url: '/api/teams', user: seniorUser }))
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException)
      const payload = (e as ForbiddenException).getResponse() as {
        error: string
        missing: string[]
      }
      expect(payload.error).toBe('ONBOARDING_REQUIRED')
      expect(payload.missing).toEqual(['contract'])
    }
  })

  it('non-admin with requiresTos only → missing:[tos]', async () => {
    const svc = makeOnboardingSvc({ requiresContract: false, requiresTos: true })
    const guard = new OnboardingGuard(svc)

    try {
      await guard.canActivate(makeContext({ url: '/api/teams', user: seniorUser }))
      expect.fail('should have thrown')
    } catch (e) {
      const payload = (e as ForbiddenException).getResponse() as {
        error: string
        missing: string[]
      }
      expect(payload.missing).toEqual(['tos'])
    }
  })

  it('non-admin with both → missing:[contract,tos]', async () => {
    const svc = makeOnboardingSvc({ requiresContract: true, requiresTos: true })
    const guard = new OnboardingGuard(svc)

    try {
      await guard.canActivate(makeContext({ url: '/api/teams', user: seniorUser }))
      expect.fail('should have thrown')
    } catch (e) {
      const payload = (e as ForbiddenException).getResponse() as {
        error: string
        missing: string[]
      }
      expect(payload.missing).toEqual(['contract', 'tos'])
    }
  })

  it('non-admin with both fulfilled → returns true', async () => {
    const svc = makeOnboardingSvc({ requiresContract: false, requiresTos: false })
    const guard = new OnboardingGuard(svc)

    const result = await guard.canActivate(makeContext({ url: '/api/teams', user: seniorUser }))
    expect(result).toBe(true)
  })

  it('strips query string when matching bypass paths', async () => {
    const svc = makeOnboardingSvc({ requiresContract: true })
    const guard = new OnboardingGuard(svc)
    const result = await guard.canActivate(
      makeContext({ url: '/api/tos/current?cb=123', user: seniorUser }),
    )
    expect(result).toBe(true)
  })
})
