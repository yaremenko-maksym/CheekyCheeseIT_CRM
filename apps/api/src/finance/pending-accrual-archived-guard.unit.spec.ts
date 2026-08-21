/**
 * task-archive-pending-modal — AC1.
 *
 * THE RULE: a NEW `status='PENDING'` accrual row (a right to money not yet
 * earned) must never be minted for an archived person. Owner's framing:
 * salary, senior-income-with-unpaid-share, drop-income-with-unpaid-share —
 * three categories, `AC1` demands each one be provably restricted to active
 * employees.
 *
 * WHAT WAS ALREADY TRUE (verified by reading, not assumed):
 *   - `createMonthlySalaries` (the cron) — both branches already filter on
 *     `archivedAt` (HR/ACCOUNTANT via the query, JUNIOR via the loop) — pinned
 *     by `salary-archived-receiver.unit.spec.ts`.
 *   - `createSalary` (manual ADMIN/ACCOUNTANT-initiated) — already refuses an
 *     archived receiver inline — also pinned by that same file.
 *
 * WHAT WAS MISSING (round 1, fixed by this task): `createSeniorIncome` /
 * `createDropIncome` had NO archival check of their own — they relied
 * entirely on `JwtAuthGuard` rejecting an archived session. That guard's
 * role/archived cache has a 60s TTL (jwt.guard.ts), so a request already
 * in flight when an archive commits can still reach the write within that
 * window. Both methods now check the row they already load (`senior` /
 * `dropUser`) before doing anything else.
 *
 * WHAT WAS ALSO MISSING (round 2, security-review MED-1 + MED-3):
 * `updateSeniorIncome` / `updateDropIncome` resubmit a REJECTED row back to
 * `status: 'PENDING'` with a caller-supplied amount — the exact same "mints
 * a NEW entitlement" shape as the create-twins, and now gated the same way.
 * The scanner below originally MISSED both of them by design: it required a
 * sibling `type: '<LITERAL>'` literal within 20 lines to tell a
 * `transactions` write apart from `pending_obligations`'/`payoutRequests`'
 * OWN `status: 'PENDING'` literals — but an UPDATE payload never repeats
 * `type:` (the row's type does not change), so both real sites fell through
 * the same hole a `pending_obligations` write is deliberately excluded
 * through. Security review reproduced this on a synthetic file before it
 * was fixed. The scanner now keys off the actual WRITE TARGET (the nearest
 * enclosing `.insert(transactions)` or `replaceReceiptAtomic(` call,
 * searched backward) instead of a co-occurring literal.
 *
 * TWO PARTS BELOW:
 *   1. An ENUMERATING completeness scan (same technique as
 *      `archived-entitlement.unit.spec.ts`'s `collectUsersWriters`) — proves
 *      the FULL SET of `status='PENDING'` accrual sites in
 *      transactions.service.ts is exactly the 7 this task audited (5 INSERT
 *      + 2 resubmit-UPDATE), so a new unguarded 8th site fails this test by
 *      name instead of silently shipping.
 *   2. Behavioural red/green specs for the two create-methods round 1
 *      changed, plus the two update-methods round 2 changed.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { ForbiddenException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const SRC_FILE = path.resolve(import.meta.dirname, 'transactions.service.ts')

// backlog 73/A-3 (mutation-gate round 2): compiles a Drizzle `where` SQL
// object (e.g. `and(eq(transactions.type, 'SENIOR_INCOME'), eq(...)))`) down
// to its bound PARAMS array — `.toHaveProperty('where')` alone cannot tell a
// correct where-clause apart from `and(eq(transactions.type, ''), eq(...))`
// (a StringLiteral mutant): both are "defined" objects. Same technique as
// senior-drop-income-idempotency-schema.spec.ts (compile-and-compare against
// real Drizzle output, never a hand-typed restatement).
function whereParams(callArg: unknown): unknown[] {
  const where = (callArg as { where?: unknown } | undefined)?.where
  expect(where, 'expected a `where` clause on the findFirst call').toBeDefined()
  return new PgDialect().sqlToQuery(where as Parameters<PgDialect['sqlToQuery']>[0]).params
}

// ── Part 1: enumerating completeness ────────────────────────────────────────

/**
 * Every method in transactions.service.ts that inserts a `transactions` row
 * with a literal `status: 'PENDING'`, and why it is (or is not) an accrual
 * this task's rule applies to. Adding a row here is a deliberate act.
 */
