import { describe, expect, it, vi } from 'vitest'
import type { ContractTemplateDto, SessionUser, TosVersionDto } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { OnboardingService } from './onboarding.service'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminUser: SessionUser = {
  id: 'admin-1',
  email: 'admin@cc.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
}

function userOfRole(role: SessionUser['role'], id = 'user-1'): SessionUser {
  return {
    id,
    email: `${role.toLowerCase()}@cc.com`,
    displayName: `Test ${role}`,
    avatarUrl: null,
    role,
    seniorSharePercent: 26,
  }
}

function makeTemplate(
  role: SessionUser['role'] = 'SENIOR',
  overrides: Record<string, unknown> = {},
): ContractTemplateDto {
  return {
    id: `tmpl-${role}`,
    targetRole: role as Exclude<SessionUser['role'], 'ADMIN'>,
    version: 1,
    bodyMarkdown: `# MSA ${role}`,
    isActive: true,
    createdByUserId: 'admin-1',
    createdAt: new Date('2026-01-01').toISOString(),
    ...overrides,
  }
}

function makeTos(overrides: Partial<TosVersionDto> = {}): TosVersionDto {
  return {
    id: 'tos-1',
    version: 1,
    bodyMarkdown: '# ToS v1',
    isActive: true,
    createdByUserId: 'admin-1',
    createdAt: new Date('2026-01-01').toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mocks for ContractTemplatesService + TosService
// ---------------------------------------------------------------------------

function makeContractsSvc(template: ContractTemplateDto | null = makeTemplate('SENIOR')) {
  return {
    getCurrentForRole: vi.fn().mockResolvedValue(template),
  } as never
}

function makeTosSvc({ active = makeTos() }: { active?: TosVersionDto | null } = {}) {
  return {
    getCurrent: vi.fn().mockResolvedValue(active),
    listAll: vi.fn().mockResolvedValue(active ? [active] : []),
  } as never
}

function makeEmployeeContractsSvc(contractReady = false) {
  return {
    hasReadyContract: vi.fn().mockResolvedValue(contractReady),
  } as never
}

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function makeDb({
  signedContract,
  acceptances = [] as Array<{ id: string; tosVersionId: string; version: number }>,
  activeTosId = 'tos-1',
}: {
  signedContract?: { id: string; templateId: string }
  acceptances?: Array<{ id: string; tosVersionId: string; version: number }>
  activeTosId?: string
} = {}) {
  // Track call number on the tosAcceptances.findFirst mock so we can
  // distinguish "for active version" (1st call) from "any acceptance for
  // user" (2nd call). The service makes the calls in that fixed order.
  let acceptanceCallCount = 0
  return {
    db: {
      query: {
        signedContracts: {
          findFirst: vi.fn().mockResolvedValue(signedContract),
        },
        tosAcceptances: {
          findFirst: vi.fn().mockImplementation(async () => {
            acceptanceCallCount += 1
            if (acceptanceCallCount === 1) {
              // first call — looking for acceptance of active version
              return acceptances.find((a) => a.tosVersionId === activeTosId)
            }
            // second call — looking for ANY acceptance for user (older version)
            return acceptances[0]
          }),
          findMany: vi.fn().mockResolvedValue(acceptances),
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnboardingService.getStatus', () => {
  it('ADMIN: returns all-false/null payload (bypass)', async () => {
    const mockDb = makeDb()
    const service = new OnboardingService(
      mockDb as unknown as DatabaseService,
      makeContractsSvc(),
      makeTosSvc(),
      makeEmployeeContractsSvc(),
    )
    const result = await service.getStatus(adminUser.id, 'ADMIN')

    expect(result).toEqual({
      requiresContract: false,
      requiresTos: false,
      contractReady: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    })
  })

  it('SENIOR fresh: requires both contract AND tos; template + tos populated', async () => {
    const tmpl = makeTemplate('SENIOR')
    const tos = makeTos()
    const mockDb = makeDb()
    const service = new OnboardingService(
      mockDb as unknown as DatabaseService,
      makeContractsSvc(tmpl),
      makeTosSvc({ active: tos }),
      makeEmployeeContractsSvc(),
    )

    const result = await service.getStatus('senior-1', 'SENIOR')

    expect(result.requiresContract).toBe(true)
    expect(result.requiresTos).toBe(true)
    expect(result.contractTemplate?.id).toBe(tmpl.id)
    expect(result.tosVersion?.id).toBe(tos.id)
    expect(result.tosUpdateAvailable).toBe(false)
    expect(result.latestTosVersion?.id).toBe(tos.id)
  })

  it('SENIOR with signed contract: requiresContract=false, contractTemplate=null', async () => {
    const tmpl = makeTemplate('SENIOR')
    const tos = makeTos()
    const mockDb = makeDb({ signedContract: { id: 'sc-1', templateId: tmpl.id } })
    const service = new OnboardingService(
      mockDb as unknown as DatabaseService,
      makeContractsSvc(tmpl),
      makeTosSvc({ active: tos }),
      makeEmployeeContractsSvc(),
    )

    const result = await service.getStatus('senior-1', 'SENIOR')

    expect(result.requiresContract).toBe(false)
    expect(result.contractTemplate).toBeNull()
    expect(result.requiresTos).toBe(true)
  })

  it('SENIOR with accepted current ToS: requiresTos=false, tosVersion=null', async () => {
    const tos = makeTos()
    const mockDb = makeDb({
      activeTosId: tos.id,
      acceptances: [{ id: 'acc-1', tosVersionId: tos.id, version: 1 }],
    })
    const service = new OnboardingService(
      mockDb as unknown as DatabaseService,
      makeContractsSvc(makeTemplate('SENIOR')),
      makeTosSvc({ active: tos }),
      makeEmployeeContractsSvc(),
    )

    const result = await service.getStatus('senior-1', 'SENIOR')

    expect(result.requiresTos).toBe(false)
    expect(result.tosVersion).toBeNull()
    expect(result.tosUpdateAvailable).toBe(false)
    expect(result.latestTosVersion?.id).toBe(tos.id)
  })

  it('SENIOR accepted older ToS v1, active is v2 → tosUpdateAvailable=true', async () => {
    const oldTos = makeTos({ id: 'tos-old', version: 1, isActive: false })
    const newTos = makeTos({ id: 'tos-new', version: 2, isActive: true })
    const mockDb = makeDb({
      activeTosId: newTos.id,
      acceptances: [{ id: 'acc-old', tosVersionId: oldTos.id, version: 1 }],
    })
    const service = new OnboardingService(
      mockDb as unknown as DatabaseService,
      makeContractsSvc(makeTemplate('SENIOR')),
      makeTosSvc({ active: newTos }),
      makeEmployeeContractsSvc(),
    )

    const result = await service.getStatus('senior-1', 'SENIOR')

    // requiresTos=true because user hasn't accepted current active v2
    expect(result.requiresTos).toBe(true)
    expect(result.tosVersion?.id).toBe(newTos.id)
    // tosUpdateAvailable describes "accepted older version, active is newer" —
    // it's the trigger for the soft-notify banner. Since requiresTos covers
    // the hard block, banner is only shown when requiresTos=false; here it's
    // still true so banner won't render — but the flag must reflect "newer
    // version exists" so caller can compute UI variants. By spec, it stays
    // true here because the user accepted v1 and v2 is newer.
    expect(result.tosUpdateAvailable).toBe(true)
    expect(result.latestTosVersion?.id).toBe(newTos.id)
  })

  it('all 6 non-ADMIN roles get their own role template', async () => {
    const roles: Array<Exclude<SessionUser['role'], 'ADMIN'>> = [
      'HR',
      'SENIOR',
      'JUNIOR',
      'DROP',
      'ACCOUNTANT',
    ]
    for (const role of roles) {
      const tmpl = makeTemplate(role)
      const mockDb = makeDb()
      const contractsSvc = makeContractsSvc(tmpl)
      const service = new OnboardingService(
        mockDb as unknown as DatabaseService,
        contractsSvc,
        makeTosSvc(),
        makeEmployeeContractsSvc(),
      )
      const u = userOfRole(role)
      await service.getStatus(u.id, role)
      const callArgs = (
        contractsSvc as unknown as { getCurrentForRole: { mock: { calls: unknown[][] } } }
      ).getCurrentForRole.mock.calls[0]
      expect(callArgs?.[0]).toBe(role)
    }
  })

  it('returns no contractTemplate when there is no active template for role', async () => {
    const mockDb = makeDb()
    const service = new OnboardingService(
      mockDb as unknown as DatabaseService,
      makeContractsSvc(null),
      makeTosSvc(),
      makeEmployeeContractsSvc(),
    )

    const result = await service.getStatus('user-1', 'SENIOR')
    // Without active template there is nothing for user to sign — defensive
    // behavior: requiresContract=false, contractTemplate=null. Onboarding
    // pipeline simply waits for ADMIN to publish.
    expect(result.requiresContract).toBe(false)
    expect(result.contractTemplate).toBeNull()
  })

  it('returns no tos required when no active ToS exists', async () => {
    const mockDb = makeDb()
    const service = new OnboardingService(
      mockDb as unknown as DatabaseService,
      makeContractsSvc(),
      makeTosSvc({ active: null }),
      makeEmployeeContractsSvc(),
    )
    const result = await service.getStatus('user-1', 'SENIOR')
    expect(result.requiresTos).toBe(false)
    expect(result.tosVersion).toBeNull()
    expect(result.latestTosVersion).toBeNull()
  })
})
