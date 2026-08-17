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
 *   was one ordinary ADMIN click.
 *
 * THE RULE BEING ENFORCED (kept verbatim-equivalent to the block above
 * `if (receiver.archivedAt)` in transactions.service.ts — if you change one,
 * change both, because the two drifting apart IS the defect this task spent two
 * review rounds correcting):
 *   the question is whether the write CREATES an entitlement not yet EARNED, or
 *   merely RECORDS one already earned. A salary accrues against a period of
 *   employment a dismissed person will not work → refuse. Writes that record
 *   something already earned must not grow the barrier even when they insert new
 *   rows naming a person — `bookCompanyObligations` inserts
 *   SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT with the senior's / drop's own
 *   `receiverId`, and that is their share of income already received; refusing
 *   would strand money that is owed.
 *   PAYING a salary sits on neither side, deliberately: a PENDING row is a
 *   reminder, so it may be a month genuinely worked before dismissal (earned) or
 *   one the cron minted after it (not earned), and the row cannot tell you
 *   which. `paySalary` refuses as a stop-loss on an irreversible payment —
 *   refusing is recoverable (un-archive, then pay), paying is not. Whether the
 *   barrier should key on the PERIOD rather than the receiver's current state is
 *   an open question with the owner (round-2 MED-2), not decided here.
 *   Round-2 correction: this paragraph first cited `manualConfirmPayout` as the
 *   precedent (it never reads receiver archival). Round-3 correction: its
 *   replacement — "new accrual to a NAMED person → refuse" — reads like an
 *   executable test and literally catches those obligation rows.
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
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { compileWhere } from './__test-helpers__/drizzle-where-introspection'
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

// ── MED-1 (round 2): the JUNIOR branch of the same cron ─────────────────────