const KNOWN_PENDING_ACCRUAL_SITES: Record<string, string> = {
  // Fixed round 1 (AC1) — see file docblock.
  createSeniorIncome: 'SENIOR_INCOME — now refuses an archived senior',
  createDropIncome: 'DROP_INCOME — now refuses an archived drop',
  // Already correct before this task — pinned by salary-archived-receiver.unit.spec.ts.
  createSalary: 'SALARY (manual) — already refuses archived receiver.role check',
  // Same method name appears TWICE — once per branch (HR/ACCOUNTANT query
  // filter, JUNIOR loop check). Both already correct; see that file too.
  createMonthlySalaries:
    'SALARY (cron) — HR/ACCOUNTANT + JUNIOR branches, both already archived-gated',
  // Fixed round 2 (security-review MED-1 + MED-3) — resubmit-UPDATE, not an
  // INSERT: REJECTED -> PENDING with a caller-supplied amount mints a NEW
  // entitlement exactly like the two create-methods above.
  updateSeniorIncome: 'SENIOR_INCOME resubmit — now refuses an archived receiver',
  updateDropIncome: 'DROP_INCOME resubmit — now refuses an archived receiver',
}

/**
 * Scans the file for `status: 'PENDING'` (or `'PENDING' as const`) literals
 * that belong to a `transactions` row write, and classifies each by its
 * ACTUAL WRITE TARGET rather than a co-occurring `type:` literal.
 *
 * security-review PR #584 round 2 (MED-3): the original version keyed off a
 * sibling `type: '<TRANSACTION_TYPE>'` literal within 20 lines to tell a
 * `transactions` INSERT apart from `pending_obligations`'/`payoutRequests`'
 * own `status: 'PENDING'` literals. That heuristic is right for every
 * INSERT in this file (`type:` is always set on a new row) but silently
 * wrong for an UPDATE that resubmits an existing row to PENDING — the type
 * never changes, so it is never repeated, and `updateSeniorIncome` /
 * `updateDropIncome` fell through the same hole `pending_obligations` is
 * deliberately excluded through. Reproduced on a synthetic file by security
 * review before this fix.
 *
 * Now: search BACKWARD from the `status: 'PENDING'` line for the nearest
 * enclosing write call —
 *   - `.insert(transactions)`            → a new row (round 1's two sites +
 *                                           createSalary + createMonthlySalaries).
 *   - `replaceReceiptAtomic(`            → a resubmit-UPDATE on `transactions`
 *                                           (round 2's two sites) — the only
 *                                           helper in this file that flips an
 *                                           existing row's status to PENDING.
 *   - `.insert(pendingObligations)` /
 *     `.insert(payoutRequests)`          → a DIFFERENT table's own PENDING
 *                                           literal — deliberately excluded.
 * First match wins (nearest, since the window is walked in reverse); no
 * match within the window excludes the line, same as before.
 *
 * Tracks the enclosing method the same way `archived-entitlement.unit.spec.ts`
 * does: 2-space class-member indentation, skip comments.
 */
