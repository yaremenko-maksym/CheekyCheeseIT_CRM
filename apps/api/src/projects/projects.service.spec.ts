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
import { ProjectsService } from './projects.service'
import { projectFinanceSettings, projects } from '../database/schema'

const adminUser: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatar: null,
  seniorSharePercent: 26,
}
const hrUser: SessionUser = {
  id: 'hr-1',
  role: 'HR',
  displayName: 'HR',
  email: 'h@x.com',
  avatar: null,
  seniorSharePercent: 26,
}
const accountantUser: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Acc',
  email: 'ac@x.com',
  avatar: null,
  seniorSharePercent: 26,
}
const seniorUser: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 's@x.com',
  avatar: null,
  seniorSharePercent: 26,
}

interface ProjectRow {
  id: string
  name: string
  companyName: string
  domain: string
  logoUrl: string | null
  startDate: Date
  seniorId: string
  rate: number
  currency: string
  seniorSharePercentOverride: number | null
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
    avatar: string | null
    role: string
    seniorSharePercent: number
  } | null
  members?: Array<{ id: string; userId: string; joinedAt: Date; leftAt: Date | null; user?: { id: string; displayName: string; email: string; avatar: string | null; role: string } | null }>
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
    logoUrl: null,
    startDate: new Date('2026-01-01'),
    seniorId: 'senior-1',
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
      id: 'senior-1',
      displayName: 'Senior One',
      email: 's@x.com',
      avatar: null,
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
              seniorSharePercentOverride: (values['seniorSharePercentOverride'] as number | null) ?? null,
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
    await h.service.update(
      'proj-1',
      { seniorSharePercentOverride: 35 },
      accountantUser,
    )
    expect(h.projectRow.seniorSharePercentOverride).toBe(35)
    expect(h.getFinanceInsertCount()).toBe(1)
    expect(h.financeRows[0]?.seniorSharePercentOverride).toBe(35)
    expect(h.financeRows[0]?.updatedBy).toBe(accountantUser.id)
  })

  it('rejects ACCOUNTANT PATCH that also touches other fields (cannot piggyback edits)', async () => {
    const h = buildHarness()
    await expect(
      h.service.update(
        'proj-1',
        { seniorSharePercentOverride: 35, rate: 9999 },
        accountantUser,
      ),
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
    ;(h.service as unknown as { db: { db: { query: { projects: { findFirst: () => Promise<undefined> } } } } }).db.db.query.projects.findFirst = async () => undefined
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
    await h.service.update(
      'proj-1',
      { seniorSharePercentOverride: 26 },
      adminUser,
    )
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
    await h.service.update(
      'proj-1',
      { seniorSharePercentOverride: 35 },
      adminUser,
    )
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
// mapProject DTO shape: seniorSharePercentDefault + seniorSharePercentOverride
// ---------------------------------------------------------------------------

describe('ProjectsService.update — DTO mapping', () => {
  it('returns seniorSharePercentDefault = senior.seniorSharePercent', async () => {
    const h = buildHarness({
      senior: {
        id: 'senior-1',
        displayName: 'Senior One',
        email: 's@x.com',
        avatar: null,
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
    expect((result as { seniorSharePercentOverride: number | null }).seniorSharePercentOverride).toBeNull()
  })

  it('returns seniorSharePercentOverride = 30 after admin sets it', async () => {
    const h = buildHarness()
    const result = await h.service.update(
      'proj-1',
      { seniorSharePercentOverride: 30 },
      adminUser,
    )
    expect((result as { seniorSharePercentOverride: number | null }).seniorSharePercentOverride).toBe(30)
  })
})
