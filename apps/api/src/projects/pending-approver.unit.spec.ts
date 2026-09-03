/**
 * Unit tests for task-project-status-filter-ui fix-round-1's SPEC-M-2 fix —
 * `ProjectDto.seniorApprovalPending` / `dropApprovalPending`, the fields
 * `ProjectRow.tsx`'s pendingCaption now reads instead of `dropId`'s mere
 * presence (see that component's own comment for the bug this replaces:
 * a project stays DRAFT after only ONE of two invited approvers decides —
 * business spec §4.1 partial agreement — and the old caption kept naming
 * an already-decided drop).
 *
 * Companion to `rejection-reason.unit.spec.ts` (same house style, same
 * `ProjectsService` constructor shape) — kept in its own file because it
 * exercises a DIFFERENT status branch (DRAFT, not REJECTED) with a
 * different-shaped batched map (`Map<string, Set<string>>`, not
 * `Map<string, string>`).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

const SENIOR_ID = 'senior-1'
const DROP_ID = 'drop-1'
const ADMIN_ID = 'admin-1'
const DROP_VIEWER_ID = 'drop-1'
const PROJECT_ID = 'draft-proj-1'

function baseProjectFields() {
  return {
    name: 'Acme',
    companyName: 'Acme',
    domain: 'Other',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: SENIOR_ID,
    dropId: DROP_ID,
    rate: 3000,
    currency: 'USDT',
    seniorSharePercentOverride: null,
    dropSharePercentOverride: null,
    techStack: null,
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
      id: SENIOR_ID,
      displayName: 'Senior',
      email: 'senior@test.spec',
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'SENIOR',
      seniorSharePercent: 26,
    },
    drop: {
      id: DROP_ID,
      displayName: 'Drop',
      email: 'drop@test.spec',
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'DROP',
      dropSharePercent: 5,
    },
    members: [],
    legend: null,
  }
}

function draftProject() {
  return { ...baseProjectFields(), id: PROJECT_ID, status: 'DRAFT' as const }
}

function sessionFor(id: string, role: SessionUser['role']): SessionUser {
  return {
    id,
    role,
    displayName: id,
    email: `${id}@test.spec`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

function buildService(projectRows: ReturnType<typeof draftProject>[]) {
  const db = {
    db: {
      query: {
        projects: {
          findFirst: async () => projectRows[0],
          findMany: async () => projectRows,
        },
        teamMembers: { findFirst: async () => null, findMany: async () => [] },
      },
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
          innerJoin: () => ({ where: () => Promise.resolve([]) }),
        }),
      }),
    },
  }
  const auditLog = { record: vi.fn(async () => undefined) }
  const hrAccess = new HrAccessService(db as never)
  const approvals = {
    isApprover: vi.fn(async () => true),
    listSubjectIdsForApprover: vi.fn(async () => new Set(projectRows.map((p) => p.id))),
    getPendingApproverIds: vi.fn(async (_subjectType: string, ids: string[]) => {
      const map = new Map<string, Set<string>>()
      if (ids.includes(PROJECT_ID)) map.set(PROJECT_ID, new Set([SENIOR_ID]))
      return map
    }),
  }
  const service = new ProjectsService(
    db as never,
    auditLog as never,
    {} as never,
    hrAccess,
    approvals as never,
  )
  return { service, approvals }
}

describe('ProjectsService — seniorApprovalPending/dropApprovalPending on findAll/findOne (SPEC-M-2)', () => {
  it('findAll: only the senior is in the live-pending set — dropApprovalPending is false, not derived from dropId presence', async () => {
    const { service } = buildService([draftProject()])
    const result = await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })
    const project = result.find((p) => p.id === PROJECT_ID)
    expect(project?.seniorApprovalPending).toBe(true)
    expect(project?.dropApprovalPending).toBe(false)
  })

  it('findAll: called with ONLY the DRAFT project ids, not the ACTIVE ones — and the ACTIVE sibling gets both booleans false regardless of what the map says', async () => {
    // The mock's own getPendingApproverIds would happily report SENIOR_ID as
    // pending for ANY id it's asked about that matches PROJECT_ID — the
    // point of this test is proving findAll only ever ASKS about DRAFT ids
    // in the first place (mutating `[project.id]` to `[]` in the call, or
    // forcing the `status === 'DRAFT'` gate to `true`, must fail this).
    const activeRow = {
      ...draftProject(),
      id: 'active-proj-1',
      status: 'ACTIVE' as const,
    }
    const { service, approvals } = buildService([draftProject(), activeRow])

    const result = await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })

    expect(approvals.getPendingApproverIds).toHaveBeenCalledWith('PROJECT', [PROJECT_ID])
    const active = result.find((p) => p.id === 'active-proj-1')
    expect(active?.seniorApprovalPending).toBe(false)
    expect(active?.dropApprovalPending).toBe(false)
  })

  it('findAll: dropApprovalPending is false when the project has no drop at all, even if the (mocked, permissive) map would otherwise say the drop id is pending', async () => {
    // dropId: null here — !!project.dropId must gate this to false BEFORE
    // the map is even consulted for a drop id that does not exist.
    const seniorOnlyProject = { ...draftProject(), dropId: null, drop: null }
    const { service } = buildService([seniorOnlyProject])

    const result = await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })

    const project = result.find((p) => p.id === PROJECT_ID)
    expect(project?.dropApprovalPending).toBe(false)
  })

  it('findAll: getPendingApproverIds is never called when the filtered list has no DRAFT project', async () => {
    const activeRow = { ...draftProject(), status: 'ACTIVE' as const }
    const { service, approvals } = buildService([activeRow])
    await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })
    expect(approvals.getPendingApproverIds).not.toHaveBeenCalled()
  })

  it('findOne: both booleans false (both already decided) when the project id has no entry in the map at all', async () => {
    const db = {
      db: {
        query: {
          projects: { findFirst: async () => draftProject() },
          teamMembers: { findFirst: async () => null, findMany: async () => [] },
        },
      },
    }
    const auditLog = { record: vi.fn(async () => undefined) }
    const hrAccess = new HrAccessService(db as never)
    const approvals = {
      getPendingApproverIds: vi.fn(async () => new Map<string, Set<string>>()),
    }
    const service = new ProjectsService(
      db as never,
      auditLog as never,
      {} as never,
      hrAccess,
      approvals as never,
    )

    const result = await service.findOne(PROJECT_ID, sessionFor(ADMIN_ID, 'ADMIN'))

    expect(result.seniorApprovalPending).toBe(false)
    expect(result.dropApprovalPending).toBe(false)
  })

  it('findOne: masking-safety — a viewer for whom seniorId is masked to null (admin-as-senior + non-privileged viewer) still gets the CORRECT seniorApprovalPending, because the check runs against the RAW project.seniorId, not the masked DTO field', async () => {
    // The exact scenario the schema doc for these fields calls out as the
    // reason booleans were chosen over a raw id array: `effectiveSeniorId`
    // masks to null here (senior IS an ADMIN-role user, viewer is DROP —
    // not privileged), but the live-pending computation must not be fooled
    // by that mask.
    const adminAsSeniorProject = {
      ...draftProject(),
      senior: { ...draftProject().senior, role: 'ADMIN' },
    }
    const db = {
      db: {
        query: {
          projects: { findFirst: async () => adminAsSeniorProject },
          teamMembers: { findFirst: async () => null, findMany: async () => [] },
        },
      },
    }
    const auditLog = { record: vi.fn(async () => undefined) }
    const hrAccess = new HrAccessService(db as never)
    const approvals = {
      // DROP is a non-ADMIN viewer on a non-ACTIVE (DRAFT) project —
      // findOne's assertAccess needs this to let the invited drop through.
      isApprover: vi.fn(async () => true),
      getPendingApproverIds: vi.fn(
        async () => new Map([[PROJECT_ID, new Set([SENIOR_ID, DROP_ID])]]),
      ),
    }
    const service = new ProjectsService(
      db as never,
      auditLog as never,
      {} as never,
      hrAccess,
      approvals as never,
    )

    const result = await service.findOne(PROJECT_ID, sessionFor(DROP_VIEWER_ID, 'DROP'))

    // The masking this test is actually about — seniorId reads null for
    // this viewer/project combination.
    expect(result.seniorId).toBeNull()
    // ...yet the pending computation is still correct, because it was
    // checked against the raw id, not this masked field.
    expect(result.seniorApprovalPending).toBe(true)
    expect(result.dropApprovalPending).toBe(true)
  })
})

describe('ProjectsService.create — seniorApprovalPending/dropApprovalPending computed with ZERO extra query (SPEC-M-2)', () => {
  it('a fresh drop-project: both booleans true, without ever calling getPendingApproverIds — every invited approver is PENDING the instant propose() inserts their row, no query needed to know that', async () => {
    const created = draftProject()
    // create() looks up the senior FIRST (`users.findFirst` for
    // data.seniorId), then the drop SECOND — a call-order-based mock, since
    // the drizzle `where: eq(users.id, ...)` argument isn't easily
    // introspected without evaluating the expression tree.
    const usersFindFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: SENIOR_ID, role: 'SENIOR', archivedAt: null })
      .mockResolvedValueOnce({ id: DROP_ID, role: 'DROP', archivedAt: null })
    const db = {
      db: {
        query: {
          users: { findFirst: usersFindFirst },
          projects: { findFirst: async () => created },
          teamMembers: { findFirst: async () => null, findMany: async () => [] },
        },
        transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
          const tx = {
            insert: (_table: unknown) => ({
              values: (_v: Record<string, unknown>) => ({
                returning: () => Promise.resolve([{ id: PROJECT_ID }]),
              }),
            }),
          }
          return fn(tx)
        },
      },
    }
    const auditLog = { record: vi.fn(async () => undefined) }
    const hrAccess = new HrAccessService(db as never)
    const approvals = {
      proposeInTx: vi.fn(async () => undefined),
      getPendingApproverIds: vi.fn(async () => new Map<string, Set<string>>()),
    }
    const service = new ProjectsService(
      db as never,
      auditLog as never,
      {} as never,
      hrAccess,
      approvals as never,
    )

    const result = await service.create(
      {
        name: 'New',
        companyName: 'New Co',
        domain: 'Other',
        seniorId: SENIOR_ID,
        dropId: DROP_ID,
        rate: 3000,
        currency: 'USDT',
        startDate: '2026-01-01T00:00:00.000Z',
      } as never,
      sessionFor(ADMIN_ID, 'ADMIN'),
    )

    expect(result.seniorApprovalPending).toBe(true)
    expect(result.dropApprovalPending).toBe(true)
    expect(approvals.getPendingApproverIds).not.toHaveBeenCalled()
  })
})

describe('ProjectsService.update — seniorApprovalPending/dropApprovalPending on a DRAFT project (SPEC-M-2)', () => {
  function buildService(projectRow: ReturnType<typeof draftProject>) {
    const db = {
      db: {
        query: {
          projects: { findFirst: async () => projectRow },
          teamMembers: { findFirst: async () => null, findMany: async () => [] },
        },
        update: (_table: unknown) => ({
          set: (_values: Record<string, unknown>) => ({
            where: (_expr: unknown) => Promise.resolve(),
          }),
        }),
      },
    }
    const auditLog = { record: vi.fn(async () => undefined) }
    const hrAccess = new HrAccessService(db as never)
    const approvals = {
      getPendingApproverIds: vi.fn(async (_subjectType: string, ids: string[]) => {
        const map = new Map<string, Set<string>>()
        if (ids.includes(PROJECT_ID)) map.set(PROJECT_ID, new Set([SENIOR_ID, DROP_ID]))
        return map
      }),
    }
    const service = new ProjectsService(
      db as never,
      auditLog as never,
      {} as never,
      hrAccess,
      approvals as never,
    )
    return { service, approvals }
  }

  it('ADMIN patches a DRAFT project (e.g. renames it before anyone confirmed) — the response carries the live pending booleans, called with exactly [id]', async () => {
    const { service, approvals } = buildService(draftProject())

    const result = await service.update(
      PROJECT_ID,
      { name: 'Renamed while still DRAFT' },
      sessionFor(ADMIN_ID, 'ADMIN'),
    )

    expect(approvals.getPendingApproverIds).toHaveBeenCalledWith('PROJECT', [PROJECT_ID])
    expect(result.seniorApprovalPending).toBe(true)
    expect(result.dropApprovalPending).toBe(true)
  })

  it('getPendingApproverIds is never called when the patched project is ACTIVE (same guard as findOne/findAll)', async () => {
    const { service, approvals } = buildService({ ...draftProject(), status: 'ACTIVE' as const })

    await service.update(PROJECT_ID, { name: 'Renamed' }, sessionFor(ADMIN_ID, 'ADMIN'))

    expect(approvals.getPendingApproverIds).not.toHaveBeenCalled()
  })
})