function scanPendingAccrualSites(): Array<{ method: string; line: number }> {
  const METHOD =
    /^ {2}(?:private |public |protected |readonly |static )*(?:async )?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/
  // backlog 73/A-3: widened from an EXACT-match anchor
  // (`/^\s*status:\s*'PENDING'(\s+as const)?,\s*$/`) after this scanner broke
  // under Stryker's OWN instrumentation of THIS repo's mutation gate — verified
  // by hand in apps/api/.stryker-tmp/sandbox-*/src/finance/transactions.service.ts
  // during that task: any `status: 'PENDING'` LITERAL that falls inside a
  // changed-line range (per mutation-gate.mjs's --changed scoping) gets
  // rewritten by Stryker's AST printer to
  // `status: stryMutAct_XXXX("N") ? "" : (stryCov_XXXX("N"), 'PENDING'),` before
  // this test ever runs (Stryker's dry run executes the WHOLE suite against
  // its instrumented sandbox copy, not the original file) — the old anchored
  // regex requires 'PENDING' immediately after `status:`, so it silently
  // stopped matching the two sites this task's diff touches
  // (createSeniorIncome/createDropIncome), and the completeness assertion
  // failed with "the test suite itself is red before any mutation is
  // applied" (mutation-gate's own documented category — see
  // scripts/devops/mutation-gate-runbook.md), not a real regression. `status:`
  // still anchors the line (so an unrelated PENDING elsewhere on the same
  // line can't false-positive), but what comes between `status:` and the
  // `'PENDING'`/trailing `,` is now permissive — matches the plain form AND
  // the Stryker-wrapped ternary form identically. task-salary-month-gap-and-
  // status (mutation-gate AC6) hit the SAME phenomenon independently on a
  // DIFFERENT pair of sites (the new resolver methods further down this
  // file) and confirms this single permissive regex is sufficient — no
  // separate "unwrap the ternary first" preprocessing pass is needed.
  const STATUS_PENDING = /^\s*status:.*'PENDING'.*,\s*$/
  const INSERT_TRANSACTIONS = /\.insert\(\s*transactions\s*\)/
  const INSERT_OTHER_TABLE = /\.insert\(\s*(?:pendingObligations|payoutRequests)\s*\)/
  const RESUBMIT_UPDATE_CALL = /replaceReceiptAtomic\(/

  const lines = readFileSync(SRC_FILE, 'utf8').split('\n')
  const out: Array<{ method: string; line: number }> = []
  let method: string | null = null
  let inBlockComment = false

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      return
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true
      return
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return

    const methodMatch = METHOD.exec(line)
    if (methodMatch?.[1]) method = methodMatch[1]

    if (STATUS_PENDING.test(line)) {
      // 25 lines is generous for every site actually in this file (the
      // farthest is ~7 lines) while staying bounded.
      const window = lines.slice(Math.max(0, index - 25), index).reverse()
      let isAccrualSite = false
      for (const l of window) {
        if (INSERT_TRANSACTIONS.test(l) || RESUBMIT_UPDATE_CALL.test(l)) {
          isAccrualSite = true
          break
        }
        if (INSERT_OTHER_TABLE.test(l)) {
          isAccrualSite = false
          break
        }
      }
      if (isAccrualSite) {
        out.push({ method: method ?? '<top-level>', line: index + 1 })
      }
    }
  })
  return out
}

describe('transactions.service.ts — every PENDING-accrual site is accounted for (AC1)', () => {
  it('the discovered set of methods matches the inventory exactly', () => {
    const sites = scanPendingAccrualSites()
    const methodsFound = new Set(sites.map((s) => s.method))

    // Fails in both directions: an unlisted method is a new, unaudited
    // accrual site; a listed one that vanished means the inventory describes
    // code that is gone.
    expect([...methodsFound].sort()).toEqual(Object.keys(KNOWN_PENDING_ACCRUAL_SITES).sort())
  })

  it('createMonthlySalaries appears exactly twice (HR/ACCOUNTANT branch + JUNIOR branch)', () => {
    const sites = scanPendingAccrualSites()
    expect(sites.filter((s) => s.method === 'createMonthlySalaries')).toHaveLength(2)
  })

  it('the scan is not vacuous — it really finds createSeniorIncome', () => {
    const sites = scanPendingAccrualSites()
    expect(sites.some((s) => s.method === 'createSeniorIncome')).toBe(true)
    // Sanity on total count: 2 (income create) + 1 (manual salary) +
    // 2 (cron) + 2 (income resubmit-update, round 2 / MED-3) = 7.
    expect(sites).toHaveLength(7)
  })

  // security-review PR #584 round 2 (MED-3): the whole point of the fix —
  // these two used to be silently excluded because an UPDATE never repeats
  // a sibling `type:` literal. Name them explicitly so a regression back to
  // the old heuristic fails here, not just via the aggregate-count test
  // above (which a coincidental unrelated line count change could mask).
  it('the scan finds BOTH resubmit-UPDATE sites the type:-literal heuristic used to miss', () => {
    const sites = scanPendingAccrualSites()
    expect(sites.some((s) => s.method === 'updateSeniorIncome')).toBe(true)
    expect(sites.some((s) => s.method === 'updateDropIncome')).toBe(true)
  })
})

// ── Part 2: behavioural red/green for the two methods this task fixed ──────

const ACTIVE_SENIOR = {
  id: 'senior-1',
  role: 'SENIOR' as const,
  archivedAt: null as Date | null,
  seniorSharePercent: 26,
}
const ARCHIVED_SENIOR = {
  ...ACTIVE_SENIOR,
  archivedAt: new Date('2026-02-28T00:00:00.000Z'),
}

