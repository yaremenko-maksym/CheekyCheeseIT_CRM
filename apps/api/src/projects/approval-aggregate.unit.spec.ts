/**
 * spec-review round 3 (SPEC-H-1, task-project-draft-status). `approveDraft` /
 * `rejectDraft` / the private `applyApprovalAggregate` are the mechanism the
 * whole task exists for — reading the post-write approval aggregate and
 * writing it back to `projects.status` (DRAFT stays DRAFT on partial
 * agreement, flips to ACTIVE once every invited approver confirmed, flips to
 * REJECTED the moment any one declines) — and nothing in the PR before this
 * file called either method with anything but a fully-mocked
 * `ProjectsService` (`projects-draft-controller.unit.spec.ts` proves only
 * controller→service delegation).
 *
 * The mutation gate's own `NoCoverage` report for `projects.service.ts`
 * looked closed because `looksIntegrationOnly()` matched the file's basename
 * against every `*.integration.spec.ts` in this directory (all of them
 * `import { ProjectsService }`) — a false positive per
 * `.claude/rules/common/mutation-gate-integration-specs.md`: none of those
 * integration specs actually calls `approveDraft`/`rejectDraft` (verified by
 * grep across every added/changed spec in the PR). This file closes the
 * REAL gap, at the unit level, mocking `ApprovalsService` (already-tested
 * elsewhere) and exercising the real `ProjectsService`.
 *
 * Three cases, matching `applyApprovalAggregate`'s own doc comment
 * (PENDING/APPROVED/REJECTED aggregate → stays-DRAFT/ACTIVE/REJECTED
 * `projects.status`), each proven red-then-green by breaking the aggregate
 * mapping in `projects.service.ts` and confirming the SPECIFIC test that
 * covers that branch fails (not some unrelated test) — see the coder's
 * final report for the transcript.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalGroupStatus, SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

const SENIOR_ID = 'senior-1'
const DROP_ID = 'drop-1'
const PROJECT_ID = 'proj-1'
// SR-H-5 fixtures (security-review round 2) — the REAL admin's own id, never
// used as `approverUserId`/`proposedByUserId`; it exists only to be distinct
// from SENIOR_ID/DROP_ID so a test that fails to refuse would show up as a
// wrong-actor write, not an accidental id collision.
const REAL_ADMIN_ID = 'admin-real-1'

const CURRENT_SENIOR: SessionUser = {
  id: SENIOR_ID,
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const CURRENT_DROP: SessionUser = {
  id: DROP_ID,
  role: 'DROP',
  displayName: 'Drop',
  email: 'drop@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 0,
}

// SR-H-5: an ADMIN who called `POST /auth/impersonate` and is now playing
// the invited senior/drop — `id`/`role` are the TARGET's (that is the whole
// point of impersonation: `approveInTx`'s "is this an invited approver?"
// check cannot otherwise tell the difference), `impersonatorId` is the real
// admin's own id.
const IMPERSONATING_AS_SENIOR: SessionUser = { ...CURRENT_SENIOR, impersonatorId: REAL_ADMIN_ID }
const IMPERSONATING_AS_DROP: SessionUser = { ...CURRENT_DROP, impersonatorId: REAL_ADMIN_ID }

/** A mutable DRAFT project row — `applyApprovalAggregate`'s tx.update writes
 * back into THIS object, so the test can assert the post-call `.status`
 * directly, the same real end-to-end shape production code produces. */
