/**
 * security-review round 3 (SR-H-1, task-project-draft-status). `assertProjectActive`
 * (Д2) sits on the 4 income-CREATION entry points in transactions.service.ts —
 * it does NOT sit on the monthly salary cron, which mints money by a completely
 * different path: `resolveJuniorSalaryReceivers` walks `project_members` through
 * a relational `with: { project }` and never asked the project's own status.
 *
 * The path is reachable end to end: `ProjectsService.addMember` does not check
 * project status either (a JUNIOR can be seated on a DRAFT/REJECTED project),
 * and once seated, `createMonthlySalaries` (or its manual twin
 * `backfillSalaryMonth`) mints a fresh PENDING salary against that project every
 * month — worse for REJECTED, which the owner does not auto-archive, so the
 * obligation would accrue indefinitely.
 *
 * Same fix location as the precedent this file's sibling
 * (`salary-archived-receiver.unit.spec.ts`) already established for the
 * archived-junior case: the check belongs in `resolveJuniorSalaryReceivers`'s
 * LOOP (Drizzle's relational query API cannot filter `project_members` parent
 * rows by the related `project.status` column), not in `addMember` — see that
 * file's MED-1 section + this fix's own comment in transactions.service.ts.
 *
 * `resolveJuniorSalaryReceivers` is private — exercised indirectly through
 * `createMonthlySalaries`, the SAME real entry point security-review used to
 * prove the gap (mocks only the DB driver, never the service under test).
 */
import { describe, expect, it, vi } from 'vitest'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

function makeCronService(members: unknown[]) {
  const insertedValues: Record<string, unknown>[] = []
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      insertedValues.push(values)
      return {
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      }
    }),
  }))

  const db = {
    db: {
      query: {
        users: {
          findMany: vi.fn().mockResolvedValue([]), // no HR/ACCOUNTANT in this fixture
          findFirst: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'ADMIN' }),
        },
        projectMembers: { findMany: vi.fn().mockResolvedValue(members) },
      },
      insert,
    },
  } as never

  return { svc: makeTransactionsService({ db }), insertedValues }
}

const JUNIOR = {
  id: 'jr-1',
  role: 'JUNIOR' as const,
  email: 'jr@test.spec',
  monthlySalary: '900',
  archivedAt: null,
}

function makeMember(status: 'DRAFT' | 'ACTIVE' | 'REJECTED') {
  return {
    leftAt: null,
    user: JUNIOR,
    project: { id: 'proj-1', name: 'Acme', status, financeSettings: null },
  }
}

describe('createMonthlySalaries — SR-H-1: a JUNIOR on a non-ACTIVE project accrues nothing', () => {
  it('mints no SALARY row for a DRAFT project', async () => {
    const { svc, insertedValues } = makeCronService([makeMember('DRAFT')])

    await svc.createMonthlySalaries('2099-12')

    expect(insertedValues).toHaveLength(0)
  })

  it('mints no SALARY row for a REJECTED project', async () => {
    const { svc, insertedValues } = makeCronService([makeMember('REJECTED')])

    await svc.createMonthlySalaries('2099-12')

    expect(insertedValues).toHaveLength(0)
  })

  it('positive control: the SAME fixture on an ACTIVE project DOES mint a SALARY row', async () => {
    // Without this, a broken fixture (e.g. a typo'd role) could pass both
    // tests above vacuously — nothing would prove the loop ever reaches the
    // insert for this exact member shape at all.
    const { svc, insertedValues } = makeCronService([makeMember('ACTIVE')])

    await svc.createMonthlySalaries('2099-12')

    expect(insertedValues.map((v) => v['receiverId'])).toEqual(['jr-1'])
    expect(insertedValues[0]).toMatchObject({
      type: 'SALARY',
      status: 'PENDING',
      amount: '900',
      projectId: 'proj-1',
      salaryMonth: '2099-12',
    })
  })

  it('one DRAFT project and one ACTIVE project in the same run — only the ACTIVE one accrues', async () => {
    const juniorOnActive = { ...JUNIOR, id: 'jr-2' }
    const { svc, insertedValues } = makeCronService([
      makeMember('DRAFT'),
      {
        leftAt: null,
        user: juniorOnActive,
        project: { id: 'proj-2', name: 'Other', status: 'ACTIVE' as const, financeSettings: null },
      },
    ])

    await svc.createMonthlySalaries('2099-12')

    expect(insertedValues.map((v) => v['receiverId'])).toEqual(['jr-2'])
  })
})
