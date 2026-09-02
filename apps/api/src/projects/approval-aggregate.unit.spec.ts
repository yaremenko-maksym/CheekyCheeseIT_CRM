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
import { NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalGroupStatus, SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

const SENIOR_ID = 'senior-1'
const DROP_ID = 'drop-1'
const PROJECT_ID = 'proj-1'

const CURRENT_SENIOR: SessionUser = {
  id: SENIOR_ID,
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

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
})