const ACTIVE_DROP = {
  id: 'drop-1',
  role: 'DROP' as const,
  archivedAt: null as Date | null,
  dropSharePercent: 5,
}
const ARCHIVED_DROP = {
  ...ACTIVE_DROP,
  archivedAt: new Date('2026-02-28T00:00:00.000Z'),
}

const SENIOR_PROJECT = {
  id: 'proj-1',
  seniorId: ACTIVE_SENIOR.id,
  dropId: null,
  paymentType: 'FOP' as const,
  companyName: 'Acme',
  seniorSharePercentOverride: null,
  financeSettings: null,
}

const DROP_PROJECT = {
  id: 'proj-2',
  seniorId: null,
  dropId: ACTIVE_DROP.id,
  paymentType: 'FOP' as const,
  companyName: 'Acme',
  dropSharePercentOverride: null,
}

const CURRENT_SENIOR_SESSION = {
  id: ACTIVE_SENIOR.id,
  role: 'SENIOR' as const,
  displayName: 'Senior One',
  email: 'senior@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const CURRENT_DROP_SESSION = {
  id: ACTIVE_DROP.id,
  role: 'DROP' as const,
  displayName: 'Drop One',
  email: 'drop@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 0,
}

describe('createSeniorIncome — AC1: an archived senior is refused before any INSERT', () => {
  function makeService(project: unknown, senior: unknown, onInsert?: () => never) {
    // backlog 73/A-3: createSeniorIncome's idempotency replay-SELECT
    // (`query.transactions.findFirst`) now runs BEFORE the archived guard
    // this file tests — default resolves to no-replay (undefined) so the
    // flow reaches the archived check/INSERT exactly as these AC1 cases
    // expect, same as a genuine first-time submit. Exposed (not inline) so
    // mutation-gate coverage (backlog 73/A-3 round 2) can assert the exact
    // call shape below — a fake that only checks the RESOLVED value can't
    // tell `findFirst({ where: and(eq(type,'SENIOR_INCOME'), eq(idempotencyKey,…)) })`
    // apart from `findFirst({})`, both resolving to whatever this mock
    // returns regardless of the argument.
    const transactionsFindFirst = vi.fn().mockResolvedValue(undefined)
    const db = {
      db: {
        query: {
          transactions: { findFirst: transactionsFindFirst },
          projects: { findFirst: vi.fn().mockResolvedValue(project) },
          users: { findFirst: vi.fn().mockResolvedValue(senior) },
          teamMembers: { findMany: vi.fn().mockRejectedValue(new Error('unstubbed')) },
        },
        insert:
          onInsert ??
          vi.fn(() => {
            throw new Error('INSERT REACHED')
          }),
      },
    } as never
    const svc = makeTransactionsService({ db })
    return { svc, transactionsFindFirst }
  }

  const payload = {
    projectId: SENIOR_PROJECT.id,
    amount: 1000,
    currency: 'USD',
    idempotencyKey: 'a1a1a1a1-1111-4111-8111-111111111111',
    receiptExternalUrl: 'https://drive.google.com/file/d/1abc/view',
  }

  it('refuses with the archived-receiver message; does not reach the INSERT', async () => {
    const { svc } = makeService(SENIOR_PROJECT, ARCHIVED_SENIOR)

    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toThrow(
      'Пользователь архивирован — доход не декларируется',
    )
    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('lets an ACTIVE senior through the gate (reaches the INSERT)', async () => {
    const { svc } = makeService(SENIOR_PROJECT, ACTIVE_SENIOR)

    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toThrow(
      'INSERT REACHED',
    )
  })

  it('replay-SELECT queries by (type=SENIOR_INCOME, idempotencyKey) — not an empty/wrong-literal read (backlog 73/A-3, mutation-gate)', async () => {
    const { svc, transactionsFindFirst } = makeService(SENIOR_PROJECT, ACTIVE_SENIOR)

    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toThrow(
      'INSERT REACHED',
    )

    expect(transactionsFindFirst).toHaveBeenCalledTimes(1)
    const callArg = transactionsFindFirst.mock.calls[0]?.[0]
    // Kills the ObjectLiteral->{} AND the StringLiteral->"" mutants on this
    // where-clause — an empty object or an emptied 'SENIOR_INCOME' literal
    // would compile to different (or no) bound params.
    expect(whereParams(callArg)).toEqual(['SENIOR_INCOME', payload.idempotencyKey])
  })

  it('same idempotencyKey returns the EXISTING row (early-SELECT hit) — never reaches the INSERT (backlog 73/A-3)', async () => {
    const existing = { id: 'existing-senior-income-1' }
    const { svc, transactionsFindFirst } = makeService(SENIOR_PROJECT, ACTIVE_SENIOR)
    transactionsFindFirst.mockResolvedValueOnce(existing)
    const findOneSpy = vi
      .spyOn(svc as unknown as { findOne: (id: string, u: unknown) => Promise<unknown> }, 'findOne')
      .mockResolvedValue('FOUND_EXISTING' as never)

    const result = await svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)

    expect(result).toBe('FOUND_EXISTING')
    expect(findOneSpy).toHaveBeenCalledWith(existing.id, CURRENT_SENIOR_SESSION)
  })

  it('a concurrent duplicate submit (genuine 23505 on the SENIOR_INCOME idempotency index) re-reads the committed winner instead of raising a 500 (backlog 73/A-3)', async () => {
    // Real pg errors carry `.code`/`.constraint` — `uniqueViolationConstraint`
    // walks the `.cause` chain for exactly this shape (see pg-errors.ts).
    const pgUniqueViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'uq_transactions_senior_income_idempotency_key',
    })
    const { svc, transactionsFindFirst } = makeService(SENIOR_PROJECT, ACTIVE_SENIOR, () => {
      throw pgUniqueViolation
    })
    const committed = { id: 'committed-senior-income-1' }
    // First call = early-SELECT (miss, undefined); second = catch-block re-read (hit).
    transactionsFindFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(committed)
    const findOneSpy = vi
      .spyOn(svc as unknown as { findOne: (id: string, u: unknown) => Promise<unknown> }, 'findOne')
      .mockResolvedValue('FOUND_COMMITTED' as never)

    const result = await svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)

    expect(result).toBe('FOUND_COMMITTED')
    expect(transactionsFindFirst).toHaveBeenCalledTimes(2)
    // Kills the ObjectLiteral->{} / StringLiteral->"" mutants on the
    // CATCH-BLOCK's own where-clause (a separate `and(eq(...), eq(...))`
    // literal from the early-SELECT's, one call earlier).
    const catchCallArg = transactionsFindFirst.mock.calls[1]?.[0]
    expect(whereParams(catchCallArg)).toEqual(['SENIOR_INCOME', payload.idempotencyKey])
    expect(findOneSpy).toHaveBeenCalledWith(committed.id, CURRENT_SENIOR_SESSION)
  })

  it('the constraint-name IF collides but NO committed row is found (should be unreachable in practice) → rethrows, never silently swallows (backlog 73/A-3, mutation-gate)', async () => {
    // Kills the ConditionalExpression->true mutant on `if (committed) return
    // …` — the other test above only ever exercises the TRUE branch (a row
    // IS found), so forcing the condition to a hardcoded `true` changes
    // nothing there. This scenario is genuinely `committed` falsy — the
    // real `if` must still fall through to `throw err` unchanged.
    const pgUniqueViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'uq_transactions_senior_income_idempotency_key',
    })
    const { svc, transactionsFindFirst } = makeService(SENIOR_PROJECT, ACTIVE_SENIOR, () => {
      throw pgUniqueViolation
    })
    transactionsFindFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)

    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toBe(
      pgUniqueViolation,
    )
  })

  it('an UNRELATED unique-violation (e.g. the receipt-document index) is rethrown, not misattributed as an idempotency race (backlog 73/A-3)', async () => {
    const unrelatedViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'uq_transactions_receipt_document_id',
    })
    const { svc } = makeService(SENIOR_PROJECT, ACTIVE_SENIOR, () => {
      throw unrelatedViolation
    })

    await expect(svc.createSeniorIncome(payload, CURRENT_SENIOR_SESSION)).rejects.toBe(
      unrelatedViolation,
    )
  })
})

