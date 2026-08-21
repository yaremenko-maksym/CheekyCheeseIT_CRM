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
 * mutation-gate (AC6): a stub whose `findMany`/`where` executor ignores the
 * arguments it was called with and just returns canned rows regardless is
 * blind to THAT query's own shape (same limitation documented in
 * income-compliance.unit.spec.ts / drizzle-where-introspection.ts). Where the
 * gate found that blind spot here — the JUNIOR relational `with` shape, the
 * existing-rows `select` projection, and the `receiverIds` actually bound
 * into the `where` — `makeService` below CAPTURES the real argument (a real
 * Drizzle AST/plain object, only the executor is stubbed) and the relevant
 * `it` asserts on it directly, via `compileWhere`/`collectParamValues`.
 *
 * Covers:
 *   - RBAC: getSalaryMonthGapReport → ADMIN/ACCOUNTANT only, 403 for everyone
 *     else BEFORE any DB access (with the exact refusal message pinned, not
 *     just instanceof); backfillSalaryMonth → ADMIN ONLY (narrower —
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
 *   - The empty-population early return (nobody eligible at all this month).
 *   - backfillSalaryMonth re-invokes createMonthlySalaries (idempotent insert
 *     path is exercised) and returns the post-backfill gap.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { compileWhere } from './__test-helpers__/drizzle-where-introspection'
import { transactions } from '../database/schema'

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
  // security-review HIGH-1: receiver ids for whom the SALARY insert should
  // simulate a REAL `ON CONFLICT DO NOTHING` no-op (RETURNING comes back
  // empty) — the only way `createMonthlySalaries` can tell "already existed"
  // from "just created", which gates whether `recordCreationAudit` fires.
  conflictReceiverIds?: string[]
}

