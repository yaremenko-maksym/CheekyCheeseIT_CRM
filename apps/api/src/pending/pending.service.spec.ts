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
  dropSharePercent: null as number | null,
}
const ADMIN_USER_ROW = {
  id: ADMIN_ID,
  displayName: 'Admin Adminovich',
  seniorSharePercent: 26,
  pendingSeniorSharePercent: null as number | null,
  dropSharePercent: null as number | null,
}
const DROP_USER_ROW = {
  id: DROP_ID,
  displayName: 'Drop One',
  seniorSharePercent: 26,
  pendingSeniorSharePercent: null as number | null,
  dropSharePercent: 7 as number | null,
}
const ACTIVE_PROJECT_ROW = {
  id: PROJECT_ID,
  name: 'GamingTec',
  archivedAt: null as Date | null,
  seniorSharePercentOverride: null as number | null,
  pendingSeniorSharePercentOverride: null as number | null,
  seniorId: SENIOR_ID,
  dropId: DROP_ID as string | null,
  dropSharePercentOverride: null as number | null,
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
        // The viewer IS this project's senior — their own resolved share,
        // and no drop identity (integration decision 2).
        viewerSharePercent: 26,
        seniorName: null,
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

  it('falls back to "Неизвестно" when the proposer row is missing from usersById', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        subjectType: 'PROJECT',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
        proposedByUserId: ADMIN_ID,
      }),
    ])
    // ADMIN_USER_ROW (the proposer) deliberately NOT seeded — only the
    // viewer's own row is, so `usersById` is non-empty but still misses it.
    const db = makeFakeDb({ projects: [ACTIVE_PROJECT_ROW], users: [SENIOR_USER_ROW] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine[0]).toMatchObject({ proposedBy: 'Неизвестно' })
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
    // Deliberately NOT `SENIOR_USER_ROW` (26): `resolveSeniorShare`'s own
    // USER_DEFAULT step falls back to a literal 26 when its input is
    // malformed (`senior-share-resolver.ts`'s `senior.seniorSharePercent ??
    // 26`), which would coincidentally match 26 either way and hide a
    // mutant on the object passed into that step. 31 cannot be confused
    // with the resolver's own internal fallback.
    const seniorWithNonDefaultShare = { ...SENIOR_USER_ROW, seniorSharePercent: 31 }
    const db = makeFakeDb({
      projects: [
        {
          ...ACTIVE_PROJECT_ROW,
          seniorSharePercentOverride: null,
          pendingSeniorSharePercentOverride: null,
        },
      ],
      users: [ADMIN_USER_ROW, seniorWithNonDefaultShare],
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

    expect(result.mine[0]).toMatchObject({
      currentPercent: 31,
      pendingPercent: 31,
      link: `/projects/${PROJECT_ID}`,
    })
  })

  it('drops the item when the underlying project is archived (§7.4 / AC2), distinctly from a missing project', async () => {
    // Distinct from "project row is missing entirely" below: `!project` is
    // already false here (the row IS found), so this exercises the SECOND
    // half of the guard (`project.archivedAt !== null`) on its own — the
    // missing-project test can't tell the two halves apart from each other
    // (both end in the same `return null`).
    const approvalsService = makeFakeApprovals([
      makeApproval({
        id: APPROVAL_ID_1,
        subjectType: 'PROJECT_SENIOR_SHARE',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    ])
    const db = makeFakeDb({
      projects: [{ ...ACTIVE_PROJECT_ROW, archivedAt: new Date('2026-08-01T00:00:00.000Z') }],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([])
  })

  it('drops the item when the project row is missing entirely, without crashing', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        id: APPROVAL_ID_1,
        subjectType: 'PROJECT_SENIOR_SHARE',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    ])
    const db = makeFakeDb({ projects: [], users: [ADMIN_USER_ROW, SENIOR_USER_ROW] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([])
  })

  it('drops the item when the viewer/senior row is missing from usersById, without crashing', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        id: APPROVAL_ID_1,
        subjectType: 'PROJECT_SENIOR_SHARE',
        subjectId: PROJECT_ID,
        approverUserId: SENIOR_ID,
      }),
    ])
    // SENIOR_ID deliberately absent from `users` — only the proposer is seeded.
    const db = makeFakeDb({ projects: [ACTIVE_PROJECT_ROW], users: [ADMIN_USER_ROW] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([])
  })

  it('falls back to the user default (not a crash) when the team-membership query itself rejects', async () => {
    // `loadTeamOverridesForSeniors`'s try/catch exists for exactly this —
    // a real DB call failing — and no other test in this file ever makes
    // the fake reject, so this is the only coverage for that branch.
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
    })
    // Override just the team-membership query to reject, keeping every
    // other table lookup from `makeFakeDb` as-is.
    db.db.query.teamMembers.findMany = vi.fn().mockRejectedValue(new Error('connection reset'))
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    // SENIOR_USER_ROW.seniorSharePercent === 26 — the USER_DEFAULT fallback,
    // reached because the failed team lookup is treated as "no override".
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
        // integration decision 1: the CLIENT-facing scope ('USER' routes the
        // action at /users/:id), not the raw approvals column.
        subjectType: 'USER',
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

  it('drops the item when the viewer/senior row is missing from usersById, without crashing', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({
        id: APPROVAL_ID_1,
        subjectType: 'USER_SENIOR_SHARE',
        subjectId: SENIOR_ID,
        approverUserId: SENIOR_ID,
      }),
    ])
    // SENIOR_ID deliberately absent — only the proposer is seeded.
    const db = makeFakeDb({ users: [ADMIN_USER_ROW] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([])
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
        // integration decision 1: user-scoped even though `subjectId` is the
        // contract row's id — `/profile` is a user-scoped surface.
        subjectType: 'USER',
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

  it('is empty for an ADMIN viewer with nothing proposed (queried, genuinely empty)', async () => {
    // Distinct from the test above: this DOES call listPendingProposedBy
    // (ADMIN), exercising `buildProposedByMeItems`'s own `rows.length === 0`
    // early return on a genuinely empty array, rather than skipping the
    // function call entirely via the role gate.
    const approvalsService = makeFakeApprovals([], [])
    const db = makeFakeDb({})
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toEqual([])
    expect(approvalsService.listPendingProposedBy).toHaveBeenCalledWith(ADMIN_ID)
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
        subjectType: 'USER',
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

  it('offers a proposed PROJECT_SENIOR_SHARE change with the resolved percent (team override applied)', async () => {
    // Deliberately the PROJECT_SENIOR_SHARE counterpart of the
    // USER_SENIOR_SHARE test above, WITH a team override seeded and
    // asserted on: `buildProposedByMeItems`'s routing loop populates
    // `projectIds`/`seniorIds` under a DIFFERENT condition than the mine-
    // side loop (no viewer-seed redundancy there), and the nested
    // `seniorIds.add(row.approverUserId)` only runs for this exact subject
    // type — a test that never seeds a team override could not tell a
    // silently-empty `teamOverridesBySenior` apart from a correctly
    // populated one.
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'PROJECT_SENIOR_SHARE',
          subjectId: PROJECT_ID,
          approverUserId: SENIOR_ID,
          proposedByUserId: ADMIN_ID,
        }),
      ],
    )
    const db = makeFakeDb({
      projects: [
        {
          ...ACTIVE_PROJECT_ROW,
          seniorSharePercentOverride: null,
          pendingSeniorSharePercentOverride: null,
        },
      ],
      users: [SENIOR_USER_ROW],
      teamMembersWithTeam: [
        { userId: SENIOR_ID, team: { seniorSharePercentOverride: 45, archivedAt: null } },
      ],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toEqual([
      {
        kind: 'SHARE_APPROVAL',
        approvalId: APPROVAL_ID_1,
        // integration decision 1: a project-scoped share proposal and a
        // project approval share one scope ('PROJECT'); `kind` still tells
        // them apart.
        subjectType: 'PROJECT',
        subjectId: PROJECT_ID,
        title: 'GamingTec',
        proposedBy: undefined,
        waitingFor: ['Senior One'],
        // No project-level override (null) and no PENDING project-level
        // override either — both resolve through the TEAM step to 45.
        currentPercent: 45,
        pendingPercent: 45,
        createdAt: '2026-09-01T10:00:00.000Z',
        actions: ['cancel', 'open'],
        link: `/projects/${PROJECT_ID}`,
      },
    ])
  })

  it('sorts proposedByMe by createdAt ascending, independently of the order the groups happened to form in', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'PROJECT',
          subjectId: PROJECT_ID,
          approverUserId: SENIOR_ID,
          createdAt: '2026-09-10T00:00:00.000Z',
        }),
        makeApproval({
          id: APPROVAL_ID_2,
          subjectType: 'USER_SENIOR_SHARE',
          subjectId: DROP_ID,
          approverUserId: DROP_ID,
          createdAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
    )
    const db = makeFakeDb({
      projects: [ACTIVE_PROJECT_ROW],
      users: [SENIOR_USER_ROW, { ...ADMIN_USER_ROW, id: DROP_ID, displayName: 'Drop One' }],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe.map((item) => item.subjectId)).toEqual([DROP_ID, PROJECT_ID])
  })

  it('two different subjects are never merged into one group, even sharing a kind', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'USER_SENIOR_SHARE',
          subjectId: SENIOR_ID,
          approverUserId: SENIOR_ID,
        }),
        makeApproval({
          id: APPROVAL_ID_2,
          subjectType: 'USER_SENIOR_SHARE',
          subjectId: DROP_ID,
          approverUserId: DROP_ID,
        }),
      ],
    )
    const db = makeFakeDb({
      users: [SENIOR_USER_ROW, { ...ADMIN_USER_ROW, id: DROP_ID, displayName: 'Drop One' }],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toHaveLength(2)
    expect(result.proposedByMe.map((item) => item.subjectId).sort()).toEqual(
      [SENIOR_ID, DROP_ID].sort(),
    )
  })

  it('a group with one approver missing from usersById still yields the OTHER name, not a crash', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'PROJECT',
          subjectId: PROJECT_ID,
          approverUserId: SENIOR_ID,
        }),
        makeApproval({
          id: APPROVAL_ID_2,
          subjectType: 'PROJECT',
          subjectId: PROJECT_ID,
          approverUserId: DROP_ID,
        }),
      ],
    )
    // DROP_ID deliberately absent from `users` — e.g. hard-deleted between
    // the approvals query and this batch fetch.
    const db = makeFakeDb({ projects: [ACTIVE_PROJECT_ROW], users: [SENIOR_USER_ROW] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toHaveLength(1)
    expect(result.proposedByMe[0]?.waitingFor).toEqual(['Senior One'])
  })

  it('drops the whole group when the underlying project is archived (§7.4 / AC2, proposedByMe)', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'PROJECT',
          subjectId: PROJECT_ID,
          approverUserId: SENIOR_ID,
        }),
      ],
    )
    const db = makeFakeDb({
      projects: [{ ...ACTIVE_PROJECT_ROW, archivedAt: new Date('2026-08-01T00:00:00.000Z') }],
      users: [SENIOR_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toEqual([])
  })

  it('drops a PROJECT_SENIOR_SHARE group when the project row is missing entirely, without crashing', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'PROJECT_SENIOR_SHARE',
          subjectId: PROJECT_ID,
          approverUserId: SENIOR_ID,
        }),
      ],
    )
    const db = makeFakeDb({ projects: [], users: [SENIOR_USER_ROW] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toEqual([])
  })

  it('drops a USER_SENIOR_SHARE group when the senior row is missing entirely, without crashing', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          id: APPROVAL_ID_1,
          subjectType: 'USER_SENIOR_SHARE',
          subjectId: SENIOR_ID,
          approverUserId: SENIOR_ID,
        }),
      ],
    )
    const db = makeFakeDb({ users: [] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe).toEqual([])
  })
})