describe('createDropIncome — AC1: an archived drop is refused before any INSERT', () => {
  function makeService(project: unknown, dropUser: unknown, onInsert?: () => never) {
    // backlog 73/A-3: same reasoning as createSeniorIncome's makeService
    // above — createDropIncome's replay-SELECT runs before the archived
    // guard; default no-replay lets these AC1 cases reach it unchanged.
    // Exposed for the same mutation-gate call-shape assertions.
    const transactionsFindFirst = vi.fn().mockResolvedValue(undefined)
    const db = {
      db: {
        query: {
          transactions: { findFirst: transactionsFindFirst },
          projects: { findFirst: vi.fn().mockResolvedValue(project) },
          users: { findFirst: vi.fn().mockResolvedValue(dropUser) },
        },
        insert:
          onInsert ??
          vi.fn(() => {
            throw new Error('INSERT REACHED')
          }),
      },
    } as never
    const svc = makeTransactionsService({ db })
    return { svc, transactionsFindFirst }
  }

  const payload = {
    projectId: DROP_PROJECT.id,
    amount: 500,
    currency: 'USD',
    idempotencyKey: 'd2d2d2d2-2222-4222-8222-222222222222',
    receiptExternalUrl: 'https://drive.google.com/file/d/2def/view',
  }

  it('refuses with the archived-receiver message; does not reach the INSERT', async () => {
    const { svc } = makeService(DROP_PROJECT, ARCHIVED_DROP)

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toThrow(
      'Пользователь архивирован — доход не декларируется',
    )
    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('lets an ACTIVE drop through the gate (reaches the INSERT)', async () => {
    const { svc } = makeService(DROP_PROJECT, ACTIVE_DROP)

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toThrow(
      'INSERT REACHED',
    )
  })

  it('does not fire when the drop user row failed to resolve (undefined, not archived)', async () => {
    // `dropUser` is looked up with no NotFoundException guard in the source —
    // `dropUser?.archivedAt` must not throw or false-positive on `undefined`.
    const { svc } = makeService(DROP_PROJECT, undefined)

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toThrow(
      'INSERT REACHED',
    )
  })

  it('replay-SELECT queries by (type=DROP_INCOME, idempotencyKey) — not an empty/wrong-literal read (backlog 73/A-3, mutation-gate)', async () => {
    const { svc, transactionsFindFirst } = makeService(DROP_PROJECT, ACTIVE_DROP)

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toThrow(
      'INSERT REACHED',
    )

    expect(transactionsFindFirst).toHaveBeenCalledTimes(1)
    const callArg = transactionsFindFirst.mock.calls[0]?.[0]
    expect(whereParams(callArg)).toEqual(['DROP_INCOME', payload.idempotencyKey])
  })

  it('same idempotencyKey returns the EXISTING row (early-SELECT hit) — never reaches the INSERT (backlog 73/A-3)', async () => {
    const existing = { id: 'existing-drop-income-1' }
    const { svc, transactionsFindFirst } = makeService(DROP_PROJECT, ACTIVE_DROP)
    transactionsFindFirst.mockResolvedValueOnce(existing)
    const findOneSpy = vi
      .spyOn(svc as unknown as { findOne: (id: string, u: unknown) => Promise<unknown> }, 'findOne')
      .mockResolvedValue('FOUND_EXISTING' as never)

    const result = await svc.createDropIncome(payload, CURRENT_DROP_SESSION)

    expect(result).toBe('FOUND_EXISTING')
    expect(findOneSpy).toHaveBeenCalledWith(existing.id, CURRENT_DROP_SESSION)
  })

  it('a concurrent duplicate submit (genuine 23505 on the DROP_INCOME idempotency index) re-reads the committed winner instead of raising a 500 (backlog 73/A-3)', async () => {
    const pgUniqueViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'uq_transactions_drop_income_idempotency_key',
    })
    const { svc, transactionsFindFirst } = makeService(DROP_PROJECT, ACTIVE_DROP, () => {
      throw pgUniqueViolation
    })
    const committed = { id: 'committed-drop-income-1' }
    transactionsFindFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(committed)
    const findOneSpy = vi
      .spyOn(svc as unknown as { findOne: (id: string, u: unknown) => Promise<unknown> }, 'findOne')
      .mockResolvedValue('FOUND_COMMITTED' as never)

    const result = await svc.createDropIncome(payload, CURRENT_DROP_SESSION)

    expect(result).toBe('FOUND_COMMITTED')
    expect(transactionsFindFirst).toHaveBeenCalledTimes(2)
    const catchCallArg = transactionsFindFirst.mock.calls[1]?.[0]
    expect(whereParams(catchCallArg)).toEqual(['DROP_INCOME', payload.idempotencyKey])
    expect(findOneSpy).toHaveBeenCalledWith(committed.id, CURRENT_DROP_SESSION)
  })

  it('the constraint-name IF collides but NO committed row is found (should be unreachable in practice) → rethrows, never silently swallows (backlog 73/A-3, mutation-gate)', async () => {
    const pgUniqueViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'uq_transactions_drop_income_idempotency_key',
    })
    const { svc, transactionsFindFirst } = makeService(DROP_PROJECT, ACTIVE_DROP, () => {
      throw pgUniqueViolation
    })
    transactionsFindFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toBe(
      pgUniqueViolation,
    )
  })

  it('an UNRELATED unique-violation (e.g. the receipt-document index) is rethrown, not misattributed as an idempotency race (backlog 73/A-3)', async () => {
    const unrelatedViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'uq_transactions_receipt_document_id',
    })
    const { svc } = makeService(DROP_PROJECT, ACTIVE_DROP, () => {
      throw unrelatedViolation
    })

    await expect(svc.createDropIncome(payload, CURRENT_DROP_SESSION)).rejects.toBe(
      unrelatedViolation,
    )
  })
})

