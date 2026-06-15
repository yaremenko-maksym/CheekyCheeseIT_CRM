/**
 * Unit tests — admin-as-senior PII masking (task-admin-as-senior).
 *
 * Covers:
 *   UNIT-1  mapProject: SENIOR viewer of admin-project → seniorId=null, seniorName=displayName
 *   UNIT-2  mapProject: HR viewer of admin-project → seniorId=null, seniorName=displayName
 *   UNIT-3  mapProject: ADMIN viewer of admin-project → seniorId=real, seniorName=displayName
 *   UNIT-4  mapProject: ACCOUNTANT viewer of admin-project → seniorId=real
 *   UNIT-5  mapProject: JUNIOR viewer of admin-project → seniorId=null (normal JUNIOR masking)
 *   UNIT-6  computeEffectiveTeam: SENIOR viewer → email='', profileNavigable=false
 *   UNIT-7  computeEffectiveTeam: ADMIN viewer → email=real, profileNavigable=true
 *   UNIT-8  computeEffectiveTeam: ACCOUNTANT viewer → email=real, profileNavigable=true
 *   UNIT-9  Regular (non-admin) senior project: SENIOR viewer → seniorId=real (no regression)
 *
 * These are pure unit tests — no real DB needed. The DB is fully mocked.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

const ADMIN_ID = 'admin-uuid-0001'
const ADMIN_EMAIL = 'admin@company.com'

const adminViewer: SessionUser = {
  id: ADMIN_ID,
  email: ADMIN_EMAIL,
  displayName: 'Maksym Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const seniorViewer: SessionUser = {
  id: 'senior-uuid-0001',
  email: 'senior@x.com',
  displayName: 'Senior One',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const hrViewer: SessionUser = {
  id: 'hr-uuid-0001',
  email: 'hr@x.com',
  displayName: 'HR One',
  avatarUrl: null,
  role: 'HR',
  seniorSharePercent: 0,
  legalFullName: null,
}

const accountantViewer: SessionUser = {
  id: 'acc-uuid-0001',
  email: 'acc@x.com',
  displayName: 'Accountant One',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}

const juniorViewer: SessionUser = {
  id: 'junior-uuid-0001',
  email: 'junior@x.com',
  displayName: 'Junior One',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// Project fixture builder
// ---------------------------------------------------------------------------

function makeAdminProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-admin-sr-001',
    name: 'Admin Senior Project',
    companyName: 'NeuroEdge Labs',
    domain: 'neuroedge.ai',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-03-01'),
    seniorId: ADMIN_ID,
    rate: 6000,
    currency: 'USDT',
    seniorSharePercentOverride: null,
    techStack: 'Python, FastAPI',
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    archivedAt: null,
    dropId: null,
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
    senior: {
      id: ADMIN_ID,
      displayName: 'Maksym Admin',
      email: ADMIN_EMAIL,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'ADMIN',
      seniorSharePercent: 26,
    },
    drop: null,
    members: [],
    legend: null,
    ...overrides,
  }
}

function makeRegularProject() {
  return {
    id: 'proj-regular-001',
    name: 'Regular Project',
    companyName: 'Acme Corp',
    domain: 'acme.com',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: 'senior-uuid-0001',
    rate: 4000,
    currency: 'USD',
    seniorSharePercentOverride: null,
    techStack: 'React, NestJS',
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    archivedAt: null,
    dropId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    senior: {
      id: 'senior-uuid-0001',
      displayName: 'Senior One',
      email: 'senior@x.com',
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'SENIOR',
      seniorSharePercent: 26,
    },
    drop: null,
    members: [],
    legend: null,
  }
}

// ---------------------------------------------------------------------------
// Harness builder
// ---------------------------------------------------------------------------

function buildHarness(project: ReturnType<typeof makeAdminProject>) {
  const db = {
    db: {
      query: {
        projects: {
          findFirst: async () => ({ ...project }),
        },
        users: { findFirst: async () => null },
        projectFinanceSettings: { findFirst: async () => null },
        teamMembers: { findFirst: async () => null },
        transactions: { findMany: async () => [] },
      },
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
          innerJoin: () => ({ where: () => Promise.resolve([]) }),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      insert: () => ({ values: async () => undefined }),
    },
  }

  const auditLog = {
    record: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ entries: [], total: 0 })),
  }
  const usersSvc = { unarchive: vi.fn(), unarchivePairTx: vi.fn() }
  const hrAccess = new HrAccessService(db as never)

  const service = new ProjectsService(db as never, auditLog as never, usersSvc as never, hrAccess)

  // Bypass access check — we test mapping logic, not RBAC gate
  vi.spyOn(service as never, 'assertAccess').mockResolvedValue(undefined)
  // Bypass team-overrides load (irrelevant for masking tests)
  vi.spyOn(service as never, 'loadTeamOverridesBySenior').mockResolvedValue(new Map())

  return { service }
}

// ---------------------------------------------------------------------------
// UNIT-1 to UNIT-9: mapProject seniorId masking
// ---------------------------------------------------------------------------

describe('admin-as-senior: mapProject seniorId masking', () => {
  it('UNIT-1. SENIOR viewer → seniorId=null (no link to admin profile)', async () => {
    const { service } = buildHarness(makeAdminProject())
    const result = await service.findOne('proj-admin-sr-001', seniorViewer)
    expect(result.seniorId, 'SENIOR viewer must get seniorId=null for admin-project').toBeNull()
    expect(result.seniorName, 'SENIOR viewer gets real displayName (not PII)').toBe('Maksym Admin')
  })

  it('UNIT-2. HR viewer → seniorId=null (no link to admin profile)', async () => {
    const { service } = buildHarness(makeAdminProject())
    const result = await service.findOne('proj-admin-sr-001', hrViewer)
    expect(result.seniorId, 'HR viewer must get seniorId=null for admin-project').toBeNull()
    expect(result.seniorName).toBe('Maksym Admin')
  })

  it('UNIT-3. ADMIN viewer → seniorId=real (privileged, full visibility)', async () => {
    const { service } = buildHarness(makeAdminProject())
    const result = await service.findOne('proj-admin-sr-001', adminViewer)
    expect(result.seniorId, 'ADMIN viewer must see real seniorId').toBe(ADMIN_ID)
    expect(result.seniorName).toBe('Maksym Admin')
  })

  it('UNIT-4. ACCOUNTANT viewer → seniorId=real (privileged, full visibility)', async () => {
    const { service } = buildHarness(makeAdminProject())
    const result = await service.findOne('proj-admin-sr-001', accountantViewer)
    expect(result.seniorId, 'ACCOUNTANT viewer must see real seniorId').toBe(ADMIN_ID)
  })

  it('UNIT-5. JUNIOR viewer → seniorId=null (normal JUNIOR masking — no regression)', async () => {
    const { service } = buildHarness(makeAdminProject())
    const result = await service.findOne('proj-admin-sr-001', juniorViewer)
    expect(result.seniorId, 'JUNIOR must get seniorId=null').toBeNull()
    // JUNIOR gets legend persona name (or null if no legend)
    expect(result.seniorName, 'JUNIOR gets null seniorName when no legend').toBeNull()
    // effectiveTeam must be absent for JUNIOR
    expect(result.effectiveTeam, 'effectiveTeam absent for JUNIOR').toBeUndefined()
  })

  it('UNIT-9. Regular (non-admin) senior project: SENIOR viewer → seniorId=real (no regression)', async () => {
    const { service } = buildHarness(makeRegularProject() as never)
    const result = await service.findOne('proj-regular-001', seniorViewer)
    expect(result.seniorId, 'Regular senior project: SENIOR viewer gets real seniorId').toBe(
      'senior-uuid-0001',
    )
  })
})

// ---------------------------------------------------------------------------
// UNIT-6 to UNIT-8: computeEffectiveTeam email + profileNavigable masking
// ---------------------------------------------------------------------------

describe('admin-as-senior: computeEffectiveTeam email + profileNavigable masking', () => {
  it('UNIT-6. SENIOR viewer → effectiveTeam.senior.email="", profileNavigable=false', async () => {
    const { service } = buildHarness(makeAdminProject())
    const result = await service.findOne('proj-admin-sr-001', seniorViewer)

    expect(result.effectiveTeam, 'effectiveTeam must be present for SENIOR').toBeDefined()
    const senior = (
      result.effectiveTeam as { senior: { email: string; profileNavigable: boolean } | null }
    )?.senior
    expect(senior, 'effectiveTeam.senior must not be null').not.toBeNull()
    expect(senior!.email, 'SENIOR viewer: admin email must be masked (empty string)').toBe('')
    expect(
      senior!.profileNavigable,
      'SENIOR viewer: profileNavigable must be false for admin-project',
    ).toBe(false)
  })

  it('UNIT-7. ADMIN viewer → effectiveTeam.senior.email=real, profileNavigable=true', async () => {
    const { service } = buildHarness(makeAdminProject())
    const result = await service.findOne('proj-admin-sr-001', adminViewer)

    expect(result.effectiveTeam).toBeDefined()
    const senior = (
      result.effectiveTeam as { senior: { email: string; profileNavigable: boolean } | null }
    )?.senior
    expect(senior).not.toBeNull()
    expect(senior!.email, 'ADMIN viewer must see real admin email').toBe(ADMIN_EMAIL)
    expect(senior!.profileNavigable, 'ADMIN viewer: profileNavigable must be true').toBe(true)
  })

  it('UNIT-8. ACCOUNTANT viewer → effectiveTeam.senior.email=real, profileNavigable=true', async () => {
    const { service } = buildHarness(makeAdminProject())
    const result = await service.findOne('proj-admin-sr-001', accountantViewer)

    expect(result.effectiveTeam).toBeDefined()
    const senior = (
      result.effectiveTeam as { senior: { email: string; profileNavigable: boolean } | null }
    )?.senior
    expect(senior).not.toBeNull()
    expect(senior!.email, 'ACCOUNTANT viewer must see real admin email').toBe(ADMIN_EMAIL)
    expect(senior!.profileNavigable, 'ACCOUNTANT viewer: profileNavigable must be true').toBe(true)
  })
})