describe('createMonthlySalaries — MED-1: an archived JUNIOR gets no salary either', () => {
  // The first version of the fix left this branch alone, on the theory that
  // archiving a junior sets `projectMembers.leftAt` and the query below already
  // filters on it. That holds only at the moment of archiving —
  // `ProjectsService` re-opens a membership without looking at `archivedAt`, so
  // a dismissed junior can be re-attached and start accruing again. Here the
  // membership is deliberately OPEN (`leftAt: null`) for both juniors: exactly
  // the state that theory could not cover.
  function makeCronService(members: unknown[]) {
    const insertedValues: Record<string, unknown>[] = []
    const insert = vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues.push(values)
        return { onConflictDoNothing: vi.fn().mockResolvedValue([]) }
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

  function makeMember(user: Record<string, unknown>) {
    return {
      leftAt: null,
      user,
      project: { id: 'proj-1', financeSettings: null },
    }
  }

  const ACTIVE_JUNIOR = {
    id: 'jr-active',
    role: 'JUNIOR' as const,
    email: 'jr-active@test.spec',
    monthlySalary: '900',
    archivedAt: null,
  }
  const ARCHIVED_JUNIOR = {
    id: 'jr-archived',
    role: 'JUNIOR' as const,
    email: 'jr-archived@test.spec',
    monthlySalary: '900',
    archivedAt: new Date('2026-03-31T00:00:00.000Z'),
  }

  const NON_JUNIOR_MEMBER = {
    id: 'senior-1',
    role: 'SENIOR' as const,
    email: 'senior@test.spec',
    monthlySalary: '5000',
    archivedAt: null,
  }

  it('accrues for the active junior and skips the archived one', async () => {
    const { svc, insertedValues } = makeCronService([
      makeMember(ACTIVE_JUNIOR),
      makeMember(ARCHIVED_JUNIOR),
    ])

    await svc.createMonthlySalaries('2099-12')

    // Asserted on the receivers actually written, not on a call count: the
    // point is WHICH junior got the row.
    expect(insertedValues.map((v) => v['receiverId'])).toEqual(['jr-active'])
    expect(insertedValues).toHaveLength(1)
    expect(insertedValues[0]).toMatchObject({
      type: 'SALARY',
      status: 'PENDING',
      amount: '900',
      salaryMonth: '2099-12',
    })
  })

  it('accrues only for JUNIORs — a SENIOR on the same project gets nothing here', async () => {
    // The role guard shares the line the archival term was added to, and until
    // this test existed nothing in the unit suite exercised it: the mutation
    // gate reported `user.role !== 'JUNIOR'` → `false` as a SURVIVOR. A senior's
    // money comes through project income and payouts, never through this loop
    // (which is also why their `monthlySalary` being set must not matter).
    const { svc, insertedValues } = makeCronService([
      makeMember(NON_JUNIOR_MEMBER),
      makeMember(ACTIVE_JUNIOR),
    ])

    await svc.createMonthlySalaries('2099-12')

    expect(insertedValues.map((v) => v['receiverId'])).toEqual(['jr-active'])
  })

  it('skips a membership whose user did not resolve, without crashing the run', async () => {
    // Same reason: the `!user` guard was uncovered, so weakening it survived.
    // A membership row pointing at a missing user must be skipped quietly — the
    // whole monthly run must not die on one broken row.
    const { svc, insertedValues } = makeCronService([
      { leftAt: null, user: null, project: { id: 'proj-1', financeSettings: null } },
      makeMember(ACTIVE_JUNIOR),
    ])

    await expect(svc.createMonthlySalaries('2099-12')).resolves.toBeUndefined()
    expect(insertedValues.map((v) => v['receiverId'])).toEqual(['jr-active'])
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

  it('looks up THIS row’s receiver — the lookup is bound to tx.receiverId', async () => {
    // Caught by the mutation gate: with `findFirst` stubbed, emptying the
    // lookup's `where` to `{}` changed nothing any assertion could see — the
    // stub answered with the archived user regardless, so the refusal above
    // still "passed" while the code was in fact asking the DB for an arbitrary
    // user. Compiling the predicate is what makes the binding observable.
    const { svc, usersFindFirst } = makePayService(SALARY_ROW, ARCHIVED_HR)

    await expect(svc.paySalary('sal-1', payData, ADMIN_USER)).rejects.toThrow(BadRequestException)

    const whereArg: unknown = usersFindFirst.mock.calls[0]![0].where
    // Checked separately so an emptied `where` reads as "no predicate at all"
    // instead of an opaque TypeError from inside the compiler.
    expect(whereArg).toBeDefined()

    const { sql, params } = compileWhere(whereArg)
    expect(sql).toContain('"id" = $1')
    expect(params).toEqual([ARCHIVED_HR.id])
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

// ── MED-3 (round 2): the guard is re-asserted INSIDE the write ───────────────

describe('paySalary — MED-3: archival is re-asserted in the write, not only pre-read', () => {
  const SALARY_ROW = {
    id: 'sal-1',
    type: 'SALARY' as const,
    status: 'PENDING' as const,
    amount: '1500',
    currency: 'USD' as const,
    receiverId: ARCHIVED_HR.id,
    senderId: null,
    deletedAt: null,
    notes: null,
    createdBy: 'admin-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const PAYER_ADMIN = {
    id: 'admin-1',
    role: 'ADMIN' as const,
    displayName: 'Payer Admin',
    email: 'payer@test.spec',
    archivedAt: null,
  }

  /**
   * ADMIN_PERSONAL funding: the flip is one guarded UPDATE on the base
   * connection, so the statement's own WHERE is observable here. (The
   * COMPANY_ACCOUNT path applies the SAME predicate from the SAME private
   * helper, one line apart, but reaching its UPDATE means stubbing the advisory
   * lock and the balance computation; its real-DB behaviour is covered by
   * salary-funding-source.integration.spec.ts.)
   *
   * `usersFindFirst` is sequenced: call 1 = the receiver (pre-read gate),
   * call 2 = the payer admin, call 3 = the receiver again (the post-write
   * disambiguation). That order IS the race window under test.
   */
  function makePayService(receiverReads: unknown[], flippedRows: unknown[]) {
    let call = 0
    const usersFindFirst = vi.fn().mockImplementation(() => {
      call += 1
      if (call === 2) return Promise.resolve(PAYER_ADMIN)
      // 1st = pre-read gate, 3rd = post-write disambiguation.
      return Promise.resolve(call === 1 ? receiverReads[0] : receiverReads[1])
    })

    const updateWhere = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(flippedRows),
    })
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: updateWhere }),
    })

    const db = {
      db: {
        query: {
          transactions: { findFirst: vi.fn().mockResolvedValue(SALARY_ROW) },
          users: { findFirst: usersFindFirst },
        },
        // No `select` stub on purpose: the archival predicate is assembled by
        // the service through Drizzle's client-less `QueryBuilder`, so the SQL
        // the assertions below read is the REAL production SQL, not something a
        // test double shaped. (An earlier iteration built it via `db.select`;
        // stubbing that returned a dummy object and the sub-select compiled to
        // an opaque `not exists $3` — invisible. It also broke every other spec
        // that reaches paySalary, which is what moved it out of `db`.)
        update,
      },
    } as never

    return { svc: makeTransactionsService({ db }), updateWhere, usersFindFirst }
  }

  const payData = {
    fundingSource: 'ADMIN_PERSONAL' as const,
    payerAdminId: PAYER_ADMIN.id,
    currency: 'USDT' as const,
    receiptExternalUrl: 'https://etherscan.io/tx/0x' + 'a'.repeat(64),
  }

  it('carries the archival term in the UPDATE statement itself', async () => {
    // Receiver active throughout, but the write reports zero rows so the flow
    // stops before the invoice side-effects; what matters here is the SQL.
    const { svc, updateWhere } = makePayService([ACTIVE_HR, ACTIVE_HR], [])

    await expect(svc.paySalary('sal-1', payData, ADMIN_USER)).rejects.toThrow(BadRequestException)

    const whereArg: unknown = updateWhere.mock.calls[0]![0]
    expect(whereArg).toBeDefined()

    const { sql } = compileWhere(whereArg)
    // A pre-read cannot produce this: it only exists if the condition is part
    // of the write Postgres executes. Asserted as one contiguous fragment
    // INCLUDING the projection — the mutation gate showed why: a separate
    // `toContain('"users"."id"')` looked like it pinned the sub-select's
    // `select({ id: users.id })`, but that same string also appears in the
    // correlation below it, so emptying the projection to `{}` changed nothing
    // the assertion could see. This form fails on both.
    expect(sql).toContain('not exists (select "id" from "users"')
    // Correlated to THIS row's receiver — not a bare "is anyone archived" — and
    // keyed on archival.
    expect(sql).toContain('"users"."id" = "transactions"."receiver_id"')
    expect(sql).toContain('"users"."archived_at" is not null')
    // The pre-existing guards must survive the addition.
    expect(sql).toContain('"deleted_at" is null')
  })

  it('names archival as the reason when the receiver was archived mid-payment', async () => {
    // THE RACE: the pre-read saw an ACTIVE receiver (so the fast gate passed),
    // the archive committed, and the in-write guard rejected the UPDATE — zero
    // rows. The operator must be told what actually happened, not «not PENDING».
    const { svc } = makePayService([ACTIVE_HR, ARCHIVED_HR], [])

    await expect(svc.paySalary('sal-1', payData, ADMIN_USER)).rejects.toThrow(
      'Получатель зарплаты архивирован — выплата невозможна',
    )
  })

  it('still reports «not PENDING» when the miss was NOT about archival', async () => {
    // Same zero-row write, receiver active both times → the other cause (a
    // racing delete or a concurrent pay). The archival message must not be
    // borrowed to explain it.
    const { svc } = makePayService([ACTIVE_HR, ACTIVE_HR], [])

    await expect(svc.paySalary('sal-1', payData, ADMIN_USER)).rejects.toThrow(
      'Transaction is not PENDING',
    )
  })
})
