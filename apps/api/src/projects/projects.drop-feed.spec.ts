/**
 * Unit tests for ProjectsService.findDropOwnProjects — the self-only DROP
 * project feed behind `GET /api/projects/drop/me` (task-drop-2-backend AC2).
 *
 * Coverage:
 *  RBAC (self-only): every non-DROP role → 403.
 *  Mapping: companyName, REAL seniorDisplayName (NOT masked), status
 *    (archivedAt null → active, set → closed), incomesCount per project
 *    (counted from this drop's DROP_INCOME rows, 0 when none).
 *  Closed projects included: archivedAt IS NOT filtered in the WHERE clause —
 *    a closed project (archivedAt set) MUST appear with status='closed'.
 *    Fix: MED review finding code-review-1 (dead 'closed' branch removed by
 *    dropping the isNull(archivedAt) WHERE restriction).
 *
 * Pure stub for DatabaseService — no Postgres. The DB-level self-scope
 * (dropId = self WHERE clause + receiverId on incomes) is pinned by the
 * real-DB integration spec (drop.rbac.integration.spec.ts); the stub's
 * findMany ignores the `where`, so these tests target the in-memory
 * enrichment/mapping the WHERE clause cannot cover.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { ProjectsService } from './projects.service'

function user(role: SessionUser['role'], id = `${role.toLowerCase()}-1`): SessionUser {
  return {
    id,
    role,
    displayName: `Test ${role}`,
    email: `${id}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

const DROP_ID = 'drop-A'

type ProjectRow = {
  id: string
  companyName: string
  archivedAt: Date | null
  senior: { displayName: string } | null
}
type IncomeRow = { projectId: string | null }

/**
 * ProjectsService whose DB returns the supplied project + income rows.
 * `projects.findMany` → projectRows; `transactions.findMany` → incomeRows.
 */
function makeSvc(projectRows: ProjectRow[], incomeRows: IncomeRow[]) {
  const dbStub = {
    db: {
      query: {
        projects: { findMany: () => Promise.resolve(projectRows) },
        transactions: { findMany: () => Promise.resolve(incomeRows) },
      },
    },
  }
  return new ProjectsService(dbStub as never, {} as never, {} as never, {} as never)
}

const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'ADMIN']

describe('findDropOwnProjects — RBAC (self-only)', () => {
  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for role ${role}`, async () => {
      const svc = makeSvc([], [])
      await expect(svc.findDropOwnProjects(user(role))).rejects.toBeInstanceOf(ForbiddenException)
    })
  }

  it('DROP → resolves an array', async () => {
    const svc = makeSvc([], [])
    const res = await svc.findDropOwnProjects(user('DROP', DROP_ID))
    expect(res).toEqual([])
  })
})

describe('findDropOwnProjects — mapping', () => {
  const projA: ProjectRow = {
    id: 'proj-A',
    companyName: 'TechCorp',
    archivedAt: null,
    senior: { displayName: 'Oleksiy Kovalenko' },
  }
  const projB: ProjectRow = {
    id: 'proj-B',
    companyName: 'StartupA',
    archivedAt: new Date('2026-01-01'),
    senior: { displayName: 'Dmytro Marchenko' },
  }

  it('maps companyName + REAL seniorDisplayName (not masked)', async () => {
    const svc = makeSvc([projA], [])
    const [row] = await svc.findDropOwnProjects(user('DROP', DROP_ID))
    expect(row!.companyName).toBe('TechCorp')
    expect(row!.seniorDisplayName).toBe('Oleksiy Kovalenko')
  })

  it('status: archivedAt null → active, set → closed', async () => {
    const svc = makeSvc([projA, projB], [])
    const res = await svc.findDropOwnProjects(user('DROP', DROP_ID))
    expect(res.find((p) => p.id === 'proj-A')!.status).toBe('active')
    expect(res.find((p) => p.id === 'proj-B')!.status).toBe('closed')
  })

  it("seniorDisplayName falls back to '' when senior missing", async () => {
    const svc = makeSvc([{ ...projA, senior: null }], [])
    const [row] = await svc.findDropOwnProjects(user('DROP', DROP_ID))
    expect(row!.seniorDisplayName).toBe('')
  })

  it('incomesCount counts this drop DROP_INCOME rows per project', async () => {
    const svc = makeSvc(
      [projA, projB],
      [
        { projectId: 'proj-A' },
        { projectId: 'proj-A' },
        { projectId: 'proj-A' },
        { projectId: 'proj-B' },
        { projectId: null }, // unlinked income → ignored
      ],
    )
    const res = await svc.findDropOwnProjects(user('DROP', DROP_ID))
    expect(res.find((p) => p.id === 'proj-A')!.incomesCount).toBe(3)
    expect(res.find((p) => p.id === 'proj-B')!.incomesCount).toBe(1)
  })

  it('incomesCount = 0 for a project with no incomes', async () => {
    const svc = makeSvc([projA], [])
    const [row] = await svc.findDropOwnProjects(user('DROP', DROP_ID))
    expect(row!.incomesCount).toBe(0)
  })

  // Regression: MED review finding code-review-1 — before the fix the WHERE
  // clause contained isNull(archivedAt), making archivedAt≠null rows invisible
  // and the 'closed' branch of the status mapping dead / unreachable.
  // After the fix the query has NO archivedAt restriction, so closed projects
  // are included and mapped to status='closed'.
  it('closed project (archivedAt set) is included in results with status=closed', async () => {
    const closedProject: ProjectRow = {
      id: 'proj-closed',
      companyName: 'ClosedCorp',
      archivedAt: new Date('2026-03-01T00:00:00Z'),
      senior: { displayName: 'Ivan Petrenko' },
    }
    const svc = makeSvc([projA, closedProject], [])
    const res = await svc.findDropOwnProjects(user('DROP', DROP_ID))
    const closed = res.find((p) => p.id === 'proj-closed')
    expect(closed).toBeDefined()
    expect(closed!.status).toBe('closed')
    expect(closed!.companyName).toBe('ClosedCorp')
  })
})
