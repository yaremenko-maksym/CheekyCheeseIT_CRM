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
 *
 * SR-M-5 (PR #646 fix-round 2): on TOP of all three call sites above,
 * `mapProject` itself gates the final text to `viewerRole === 'ADMIN'` —
 * design spec §1/§2/§6 name ADMIN as the only audience for the reason text,
 * narrower than "is this project visible to me at all" (an invited approver
 * legitimately sees their own REJECTED project's STATUS, never the reason,
 * which may have been authored by the OTHER invited approver whose
 * identity is otherwise masked from them). No special case for "it is MY
 * OWN reason, I just wrote it" — `rejectDraft`'s own actor gets `null` back
 * too, same as anyone else who is not ADMIN.
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

  it('SR-M-5 (PR #646 fix-round 2): findOne — the invited SENIOR sees the project (assertAccess passes) but NOT the reason text — rejectionReason is ADMIN-only, narrower than the visibility gate', async () => {
    const { service } = buildService([rejectedProject()])
    const result = await service.findOne(PROJECT_ID, sessionFor(SENIOR_ID, 'SENIOR'))
    // The project itself IS visible (design spec: an invited approver sees
    // their own REJECTED project's status) — only the free-text reason,
    // possibly authored by the OTHER invited approver, is withheld.
    expect(result.status).toBe('REJECTED')
    expect(result.rejectionReason).toBeNull()
  })

  it('SR-M-5: findOne — ADMIN still sees the reason (the one audience the design spec names)', async () => {
    const { service } = buildService([rejectedProject()])
    const result = await service.findOne(PROJECT_ID, sessionFor(ADMIN_ID, 'ADMIN'))
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

// SR-M-3 (PR #646 fix-round 1). Every test above sets isApprover -> true and
// listSubjectIdsForApprover -> every project id, unconditionally — the exact
// gate that keeps rejectionReason from reaching a non-approver is disabled
// in all of them. A regression that leaked the reason past that gate would
// pass every test above and still be a real leak. These tests turn the gate
// back on (isApprover -> false, listSubjectIdsForApprover -> empty) and
// prove the reason genuinely cannot be reached — not just that the field
// happens to read null, but that the REJECTED project is invisible at all,
// same as `draft-visibility.unit.spec.ts`'s own AC5 coverage, specifically
// for the path this field's own tests were blind to.
describe('ProjectsService — rejectionReason genuinely gated behind visibility, not just null-by-default (SR-M-3)', () => {
  function buildServiceWithNoApprovers(projectRows: ReturnType<typeof rejectedProject>[]) {
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
      // The gate turned ON: nobody is an approver, nobody was ever invited.
      isApprover: vi.fn(async () => false),
      listSubjectIdsForApprover: vi.fn(async () => new Set<string>()),
      getRejectionReasons: vi.fn(async (_subjectType: string, ids: string[]) => {
        const map = new Map<string, string>()
        if (ids.includes(PROJECT_ID)) map.set(PROJECT_ID, 'Бюджет не подтверждён')
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

  it('findAll: a non-ADMIN, non-invited viewer (HR) never sees the REJECTED project at all — not present in the result, not just rejectionReason: null', async () => {
    const { service } = buildServiceWithNoApprovers([rejectedProject()])

    const result = await service.findAll(sessionFor('hr-1', 'HR'), { archived: false })

    expect(result.find((p) => p.id === PROJECT_ID)).toBeUndefined()
  })

  it('findAll: getRejectionReasons is never even called for a non-invited viewer — the project is filtered out BEFORE the batch lookup runs, not after', async () => {
    const { service, approvals } = buildServiceWithNoApprovers([rejectedProject()])

    await service.findAll(sessionFor('hr-1', 'HR'), { archived: false })

    expect(approvals.getRejectionReasons).not.toHaveBeenCalled()
  })

  it('findOne: a non-ADMIN, non-invited viewer gets 404 (existence-oracle-safe), not a project with rejectionReason: null', async () => {
    const { service } = buildServiceWithNoApprovers([rejectedProject()])

    await expect(service.findOne(PROJECT_ID, sessionFor('hr-1', 'HR'))).rejects.toThrow(
      'Project not found',
    )
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

  it('SR-M-5 (PR #646 fix-round 2): the response status flips to REJECTED, but rejectionReason is null — the actor who JUST wrote the reason is SENIOR/DROP, never ADMIN, so mapProject\'s ADMIN-only gate applies to them too, no special case for "it is my own reason"', async () => {
    const projectRow = { ...rejectedProject(), status: 'DRAFT' as const }
    const { service } = buildService(projectRow)

    const result = await service.rejectDraft(
      PROJECT_ID,
      'Бюджет не подтверждён',
      sessionFor(SENIOR_ID, 'SENIOR'),
    )

    expect(result.status).toBe('REJECTED')
    expect(result.rejectionReason).toBeNull()
  })

  it("mutation-gate (projects.service.ts:1068): the single-entry Map built from the reason this call just wrote is what loadForResponse actually reads — an ADMIN-role viewer (mechanism check: SR-M-5's ADMIN-only gate does NOT apply here, so a correctly- vs incorrectly-populated Map is finally observable) sees the EXACT reason text back, proving the Map, not an empty fallback, reached mapProject", async () => {
    const projectRow = { ...rejectedProject(), status: 'DRAFT' as const }
    const { service } = buildService(projectRow)

    // ADMIN never actually calls rejectDraft as the deciding approver in
    // production (rejectInTx would refuse a non-invited caller on a real
    // DB) — this test's `approvals.rejectInTx` is mocked and accepts any
    // caller, which is exactly what makes it a clean mechanism check: does
    // `new Map([[id, reason]])` (projects.service.ts:1068) actually reach
    // `mapProject` intact? A Stryker `ArrayDeclaration` mutant emptying that
    // Map (`new Map([])` or the malformed `new Map([[]])`) is invisible to
    // the SR-M-5 test above (SENIOR/DROP get null either way), but NOT to
    // an ADMIN viewer, who passes the ADMIN-only gate and would see
    // `undefined` instead of the real text if the Map lookup missed.
    const result = await service.rejectDraft(
      PROJECT_ID,
      'Бюджет не подтверждён',
      sessionFor(ADMIN_ID, 'ADMIN'),
    )

    expect(result.status).toBe('REJECTED')
    expect(result.rejectionReason).toBe('Бюджет не подтверждён')
  })
})

// CR-M-1 (PR #646 fix-round 1): update() was the one call site of the five
// (findAll/findOne/create/loadForResponse/update) that did NOT enrich
// rejectionReason — reachable because ProjectRow's row-Link is unconditional
// for a REJECTED project (same as ARCHIVED), so a REJECTED project can be
// PATCHed, and the PATCH response silently answered `rejectionReason: null`
// for the one status AC4 requires it on. Mirrors findOne's own guarded
// batch-lookup exactly.
describe('ProjectsService.update — rejectionReason on the response (CR-M-1, PR #646 fix-round 1)', () => {
  function buildService(projectRow: ReturnType<typeof rejectedProject>) {
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
    const usersService = {}
    const hrAccess = new HrAccessService(db as never)
    const approvals = {
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

  it('ADMIN patches a REJECTED project (e.g. a display-only field) — the response still carries rejectionReason', async () => {
    const { service } = buildService(rejectedProject())

    const result = await service.update(
      PROJECT_ID,
      { name: 'Renamed after rejection' },
      sessionFor(ADMIN_ID, 'ADMIN'),
    )

    expect(result.status).toBe('REJECTED')
    expect(result.rejectionReason).toBe('Бюджет не подтверждён')
  })

  it('getRejectionReasons is never called when the patched project is not REJECTED (same guard as findOne)', async () => {
    const { service, approvals } = buildService({ ...rejectedProject(), status: 'ACTIVE' as const })

    await service.update(PROJECT_ID, { name: 'Renamed' }, sessionFor(ADMIN_ID, 'ADMIN'))

    expect(approvals.getRejectionReasons).not.toHaveBeenCalled()
  })

  // SR-H-1 (PR #646 fix-round 2, HIGH). update() never called assertAccess —
  // HR/ACCOUNTANT could PATCH a field they are allowed to touch (e.g. name)
  // on a REJECTED project they can never GET (findOne 404s them on the same
  // project) and get the full rejectionReason text back in the PATCH
  // response. Proven here the same way the finding itself proved it:
  // findOne 404s, THEN update on the identical project/viewer pair must
  // ALSO refuse — not just omit the reason, refuse the whole write, same as
  // a caller who cannot even see the row.
  function buildServiceWithAccessGate(
    projectRow: ReturnType<typeof rejectedProject>,
    opts: { isApprover: boolean },
  ) {
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
      isApprover: vi.fn(async () => opts.isApprover),
      getRejectionReasons: vi.fn(async () => new Map([[PROJECT_ID, 'Бюджет не подтверждён']])),
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

  it('SR-H-1: HR patching a REJECTED project they are not invited on gets 404 — same as findOne, not a 200 with the field merely blank', async () => {
    const { service } = buildServiceWithAccessGate(rejectedProject(), { isApprover: false })

    await expect(
      service.update(PROJECT_ID, { name: 'Sneaky rename' }, sessionFor('hr-1', 'HR')),
    ).rejects.toThrow('Project not found')
  })

  it('SR-H-1: ACCOUNTANT patching ONLY finance-scoped fields (the branch that skips assertHrCanManageProject) still gets 404 on a REJECTED project they are not invited on — assertAccess runs regardless of which fields are touched', async () => {
    const { service } = buildServiceWithAccessGate(rejectedProject(), { isApprover: false })

    await expect(
      service.update(
        PROJECT_ID,
        { seniorSharePercentOverride: 30 },
        sessionFor('accountant-1', 'ACCOUNTANT'),
      ),
    ).rejects.toThrow('Project not found')
  })

  it("SR-H-1 defense-in-depth: even if update() authorization is ever loosened so a non-ADMIN caller CAN pass assertAccess on a REJECTED project (isApprover: true), the response still never carries rejectionReason — SR-M-5's ADMIN-only gate is independent of, not redundant with, the assertAccess gate", async () => {
    // ACCOUNTANT doing a finance-scoped-only patch is the one non-ADMIN
    // path that skips assertHrCanManageProject and reaches assertAccess
    // directly — poisoning isApprover to true here (unreachable in the
    // real domain model today, since only SENIOR/DROP are ever assigned as
    // approvers) proves SR-M-5's gate does not silently rely on "nobody
    // non-ADMIN ever gets this far" being true forever.
    const { service } = buildServiceWithAccessGate(rejectedProject(), { isApprover: true })

    // paymentType (not seniorSharePercentOverride) — still finance-scoped
    // (satisfies ACCOUNTANT's hasOnlyOverride gate) but avoids
    // syncFinanceSettingsOverride's own DB dependency, which this focused
    // mock does not stub.
    const result = await service.update(
      PROJECT_ID,
      { paymentType: 'FOP' },
      sessionFor('accountant-1', 'ACCOUNTANT'),
    )

    expect(result.status).toBe('REJECTED')
    expect(result.rejectionReason).toBeNull()
  })
})
