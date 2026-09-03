/**
 * Unit tests for AC5 (task-project-draft-status, item 4 + decision Д1):
 * "Черновик невидим всем, кроме админа и подтверждающих." One test per role
 * in `ADMIN | SENIOR | JUNIOR | HR | ACCOUNTANT` + DROP, on a DRAFT project —
 * ADMIN and an INVITED SENIOR/DROP see it, everyone else (including a
 * SENIOR/DROP who was never invited, and ACCOUNTANT — who otherwise has
 * unconditional access to every ACTIVE project) gets 404, never 403 (see
 * `assertAccess`'s own comment for the existence-oracle reasoning this
 * mirrors from `transaction-visibility.util.ts`).
 *
 * `assertAccess` runs BEFORE any of the pre-existing per-role branches when
 * `project.status !== 'ACTIVE'`, so a single representative case per role
 * is a structural proof, not a sampled one — see that method's own comment.
 */
import { NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

const SENIOR_ID = 'senior-invited'
const OTHER_SENIOR_ID = 'senior-not-invited'
const DROP_ID = 'drop-invited'
const ADMIN_ID = 'admin-1'
const HR_ID = 'hr-1'
const JUNIOR_ID = 'junior-1'
const ACCOUNTANT_ID = 'accountant-1'
const PROJECT_ID = 'draft-proj-1'

function draftProject() {
  return {
    id: PROJECT_ID,
    name: 'Still unconfirmed',
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

/** invitedIds: the set of userIds `approvals.isApprover` reports as invited for this project. */
function buildService(invitedIds: Set<string>) {
  const db = {
    db: {
      query: {
        projects: {
          findFirst: async () => draftProject(),
          findMany: async () => [draftProject()],
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
    isApprover: vi.fn(async (_subjectType: string, _subjectId: string, userId: string) =>
      invitedIds.has(userId),
    ),
    listSubjectIdsForApprover: vi.fn(async (_subjectType: string, userId: string) =>
      invitedIds.has(userId) ? new Set([PROJECT_ID]) : new Set<string>(),
    ),
    // SPEC-M-2 (PR #646 fix-round 1): findAll/findOne now unconditionally
    // call this for every DRAFT project in scope — this file's fixtures
    // ARE drafts, so the stub is required, not just completeness. Returns
    // empty (no entry) for every id: this file's own AC5 concern is
    // visibility, not the caption text, so "nobody pending" is a safe,
    // unopinionated default that doesn't assert anything this suite isn't
    // about.
    getPendingApproverIds: vi.fn(async () => new Map<string, Set<string>>()),
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

describe('AC5 — draft project visibility (findOne/assertAccess)', () => {
  const invited = new Set([SENIOR_ID, DROP_ID])

  it('ADMIN sees the draft', async () => {
    const { service } = buildService(invited)
    const result = await service.findOne(PROJECT_ID, sessionFor(ADMIN_ID, 'ADMIN'))
    expect(result.id).toBe(PROJECT_ID)
  })

  it('the invited SENIOR (project.seniorId, an approver) sees the draft', async () => {
    const { service } = buildService(invited)
    const result = await service.findOne(PROJECT_ID, sessionFor(SENIOR_ID, 'SENIOR'))
    expect(result.id).toBe(PROJECT_ID)
  })

  it('the invited DROP (project.dropId, an approver) sees the draft', async () => {
    const { service } = buildService(invited)
    const result = await service.findOne(PROJECT_ID, sessionFor(DROP_ID, 'DROP'))
    expect(result.id).toBe(PROJECT_ID)
  })

  it('a SENIOR who was never invited gets 404, not 403 (existence-oracle)', async () => {
    const { service } = buildService(invited)
    await expect(
      service.findOne(PROJECT_ID, sessionFor(OTHER_SENIOR_ID, 'SENIOR')),
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(
      service.findOne(PROJECT_ID, sessionFor(OTHER_SENIOR_ID, 'SENIOR')),
    ).rejects.toThrow('Project not found')
  })

  it('JUNIOR gets 404', async () => {
    const { service } = buildService(invited)
    await expect(
      service.findOne(PROJECT_ID, sessionFor(JUNIOR_ID, 'JUNIOR')),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('HR gets 404 (even though HR would otherwise manage this senior once ACTIVE)', async () => {
    const { service } = buildService(invited)
    await expect(service.findOne(PROJECT_ID, sessionFor(HR_ID, 'HR'))).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('ACCOUNTANT gets 404 — NOT the unconditional access ACCOUNTANT has on an ACTIVE project', async () => {
    const { service } = buildService(invited)
    await expect(
      service.findOne(PROJECT_ID, sessionFor(ACCOUNTANT_ID, 'ACCOUNTANT')),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('AC5 — draft project visibility (findAll)', () => {
  const invited = new Set([SENIOR_ID, DROP_ID])

  it('ACCOUNTANT does not see the draft in the list either', async () => {
    const { service } = buildService(invited)
    const result = await service.findAll(sessionFor(ACCOUNTANT_ID, 'ACCOUNTANT'), {
      archived: false,
    })
    expect(result.map((p) => p.id)).not.toContain(PROJECT_ID)
  })

  it('the invited SENIOR sees their own draft in the list', async () => {
    const { service } = buildService(invited)
    const result = await service.findAll(sessionFor(SENIOR_ID, 'SENIOR'), { archived: false })
    expect(result.map((p) => p.id)).toContain(PROJECT_ID)
  })

  it('ADMIN sees the draft AND the pre-filter never even queries approvals for ADMIN', async () => {
    // Pins `if (currentUser.role !== 'ADMIN')` itself, not just its outcome —
    // an ADMIN is not just exempt from the filter's RESULT, the filter must
    // never call `listSubjectIdsForApprover` at all for an ADMIN caller.
    const { service, approvals } = buildService(invited)
    const result = await service.findAll(sessionFor(ADMIN_ID, 'ADMIN'), { archived: false })
    expect(result.map((p) => p.id)).toContain(PROJECT_ID)
    expect(approvals.listSubjectIdsForApprover).not.toHaveBeenCalled()
  })

  it('the listSubjectIdsForApprover call uses subjectType PROJECT specifically', async () => {
    const { service, approvals } = buildService(invited)
    await service.findAll(sessionFor(SENIOR_ID, 'SENIOR'), { archived: false })
    expect(approvals.listSubjectIdsForApprover).toHaveBeenCalledWith('PROJECT', SENIOR_ID)
  })
})