// task-archive-pending-modal (round 2, security MED-1). `updateSeniorIncome` /
// `updateDropIncome` resubmit an existing REJECTED row back to PENDING with a
// caller-supplied amount — the same "mints a NEW entitlement" shape the two
// create-methods above already guard, on the resubmit path this task's
// round 1 missed entirely (see file docblock + MED-3).

const REJECTED_SENIOR_INCOME = {
  id: 'tx-senior-income-1',
  type: 'SENIOR_INCOME' as const,
  status: 'REJECTED' as const,
  receiverId: ACTIVE_SENIOR.id,
  receiptDocumentId: null,
  receiptExternalUrl: 'https://drive.google.com/file/d/1abc/view',
  amount: '1000',
  currency: 'USD',
  notes: null,
  deletedAt: null as Date | null,
}

const REJECTED_DROP_INCOME = {
  id: 'tx-drop-income-1',
  type: 'DROP_INCOME' as const,
  status: 'REJECTED' as const,
  receiverId: ACTIVE_DROP.id,
  receiptDocumentId: null,
  receiptExternalUrl: 'https://drive.google.com/file/d/2def/view',
  amount: '500',
  currency: 'USD',
  notes: null,
  deletedAt: null as Date | null,
}

describe('updateSeniorIncome — AC1/MED-1: an archived receiver is refused before any resubmit', () => {
  function makeService(receiver: unknown) {
    const usersFindFirst = vi.fn().mockResolvedValue(receiver)
    const db = {
      db: {
        query: {
          transactions: { findFirst: vi.fn().mockResolvedValue(REJECTED_SENIOR_INCOME) },
          users: { findFirst: usersFindFirst },
        },
      },
    } as never
    const svc = makeTransactionsService({ db })
    // `replaceReceiptAtomic` does its own receipt-swap/audit-log plumbing —
    // out of scope here. Spying it lets this test prove ONLY the ordering
    // question: does the archived-guard run before it.
    vi.spyOn(
      svc as unknown as { replaceReceiptAtomic: () => Promise<never> },
      'replaceReceiptAtomic',
    ).mockRejectedValue(new Error('REPLACE REACHED'))
    return { svc, usersFindFirst }
  }

  it('refuses with the archived-receiver message; does not reach the resubmit', async () => {
    const { svc } = makeService(ARCHIVED_SENIOR)

    await expect(
      svc.updateSeniorIncome(REJECTED_SENIOR_INCOME.id, {}, CURRENT_SENIOR_SESSION),
    ).rejects.toThrow('Пользователь архивирован — доход не декларируется')
    await expect(
      svc.updateSeniorIncome(REJECTED_SENIOR_INCOME.id, {}, CURRENT_SENIOR_SESSION),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('lets an ACTIVE senior through the gate (reaches the resubmit)', async () => {
    const { svc } = makeService(ACTIVE_SENIOR)

    await expect(
      svc.updateSeniorIncome(REJECTED_SENIOR_INCOME.id, { amount: 1200 }, CURRENT_SENIOR_SESSION),
    ).rejects.toThrow('REPLACE REACHED')
  })

  it('does not fire when the receiver row failed to resolve (undefined, not archived)', async () => {
    // Mirrors the createSeniorIncome/updateDropIncome test of the same name —
    // `receiver?.archivedAt` must not throw or false-positive on `undefined`.
    const { svc } = makeService(undefined)

    await expect(
      svc.updateSeniorIncome(REJECTED_SENIOR_INCOME.id, {}, CURRENT_SENIOR_SESSION),
    ).rejects.toThrow('REPLACE REACHED')
  })

  it("queries the CALLER's own row (WHERE eq(users.id, currentUser.id)), not an empty read", async () => {
    // security-review PR #584 round 2 (mutation-gate survivor): a fake that
    // only checks the RESOLVED value, never the query shape, cannot tell
    // `findFirst({ where: eq(users.id, currentUser.id) })` apart from
    // `findFirst({})` — both resolve to whatever the mock was told to
    // return regardless of the argument. Assert the call shape directly.
    const { svc, usersFindFirst } = makeService(ACTIVE_SENIOR)

    await expect(
      svc.updateSeniorIncome(REJECTED_SENIOR_INCOME.id, {}, CURRENT_SENIOR_SESSION),
    ).rejects.toThrow('REPLACE REACHED')

    expect(usersFindFirst).toHaveBeenCalledTimes(1)
    const callArg = usersFindFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(callArg).toBeDefined()
    expect(callArg).toHaveProperty('where')
    expect(callArg!.where).toBeDefined()
  })
})

describe('updateDropIncome — AC1/MED-1: an archived receiver is refused before any resubmit', () => {
  function makeService(receiver: unknown) {
    const usersFindFirst = vi.fn().mockResolvedValue(receiver)
    const db = {
      db: {
        query: {
          transactions: { findFirst: vi.fn().mockResolvedValue(REJECTED_DROP_INCOME) },
          users: { findFirst: usersFindFirst },
        },
      },
    } as never
    const svc = makeTransactionsService({ db })
    vi.spyOn(
      svc as unknown as { replaceReceiptAtomic: () => Promise<never> },
      'replaceReceiptAtomic',
    ).mockRejectedValue(new Error('REPLACE REACHED'))
    return { svc, usersFindFirst }
  }

  it('refuses with the archived-receiver message; does not reach the resubmit', async () => {
    const { svc } = makeService(ARCHIVED_DROP)

    await expect(
      svc.updateDropIncome(REJECTED_DROP_INCOME.id, {}, CURRENT_DROP_SESSION),
    ).rejects.toThrow('Пользователь архивирован — доход не декларируется')
    await expect(
      svc.updateDropIncome(REJECTED_DROP_INCOME.id, {}, CURRENT_DROP_SESSION),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('lets an ACTIVE drop through the gate (reaches the resubmit)', async () => {
    const { svc } = makeService(ACTIVE_DROP)

    await expect(
      svc.updateDropIncome(REJECTED_DROP_INCOME.id, { amount: 600 }, CURRENT_DROP_SESSION),
    ).rejects.toThrow('REPLACE REACHED')
  })

  it('does not fire when the receiver row failed to resolve (undefined, not archived)', async () => {
    // Mirrors the createDropIncome test of the same name — `dropReceiver?.archivedAt`
    // must not throw or false-positive on `undefined`.
    const { svc } = makeService(undefined)

    await expect(
      svc.updateDropIncome(REJECTED_DROP_INCOME.id, {}, CURRENT_DROP_SESSION),
    ).rejects.toThrow('REPLACE REACHED')
  })

  it("queries the CALLER's own row (WHERE eq(users.id, currentUser.id)), not an empty read", async () => {
    const { svc, usersFindFirst } = makeService(ACTIVE_DROP)

    await expect(
      svc.updateDropIncome(REJECTED_DROP_INCOME.id, {}, CURRENT_DROP_SESSION),
    ).rejects.toThrow('REPLACE REACHED')

    expect(usersFindFirst).toHaveBeenCalledTimes(1)
    const callArg = usersFindFirst.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(callArg).toBeDefined()
    expect(callArg).toHaveProperty('where')
    expect(callArg!.where).toBeDefined()
  })
})