function draftProjectRow() {
  return {
    id: PROJECT_ID,
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
    status: 'DRAFT' as const,
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

/**
 * `tx.update(projects).set(values).where(...)` — the where predicate is not
 * inspected (this fixture only ever has ONE project row, so it cannot target
 * the wrong one); `.set()`'s VALUES are applied straight onto `projectRow`,
 * the same object `db.query.projects.findFirst` keeps returning afterwards
 * — so a passing test proves the write actually lands, not just that some
 * mock resolved.
 */
function buildService(
  projectRow: ReturnType<typeof draftProjectRow> | undefined,
  aggregate: ApprovalGroupStatus,
) {
  // Exposed (not inline) so the mutation-gate coverage below can assert the
  // call actually happened — `loadTeamOverridesBySenior` short-circuits
  // (`if (seniorIds.length === 0) return map`) BEFORE ever calling this when
  // handed an EMPTY project list, so "was this called at all" is what tells
  // `loadForResponse([project])` apart from a mutant that silently narrowed
  // it to `[]`.
  const teamMembersFindMany = vi.fn(async () => [])
  const db = {
    db: {
      query: {
        // `undefined` (the race-safety test below) simulates the project
        // row having vanished between the transaction and this re-fetch —
        // `loadForResponse` is the ONLY caller of `query.projects.findFirst`
        // reachable from `approveDraft`/`rejectDraft` (the transaction only
        // WRITES via `tx.update`), so this mock's single behaviour models
        // that one call site exactly.
        projects: { findFirst: async () => projectRow },
        teamMembers: { findFirst: async () => null, findMany: teamMembersFindMany },
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
    approveInTx: vi.fn(async () => undefined),
    rejectInTx: vi.fn(async () => undefined),
    getStatusInTx: vi.fn(async () => aggregate),
    // SPEC-M-2 (PR #646 fix-round 1): loadForResponse now unconditionally
    // asks this for every project it returns that is STILL DRAFT — exactly
    // the PENDING-aggregate case this file's own top test is about. Reports
    // the drop as the one still-pending approver (the senior — CURRENT_SENIOR
    // — just approved via THIS call), letting that test assert on the
    // response's booleans instead of only `projectRow.status`.
    getPendingApproverIds: vi.fn(async () => new Map([[PROJECT_ID, new Set([DROP_ID])]])),
  }
  const service = new ProjectsService(
    db as never,
    auditLog as never,
    usersService as never,
    hrAccess,
    approvals as never,
  )
  return { service, approvals, teamMembersFindMany }
}

describe('ProjectsService.approveDraft / rejectDraft — applyApprovalAggregate (SPEC-H-1)', () => {
  it('PENDING aggregate (partial agreement — one of two approvers confirmed) leaves the project DRAFT', async () => {
    const projectRow = draftProjectRow()
    const { service, approvals } = buildService(projectRow, 'PENDING')

    const result = await service.approveDraft(PROJECT_ID, CURRENT_SENIOR)

    expect(approvals.approveInTx).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'PROJECT',
      subjectId: PROJECT_ID,
      approverUserId: SENIOR_ID,
    })
    expect(projectRow.status).toBe('DRAFT')
    expect(result.status).toBe('DRAFT')
    // SPEC-M-2 (PR #646 fix-round 1): the response of the SENIOR's own
    // approve call correctly reports the DROP as the one still pending —
    // this exact response is what `PendingProjectApprovalsPanel`'s
    // dismiss-fix and `ProjectRow`'s pendingCaption both build on.
    expect(result.seniorApprovalPending).toBe(false)
    expect(result.dropApprovalPending).toBe(true)
    // SPEC-M-2: pins the exact call args loadForResponse's own guard makes
    // — mutating `[project.id]` to `[]` in that call must fail this.
    expect(approvals.getPendingApproverIds).toHaveBeenCalledWith('PROJECT', [PROJECT_ID])
  })

  it('APPROVED aggregate (every invited approver confirmed) flips the project to ACTIVE', async () => {
    const projectRow = draftProjectRow()
    const { service, teamMembersFindMany } = buildService(projectRow, 'APPROVED')

    const result = await service.approveDraft(PROJECT_ID, CURRENT_SENIOR)

    expect(projectRow.status).toBe('ACTIVE')
    expect(result.status).toBe('ACTIVE')
    // loadForResponse's re-fetched project (not an empty list) is what
    // feeds loadTeamOverridesBySenior — proves the response actually
    // resolves override data for THIS project's senior, not for nobody.
    expect(teamMembersFindMany).toHaveBeenCalled()
  })

  it('loadForResponse refuses to answer for a project that vanished between the transaction and the re-fetch', async () => {
    // Race safety, not a hypothetical: the transaction that flips DRAFT ->
    // ACTIVE and the SELECT that builds the response are two separate round
    // trips (`loadForResponse` re-reads by id after the transaction
    // commits) — a concurrent hard-delete landing in that window must not
    // surface as a crash or a stale/empty response.
    const { service } = buildService(undefined, 'APPROVED')

    await expect(service.approveDraft(PROJECT_ID, CURRENT_SENIOR)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    await expect(service.approveDraft(PROJECT_ID, CURRENT_SENIOR)).rejects.toThrow(
      'Project not found',
    )
  })

  it('REJECTED aggregate (any one approver declined) flips the project to REJECTED', async () => {
    const projectRow = draftProjectRow()
    const { service, approvals } = buildService(projectRow, 'REJECTED')

    const result = await service.rejectDraft(PROJECT_ID, 'Бюджет не подтверждён', CURRENT_SENIOR)

    expect(approvals.rejectInTx).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'PROJECT',
      subjectId: PROJECT_ID,
      approverUserId: SENIOR_ID,
      reason: 'Бюджет не подтверждён',
    })
    expect(projectRow.status).toBe('REJECTED')
    expect(result.status).toBe('REJECTED')
  })

  it('CONTROL: the ORDINARY (non-impersonated) drop confirmation still works — not just the senior', async () => {
    // SR-H-5's fix reads `currentUser.impersonatorId`, present on EVERY
    // `SessionUser`. This pins that the check does not accidentally also
    // reject a real, non-impersonated DROP session — the other invited
    // approver besides the senior (design spec §3 decision 4, "оба").
    const projectRow = draftProjectRow()
    const { service, approvals, teamMembersFindMany } = buildService(projectRow, 'APPROVED')

    const result = await service.approveDraft(PROJECT_ID, CURRENT_DROP)

    expect(approvals.approveInTx).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'PROJECT',
      subjectId: PROJECT_ID,
      approverUserId: DROP_ID,
    })
    expect(projectRow.status).toBe('ACTIVE')
    expect(result.status).toBe('ACTIVE')
    expect(teamMembersFindMany).toHaveBeenCalled()
  })
})