describe('PendingService.getPending — forward-compatible unknown subjectType', () => {
  it('skips a row whose subjectType this service does not recognise, without throwing', async () => {
    // `subjectId: SENIOR_ID` + a seeded `SENIOR_USER_ROW` deliberately make
    // this row's subject ALSO resolvable as a user: if `buildItemForSubject`
    // ever mis-routed an unrecognised type into the USER_SENIOR_SHARE branch
    // (instead of falling through to its own `return null`), THIS fixture
    // would build a bogus item instead of skipping it — an empty `usersById`
    // would hide that bug, since both the correct fallback AND a wrongly-
    // entered branch with no matching user end in the same `null`.
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'SOME_FUTURE_SUBJECT_TYPE', subjectId: SENIOR_ID }),
    ])
    const db = makeFakeDb({ users: [SENIOR_USER_ROW] })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Integration decision 2 (2026-09-11): a PROJECT_APPROVAL row carries the
// VIEWER'S OWN share — and only theirs. Unit-level twins of
// `pending.integration.spec.ts`'s AC3 deep-JSON cases; they exist here too
// because the mutation gate only ever executes unit specs (see
// .claude/rules/common/mutation-gate-integration-specs.md).
// ---------------------------------------------------------------------------

/** Every primitive leaf of a JSON-serialisable value, flattened. AC3 asserts
 * "this number/name appears NOWHERE in the response" — a field-by-field
 * assertion cannot say that, since a field added later would slip past it. */
function leafValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(leafValues)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(leafValues)
  }
  return [value]
}

describe('PendingService.getPending — PROJECT_APPROVAL viewer share (decision 2)', () => {
  const PROJECT_WITH_BOTH_OVERRIDES = {
    ...ACTIVE_PROJECT_ROW,
    seniorSharePercentOverride: 40 as number | null,
    dropSharePercentOverride: 9 as number | null,
  }

  it('gives a SENIOR viewer their own resolved share and no drop figure or drop name anywhere in the JSON', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'PROJECT', subjectId: PROJECT_ID, approverUserId: SENIOR_ID }),
    ])
    const db = makeFakeDb({
      projects: [PROJECT_WITH_BOTH_OVERRIDES],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW, DROP_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine[0]?.viewerSharePercent).toBe(40)
    expect(result.mine[0]?.seniorName).toBeNull()
    const leaves = leafValues(result)
    expect(leaves).not.toContain(9)
    expect(leaves).not.toContain(7)
    expect(leaves).not.toContain('Drop One')
  })

  it("gives a DROP viewer their own resolved share plus the senior's NAME, and no senior figure anywhere in the JSON", async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'PROJECT', subjectId: PROJECT_ID, approverUserId: DROP_ID }),
    ])
    const db = makeFakeDb({
      projects: [PROJECT_WITH_BOTH_OVERRIDES],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW, DROP_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: DROP_ID, role: 'DROP' } as never)

    expect(result.mine[0]?.viewerSharePercent).toBe(9)
    expect(result.mine[0]?.seniorName).toBe('Senior One')
    const leaves = leafValues(result)
    expect(leaves).not.toContain(40)
    expect(leaves).not.toContain(26)
  })

  it("falls back to the DROP viewer's own default when the project carries no drop override", async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'PROJECT', subjectId: PROJECT_ID, approverUserId: DROP_ID }),
    ])
    const db = makeFakeDb({
      projects: [ACTIVE_PROJECT_ROW],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW, DROP_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: DROP_ID, role: 'DROP' } as never)

    expect(result.mine[0]?.viewerSharePercent).toBe(7)
  })

  it('applies the senior team override when the project has none (same resolver as the project page)', async () => {
    const approvalsService = makeFakeApprovals([
      makeApproval({ subjectType: 'PROJECT', subjectId: PROJECT_ID, approverUserId: SENIOR_ID }),
    ])
    const db = makeFakeDb({
      projects: [ACTIVE_PROJECT_ROW],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW],
      teamMembersWithTeam: [
        { userId: SENIOR_ID, team: { seniorSharePercentOverride: 33, archivedAt: null } },
      ],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: SENIOR_ID, role: 'SENIOR' } as never)

    expect(result.mine[0]?.viewerSharePercent).toBe(33)
  })

  it('gives an ADMIN neither figure on a proposedByMe project row (the widget showed them none either)', async () => {
    const approvalsService = makeFakeApprovals(
      [],
      [
        makeApproval({
          subjectType: 'PROJECT',
          subjectId: PROJECT_ID,
          approverUserId: SENIOR_ID,
          proposedByUserId: ADMIN_ID,
        }),
      ],
    )
    const db = makeFakeDb({
      projects: [PROJECT_WITH_BOTH_OVERRIDES],
      users: [ADMIN_USER_ROW, SENIOR_USER_ROW, DROP_USER_ROW],
    })
    const service = new PendingService(db, approvalsService)

    const result = await service.getPending({ id: ADMIN_ID, role: 'ADMIN' } as never)

    expect(result.proposedByMe[0]?.viewerSharePercent).toBeNull()
    expect(result.proposedByMe[0]?.seniorName).toBeNull()
    const leaves = leafValues(result)
    expect(leaves).not.toContain(40)
    expect(leaves).not.toContain(9)
  })
})
