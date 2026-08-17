/**
 * task-finance-fix-wave1 / E-1 — an ARCHIVED (dismissed) HR or ACCOUNTANT must
 * not be given a salary, neither by the cron nor by hand, and a salary row that
 * already points at an archived receiver must not be payable.
 *
 * WHY (the defect these tests pin):
 *   `createMonthlySalaries` selected employees by ROLE ALONE
 *   (`or(eq(users.role,'HR'), eq(users.role,'ACCOUNTANT'))`) with no
 *   `archivedAt` filter, and `UsersService.archive` neither zeroes
 *   `monthlySalary` nor changes the role — so every month a dismissed employee
 *   got a fresh PENDING salary, and the finance page does not hide it: paying it
 *   was one ordinary ADMIN click. Three other money paths in the same service
 *   (createAdminIncome, declareUsdtProjectIncome, manualConfirmPayout) already
 *   check `receiver.archivedAt`; this was a gap, not a decision.
 *
 * WHY THESE ARE UNIT TESTS (and why the WHERE clause is asserted as SQL):
 *   the mutation gate (`scripts/devops/mutation-gate.mjs --changed`) mutates the
 *   changed LINES and runs the UNIT suite — `*.integration.spec.ts` files are
 *   structurally excluded from any non-integration run (see vitest.config.mts),
 *   so a real-DB spec cannot kill a mutant in a changed line. The cron's fix
 *   lives INSIDE a Drizzle `where`, and a stubbed `findMany` returns its canned
 *   rows regardless of the predicate it was handed — so the predicate is
 *   asserted by COMPILING it (`PgDialect.sqlToQuery`, a pure function, no
 *   connection) and reading the SQL text + bound params. Delete the
 *   `isNull(users.archivedAt)` term and the compiled SQL loses `is null`;
 *   blank out the role literals and `params` loses them.
 *   The real-DB behaviour ("an archived HR gets no row") is pinned separately in
 *   salary-archived-receiver.integration.spec.ts.
 */
import { BadRequestException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const ADMIN_USER: SessionUser = {
  id: 'admin-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const ARCHIVED_HR = {
  id: 'hr-archived',
  role: 'HR' as const,
  displayName: 'Dismissed HR',
  email: 'hr-archived@test.spec',
  monthlySalary: '1500',
  archivedAt: new Date('2026-01-31T00:00:00.000Z'),
}

const ACTIVE_HR = {
  id: 'hr-active',
  role: 'HR' as const,
  displayName: 'Active HR',
  email: 'hr-active@test.spec',
  monthlySalary: '1500',
  archivedAt: null,
}

/** Compile a captured Drizzle `where` into real SQL + bound params (no DB). */
function compileWhere(where: unknown): { sql: string; params: unknown[] } {
  const q = new PgDialect().sqlToQuery(where as SQL)
  return { sql: q.sql, params: q.params }
}

// ── AC1: the cron's own SELECT excludes archived employees ──────────────────

describe('createMonthlySalaries — AC1: the employee SELECT excludes archived users', () => {
  function makeCronService() {
    const usersFindMany = vi.fn().mockResolvedValue([])
    const projectMembersFindMany = vi.fn().mockResolvedValue([])
    const db = {
      db: {
        query: {
          users: {
            findMany: usersFindMany,
            // The cron resolves ANY admin as the `createdBy` author.
            findFirst: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'ADMIN' }),
          },
          projectMembers: { findMany: projectMembersFindMany },
        },
        insert: vi.fn(),
      },
    } as never

    return { svc: makeTransactionsService({ db }), usersFindMany }
  }

  it('binds both salaried roles AND an "archived_at is null" term', async () => {
    const { svc, usersFindMany } = makeCronService()

    await svc.createMonthlySalaries('2099-12')

    expect(usersFindMany).toHaveBeenCalledTimes(1)
    const { sql, params } = compileWhere(usersFindMany.mock.calls[0]![0].where)

    // The archivedAt term is the fix. Asserted on the compiled SQL text, because
    // `IS NULL` binds no parameter there is nothing else to observe.
    expect(sql).toContain('"archived_at" is null')
    // The roles the cron is FOR must still be bound — a fix that narrowed the
    // query into selecting nobody would also "exclude archived employees".
    expect(params).toContain('HR')
    expect(params).toContain('ACCOUNTANT')
  })
})