describe('approveDraft / rejectDraft — impersonation refusal (SR-H-5, security-review round 2)', () => {
  // security-review round 2, SR-H-5: an ADMIN who impersonates the invited
  // senior/drop and calls either endpoint would otherwise write an
  // APPROVED/REJECTED row indistinguishable from that person's own consent
  // — confirmation IS the consent record this task exists to produce, and
  // `approvals` has no column to attribute it to the real operator instead.
  // Both methods refuse OUTRIGHT (before the transaction even opens) rather
  // than record anything.

  it('approveDraft refuses an ADMIN impersonating the invited senior', async () => {
    const projectRow = draftProjectRow()
    const { service, approvals } = buildService(projectRow, 'PENDING')

    await expect(service.approveDraft(PROJECT_ID, IMPERSONATING_AS_SENIOR)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    // The refusal happens BEFORE `approveInTx` — no half-written consent row.
    expect(approvals.approveInTx).not.toHaveBeenCalled()
    expect(projectRow.status).toBe('DRAFT')
  })

  it('rejectDraft refuses the same way — a fabricated rejection reason is the mirror problem', async () => {
    const projectRow = draftProjectRow()
    const { service, approvals } = buildService(projectRow, 'PENDING')

    await expect(
      service.rejectDraft(PROJECT_ID, 'Не согласен', IMPERSONATING_AS_SENIOR),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(approvals.rejectInTx).not.toHaveBeenCalled()
    expect(projectRow.status).toBe('DRAFT')
  })

  it('refuses the identical impersonated call for the invited DROP too, not only the senior', async () => {
    const projectRow = draftProjectRow()
    const { service, approvals } = buildService(projectRow, 'PENDING')

    await expect(service.approveDraft(PROJECT_ID, IMPERSONATING_AS_DROP)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(approvals.approveInTx).not.toHaveBeenCalled()
    expect(projectRow.status).toBe('DRAFT')
  })

  it('refusal message names the actual reason (impersonation), not a generic 403', async () => {
    const projectRow = draftProjectRow()
    const { service } = buildService(projectRow, 'PENDING')

    await expect(service.approveDraft(PROJECT_ID, IMPERSONATING_AS_SENIOR)).rejects.toThrow(
      /impersonat/i,
    )
  })

  it('rejectDraft refusal message also names impersonation, not a generic 403', async () => {
    const projectRow = draftProjectRow()
    const { service } = buildService(projectRow, 'PENDING')

    await expect(
      service.rejectDraft(PROJECT_ID, 'Не согласен', IMPERSONATING_AS_SENIOR),
    ).rejects.toThrow(/impersonat/i)
  })
})