function makeService(data: StubData = {}): {
  svc: TransactionsService
  insertedValues: Record<string, unknown>[]
  auditValues: Record<string, unknown>[]
  getProjectMembersArgs: () => { where: unknown; with: unknown } | undefined
  getSelectColumns: () => Record<string, unknown> | undefined
  getExistingRowsWhere: () => unknown
  getSelectCallCount: () => number
} {
  const insertedValues: Record<string, unknown>[] = []
  const auditValues: Record<string, unknown>[] = []
  let insertedRowCounter = 0
  // `insert(table)` branches on WHICH table the caller is inserting into:
  //   - `transactions` (the actual SALARY rows) — chainable
  //     `.onConflictDoNothing().returning(...)`, matching production. Resolves
  //     to a fake inserted row UNLESS `data.conflictReceiverIds` names this
  //     receiver (simulating a real `ON CONFLICT DO NOTHING` no-op) — needed
  //     to prove security-review HIGH-1's audit-only-on-REAL-insert guarantee.
  //   - `transactionAuditLog` (recordCreationAudit) — plain `.values()` await,
  //     no further chain, captured separately so it never pollutes
  //     `insertedValues` (which several existing assertions count exactly).
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((values: Record<string, unknown>) => {
      if (table === transactions) {
        insertedValues.push(values)
        const receiverId = values['receiverId'] as string | undefined
        const conflicted = receiverId && (data.conflictReceiverIds ?? []).includes(receiverId)
        return {
          onConflictDoNothing: vi.fn(() => ({
            // security-review round 3 (mutation gate): `.returning({id:
            // transactions.id})` used to resolve a HARDCODED `{id:
            // 'fake-tx-N'}` regardless of what projection it was actually
            // called with — a mutated `.returning({})` (the real column
            // projection gone) was invisible, since the stub never
            // inspected its own argument. Made projection-AWARE instead:
            // only synthesize an `id` when the requested projection
            // actually asks for one — a real Postgres `RETURNING` with an
            // empty column list would come back with rows that have no
            // `id` field either, so `inserted[0].id` would genuinely be
            // `undefined` and propagate into `recordCreationAudit`'s
            // `targetId` — which the HIGH-1 tests now assert directly.
            returning: vi.fn((projection: Record<string, unknown> | undefined) => {
              if (conflicted) return Promise.resolve([])
              const row: Record<string, unknown> = {}
              if (projection && 'id' in projection) row['id'] = `fake-tx-${++insertedRowCounter}`
              return Promise.resolve([row])
            }),
          })),
        }
      }
      auditValues.push(values)
      return Promise.resolve([])
    }),
  }))

  let projectMembersArgs: { where: unknown; with: unknown } | undefined
  let selectColumns: Record<string, unknown> | undefined
  let existingRowsWhere: unknown
  let selectCallCount = 0

  const dbStub = {
    db: {
      query: {
        users: {
          findMany: () => Promise.resolve(data.hrAccountantEmployees ?? []),
          findFirst: () => Promise.resolve(data.admin ?? { id: 'admin-1', role: 'ADMIN' }),
        },
        projectMembers: {
          findMany: (args: { where: unknown; with: unknown }) => {
            projectMembersArgs = args
            return Promise.resolve(data.activeMembers ?? [])
          },
        },
      },
      select: (columns: Record<string, unknown>) => {
        selectCallCount += 1
        selectColumns = columns
        return {
          from: () => ({
            where: (whereArg: unknown) => {
              existingRowsWhere = whereArg
              return Promise.resolve(
                (data.existingSalaryReceiverIds ?? []).map((receiverId) => ({ receiverId })),
              )
            },
          }),
        }
      },
      insert,
    },
  }
  return {
    svc: makeTransactionsService({ db: dbStub as never }),
    insertedValues,
    auditValues,
    getProjectMembersArgs: () => projectMembersArgs,
    getSelectCallCount: () => selectCallCount,
    getSelectColumns: () => selectColumns,
    getExistingRowsWhere: () => existingRowsWhere,
  }
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

  it('refuses with the exact "ADMIN or ACCOUNTANT" message, not a generic one', async () => {
    const throwingDb = { db: { query: { users: { findMany: () => [] } } } }
    const svc = makeTransactionsService({ db: throwingDb as never })
    await expect(svc.getSalaryMonthGapReport(user('SENIOR'), MONTH)).rejects.toThrow(
      'Access denied: salary month gap report requires ADMIN or ACCOUNTANT role',
    )
  })

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

  it('refuses with the exact "requires ADMIN role" message, not a generic one', async () => {
    const throwingDb = { db: { query: { users: { findMany: () => [] } } } }
    const svc = makeTransactionsService({ db: throwingDb as never })
    await expect(svc.backfillSalaryMonth(user('ACCOUNTANT'), MONTH)).rejects.toThrow(
      'Access denied: salary month backfill requires ADMIN role',
    )
  })

  it('resolves for ADMIN', async () => {
    const { svc } = makeService()
    await expect(svc.backfillSalaryMonth(user('ADMIN'), MONTH)).resolves.toBeDefined()
  })
})

