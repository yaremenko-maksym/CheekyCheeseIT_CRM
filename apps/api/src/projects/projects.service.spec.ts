/**
 * Unit tests for the per-project SENIOR share % override feature.
 *
 * Spec: docs/specs/tasks/task-projects-senior-share-override.md
 *
 * Scenarios covered (AC6):
 *  - HR PATCH со `seniorSharePercentOverride` (любое значение) → 403
 *  - HR PATCH с другими полями (БЕЗ override) → 200, поле projects не трогается
 *  - ADMIN PATCH со `seniorSharePercentOverride: 30` → 200, projects.* и
 *    project_finance_settings синхронизированы
 *  - ACCOUNTANT PATCH со `seniorSharePercentOverride: 35` → 200, синхронизация
 *  - ADMIN PATCH со `seniorSharePercentOverride: null` → projects.* = null,
 *    project_finance_settings.seniorSharePercentOverride = null
 *  - mapProject возвращает seniorSharePercentDefault = senior.seniorSharePercent
 *
 * The "snapshot" behavior of transactions.service.ts is NOT exercised here
 * (covered by the existing finance integration tests + the local Playwright
 * scenario D in projects-senior-share-override.spec.ts).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { HrAccessService } from '../common/hr-access.service'
import { ProjectsService } from './projects.service'
import { projectFinanceSettings, projects } from '../database/schema'

const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const hrUser: SessionUser = {
  id: 'hr-1',
  role: 'HR',
  displayName: 'HR',
  email: 'h@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const accountantUser: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Acc',
  email: 'ac@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const seniorUser: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 's@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

interface ProjectRow {
  id: string
  name: string
  companyName: string
  domain: string
  logoDocumentId: string | null
  logoExternalUrl: string | null
  startDate: Date
  seniorId: string
  rate: number
  currency: string
  seniorSharePercentOverride: number | null
  dropSharePercentOverride?: number | null
  drop?: { id: string; dropSharePercent: number | null } | null
  techStack: string | null
  teamSize: string | null
  benefits: string | null
  paymentType: string | null
  salaryReview: string | null
  corpTech: string | null
  notesGeneral: string | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
  senior?: {
    id: string
    displayName: string
    email: string
    avatarUrl: string | null
    avatarDocumentId: string | null
    role: string
    seniorSharePercent: number
  } | null
  members?: Array<{
    id: string
    userId: string
    joinedAt: Date
    leftAt: Date | null
    user?: {
      id: string
      displayName: string
      email: string
      avatarUrl: string | null
      avatarDocumentId: string | null
      role: string
    } | null
  }>
}

interface FinanceSettingsRow {
  id: string
  projectId: string
  seniorSharePercentOverride: number | null
  juniorSalaryOverride: string | null
  updatedBy: string | null
  updatedAt: Date
}

function buildHarness(initialProject: Partial<ProjectRow> = {}) {
  const projectRow: ProjectRow = {
    id: 'proj-1',
    name: 'Acme Project',
    companyName: 'Acme Corp',
    domain: 'Other',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: 'senior-1',
    rate: 4000,
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
      id: 'senior-1',
      displayName: 'Senior One',
      email: 's@x.com',
      avatarUrl: null,
      role: 'SENIOR',
      seniorSharePercent: 26,
    },
    members: [],
    ...initialProject,
  }
  const financeRows: FinanceSettingsRow[] = []
  let financeInsertCount = 0
  let financeUpdateCount = 0
  const projectUpdateValues: Record<string, unknown>[] = []

  // select() stub for getHrSeniorIds: HR-1 owns the project's senior (senior-1).
  // Call 1: HR teams → [{teamId: 'team-1'}]
  // Call 2: seniors in team → [{userId: 'senior-1'}]
  let _selectCallCount = 0
  const _makeSelectChain = (val: unknown[]) => ({
    from: () => ({
      where: () => Promise.resolve(val),
      innerJoin: () => ({ where: () => Promise.resolve(val) }),
    }),
  })

  const db = {
    db: {
      query: {
        projects: {
          // Return a shallow snapshot so subsequent in-place mutations from
          // `update(projects).set(...)` don't leak back into the captured
          // `project` variable inside the service (mimics real DB read).
          findFirst: async () => ({ ...projectRow }),
        },
        users: {
          findFirst: async () => (projectRow.senior ? { ...projectRow.senior } : null),
        },
        projectFinanceSettings: {
          findFirst: async () => (financeRows[0] ? { ...financeRows[0] } : null),
        },
      },
      // getHrSeniorIds uses select().from().where() / .innerJoin().where()
      // The existing tests use adminUser / accountantUser (no select call) or
      // hrUser whose project.senior.id = 'senior-1' (must be in allowed list).
      select: (_fields: unknown) => {
        _selectCallCount++
        if (_selectCallCount % 2 === 1) {
          return _makeSelectChain([{ teamId: 'team-1' }])
        }
        return _makeSelectChain([{ userId: projectRow.seniorId }])
      },
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (table === projectFinanceSettings) {
              if (financeRows[0]) {
                Object.assign(financeRows[0], values)
                financeUpdateCount++
              }
            } else if (table === projects) {
              projectUpdateValues.push(values)
              Object.assign(projectRow, values)
            }
          },
        }),
      }),
      insert: (_table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          if ('projectId' in values) {
            financeRows.push({
              id: 'fs-1',
              projectId: values['projectId'] as string,
              seniorSharePercentOverride:
                (values['seniorSharePercentOverride'] as number | null) ?? null,
              juniorSalaryOverride: null,
              updatedBy: (values['updatedBy'] as string | null) ?? null,
              updatedAt: new Date(),
            })
            financeInsertCount++
          }
        },
      }),
    },
  }

  const projectAuditLogService = {
    record: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ entries: [], total: 0 })),
  }
  const usersService = {
    unarchive: vi.fn(async () => undefined),
    unarchivePairTx: vi.fn(async () => undefined),
  }

  const service = new ProjectsService(
    db as never,
    projectAuditLogService as never,
    usersService as never,
    new HrAccessService(db as never),
  )

  return {
    service,
    projectRow,
    financeRows,
    projectUpdateValues,
    auditRecord: projectAuditLogService.record,
    getFinanceInsertCount: () => financeInsertCount,
    getFinanceUpdateCount: () => financeUpdateCount,
  }
}

// ---------------------------------------------------------------------------
// RBAC: HR / SENIOR / JUNIOR cannot set the override field
// ---------------------------------------------------------------------------

describe('ProjectsService.update — seniorSharePercentOverride RBAC', () => {
  it('rejects HR PATCH with seniorSharePercentOverride: 30 → ForbiddenException', async () => {
    const h = buildHarness()
    await expect(
      h.service.update('proj-1', { seniorSharePercentOverride: 30 }, hrUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects HR PATCH with seniorSharePercentOverride: null (explicit clear) → ForbiddenException', async () => {
    const h = buildHarness({ seniorSharePercentOverride: 30 })
    await expect(
      h.service.update('proj-1', { seniorSharePercentOverride: null }, hrUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects SENIOR PATCH with seniorSharePercentOverride → ForbiddenException', async () => {
    const h = buildHarness()
    await expect(
      h.service.update('proj-1', { seniorSharePercentOverride: 30 }, seniorUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows HR PATCH WITHOUT seniorSharePercentOverride (other fields) — no override write', async () => {
    const h = buildHarness()
    await h.service.update('proj-1', { rate: 5000 }, hrUser)
    expect(h.projectRow.rate).toBe(5000)
    // No override write should have happened.
    expect(h.projectRow.seniorSharePercentOverride).toBeNull()
    expect(h.getFinanceInsertCount()).toBe(0)
    expect(h.getFinanceUpdateCount()).toBe(0)
  })

  it('allows ADMIN PATCH with seniorSharePercentOverride: 30 — persists on projects + finance_settings', async () => {
    const h = buildHarness()
    await h.service.update('proj-1', { seniorSharePercentOverride: 30 }, adminUser)
    expect(h.projectRow.seniorSharePercentOverride).toBe(30)
    // First write — insert into finance_settings.
    expect(h.getFinanceInsertCount()).toBe(1)
    expect(h.financeRows[0]?.seniorSharePercentOverride).toBe(30)
    expect(h.financeRows[0]?.updatedBy).toBe(adminUser.id)
    // Audit log records the change.
    expect(h.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: adminUser.id,
        targetId: 'proj-1',
        action: 'project_edited',
        changes: expect.objectContaining({
          seniorSharePercentOverride: { before: null, after: 30 },
        }),
      }),
    )
  })

  it('allows ACCOUNTANT PATCH with seniorSharePercentOverride: 35 (only override) — persists', async () => {
    const h = buildHarness()
    await h.service.update('proj-1', { seniorSharePercentOverride: 35 }, accountantUser)
    expect(h.projectRow.seniorSharePercentOverride).toBe(35)
    expect(h.getFinanceInsertCount()).toBe(1)
    expect(h.financeRows[0]?.seniorSharePercentOverride).toBe(35)
    expect(h.financeRows[0]?.updatedBy).toBe(accountantUser.id)
  })

  it('rejects ACCOUNTANT PATCH that also touches other fields (cannot piggyback edits)', async () => {
    const h = buildHarness()
    await expect(
      h.service.update('proj-1', { seniorSharePercentOverride: 35, rate: 9999 }, accountantUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows ADMIN PATCH with seniorSharePercentOverride: null (reset) — projects.* and finance_settings cleared', async () => {
    const h = buildHarness({ seniorSharePercentOverride: 30 })
    // Pre-seed finance_settings so the second update path is exercised.
    h.financeRows.push({
      id: 'fs-1',
      projectId: 'proj-1',
      seniorSharePercentOverride: 30,
      juniorSalaryOverride: null,
      updatedBy: 'admin-1',
      updatedAt: new Date(),
    })
    await h.service.update('proj-1', { seniorSharePercentOverride: null }, adminUser)
    expect(h.projectRow.seniorSharePercentOverride).toBeNull()
    expect(h.getFinanceUpdateCount()).toBe(1)
    expect(h.financeRows[0]?.seniorSharePercentOverride).toBeNull()
    expect(h.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({
          seniorSharePercentOverride: { before: 30, after: null },
        }),
      }),
    )
  })

  it('throws NotFoundException when project does not exist', async () => {
    const h = buildHarness()
    // Override the project lookup to return undefined.
    ;(
      h.service as unknown as {
        db: { db: { query: { projects: { findFirst: () => Promise<undefined> } } } }
      }
    ).db.db.query.projects.findFirst = async () => undefined
    await expect(
      h.service.update('ghost', { seniorSharePercentOverride: 30 }, adminUser),
    ).rejects.toThrow(NotFoundException)
  })

  // -----------------------------------------------------------------------
  // PR #39 round 2: implicit null detection. UI больше не имеет toggle/
  // «Сбросить» — слайдер всегда виден. Когда payload value === senior's
  // эффективному дефолту → backend пишет null (implicit reset).
  // -----------------------------------------------------------------------

  it('implicit-null: ADMIN PATCH с value === senior default (26) → projects.* = null, finance_settings.* = null', async () => {
    const h = buildHarness({ seniorSharePercentOverride: 30 })
    // Pre-seed finance_settings так чтобы exercised update-путь, не insert.
    h.financeRows.push({
      id: 'fs-1',
      projectId: 'proj-1',
      seniorSharePercentOverride: 30,
      juniorSalaryOverride: null,
      updatedBy: 'admin-1',
      updatedAt: new Date(),
    })
    // Senior default = 26 (из default-харности). Слайдер выставлен на 26.
    await h.service.update('proj-1', { seniorSharePercentOverride: 26 }, adminUser)
    // Записалось null, а не 26.
    expect(h.projectRow.seniorSharePercentOverride).toBeNull()
    expect(h.financeRows[0]?.seniorSharePercentOverride).toBeNull()
    // Audit log зафиксировал переход 30 → null (implicit reset), не 30 → 26.
    expect(h.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({
          seniorSharePercentOverride: { before: 30, after: null },
        }),
      }),
    )
  })

  it('implicit-null: ADMIN PATCH с value !== senior default (35) → projects.* = 35, finance_settings.* = 35', async () => {
    const h = buildHarness()
    await h.service.update('proj-1', { seniorSharePercentOverride: 35 }, adminUser)
    // Записалось число (35 ≠ 26), не null.
    expect(h.projectRow.seniorSharePercentOverride).toBe(35)
    expect(h.financeRows[0]?.seniorSharePercentOverride).toBe(35)
    expect(h.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({
          seniorSharePercentOverride: { before: null, after: 35 },
        }),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// task-drop-share-override-and-receiver (AC6): field-scoped RBAC for
// dropSharePercentOverride + paymentType — only ADMIN/ACCOUNTANT may send them.
// ---------------------------------------------------------------------------
describe('ProjectsService.update — dropSharePercentOverride + paymentType field-scoped RBAC', () => {
  it('rejects HR PATCH with dropSharePercentOverride → ForbiddenException', async () => {
    const h = buildHarness()
    await expect(
      h.service.update('proj-1', { dropSharePercentOverride: 12 }, hrUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects HR PATCH with dropSharePercentOverride: null (explicit clear) → ForbiddenException', async () => {
    const h = buildHarness({ dropSharePercentOverride: 12 })
    await expect(
      h.service.update('proj-1', { dropSharePercentOverride: null }, hrUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects SENIOR PATCH with dropSharePercentOverride → ForbiddenException', async () => {
    const h = buildHarness()
    await expect(
      h.service.update('proj-1', { dropSharePercentOverride: 12 }, seniorUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects HR PATCH with paymentType → ForbiddenException', async () => {
    const h = buildHarness()
    await expect(h.service.update('proj-1', { paymentType: 'USDT' }, hrUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('rejects SENIOR PATCH with paymentType → ForbiddenException', async () => {
    const h = buildHarness()
    await expect(
      h.service.update('proj-1', { paymentType: 'GIG_CONTRACT' }, seniorUser),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows ADMIN PATCH with dropSharePercentOverride: 30 — persists on projects.*', async () => {
    const h = buildHarness()
    await h.service.update('proj-1', { dropSharePercentOverride: 30 }, adminUser)
    expect(h.projectRow.dropSharePercentOverride).toBe(30)
    expect(h.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({
          dropSharePercentOverride: { before: null, after: 30 },
        }),
      }),
    )
  })

  it('allows ACCOUNTANT PATCH with ONLY dropSharePercentOverride (finance-scoped) — persists', async () => {
    const h = buildHarness()
    await h.service.update('proj-1', { dropSharePercentOverride: 18 }, accountantUser)
    expect(h.projectRow.dropSharePercentOverride).toBe(18)
  })

  it('allows ACCOUNTANT PATCH with ONLY paymentType (finance-scoped) — persists valid enum', async () => {
    const h = buildHarness()
    await h.service.update('proj-1', { paymentType: 'USDT' }, accountantUser)
    expect(h.projectRow.paymentType).toBe('USDT')
  })

  it('allows ADMIN PATCH with paymentType: GIG_CONTRACT — persists', async () => {
    const h = buildHarness()
    await h.service.update('proj-1', { paymentType: 'GIG_CONTRACT' }, adminUser)
    expect(h.projectRow.paymentType).toBe('GIG_CONTRACT')
  })

  it('rejects an invalid paymentType value from ADMIN → 400 (Zod)', async () => {
    const h = buildHarness()
    await expect(
      h.service.update('proj-1', { paymentType: 'Crypto USDT' }, adminUser),
    ).rejects.toThrow()
  })

  it('rejects ACCOUNTANT PATCH that piggybacks a non-finance field (dropSharePercentOverride + rate)', async () => {
    const h = buildHarness()
    await expect(
      h.service.update('proj-1', { dropSharePercentOverride: 18, rate: 9999 }, accountantUser),
    ).rejects.toThrow(ForbiddenException)
  })
})

// ---------------------------------------------------------------------------
// mapProject DTO shape: seniorSharePercentDefault + seniorSharePercentOverride
// ---------------------------------------------------------------------------

describe('ProjectsService.update — DTO mapping', () => {
  it('returns seniorSharePercentDefault = senior.seniorSharePercent', async () => {
    const h = buildHarness({
      senior: {
        id: 'senior-1',
        displayName: 'Senior One',
        email: 's@x.com',
        avatarUrl: null,
        role: 'SENIOR',
        seniorSharePercent: 40,
      },
    })
    const result = await h.service.update('proj-1', { rate: 7000 }, adminUser)
    expect((result as { seniorSharePercentDefault: number }).seniorSharePercentDefault).toBe(40)
  })

  it('returns seniorSharePercentDefault = 26 fallback when senior is missing', async () => {
    const h = buildHarness({ senior: null })
    const result = await h.service.update('proj-1', { rate: 7000 }, adminUser)
    expect((result as { seniorSharePercentDefault: number }).seniorSharePercentDefault).toBe(26)
  })

  it('returns seniorSharePercentOverride = null when no override is set', async () => {
    const h = buildHarness()
    const result = await h.service.update('proj-1', { rate: 7000 }, adminUser)
    expect(
      (result as { seniorSharePercentOverride: number | null }).seniorSharePercentOverride,
    ).toBeNull()
  })

  it('returns seniorSharePercentOverride = 30 after admin sets it', async () => {
    const h = buildHarness()
    const result = await h.service.update('proj-1', { seniorSharePercentOverride: 30 }, adminUser)
    expect(
      (result as { seniorSharePercentOverride: number | null }).seniorSharePercentOverride,
    ).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// HR cross-team write-IDOR (OWASP A01:2021)
//
// getHrSeniorIds uses raw select chains. We stub db.db.select() to return
// team/senior sets for HR-A (owns team-A / senior-A) and HR-B scenario.
// The helper returns a fluent builder: select().from().where() → rows
// and select().from().innerJoin().where() → rows.
// ---------------------------------------------------------------------------

function buildHrScopingHarness({
  hrId,
  hrSeniorIds,
  projectSeniorId,
}: {
  hrId: string
  hrSeniorIds: string[]
  projectSeniorId: string
}) {
  const hrUserLocal: SessionUser = {
    id: hrId,
    role: 'HR',
    displayName: 'HR User',
    email: `${hrId}@x.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }

  const projectRow: ProjectRow = {
    id: 'proj-target',
    name: 'Target Project',
    companyName: 'Target Corp',
    domain: 'Other',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: projectSeniorId,
    rate: 4000,
    currency: 'USDT',
    seniorSharePercentOverride: null,
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
      id: projectSeniorId,
      displayName: 'Senior B',
      email: `${projectSeniorId}@x.com`,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'SENIOR',
      seniorSharePercent: 26,
    },
    members: [],
  }

  // Stub rows for different query contexts
  const seniorUserRow = {
    id: projectSeniorId,
    role: 'SENIOR' as const,
    displayName: 'Senior B',
    email: `${projectSeniorId}@x.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
    archivedAt: null,
  }
  const juniorUserRow = {
    id: 'junior-1',
    role: 'JUNIOR' as const,
    displayName: 'Junior',
    email: 'j@x.com',
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
    archivedAt: null,
  }

  // Context tracker: create() looks up senior user first, addMember/removeMember look up junior
  // We use a simple flag to distinguish by requested userId (not available in mock where clause).
  // Instead: users.findFirst is called with where(eq(users.id, userId)):
  //   - create() calls it with seniorId → return seniorUserRow
  //   - addMember() calls it with userId (junior-1) → return juniorUserRow
  //   - removeMember() calls it with userId (junior-1) → return juniorUserRow
  // Since the mock doesn't get the actual where arg value, we track by call order per test.
  // A simpler approach: return a different row based on the lastRequestedId tracked via closure.
  let lastUserLookupId = ''
  const usersQueryFindFirst = async (_args: { where: unknown }) => {
    // The service calls: eq(users.id, someId). We can't easily decode the drizzle where
    // object, so we expose a setter that tests can use to prime the expected lookup.
    // Default: if projectSeniorId matches the test context, return seniorUserRow;
    // for junior-1 lookups return juniorUserRow.
    if (lastUserLookupId === 'junior-1') return juniorUserRow
    return seniorUserRow
  }

  // select() builder: first call (HR teams) and second call (seniors in teams)
  // We model this as a chainable fluent object that resolves to arrays.
  let selectCallCount = 0
  const makeSelectChain = (resolveValue: unknown[]) => ({
    from: () => ({
      where: () => Promise.resolve(resolveValue),
      innerJoin: () => ({
        where: () => Promise.resolve(resolveValue),
      }),
    }),
  })

  const db = {
    db: {
      query: {
        projects: {
          findFirst: async () => ({ ...projectRow }),
        },
        users: {
          findFirst: usersQueryFindFirst,
        },
        projectFinanceSettings: {
          findFirst: async () => null,
        },
        projectMembers: {
          findFirst: async () => null,
        },
      },
      // select() is called twice inside getHrSeniorIds:
      //   call 1: get HR's teamIds → [{teamId}]
      //   call 2: get senior userIds in those teams → [{userId}]
      // We use a counter to return the right data per call.
      select: (_fields: unknown) => {
        selectCallCount++
        if (selectCallCount % 2 === 1) {
          // First call: return [{teamId: 'team-a'}] (HR always has a team)
          return makeSelectChain([{ teamId: 'team-a' }])
        } else {
          // Second call: return the senior ids scoped to the HR
          return makeSelectChain(hrSeniorIds.map((id) => ({ userId: id })))
        }
      },
      insert: (_table: unknown) => ({
        values: (_values: unknown) => ({
          // create() uses .returning(); addMember/removeMember do NOT chain .returning()
          returning: async () => [
            {
              id: 'proj-new',
              name: 'Project A',
              companyName: 'A Corp',
              domain: 'Other',
              logoDocumentId: null,
              logoExternalUrl: null,
              startDate: new Date('2026-01-01'),
              seniorId: projectSeniorId,
              dropId: null,
              rate: 3000,
              currency: 'USDT',
              seniorSharePercentOverride: null,
              techStack: null,
              teamSize: null,
              benefits: null,
              paymentType: null,
              salaryReview: null,
              corpTech: null,
              notesGeneral: null,
              archivedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        }),
      }),
      update: (_table: unknown) => ({
        set: (_values: unknown) => ({
          where: async () => undefined,
        }),
      }),
    },
  }

  const projectAuditLogService = {
    record: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ entries: [], total: 0 })),
  }
  const usersService = {
    unarchive: vi.fn(async () => undefined),
    unarchivePairTx: vi.fn(async () => undefined),
  }

  const service = new ProjectsService(
    db as never,
    projectAuditLogService as never,
    usersService as never,
    new HrAccessService(db as never),
  )

  return {
    service,
    hrUserLocal,
    projectRow,
    resetSelectCount: () => {
      selectCallCount = 0
    },
    // Call before addMember/removeMember tests so users.findFirst returns juniorUserRow
    setNextUserLookupAsJunior: () => {
      lastUserLookupId = 'junior-1'
    },
    setNextUserLookupAsSenior: () => {
      lastUserLookupId = ''
    },
  }
}

const HR_A_ID = 'hr-a'
const SENIOR_A_ID = 'senior-a'
const SENIOR_B_ID = 'senior-b'

// ---------------------------------------------------------------------------
// create — HR cross-team scoping
// ---------------------------------------------------------------------------
describe('ProjectsService.create — HR cross-team IDOR protection', () => {
  it('HR-A cannot create project for senior of team-B → ForbiddenException', async () => {
    // HR-A manages only senior-A; project targets senior-B → must be 403
    const { service, hrUserLocal } = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_B_ID,
    })
    await expect(
      service.create(
        {
          name: 'Project B',
          companyName: 'B Corp',
          domain: 'Other',
          startDate: '2026-01-01',
          seniorId: SENIOR_B_ID,
          rate: 3000,
          currency: 'USDT',
        },
        hrUserLocal,
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('HR-A can create project for senior of own team-A → resolves', async () => {
    const { service, hrUserLocal } = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_A_ID,
    })
    // The call will succeed the HR-scoping check and then attempt DB insert.
    // Our mock's insert chain resolves. We expect no ForbiddenException.
    await expect(
      service.create(
        {
          name: 'Project A',
          companyName: 'A Corp',
          domain: 'Other',
          startDate: '2026-01-01',
          seniorId: SENIOR_A_ID,
          rate: 3000,
          currency: 'USDT',
        },
        hrUserLocal,
      ),
    ).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// update — HR cross-team scoping
// ---------------------------------------------------------------------------
describe('ProjectsService.update — HR cross-team IDOR protection', () => {
  it('HR-A cannot update project owned by senior of team-B → ForbiddenException', async () => {
    const { service, hrUserLocal } = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_B_ID,
    })
    await expect(service.update('proj-target', { rate: 9999 }, hrUserLocal)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('HR-A can update project owned by senior of own team-A → resolves', async () => {
    const { service, hrUserLocal } = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_A_ID,
    })
    await expect(service.update('proj-target', { rate: 9999 }, hrUserLocal)).resolves.not.toThrow()
  })

  it('ADMIN can update any project regardless of senior team → resolves', async () => {
    const { service } = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_B_ID,
    })
    // ADMIN user — no HR scoping applies
    await expect(service.update('proj-target', { rate: 5000 }, adminUser)).resolves.not.toThrow()
  })

  it('ACCOUNTANT can update override on any project → resolves', async () => {
    const { service } = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_B_ID,
    })
    await expect(
      service.update('proj-target', { seniorSharePercentOverride: 30 }, accountantUser),
    ).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// addMember — HR cross-team scoping
// ---------------------------------------------------------------------------
describe('ProjectsService.addMember — HR cross-team IDOR protection', () => {
  it('HR-A cannot add member to project owned by senior of team-B → ForbiddenException', async () => {
    const h = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_B_ID,
    })
    h.setNextUserLookupAsJunior()
    await expect(h.service.addMember('proj-target', 'junior-1', h.hrUserLocal)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('HR-A can add member to project owned by senior of own team-A → resolves', async () => {
    const h = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_A_ID,
    })
    h.setNextUserLookupAsJunior()
    await expect(
      h.service.addMember('proj-target', 'junior-1', h.hrUserLocal),
    ).resolves.not.toThrow()
  })

  it('ADMIN can add member to any project → resolves', async () => {
    const h = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_B_ID,
    })
    h.setNextUserLookupAsJunior()
    await expect(h.service.addMember('proj-target', 'junior-1', adminUser)).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// removeMember — HR cross-team scoping
// ---------------------------------------------------------------------------
describe('ProjectsService.removeMember — HR cross-team IDOR protection', () => {
  it('HR-A cannot remove member from project owned by senior of team-B → ForbiddenException', async () => {
    const h = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_B_ID,
    })
    h.setNextUserLookupAsJunior()
    // For removeMember we need an active project member record.
    // Override projectMembers.findFirst to return an active member.
    ;(
      h.service as unknown as {
        db: {
          db: {
            query: {
              projectMembers: {
                findFirst: () => Promise<{
                  id: 'pm-1'
                  projectId: 'proj-target'
                  userId: 'junior-1'
                  leftAt: null
                }>
              }
            }
          }
        }
      }
    ).db.db.query.projectMembers.findFirst = async () => ({
      id: 'pm-1',
      projectId: 'proj-target',
      userId: 'junior-1',
      leftAt: null,
    })
    await expect(h.service.removeMember('proj-target', 'junior-1', h.hrUserLocal)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('HR-A can remove member from project owned by senior of own team-A → resolves', async () => {
    const h = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_A_ID,
    })
    h.setNextUserLookupAsJunior()
    ;(
      h.service as unknown as {
        db: {
          db: {
            query: {
              projectMembers: {
                findFirst: () => Promise<{
                  id: 'pm-1'
                  projectId: 'proj-target'
                  userId: 'junior-1'
                  leftAt: null
                }>
              }
            }
          }
        }
      }
    ).db.db.query.projectMembers.findFirst = async () => ({
      id: 'pm-1',
      projectId: 'proj-target',
      userId: 'junior-1',
      leftAt: null,
    })
    await expect(
      h.service.removeMember('proj-target', 'junior-1', h.hrUserLocal),
    ).resolves.not.toThrow()
  })

  it('ADMIN can remove member from any project → resolves', async () => {
    const h = buildHrScopingHarness({
      hrId: HR_A_ID,
      hrSeniorIds: [SENIOR_A_ID],
      projectSeniorId: SENIOR_B_ID,
    })
    ;(
      h.service as unknown as {
        db: {
          db: {
            query: {
              projectMembers: {
                findFirst: () => Promise<{
                  id: 'pm-1'
                  projectId: 'proj-target'
                  userId: 'junior-1'
                  leftAt: null
                }>
              }
            }
          }
        }
      }
    ).db.db.query.projectMembers.findFirst = async () => ({
      id: 'pm-1',
      projectId: 'proj-target',
      userId: 'junior-1',
      leftAt: null,
    })
    await expect(
      h.service.removeMember('proj-target', 'junior-1', adminUser),
    ).resolves.not.toThrow()
  })
})
