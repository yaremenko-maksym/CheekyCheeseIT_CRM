/**
 * Unit tests — SENIOR drop identity masking (fix/senior-drop-identity-mask).
 *
 * Pre-existing PR #359 closed the UI layer (SENIOR does not render the drop row).
 * This spec covers the API layer: service-level masking of drop identity from SENIOR.
 *
 * Finding H1 (code-review PR #359):
 *   - `mapProject.dropName` was NOT masked for SENIOR viewers.
 *   - `computeEffectiveTeam.drop` object was NOT masked for SENIOR viewers.
 *   - `dropId` and `dropSharePercent` must remain visible to SENIOR (FE needs them).
 *
 * Scenarios (AC1 + AC2 from task-fix-senior-drop-identity-mask.md):
 *
 *   computeEffectiveTeam (AC1):
 *   DROP-ET-1  SENIOR viewer → effectiveTeam.drop === null
 *   DROP-ET-2  ADMIN viewer → effectiveTeam.drop present (non-null)
 *   DROP-ET-3  HR viewer → effectiveTeam.drop present
 *   DROP-ET-4  ACCOUNTANT viewer → effectiveTeam.drop present
 *   DROP-ET-5  DROP viewer (own project) → effectiveTeam.drop present
 *
 *   mapProject (AC2):
 *   DROP-MAP-1  SENIOR viewer → dropName=null, dropId=present, dropSharePercent=present
 *   DROP-MAP-2  ADMIN viewer → dropName=displayName, dropId=present, dropSharePercent=present
 *   DROP-MAP-3  HR viewer → dropName=displayName
 *   DROP-MAP-4  ACCOUNTANT viewer → dropName=displayName
 *   DROP-MAP-5  JUNIOR viewer → dropId=null, dropName=null, dropSharePercent=null (regression)
 *   DROP-MAP-6  Regular (no-drop) project: SENIOR viewer → dropName=null, dropId=null (no regression)
 *
 * These are pure unit tests — no real DB needed. DB is fully mocked.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

const DROP_ID = 'drop-uuid-0001'
const DROP_EMAIL = 'drop@company.com'
const DROP_DISPLAY_NAME = 'Drop User One'
const DROP_SHARE_PERCENT = 15

const S1_ID = 'senior-uuid-0001'

const adminViewer: SessionUser = {
  id: 'admin-uuid-0001',
  email: 'admin@company.com',
  displayName: 'Admin User',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}

const seniorViewer: SessionUser = {
  id: S1_ID,
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

const dropViewer: SessionUser = {
  id: DROP_ID,
  email: DROP_EMAIL,
  displayName: DROP_DISPLAY_NAME,
  avatarUrl: null,
  role: 'DROP',
  seniorSharePercent: 0,
  legalFullName: null,
}

// ---------------------------------------------------------------------------
// Project fixture builders
// ---------------------------------------------------------------------------

/** Drop-project: has DROP user attached. Used for most masking tests. */
function makeDropProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-drop-001',
    name: 'Drop Project Alpha',
    companyName: 'AlphaCorp',
    domain: 'alphacorp.io',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: S1_ID,
    dropId: DROP_ID,
    rate: 5000,
    currency: 'USDT',
    seniorSharePercentOverride: null,
    techStack: 'TypeScript, NestJS',
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    senior: {
      id: S1_ID,
      displayName: 'Senior One',
      email: 'senior@x.com',
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'SENIOR',
      seniorSharePercent: 26,
    },
    drop: {
      id: DROP_ID,
      displayName: DROP_DISPLAY_NAME,
      email: DROP_EMAIL,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'DROP',
      dropSharePercent: DROP_SHARE_PERCENT,
    },
    members: [],
    legend: null,
    ...overrides,
  }
}