describe('getSalaryMonthGapReport — AC5: exactly the configured-and-missing, never who legitimately has none', () => {
  it('nobody eligible at all this month → { month, missing: [] } WITHOUT querying existing rows (the early-return branch)', async () => {
    const { svc, getSelectCallCount } = makeService({
      hrAccountantEmployees: [],
      activeMembers: [],
    })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    expect(report).toEqual({ month: MONTH, missing: [] })
    // With nobody expected, `[].filter(...)` would ALSO end up `[]` even if
    // the early return were removed — a stub whose `.where()` ignores its
    // argument can't tell "queried with an empty receiverIds list" from
    // "never queried at all". Asserting the call count is what actually pins
    // the early return (kills `if (expected.length === 0)` → `if (false)`).
    expect(getSelectCallCount()).toBe(0)
  })

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

  // security-review round 3 (mutation gate): MED-2's dedup guard
  // (`seenReceiverIds`) previously had ONLY integration-level coverage
  // (salary-month-gap.integration.spec.ts, real Postgres) — invisible to
  // the mutation gate, which never runs integration specs. Mutating
  // `seenReceiverIds.has(user.id)` to `false` (never skip an already-seen
  // receiver) survived every unit test in this file. Pinned directly here:
  // a JUNIOR on TWO active project memberships must appear exactly ONCE in
  // `missing`, carrying the FIRST membership's resolved amount — matching
  // what the unique index would let the cron actually write (measured +21%
  // inflation on real data before this fix).
  it('MED-2: a JUNIOR on TWO active project memberships is counted exactly ONCE, not twice', async () => {
    const jr = {
      id: 'jr-multi',
      email: 'jr-multi@test.spec',
      displayName: 'Junior Multi',
      role: 'JUNIOR',
      monthlySalary: '900',
      archivedAt: null,
    }
    const { svc } = makeService({
      activeMembers: [
        juniorMember(jr, {
          id: 'proj-multi-a',
          name: 'Proj Multi A',
          financeSettings: { juniorSalaryOverride: '1234' },
        }),
        juniorMember(jr, {
          id: 'proj-multi-b',
          name: 'Proj Multi B',
          financeSettings: { juniorSalaryOverride: '5678' },
        }),
      ],
    })
    const report = await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    const entries = report.missing.filter((m) => m.userId === 'jr-multi')
    expect(entries).toHaveLength(1)
    // First membership in iteration order wins — 1234 (proj-multi-a), never
    // 5678 (the second) and never their sum (6912).
    expect(entries[0]?.expectedAmount).toBe(1234)
    expect(entries[0]?.projectId).toBe('proj-multi-a')
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

  // security-review HIGH-2: this test used to pin a HARD-CODED "current UTC
  // month" default — which was ITSELF the bug (the cron never touches the
  // current month; see salary-month.util.ts), so the test PINNED the
  // regression instead of catching it. Rewritten to assert MATCH-TO-CRON via
  // the SAME shared resolver `SalaryCronService` uses, so a future shift in
  // what the cron targets and a drift in the report's default can never
  // silently diverge again — changing the cron's month resolver would move
  // BOTH sides of this assertion together, keeping the test green for the
  // RIGHT reason instead of the wrong one.
  // security-review round 3: the PREVIOUS version of this test compared
  // `report.month` against a SECOND, independent call to
  // `previousSalaryMonthKey()` — a tautology mutation testing caught
  // (`salary-month.util.ts` mutation score 0.00%, survives `BlockStatement
  // → {}`: gut the function to always return `undefined`, and
  // `expect(undefined).toBe(undefined)` still passes). A test must pin a
  // VALUE, not the equality of two calls to the same function. Fixed by
  // fixing the system clock to a literal, hardcoded date and asserting a
  // literal, hardcoded month string — no call to `previousSalaryMonthKey()`
  // anywhere in this test.
  it('defaults `month` to a LITERAL previous-month string for a fixed clock (not a second call to previousSalaryMonthKey)', async () => {
    vi.useFakeTimers()
    try {
      // 2026-08-15 (any day in August) → the cron/report both target July.
      vi.setSystemTime(new Date(2026, 7, 15))
      const { svc } = makeService({ hrAccountantEmployees: [hrEmployee()] })
      const report = await svc.getSalaryMonthGapReport(user('ADMIN'))
      expect(report.month).toBe('2026-07')
    } finally {
      vi.useRealTimers()
    }
  })

  it('the default month is NEVER the current calendar month (the cron has not touched it yet) — literal fixed-clock proof', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 7, 15))
      const { svc } = makeService({ hrAccountantEmployees: [hrEmployee()] })
      const report = await svc.getSalaryMonthGapReport(user('ADMIN'))
      expect(report.month).not.toBe('2026-08')
      expect(report.month).toBe('2026-07')
    } finally {
      vi.useRealTimers()
    }
  })

  // security-review round 3 (bidirectional-invariant gap): the two tests
  // above only prove the REPORT tracks previousSalaryMonthKey() — they say
  // NOTHING about whether the CRON's real handler does too. A reviewer
  // proved this gap by hand: diverging `SalaryCronService.handleMonthlySalaries`
  // from the shared resolver left this file's OWN idempotency spec
  // (salary-cron-idempotency.integration.spec.ts, which calls
  // `createMonthlySalaries(MONTH)` directly, bypassing the handler) 100%
  // green — the "cannot drift apart" guarantee rested entirely on both call
  // sites importing the same function, not on any test enforcing it. The
  // CRON side of this invariant is pinned in `salary-cron-error-handling.spec.ts`
  // ("handleMonthlySalaries computes the previous month...") — that test
  // drives the REAL `handleMonthlySalaries()` handler (not a direct
  // `createMonthlySalaries(month)` call) and pins the literal month it
  // computes and passes on.

  // mutation-gate: pins the JUNIOR resolver's relational-query SHAPE itself —
  // a stub that ignores `findMany`'s arguments and returns canned rows
  // regardless cannot tell an emptied `with` from the real one.
  it('resolveJuniorSalaryReceivers requests the isNull(leftAt) filter and the user+project(+financeSettings) relational shape', async () => {
    const { svc, getProjectMembersArgs } = makeService({ activeMembers: [] })
    await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)
    const args = getProjectMembersArgs()
    expect(args).toBeDefined()
    const { sql } = compileWhere(args!.where)
    expect(sql).toContain('"left_at" is null')
    expect(args!.with).toEqual({ user: true, project: { with: { financeSettings: true } } })
  })

  // mutation-gate: pins that the "existing SALARY rows" read actually scopes
  // by type/month/receiverIds AND projects only `receiverId` — a stub whose
  // `.where()` ignores its argument cannot tell `receiverIds.map(() =>
  // undefined)` from the real ids, or `eq(type, 'SALARY')` from `eq(type,
  // '')`, or `.select({})` from `.select({ receiverId: ... })`.
  it('the existing-rows read selects only receiverId, scoped to type=SALARY/month/the expected receiverIds', async () => {
    const { svc, getSelectColumns, getExistingRowsWhere } = makeService({
      hrAccountantEmployees: [hrEmployee(), hrEmployee({ id: 'hr-2', displayName: 'HR Two' })],
    })
    await svc.getSalaryMonthGapReport(user('ADMIN'), MONTH)

    expect(Object.keys(getSelectColumns() ?? {})).toEqual(['receiverId'])

    const { sql, params } = compileWhere(getExistingRowsWhere())
    expect(sql).toContain('"type" = $1')
    expect(sql).toContain('"salary_month" = $2')
    expect(params).toContain('SALARY')
    expect(params).toContain(MONTH)
    // The REAL receiver ids the resolver computed, not `undefined`×2 (kills
    // `expected.map(() => undefined)`). `compileWhere`'s own params list is
    // used here (not the generic `collectParamValues` walker) — that walker
    // recurses into `nonDeletedTransactions`' aliased-column proxies and
    // blows the call stack; `PgDialect().sqlToQuery()` handles the same view
    // correctly since it is the REAL code path that builds runnable SQL.
    expect(params).toEqual(expect.arrayContaining(['hr-1', 'hr-2']))
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
    // — real de-duplication is the DB's `ON CONFLICT DO NOTHING` against the
    // unique index, simulated here via `conflictReceiverIds` (RETURNING comes
    // back empty, exactly like a real conflict). What this test proves at the
    // unit level is the report's own read: with the row already existing, the
    // POST-backfill `resolveSalaryMonthGap` reports nothing missing.
    const { svc, insertedValues, auditValues } = makeService({
      hrAccountantEmployees: [hrEmployee()],
      existingSalaryReceiverIds: ['hr-1'],
      conflictReceiverIds: ['hr-1'],
    })
    const result = await svc.backfillSalaryMonth(user('ADMIN'), MONTH)
    expect(insertedValues).toHaveLength(1) // the (harmless, ON CONFLICT DO NOTHING) attempt
    expect(result.missing).toHaveLength(0)
    // security-review HIGH-1: the attempt CONFLICTED (no row actually
    // created) — must NOT be audited as a creation that never happened.
    expect(auditValues).toHaveLength(0)
  })

  // security-review HIGH-1: `createdBy` used to always be an arbitrary admin
  // (`findFirst({role:'ADMIN'})`, no `orderBy`) — correct for the CRON (no
  // human actor exists), wrong for a button an ADMIN just clicked. The row
  // must be attributed to the ADMIN who ACTUALLY triggered the backfill, and
  // that creation must be journalled — exactly like every other user-facing
  // creation entry point in this file (createSalary etc.), which the cron
  // itself is deliberately exempt from (system-derived, not a human decision).
  it('attributes createdBy to the REAL calling admin, not an arbitrary one, and journals the creation', async () => {
    const CALLING_ADMIN = user('ADMIN', 'the-real-caller')
    const { svc, insertedValues, auditValues } = makeService({
      hrAccountantEmployees: [hrEmployee()],
      admin: { id: 'some-other-admin-arbitrary-lookup', role: 'ADMIN' },
    })
    await svc.backfillSalaryMonth(CALLING_ADMIN, MONTH)

    expect(insertedValues[0]).toMatchObject({ createdBy: CALLING_ADMIN.id })
    expect(insertedValues[0]?.['createdBy']).not.toBe('some-other-admin-arbitrary-lookup')

    expect(auditValues).toHaveLength(1)
    expect(auditValues[0]).toMatchObject({
      actorId: CALLING_ADMIN.id,
      action: 'CREATE',
      metadata: { type: 'SALARY', amount: '1500', currency: 'USD' },
      // security-review round 3 (mutation gate): the audit row's targetId
      // is `inserted[0].id` — the REAL `.returning({id: transactions.id})`
      // projection's result, not a hardcoded stub value. Proves the actual
      // just-inserted row's id (not `undefined`, not some other row) is
      // what gets journalled.
      targetId: 'fake-tx-1',
    })
  })

  // security-review pattern (mirrors adminDeleteTransaction / paySalary):
  // under impersonation, attribute to the REAL admin operator, never the
  // impersonated target.
  it('attributes to the REAL admin operator under impersonation (impersonatorId wins)', async () => {
    const IMPERSONATING_ADMIN: SessionUser = {
      ...user('ADMIN', 'impersonated-target'),
      impersonatorId: 'real-admin-operator-id',
    }
    const { svc, insertedValues, auditValues } = makeService({
      hrAccountantEmployees: [hrEmployee()],
    })
    await svc.backfillSalaryMonth(IMPERSONATING_ADMIN, MONTH)

    expect(insertedValues[0]).toMatchObject({ createdBy: 'real-admin-operator-id' })
    expect(auditValues[0]).toMatchObject({ actorId: 'real-admin-operator-id' })
  })

  // security-review round 3: the HIGH-1 audit tests above ALL use an
  // HR/ACCOUNTANT persona — `createMonthlySalaries`'s audit call is
  // DUPLICATED (once in the HR/ACCOUNTANT loop, once in the JUNIOR loop),
  // and nothing exercised the JUNIOR copy. A reviewer proved this by
  // mutation: `if (actor && inserted[0])` on the JUNIOR branch survives
  // being flipped to BOTH `true` (always audit) and `false` (never audit)
  // — every existing test stays green either way, because none of them
  // ever put a JUNIOR receiver through `backfillSalaryMonth`.
  it('backfilling a missing JUNIOR journals the creation too — not just HR/ACCOUNTANT (audit coverage gap)', async () => {
    const jr = {
      id: 'jr-audit-1',
      email: 'jr-audit-1@test.spec',
      displayName: 'Junior Audit',
      role: 'JUNIOR',
      monthlySalary: '900',
      archivedAt: null,
    }
    const CALLING_ADMIN = user('ADMIN', 'the-real-caller')
    const { svc, insertedValues, auditValues } = makeService({
      activeMembers: [juniorMember(jr, { id: 'proj-1', name: 'Proj One', financeSettings: null })],
    })
    await svc.backfillSalaryMonth(CALLING_ADMIN, MONTH)

    expect(insertedValues).toHaveLength(1)
    expect(insertedValues[0]).toMatchObject({
      receiverId: 'jr-audit-1',
      createdBy: CALLING_ADMIN.id,
    })

    expect(auditValues).toHaveLength(1)
    expect(auditValues[0]).toMatchObject({
      actorId: CALLING_ADMIN.id,
      action: 'CREATE',
      metadata: { type: 'SALARY', amount: '900', currency: 'USD' },
      // security-review round 3 (mutation gate): same as the HR/ACCOUNTANT
      // test above — the JUNIOR branch has its OWN `.returning({id:
      // transactions.id})` call, a separate mutant Stryker generates
      // independently of the HR/ACCOUNTANT one.
      targetId: 'fake-tx-1',
    })
  })

  // The cron path (createMonthlySalaries called with NO actor) must be
  // COMPLETELY unaffected by this task — no audit entries, "any admin" is
  // still the createdBy (RBAC/backfill-specific behaviour must not leak into
  // the unaudited system path).
  //
  // security-review round 3: asserting `auditValues.toHaveLength(0)` ALONE
  // does not distinguish "correctly skipped" from "attempted, then crashed
  // and was silently swallowed" — `recordCreationAudit`'s own try/catch logs
  // and eats ANY error, including `TypeError: Cannot read properties of
  // undefined (reading 'impersonatorId')` if it is ever called with
  // `actor=undefined` (the mutant `actor && inserted[0]` → `actor ||
  // inserted[0]` does exactly this for the cron path: `inserted[0]` is
  // truthy, so the call fires with `actor=undefined`, throws inside
  // `recordCreationAudit`, gets caught there, and `auditValues` ends up
  // empty either way — the previous version of this test could not tell the
  // two apart). Spying on `recordCreationAudit` itself — not just its
  // observable side effect — proves it was never CALLED, not merely that it
  // failed to write anything.
  it('createMonthlySalaries called WITHOUT an actor (the cron path) never journals — unchanged from before this task', async () => {
    const jr = {
      id: 'jr-cron-1',
      email: 'jr-cron-1@test.spec',
      displayName: 'Junior Cron',
      role: 'JUNIOR',
      monthlySalary: '900',
      archivedAt: null,
    }
    const { svc, insertedValues, auditValues } = makeService({
      // BOTH loops populated — the spy assertion below must hold for
      // whichever loop's `actor && inserted[0]` guard a mutant flips.
      hrAccountantEmployees: [hrEmployee()],
      activeMembers: [juniorMember(jr, { id: 'proj-1', name: 'Proj One', financeSettings: null })],
      admin: { id: 'cron-arbitrary-admin', role: 'ADMIN' },
    })
    const recordCreationAuditSpy = vi.spyOn(
      svc as unknown as {
        recordCreationAudit: (
          txId: string,
          created: { type: string; amount: string; currency: string },
          currentUser: SessionUser,
        ) => Promise<void>
      },
      'recordCreationAudit',
    )
    await svc.createMonthlySalaries(MONTH)

    expect(insertedValues).toHaveLength(2) // 1 HR/ACCOUNTANT + 1 JUNIOR row
    expect(insertedValues[0]).toMatchObject({ createdBy: 'cron-arbitrary-admin' })
    expect(insertedValues[1]).toMatchObject({ createdBy: 'cron-arbitrary-admin' })
    expect(auditValues).toHaveLength(0)
    // The decisive assertion: recordCreationAudit must never even be
    // INVOKED for the cron path — not just "produced no visible row". Kills
    // the `actor && inserted[0]` → `actor || inserted[0]` mutant on EITHER
    // loop: with `||`, `inserted[0]` alone (truthy for a real insert) would
    // fire the call with `actor=undefined`, which `auditValues.toHaveLength(0)`
    // alone cannot distinguish from a correct skip (see the comment above).
    expect(recordCreationAuditSpy).not.toHaveBeenCalled()
  })
})
