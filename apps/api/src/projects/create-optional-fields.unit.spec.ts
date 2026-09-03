/**
 * Unit tests pinning `ProjectsService.create()`'s optional-field mapping —
 * PRE-EXISTING logic (verified against `origin/main`, byte-identical) that
 * task-project-draft-status only RELOCATED inside a new `db.transaction(...)`
 * wrapper (Д1 — the insert and the approvals proposal must commit together).
 * Never covered by a dedicated assertion before this file: the mutation gate
 * flagged 14 survivors here once the relocation made these lines "changed"
 * for the first time. Captures the REAL argument passed to `.values(...)`
 * (the existing `buildHrScopingHarness` mock in projects.service.spec.ts
 * ignores it and always returns a canned row, which is why none of these
 * mutants were ever caught) — one assertion per optional field, covering
 * BOTH "provided" and "omitted" for each `?? null` / `&&... null` /
 * ternary-spread the create payload uses.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CreateProjectDto, SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'

const ADMIN: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const SENIOR_ID = 'senior-1'

const MINIMAL_DTO: CreateProjectDto = {
  name: 'Proj',
  companyName: 'Co',
  domain: 'Other',
  startDate: '2026-01-01T00:00:00.000Z',
  seniorId: SENIOR_ID,
  rate: 1000,
  currency: 'USDT',
}

function buildHarness() {
  let capturedValues: Record<string, unknown> | undefined
  const db = {
    db: {
      query: {
        users: { findFirst: async () => ({ id: SENIOR_ID, role: 'SENIOR', archivedAt: null }) },
        documents: {
          findFirst: async () => ({
            id: 'doc-1',
            category: 'LOGO',
            deletedAt: null,
            projectId: null,
          }),
        },
        projects: {
          findFirst: async () => ({
            id: 'proj-new',
            status: 'DRAFT',
            senior: null,
            drop: null,
            members: [],
            legend: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            startDate: new Date(),
          }),
        },
      },
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
        fn({
          insert: (_table: unknown) => ({
            values: (values: Record<string, unknown>) => {
              capturedValues = values
              return { returning: async () => [{ id: 'proj-new', ...values }] }
            },
          }),
        }),
    },
  }
  const auditLog = { record: vi.fn(async () => undefined) }
  const usersService = {}
  const hrAccess = new HrAccessService(db as never)
  const approvals = { proposeInTx: vi.fn(async () => undefined) }
  const service = new ProjectsService(
    db as never,
    auditLog as never,
    usersService as never,
    hrAccess,
    approvals as never,
  )
  return { service, approvals, getCapturedValues: () => capturedValues }
}

describe('ProjectsService.create — optional field mapping (pre-existing, relocated by Д1)', () => {
  it('omitted optional fields all map to null, and paymentType is OMITTED (not null) from the insert', async () => {
    const { service, getCapturedValues } = buildHarness()
    await service.create(MINIMAL_DTO, ADMIN)
    const values = getCapturedValues()!
    expect(values['logoDocumentId']).toBeNull()
    expect(values['logoExternalUrl']).toBeNull()
    expect(values['techStack']).toBeNull()
    expect(values['teamSize']).toBeNull()
    expect(values['benefits']).toBeNull()
    expect(values['salaryReview']).toBeNull()
    expect(values['corpTech']).toBeNull()
    expect(values['notesGeneral']).toBeNull()
    // Omitted so the column DEFAULT ('FOP') applies — the key must be ABSENT,
    // not present-with-null (a NULL would override the DEFAULT and violate
    // the NOT NULL column).
    expect('paymentType' in values).toBe(false)
  })

  it('provided optional fields pass through verbatim, including paymentType', async () => {
    const { service, getCapturedValues } = buildHarness()
    await service.create(
      {
        ...MINIMAL_DTO,
        logoDocumentId: 'doc-1',
        logoExternalUrl: null,
        techStack: 'TypeScript',
        teamSize: '5',
        benefits: 'Remote',
        salaryReview: 'Annual',
        corpTech: 'Slack',
        notesGeneral: 'Notes',
        paymentType: 'USDT',
      },
      ADMIN,
    )
    const values = getCapturedValues()!
    expect(values['logoDocumentId']).toBe('doc-1')
    expect(values['techStack']).toBe('TypeScript')
    expect(values['teamSize']).toBe('5')
    expect(values['benefits']).toBe('Remote')
    expect(values['salaryReview']).toBe('Annual')
    expect(values['corpTech']).toBe('Slack')
    expect(values['notesGeneral']).toBe('Notes')
    expect(values['paymentType']).toBe('USDT')
  })

  it('every new project starts DRAFT, regardless of who creates it', async () => {
    const { service, getCapturedValues } = buildHarness()
    await service.create(MINIMAL_DTO, ADMIN)
    expect(getCapturedValues()!['status']).toBe('DRAFT')
  })

  it('Д1: the approval is proposed to exactly [seniorId] when there is no drop', async () => {
    const { service, approvals } = buildHarness()
    await service.create(MINIMAL_DTO, ADMIN)
    expect(approvals.proposeInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approverUserIds: [SENIOR_ID] }),
    )
  })
})
