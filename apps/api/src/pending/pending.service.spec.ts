/**
 * pending.service.spec.ts — task-pending-screen (position 7c). Unit-level
 * coverage for `PendingService`'s TRANSFORMATION logic (given known
 * `approvals` rows + known project/user/contract rows, does it build the
 * right `PendingItem`s), with `ApprovalsService` and the DB both faked.
 *
 * Deliberately NOT re-proving `listPendingForApprover`/`listPendingProposedBy`'s
 * own WHERE-clause filtering here — that is `approvals.service.spec.ts`'s
 * job (already covers it) and `pending.integration.spec.ts`'s job against a
 * real Postgres (AC1-AC3). This file exists because the mutation gate only
 * ever executes UNIT specs (see .claude/rules/common/mutation-gate-
 * integration-specs.md) — without it, every branch in `pending.service.ts`
 * would report `NoCoverage` regardless of how thorough the integration spec
 * is.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Approval } from '@crm/shared'
import { PendingService } from './pending.service'
import { employeeContracts, projects, users } from '../database/schema'
import type { DatabaseService } from '../database/database.service'
import type { ApprovalsService } from '../approvals/approvals.service'

const SENIOR_ID = '10000000-0000-4000-8000-000000000001'
const DROP_ID = '20000000-0000-4000-8000-000000000002'
const ADMIN_ID = '30000000-0000-4000-8000-000000000003'
const PROJECT_ID = '40000000-0000-4000-8000-000000000004'
const CONTRACT_ID = '50000000-0000-4000-8000-000000000005'
const APPROVAL_ID_1 = '60000000-0000-4000-8000-000000000006'
const APPROVAL_ID_2 = '70000000-0000-4000-8000-000000000007'

function makeApproval(overrides: Partial<Approval>): Approval {
  return {
    id: APPROVAL_ID_1,
    subjectType: 'PROJECT',
    subjectId: PROJECT_ID,
    approverUserId: SENIOR_ID,
    status: 'PENDING',
    rejectionReason: null,
    decidedAt: null,
    proposedByUserId: ADMIN_ID,
    supersededAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  }
}

/** A chain that is both further-chainable (`.where`/`.limit`/`.orderBy`) AND
 * awaitable — matches every `.select({...}).from(x)...` call shape used in
 * `PendingService` without having to simulate Drizzle's actual filtering
 * (that is what the integration spec proves against a real DB). */
function tableChain(rows: unknown[]) {
  const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>
  chain.where = () => chain
  chain.limit = () => chain
  chain.orderBy = () => chain
  chain.for = () => chain
  return chain
}

function makeFakeDb(data: {
  employeeContracts?: unknown[]
  projects?: unknown[]
  users?: unknown[]
  teamMembersWithTeam?: unknown[]
}): DatabaseService {
  const fakeDb = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        if (table === employeeContracts) return tableChain(data.employeeContracts ?? [])
        if (table === projects) return tableChain(data.projects ?? [])
        if (table === users) return tableChain(data.users ?? [])
        return tableChain([])
      }),
    })),
    query: {
      teamMembers: {
        findMany: vi.fn().mockResolvedValue(data.teamMembersWithTeam ?? []),
      },
    },
  }
  return { db: fakeDb } as unknown as DatabaseService
}

function makeFakeApprovals(mine: Approval[], proposedByMe: Approval[] = []): ApprovalsService {
  return {
    listPendingForApprover: vi.fn().mockResolvedValue(mine),
    listPendingProposedBy: vi.fn().mockResolvedValue(proposedByMe),
  } as unknown as ApprovalsService
}

const SENIOR_USER_ROW = {
  id: SENIOR_ID,
  displayName: 'Senior One',
  seniorSharePercent: 26,
  pendingSeniorSharePercent: null as number | null,
}
const ADMIN_USER_ROW = {
  id: ADMIN_ID,
  displayName: 'Admin Adminovich',
  seniorSharePercent: 26,
  pendingSeniorSharePercent: null as number | null,
}
const ACTIVE_PROJECT_ROW = {
  id: PROJECT_ID,
  name: 'GamingTec',
  archivedAt: null as Date | null,
  seniorSharePercentOverride: null as number | null,
  pendingSeniorSharePercentOverride: null as number | null,
}