/** Regular senior-project (no drop). Used for regression tests. */
function makeRegularProject() {
  return {
    id: 'proj-regular-001',
    name: 'Regular Project',
    companyName: 'Acme Corp',
    domain: 'acme.com',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: S1_ID,
    dropId: null,
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
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    senior: {
      id: S1_ID,
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
// Harness builder (mirrors admin-as-senior.unit.spec.ts pattern)
// ---------------------------------------------------------------------------

function buildHarness(project: ReturnType<typeof makeDropProject>) {
  const db = {
    db: {
      query: {
        projects: {
          findFirst: async () => ({ ...project }),
        },
        users: { findFirst: async () => null },
        projectFinanceSettings: { findFirst: async () => null },
        teamMembers: {
          findFirst: async () => null,
          findMany: async () => [],
        },
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
  // task-pending-share: findOne's response path resolves pendingSeniorShare
  // via getStatus — 'NONE' here, this file only exercises drop-identity masking.
  const approvals = { getStatus: vi.fn(async () => 'NONE' as const) }

  const service = new ProjectsService(
    db as never,
    auditLog as never,
    usersSvc as never,
    hrAccess,
    approvals as never,
  )

  // Bypass access check — we test mapping logic, not RBAC gate
  vi.spyOn(service as never, 'assertAccess').mockResolvedValue(undefined)
  // Bypass team-overrides load (irrelevant for masking tests)
  vi.spyOn(service as never, 'loadTeamOverridesBySenior').mockResolvedValue(new Map())

  return { service }
}

// ---------------------------------------------------------------------------
// computeEffectiveTeam — AC1: drop field masking per viewer role
// ---------------------------------------------------------------------------

describe('senior-drop-mask: computeEffectiveTeam drop field (AC1)', () => {
  it('DROP-ET-1. SENIOR viewer → effectiveTeam.drop === null (identity hidden)', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', seniorViewer)

    expect(result.effectiveTeam, 'effectiveTeam must be present for SENIOR').toBeDefined()
    const et = result.effectiveTeam as { drop: unknown }
    expect(et.drop, 'SENIOR viewer: effectiveTeam.drop must be null').toBeNull()
  })

  it('DROP-ET-2. ADMIN viewer → effectiveTeam.drop present with identity (positive control)', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', adminViewer)

    expect(result.effectiveTeam).toBeDefined()
    const et = result.effectiveTeam as {
      drop: { id: string; displayName: string; email: string; role: string } | null
    }
    expect(et.drop, 'ADMIN viewer: effectiveTeam.drop must be non-null').not.toBeNull()
    expect(et.drop!.id, 'ADMIN viewer: drop.id must match DROP_ID').toBe(DROP_ID)
    expect(et.drop!.displayName, 'ADMIN viewer: drop.displayName must be real').toBe(
      DROP_DISPLAY_NAME,
    )
    expect(et.drop!.email, 'ADMIN viewer: drop.email must be real').toBe(DROP_EMAIL)
    expect(et.drop!.role).toBe('DROP')
  })

  it('DROP-ET-3. HR viewer → effectiveTeam.drop present', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', hrViewer)

    expect(result.effectiveTeam).toBeDefined()
    const et = result.effectiveTeam as { drop: { id: string } | null }
    expect(et.drop, 'HR viewer: effectiveTeam.drop must be non-null').not.toBeNull()
    expect(et.drop!.id).toBe(DROP_ID)
  })

  it('DROP-ET-4. ACCOUNTANT viewer → effectiveTeam.drop present', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', accountantViewer)

    expect(result.effectiveTeam).toBeDefined()
    const et = result.effectiveTeam as { drop: { id: string } | null }
    expect(et.drop, 'ACCOUNTANT viewer: effectiveTeam.drop must be non-null').not.toBeNull()
    expect(et.drop!.id).toBe(DROP_ID)
  })

  it('DROP-ET-5. DROP viewer (own project) → effectiveTeam.drop present', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', dropViewer)

    expect(result.effectiveTeam).toBeDefined()
    const et = result.effectiveTeam as { drop: { id: string } | null }
    expect(et.drop, 'DROP viewer: effectiveTeam.drop must be non-null (own project)').not.toBeNull()
    expect(et.drop!.id).toBe(DROP_ID)
  })
})

// ---------------------------------------------------------------------------
// mapProject — AC2: dropName masking; dropId + dropSharePercent preserved
// ---------------------------------------------------------------------------

describe('senior-drop-mask: mapProject dropName / dropId / dropSharePercent (AC2)', () => {
  it('DROP-MAP-1. SENIOR viewer → dropName=null, dropId=present, dropSharePercent=present', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', seniorViewer)

    expect(result.dropName, 'SENIOR viewer: dropName must be null (identity hidden)').toBeNull()
    expect(result.dropId, 'SENIOR viewer: dropId must be present (opaque uuid OK)').toBe(DROP_ID)
    expect(
      result.dropSharePercent,
      'SENIOR viewer: dropSharePercent must be present (financial field)',
    ).toBe(DROP_SHARE_PERCENT)
  })

  it('DROP-MAP-2. ADMIN viewer → dropName=real, dropId=present, dropSharePercent=present', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', adminViewer)

    expect(result.dropName, 'ADMIN viewer: dropName must be real displayName').toBe(
      DROP_DISPLAY_NAME,
    )
    expect(result.dropId, 'ADMIN viewer: dropId must be present').toBe(DROP_ID)
    expect(result.dropSharePercent, 'ADMIN viewer: dropSharePercent must be present').toBe(
      DROP_SHARE_PERCENT,
    )
  })

  it('DROP-MAP-3. HR viewer → dropName=real', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', hrViewer)

    expect(result.dropName, 'HR viewer: dropName must be real').toBe(DROP_DISPLAY_NAME)
  })

  it('DROP-MAP-4. ACCOUNTANT viewer → dropName=real', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', accountantViewer)

    expect(result.dropName, 'ACCOUNTANT viewer: dropName must be real').toBe(DROP_DISPLAY_NAME)
  })

  it('DROP-MAP-5. JUNIOR viewer → dropId=null, dropName=null, dropSharePercent=null (regression guard)', async () => {
    const { service } = buildHarness(makeDropProject())
    const result = await service.findOne('proj-drop-001', juniorViewer)

    expect(result.dropId, 'JUNIOR viewer: dropId must be null').toBeNull()
    expect(result.dropName, 'JUNIOR viewer: dropName must be null').toBeNull()
    expect(result.dropSharePercent, 'JUNIOR viewer: dropSharePercent must be null').toBeNull()
    // effectiveTeam must be absent for JUNIOR
    expect(result.effectiveTeam, 'effectiveTeam absent for JUNIOR').toBeUndefined()
  })

  it('DROP-MAP-6. Regular (no-drop) project: SENIOR viewer → dropName=null, dropId=null (no regression)', async () => {
    const { service } = buildHarness(makeRegularProject() as never)
    const result = await service.findOne('proj-regular-001', seniorViewer)

    expect(result.dropName, 'Regular project: dropName null (no drop exists)').toBeNull()
    expect(result.dropId, 'Regular project: dropId null (no drop)').toBeNull()
    // dropSharePercent defaults to null when drop is null
    expect(result.dropSharePercent, 'Regular project: dropSharePercent null').toBeNull()
  })
})
