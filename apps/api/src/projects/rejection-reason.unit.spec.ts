/**
 * Unit tests for task-project-status-filter-ui's `rejectionReason` DTO field
 * — AC4 ("причина отказа... рендерится") needs the text somewhere on the
 * wire, and `approvals.rejectionReason` (the only place it is ever written,
 * see `ApprovalsService.rejectInTx`) was not previously projected onto
 * `ProjectDto` at all.
 *
 * Three call sites read it differently, on purpose — see each method's own
 * comment in `projects.service.ts`:
 *   - `findAll`/`findOne` — batch-query `ApprovalsService.getRejectionReasons`,
 *     but ONLY when the result actually contains a REJECTED project (proven
 *     below as a call-count assertion, not just an output assertion — this
 *     is the exact guard whose absence broke five unrelated spec files
 *     during development, see the coder's final report).
 *   - `rejectDraft` — passes the reason it already has in scope straight
 *     through `loadForResponse`, WITHOUT calling `getRejectionReasons` at
 *     all.
 *   - `approveDraft` — never populates the field (a project it just
 *     approved is never REJECTED).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

const SENIOR_ID = 'senior-1'
const DROP_ID = 'drop-1'
const ADMIN_ID = 'admin-1'
const PROJECT_ID = 'rejected-proj-1'
const OTHER_ACTIVE_PROJECT_ID = 'active-proj-1'

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

function rejectedProject() {
  return { ...baseProjectFields(), id: PROJECT_ID, status: 'REJECTED' as const }
}

function activeProject() {
  return {
    ...baseProjectFields(),
    id: OTHER_ACTIVE_PROJECT_ID,
    status: 'ACTIVE' as const,
    seniorId: SENIOR_ID,
    dropId: null,
    drop: null,
  }
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

describe('ProjectsService — rejectionReason on findAll/findOne (task-project-status-filter-ui)', () => {
  function buildService(projectRows: ReturnType<typeof rejectedProject>[]) {
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
    const usersService = {}
    const hrAccess = new HrAccessService(db as never)
    const approvals = {
      isApprover: vi.fn(async () => true),
      listSubjectIdsForApprover: vi.fn(async () => new Set(projectRows.map((p) => p.id))),
      getRejectionReasons: vi.fn(async (_subjectType: string, ids: string[]) => {
        const map = new Map<string, string>()
        if (ids.includes(PROJECT_ID)) map.set(PROJECT_ID, 'Бюджет не подтверждён')
        return map
      }),
    }
    const service = new ProjectsService(
      db as never,
      auditLog as never,
      usersService as never,
      hrAccess,
      approvals as never,
    )
    return { service, approvals }
  }

  it('findAll: ADMIN sees rejectionReason on the REJECTED project', async () => {
    const { service } = buildService([rejectedProject()])
    const result = await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })
    const project = result.find((p) => p.id === PROJECT_ID)
    expect(project?.rejectionReason).toBe('Бюджет не подтверждён')
  })

  it('findAll: an ACTIVE project in the SAME list never gets a rejectionReason', async () => {
    const { service } = buildService([rejectedProject(), activeProject()])
    const result = await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })
    const project = result.find((p) => p.id === OTHER_ACTIVE_PROJECT_ID)
    expect(project?.rejectionReason).toBeNull()
  })

  it('findAll: getRejectionReasons is never called when the filtered list has no REJECTED project (the guard that broke 5 unrelated spec files when missing)', async () => {
    const { service, approvals } = buildService([activeProject()])
    await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })
    expect(approvals.getRejectionReasons).not.toHaveBeenCalled()
  })

  it('findOne: the invited SENIOR sees the reason on their own rejected project', async () => {
    const { service } = buildService([rejectedProject()])
    const result = await service.findOne(PROJECT_ID, sessionFor(SENIOR_ID, 'SENIOR'))
    expect(result.rejectionReason).toBe('Бюджет не подтверждён')
  })

  it('findOne: getRejectionReasons is never called for a project that is not REJECTED', async () => {
    const { service, approvals } = buildService([activeProject()])
    await service.findOne(OTHER_ACTIVE_PROJECT_ID, sessionFor(ADMIN_ID, 'ADMIN'))
    expect(approvals.getRejectionReasons).not.toHaveBeenCalled()
  })

  it('findAll: an entry in the reasons map for a NON-rejected project id is still not surfaced — the status gate is what decides, not map membership', async () => {
    // Deliberately stocks the map with an entry for the ACTIVE project's id
    // too (something `getRejectionReasons` would never legitimately do,
    // since `findAll` only ever asks it about REJECTED ids) — proves
    // `mapProject`'s `project.status === 'REJECTED'` check is load-bearing
    // on its own, not merely redundant with "absent from the map".
    const projectRows = [rejectedProject(), activeProject()]
    const db = {
      db: {
        query: {
          projects: { findFirst: async () => projectRows[0], findMany: async () => projectRows },
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
      getRejectionReasons: vi.fn(
        async () =>
          new Map([
            [PROJECT_ID, 'Бюджет не подтверждён'],
            [OTHER_ACTIVE_PROJECT_ID, 'should never surface — project is ACTIVE'],
          ]),
      ),
    }
    const service = new ProjectsService(
      db as never,
      auditLog as never,
      {} as never,
      hrAccess,
      approvals as never,
    )

    const result = await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })

    expect(result.find((p) => p.id === PROJECT_ID)?.rejectionReason).toBe('Бюджет не подтверждён')
    expect(result.find((p) => p.id === OTHER_ACTIVE_PROJECT_ID)?.rejectionReason).toBeNull()
  })
})

describe('ProjectsService.rejectDraft — rejectionReason on the response (task-project-status-filter-ui)', () => {
  function buildService(projectRow: ReturnType<typeof rejectedProject> | undefined) {
    const db = {
      db: {
        query: {
          projects: { findFirst: async () => projectRow },
          teamMembers: { findFirst: async () => null, findMany: async () => [] },
        },
        transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
          const tx = {
            update: (_table: unknown) => ({
              set: (values: Record<string, unknown>) => ({
                where: (_expr: unknown) => {
                  if (projectRow) Object.assign(projectRow, values)
                  return Promise.resolve()
                },
              }),
            }),
          }
          return fn(tx)
        },
      },
    }
    const auditLog = { record: vi.fn(async () => undefined) }
    const usersService = {}
    const hrAccess = new HrAccessService(db as never)
    const approvals = {
      rejectInTx: vi.fn(async () => undefined),
      getStatusInTx: vi.fn(async () => 'REJECTED' as const),
      // Deliberately absent: `getRejectionReasons`. If `rejectDraft` ever
      // starts calling it (instead of passing the known reason straight
      // through), this mock throws `is not a function` — the test fails
      // loudly rather than the assertion below just happening to still pass.
    }
    const service = new ProjectsService(
      db as never,
      auditLog as never,
      usersService as never,
      hrAccess,
      approvals as never,
    )
    return { service }
  }

  it('the response carries the SAME reason string just passed in, with no extra approvals query', async () => {
    const projectRow = { ...rejectedProject(), status: 'DRAFT' as const }
    const { service } = buildService(projectRow)

    const result = await service.rejectDraft(
      PROJECT_ID,
      'Бюджет не подтверждён',
      sessionFor(SENIOR_ID, 'SENIOR'),
    )

    expect(result.status).toBe('REJECTED')
    expect(result.rejectionReason).toBe('Бюджет не подтверждён')
  })
})