// ── AC2: createSalary refuses an archived receiver ──────────────────────────

describe('createSalary — AC2: an archived receiver is refused', () => {
  function makeSalaryService(receiver: unknown, onInsert?: () => never) {
    const db = {
      db: {
        query: {
          users: { findFirst: vi.fn().mockResolvedValue(receiver) },
        },
        insert:
          onInsert ??
          vi.fn(() => {
            throw new Error('INSERT REACHED')
          }),
      },
    } as never
    return makeTransactionsService({ db })
  }

  const payload = {
    receiverId: ARCHIVED_HR.id,
    amount: 1500,
    salaryMonth: '2099-12',
  }

  it('refuses with the archived-receiver message', async () => {
    const svc = makeSalaryService(ARCHIVED_HR)

    await expect(svc.createSalary(payload, ADMIN_USER)).rejects.toThrow(
      'Получатель архивирован — зарплата не начисляется',
    )
    await expect(svc.createSalary(payload, ADMIN_USER)).rejects.toBeInstanceOf(BadRequestException)
  })

  it('lets an ACTIVE receiver through the gate (reaches the INSERT)', async () => {
    // The insert stub throws a sentinel: proving the gate did NOT fire needs no
    // findOne/audit wiring, only evidence that control reached the write.
    const svc = makeSalaryService(ACTIVE_HR)

    await expect(
      svc.createSalary({ ...payload, receiverId: ACTIVE_HR.id }, ADMIN_USER),
    ).rejects.toThrow('INSERT REACHED')
  })
})

// ── AC2: paySalary refuses a row whose receiver is archived ─────────────────

describe('paySalary — AC2: a salary of an archived receiver cannot be paid', () => {
  const SALARY_ROW = {
    id: 'sal-1',
    type: 'SALARY' as const,
    status: 'PENDING' as const,
    amount: '1500',
    currency: 'USD' as const,
    receiverId: ARCHIVED_HR.id,
    senderId: null,
    deletedAt: null,
    createdBy: 'admin-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  function makePayService(row: Record<string, unknown>, receiver: unknown) {
    const usersFindFirst = vi.fn().mockResolvedValue(receiver)
    const db = {
      db: {
        query: {
          transactions: { findFirst: vi.fn().mockResolvedValue(row) },
          users: { findFirst: usersFindFirst },
        },
      },
    } as never
    return { svc: makeTransactionsService({ db }), usersFindFirst }
  }

  const payData = {
    fundingSource: 'COMPANY_ACCOUNT' as const,
    currency: 'USDT' as const,
    txHash: '0x' + 'a'.repeat(64),
  }

  it('refuses with the archived-receiver message', async () => {
    const { svc } = makePayService(SALARY_ROW, ARCHIVED_HR)

    await expect(svc.paySalary('sal-1', payData, ADMIN_USER)).rejects.toThrow(
      'Получатель зарплаты архивирован — выплата невозможна',
    )
    await expect(svc.paySalary('sal-1', payData, ADMIN_USER)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('does not fire for an ACTIVE receiver (flow proceeds to receipt validation)', async () => {
    // No receipt is supplied, so the very next gate (mandatory pay-time proof)
    // is what must reject — evidence the archived gate stayed silent.
    const { svc } = makePayService(SALARY_ROW, ACTIVE_HR)

    const rejection = await svc
      .paySalary('sal-1', { ...payData, txHash: undefined }, ADMIN_USER)
      .then(
        () => null,
        (err: Error) => err.message,
      )

    expect(rejection).not.toBeNull()
    expect(rejection).not.toContain('архивирован')
  })

  it('does not look up a user at all for a row without a receiverId', async () => {
    // A label-only SALARY row (no receiverId) has no receiver to be archived;
    // the gate must key on the row's OWN receiver, never query a null id.
    const { svc, usersFindFirst } = makePayService(
      { ...SALARY_ROW, receiverId: null },
      ARCHIVED_HR, // would refuse if the gate queried regardless
    )

    const rejection = await svc.paySalary('sal-1', payData, ADMIN_USER).then(
      () => null,
      (err: Error) => err.message,
    )

    expect(usersFindFirst).not.toHaveBeenCalled()
    expect(rejection).not.toContain('архивирован')
  })
})