describe('PendingService.getPending — mine, PROJECT_APPROVAL', () => {
  it('maps a live project-draft approval row to a PROJECT_APPROVAL item', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'PROJECT', subjectId: PROJECT_ID, approverUserId: SENIOR_ID }),
    ])
    const db = makeFakeDb({
      projects: [ACTIVE_PROJECT_ROW],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([
      {
        kind: 'PROJECT_APPROVAL',
        approvalId: APPROVAL_ID_1,
        subjectType: 'PROJECT',
        subjectId: PROJECT_ID,
        title: 'GamingTec',
        proposedBy: 'Admin Adminovich',
        waitingFor: undefined,
        createdAt: '2026-09-01T10:00:00.000Z',
        actions: ['approve', 'reject', 'open'],
        link: `/projects/${PROJECT_ID}`,
      },
    ])
    expect(result.proposedByMe).toEqual([])
    // SENIOR never reaches listPendingProposedBy — task file: ADMIN-only.
    expect(approvalsService.listPendingProposedBy).not.toHaveBeenCalled()
  })

  it('drops the item when the underlying project is archived (§7.4 / AC2)', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'PROJECT', subjectId: PROJECT_ID, approverUserId: SENIOR_ID }),
    ])
    const db = makeFakeDb({
      projects: [{ ...ACTIVE_PROJECT_ROW, archivedAt: new Date('2026-08-01T00:00:00.000Z') }],
      users: [ADMIN_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([])
  })

  it('drops the item when the project row is missing entirely (deleted between the two queries)', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'PROJECT', subjectId: PROJECT_ID, approverUserId: SENIOR_ID }),
    ])
    const db = makeFakeDb({ projects: [], users: [ADMIN_USER_ROW] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([])
  })
})

describe('PendingService.getPending — mine, SHARE_APPROVAL (PROJECT_SENIOR_SHARE)', () => {
  it('resolves currentPercent/pendingPercent via the shared resolver, no team override', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        id: APPROVAL_ID_1,
        subjectType: 'PROJECT_SENIOR_SHARE',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    ])
    const db = makeFakeDb({
      projects: [
        {
          ...ACTIVE_PROJECT_ROW,
          seniorSharePercentOverride: 30,
          pendingSeniorSharePercentOverride: 40,
        },
      ],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toHaveLength(1)
    expect(result.mine[0]).toMatchObject({
      kind: 'SHARE_APPROVAL',
      subjectId: PROJECT_ID,
      currentPercent: 30,
      pendingPercent: 40,
    })
  })

  it('clearing the override (pending value null) resolves to the team override, not 0 or null', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        id: APPROVAL_ID_1,
        subjectType: 'PROJECT_SENIOR_SHARE',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    ])
    const db = makeFakeDb({
      projects: [
        {
          ...ACTIVE_PROJECT_ROW,
          seniorSharePercentOverride: 30,
          pendingSeniorSharePercentOverride: null,
        },
      ],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW],
      teamMembersWithTeam: [
        {
          userId: SENIOR_ID,
          team: { seniorSharePercentOverride: 35, archivedAt: null },
        },
      ],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine[0]).toMatchObject({ currentPercent: 30, pendingPercent: 35 })
  })

  it('ignores an archived team override, falling back to the user default', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        id: APPROVAL_ID_1,
        subjectType: 'PROJECT_SENIOR_SHARE',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    ])
    const db = makeFakeDb({
      projects: [
        {
          ...ACTIVE_PROJECT_ROW,
          seniorSharePercentOverride: null,
          pendingSeniorSharePercentOverride: null,
        },
      ],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW],
      teamMembersWithTeam: [
        {
          userId: SENIOR_ID,
          team: {
            seniorSharePercentOverride: 99,
            archivedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        },
      ],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    // SENIOR_USER_ROW.seniorSharePercent === 26 — the USER_DEFAULT fallback.
    expect(result.mine[0]).toMatchObject({ currentPercent: 26, pendingPercent: 26 })
  })
})

describe('PendingService.getPending — mine, SHARE_APPROVAL (USER_SENIOR_SHARE)', () => {
  it('titles a self base-share proposal "Ваша базовая доля" and links to /profile', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        id: APPROVAL_ID_1,
        subjectType: 'USER_SENIOR_SHARE',
        subjectId: SENIOR_ID,
        approverUserId: SENIOR_ID,
      }),
    ])
    const db = makeFakeDb({
      users: [ADMIN_USER_ROW, { ...SENIOR_USER_ROW, pendingSeniorSharePercent: 33 }],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([
      {
        kind: 'SHARE_APPROVAL',
        approvalId: APPROVAL_ID_1,
        subjectType: 'USER_SENIOR_SHARE',
        subjectId: SENIOR_ID,
        title: 'Ваша базовая доля',
        proposedBy: 'Admin Adminovich',
        waitingFor: undefined,
        currentPercent: 26,
        pendingPercent: 33,
        createdAt: '2026-09-01T10:00:00.000Z',
        actions: ['approve', 'reject', 'open'],
        link: '/profile',
      },
    ])
  })
})

