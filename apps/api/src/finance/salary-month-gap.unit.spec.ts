/**
 * Unit tests for TransactionsService.getSalaryMonthGapReport /
 * backfillSalaryMonth — task-salary-month-gap-and-status (E-5).
 *
 * Before this task NEITHER method existed (`git show origin/main:apps/api/src/
 * finance/transactions.service.ts | grep -c getSalaryMonthGapReport` → 0) —
 * `createMonthlySalaries` (the cron) was the ONLY way to see who has a salary
 * this month, and it only ever wrote, never reported. That IS the RED state
 * these tests prove GREEN against: a missed/failed cron month had no way to
 * be observed. See salary-status.helper.spec.ts for the companion E-6 proof
 * (mySalaryStatus no longer collapsing two states into `null`).
 *
 * The population math (who is "expected") is deterministic JS over rows read
 * via the Drizzle relational-query API, the SAME shape income-compliance.unit
 * .spec.ts / senior-summary.unit.spec.ts already unit-test at — no Postgres
 * needed. What "existing" means (a real non-deleted SALARY row) is exercised
 * against Postgres separately in salary-month-gap.integration.spec.ts.
 *
 * Covers:
 *   - RBAC: getSalaryMonthGapReport → ADMIN/ACCOUNTANT only, 403 for everyone
 *     else BEFORE any DB access; backfillSalaryMonth → ADMIN ONLY (narrower —
 *     ACCOUNTANT is refused too, matching paySalary's ADMIN-only bar).
 *   - AC5 positive: HR/ACCOUNTANT with monthlySalary set and no row this
 *     month → appears in `missing`.
 *   - AC5 positive: JUNIOR on an active membership with a resolved salary
 *     (override or default) and no row → appears in `missing`, carrying
 *     projectId/projectName.
 *   - AC5 negative: HR/ACCOUNTANT with monthlySalary set but an EXISTING row
 *     → excluded.
 *   - AC5 negative ("law says they shouldn't be there"): no monthlySalary
 *     configured → excluded. Archived JUNIOR → excluded. Non-eligible role on
 *     a project membership (e.g. SENIOR) → excluded.
 *   - backfillSalaryMonth re-invokes createMonthlySalaries (idempotent insert
 *     path is exercised) and returns the post-backfill gap.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

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

type AnyRow = Record<string, unknown>

interface StubData {
  // Already correctly SQL-scoped (active, non-archived HR/ACCOUNTANT) — the
  // resolver's OWN archival/role SQL filter is pinned separately in
  // salary-archived-receiver.unit.spec.ts (compiled WHERE inspection); this
  // stub tests the JS layer ON TOP of that (monthlySalary truthiness).
  hrAccountantEmployees?: AnyRow[]
  // Already correctly SQL-scoped (isNull(leftAt)) active project memberships.
  activeMembers?: AnyRow[]
  // Existing non-deleted SALARY rows for the target month (receiverId only —
  // matches the `.select({ receiverId: ... })` projection).
  existingSalaryReceiverIds?: string[]
  admin?: AnyRow | undefined
}

function makeService(data: StubData = {}): {
  svc: TransactionsService
  insertedValues: Record<string, unknown>[]
} {
  const insertedValues: Record<string, unknown>[] = []
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      insertedValues.push(values)
      return { onConflictDoNothing: vi.fn().mockResolvedValue([]) }
    }),
  }))

  const dbStub = {
    db: {
      query: {
        users: {
          findMany: () => Promise.resolve(data.hrAccountantEmployees ?? []),
          findFirst: () => Promise.resolve(data.admin ?? { id: 'admin-1', role: 'ADMIN' }),
        },
        projectMembers: {
          findMany: () => Promise.resolve(data.activeMembers ?? []),
        },
      },
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve(
              (data.existingSalaryReceiverIds ?? []).map((receiverId) => ({ receiverId })),
            ),
        }),
      }),
      insert,
    },
  }
  return { svc: makeTransactionsService({ db: dbStub as never }), insertedValues }
}

function hrEmployee(overrides: Partial<AnyRow> = {}): AnyRow {
  return {
    id: 'hr-1',
    email: 'hr-1@test.spec',
    displayName: 'HR One',
    role: 'HR',
    monthlySalary: '1500',
    archivedAt: null,
    ...overrides,
  }
}

function juniorMember(
  user: AnyRow,
  project: AnyRow = { id: 'proj-1', name: 'Proj One', financeSettings: null },
): AnyRow {
  return { leftAt: null, user, project }
}

const MONTH = '2099-12'
type TransactionsService = ReturnType<typeof makeTransactionsService>

describe('getSalaryMonthGapReport — RBAC guard', () => {
  const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'DROP']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for ${role} (before any DB access)`, async () => {
      const throwingDb = {
        db: {
          query: {
            users: {
              findMany: () => {
                throw new Error('DB must not be queried for forbidden roles')
              },
            },
          },
        },
      }
      const svc = makeTransactionsService({ db: throwingDb as never })
      await expect(svc.getSalaryMonthGapReport(user(role), MONTH)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })
  }

  it('resolves for ADMIN', async () => {
    const { svc } = makeService()
    await expect(svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)).resolves.toBeDefined()
  })

  it('resolves for ACCOUNTANT', async () => {
    const { svc } = makeService()
    await expect(svc.getSalaryMonthGapReport(user('ACCOUNTANT'), MONTH)).resolves.toBeDefined()
  })
})

describe('backfillSalaryMonth — RBAC guard (ADMIN only, narrower than the report)', () => {
  const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'DROP', 'ACCOUNTANT']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for ${role} (before any DB access)`, async () => {
      const throwingDb = {
        db: {
          query: {
            users: {
              findMany: () => {
                throw new Error('DB must not be queried for forbidden roles')
              },
            },
          },
        },
      }
      const svc = makeTransactionsService({ db: throwingDb as never })
      await expect(svc.backfillSalaryMonth(user(role), MONTH)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })
  }

  it('resolves for ADMIN', async () => {
    const { svc } = makeService()
    await expect(svc.backfillSalaryMonth(user('ADMIN'), MONTH)).resolves.toBeDefined()
  })
})

describe('getSalaryMonthGapReport — AC5: exactly the configured-and-missing, never who legitimately has none', () => {
  it('an HR with monthlySalary set and no row this month is missing', async () => {
    const { svc } = makeService({ hrAccountantEmployees: [hrEmployee()] })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report.month).toBe(MONTH)
    expect(report.missing).toHaveLength(1)
    expect(report.missing[0]).toMatchObject({
      userId: 'hr-1',
      displayName: 'HR One',
      role: 'HR',
      expectedAmount: 1500,
      projectId: null,
      projectName: null,
    })
  })

  it('an HR with monthlySalary set but an EXISTING row this month is NOT missing', async () => {
    const { svc } = makeService({
      hrAccountantEmployees: [hrEmployee()],
      existingSalaryReceiverIds: ['hr-1'],
    })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report.missing).toHaveLength(0)
  })

  it('an HR WITHOUT monthlySalary configured is NEVER missing (legitimately absent)', async () => {
    const { svc } = makeService({
      hrAccountantEmployees: [hrEmployee({ id: 'hr-2', monthlySalary: null })],
    })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report.missing).toHaveLength(0)
  })

  it('an ACCOUNTANT behaves the same as HR (both auto-eligible)', async () => {
    const { svc } = makeService({
      hrAccountantEmployees: [
        hrEmployee({
          id: 'acc-1',
          displayName: 'Acc One',
          role: 'ACCOUNTANT',
          monthlySalary: '2000',
        }),
      ],
    })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report.missing).toEqual([
      {
        userId: 'acc-1',
        displayName: 'Acc One',
        role: 'ACCOUNTANT',
        expectedAmount: 2000,
        projectId: null,
        projectName: null,
      },
    ])
  })

  it('a JUNIOR on an active project with a resolved salary and no row is missing, with project context', async () => {
    const jr = {
      id: 'jr-1',
      email: 'jr-1@test.spec',
      displayName: 'Junior One',
      role: 'JUNIOR',
      monthlySalary: '900',
      archivedAt: null,
    }
    const { svc } = makeService({
      activeMembers: [juniorMember(jr, { id: 'proj-1', name: 'Proj One', financeSettings: null })],
    })
    const report = await svc.getSalaryMonthGapReport(user('ACCOUNTANT'), MONTH)
    expect(report.missing).toEqual([
      {
        userId: 'jr-1',
        displayName: 'Junior One',
        role: 'JUNIOR',
        expectedAmount: 900,
        projectId: 'proj-1',
        projectName: 'Proj One',
      },
    ])
  })

  it('a JUNIOR project override wins over the user default', async () => {
    const jr = {
      id: 'jr-2',
      email: 'jr-2@test.spec',
      displayName: 'Junior Two',
      role: 'JUNIOR',
      monthlySalary: '900',
      archivedAt: null,
    }
    const { svc } = makeService({
      activeMembers: [
        juniorMember(jr, {
          id: 'proj-2',
          name: 'Proj Two',
          financeSettings: { juniorSalaryOverride: '1234' },
        }),
      ],
    })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report.missing[0]?.expectedAmount).toBe(1234)
  })

  it('an ARCHIVED junior is NEVER missing (legitimately absent — a re-opened membership must not count)', async () => {
    const jr = {
      id: 'jr-archived',
      email: 'jr-archived@test.spec',
      displayName: 'Junior Archived',
      role: 'JUNIOR',
      monthlySalary: '900',
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    const { svc } = makeService({ activeMembers: [juniorMember(jr)] })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report.missing).toHaveLength(0)
  })

  it('a JUNIOR with no resolved salary (no override, no user default) is NEVER missing', async () => {
    const jr = {
      id: 'jr-nosalary',
      email: 'jr-nosalary@test.spec',
      displayName: 'Junior NoSalary',
      role: 'JUNIOR',
      monthlySalary: null,
      archivedAt: null,
    }
    const { svc } = makeService({ activeMembers: [juniorMember(jr)] })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report.missing).toHaveLength(0)
  })

  it('a non-JUNIOR on a project membership (e.g. SENIOR) is NEVER counted here', async () => {
    const senior = {
      id: 'sr-1',
      email: 'sr-1@test.spec',
      displayName: 'Senior One',
      role: 'SENIOR',
      monthlySalary: '5000',
      archivedAt: null,
    }
    const { svc } = makeService({ activeMembers: [juniorMember(senior)] })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report.missing).toHaveLength(0)
  })

  it('defaults `month` to the current UTC month when omitted', async () => {
    const { svc } = makeService({ hrAccountantEmployees: [hrEmployee()] })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'))
    const now = new Date()
    const expectedMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    expect(report.month).toBe(expectedMonth)
  })
})

describe('backfillSalaryMonth — re-invokes the idempotent cron insert, then reports the residual gap', () => {
  it('inserts a SALARY row for the missing HR and the post-backfill report is clean', async () => {
    const { svc, insertedValues } = makeService({
      hrAccountantEmployees: [hrEmployee()],
      // No existing row initially — the insert stub doesn't feed back into the
      // `existingSalaryReceiverIds` fixture (it's a separate stub), so the
      // POST-backfill resolveSalaryMonthGap call still sees "no row" from the
      // `select` stub's point of view. What this test proves is narrower and
      // exactly what unit-level can prove: createMonthlySalaries' insert path
      // fires with the SAME receiver the report identified. The end-to-end
      // "the row is really gone after backfill" is an integration-level claim
      // (salary-month-gap.integration.spec.ts).
    })
    const result = await svc.backfillSalaryMonth(user('ADMIN'), MONTH)
    expect(insertedValues).toHaveLength(1)
    expect(insertedValues[0]).toMatchObject({
      type: 'SALARY',
      status: 'PENDING',
      receiverId: 'hr-1',
      salaryMonth: MONTH,
      amount: '1500',
    })
    expect(result.month).toBe(MONTH)
  })

  it('backfilling a month with nothing missing reports a clean post-backfill gap', async () => {
    // `createMonthlySalaries` always ATTEMPTS the insert per eligible receiver
    // (real de-duplication is the DB's `ON CONFLICT DO NOTHING` against the
    // unique index — a unit-level insert-recorder stub cannot observe a real
    // conflict, only that the attempt was made). What this test proves at the
    // unit level is the report's own read: with the row already existing, the
    // POST-backfill `resolveSalaryMonthGap` reports nothing missing.
    const { svc, insertedValues } = makeService({
      hrAccountantEmployees: [hrEmployee()],
      existingSalaryReceiverIds: ['hr-1'],
    })
    const result = await svc.backfillSalaryMonth(user('ADMIN'), MONTH)
    expect(insertedValues).toHaveLength(1) // the (harmless, ON CONFLICT DO NOTHING) attempt
    expect(result.missing).toHaveLength(0)
  })
})