describe('PendingService.getPending — mine, CONTRACT_TO_SIGN', () => {
  it('appends the contract item when a READY_TO_SIGN contract exists for the viewer', async () => {
    const approvalsService = makeFakeApprovals([])
    const db = makeFakeDb({
      employeeContracts: [{ id: CONTRACT_ID, updatedAt: new Date('2026-09-05T12:00:00.000Z') }],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'JUNIOR' } as never)

    expect(result.mine).toEqual([
      {
        kind: 'CONTRACT_TO_SIGN',
        subjectId: CONTRACT_ID,
        title: 'Контракт сотрудника',
        createdAt: '2026-09-05T12:00:00.000Z',
        actions: ['open'],
        link: '/profile',
      },
    ])
  })

  it('omits the contract item when nothing is READY_TO_SIGN', async () => {
    const approvalsService = makeFakeApprovals([])
    const db = makeFakeDb({ employeeContracts: [] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'JUNIOR' } as never)

    expect(result.mine).toEqual([])
  })

  it('sorts a contract item alongside approval items by createdAt ascending', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        subjectType: 'PROJECT',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
        createdAt: '2026-09-10T00:00:00.000Z',
      }),
    ])
    const db = makeFakeDb({
      projects: [ACTIVE_PROJECT_ROW],
      users: [ADMIN_USER_ROW],
      employeeContracts: [{ id: CONTRACT_ID, updatedAt: new Date('2026-09-01T00:00:00.000Z') }],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine.map((item) => item.kind)).toEqual(['CONTRACT_TO_SIGN', 'PROJECT_APPROVAL'])
  })
})

describe('PendingService.getPending — proposedByMe (ADMIN only)', () => {
  it('is empty and never queried for a non-ADMIN viewer', async () => {
    const approvalsService = makeFakeApprovals([], [makeApproval({})])
    const db = makeFakeDb({})
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.proposedByMe).toEqual([])
    expect(approvalsService.listPendingProposedBy).not.toHaveBeenCalled()
  })

  it('groups two live approver rows for the same PROJECT into one item with both names in waitingFor', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'PROJECT',
          subjectId: PROJECT_ID,
          approverUserId: SENIOR_ID,
          proposedByUserId: ADMIN_ID,
        }),
        makeApproval({
          id: APPROVAL_ID_2,
          subjectType: 'PROJECT',
          subjectId: PROJECT_ID,
          approverUserId: DROP_ID,
          proposedByUserId: ADMIN_ID,
        }),
      ],
    )
    const db = makeFakeDb({
      projects: [ACTIVE_PROJECT_ROW],
      users: [SENIOR_USER_ROW, { ...ADMIN_USER_ROW, id: DROP_ID, displayName: 'Drop One' }],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toHaveLength(1)
    expect(result.proposedByMe[0]).toMatchObject({
      kind: 'PROJECT_APPROVAL',
      subjectId: PROJECT_ID,
      // No withdraw-project endpoint in main — task file §Что сделать item 2.
      actions: ['open'],
    })
    expect(result.proposedByMe[0]?.waitingFor).toEqual(
      expect.arrayContaining(['Senior One', 'Drop One']),
    )
  })

  it('offers cancel for a proposed SHARE_APPROVAL (senior-share/cancel exists, #648)', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'USER_SENIOR_SHARE',
          subjectId: SENIOR_ID,
          approverUserId: SENIOR_ID,
          proposedByUserId: ADMIN_ID,
        }),
      ],
    )
    const db = makeFakeDb({ users: [{ ...SENIOR_USER_ROW, pendingSeniorSharePercent: 40 }] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toEqual([
      {
        kind: 'SHARE_APPROVAL',
        approvalId: APPROVAL_ID_1,
        subjectType: 'USER_SENIOR_SHARE',
        subjectId: SENIOR_ID,
        title: 'Senior One',
        proposedBy: undefined,
        waitingFor: ['Senior One'],
        currentPercent: 26,
        pendingPercent: 40,
        createdAt: '2026-09-01T10:00:00.000Z',
        actions: ['cancel', 'open'],
        link: '/users',
      },
    ])
  })
})

describe('PendingService.getPending — forward-compatible unknown subjectType', () => {
  it('skips a row whose subjectType this service does not recognise, without throwing', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'SOME_FUTURE_SUBJECT_TYPE', subjectId: PROJECT_ID }),
    ])
    const db = makeFakeDb({})
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([])
  })
})
