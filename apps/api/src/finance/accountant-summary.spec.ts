/**
 * Unit tests for TransactionsService.getAccountantSummary — RBAC guard only.
 *
 * Sprint 2 (task-accountant-s2-sql-kpi): the KPI math moved from an in-memory
 * `query.transactions.findMany()` + JS aggregation to a single SQL aggregating
 * `.select()` (conditional SUM/COUNT FILTER + COUNT DISTINCT). A mocked
 * `findMany` no longer reflects the production path, and finance math is only
 * honestly provable against a real DB — so the KPI-math cases that used to live
 * here were moved to `accountant-summary.integration.spec.ts` (real Postgres,
 * delta-based assertions over inserted rows).
 *
 * What stays here (DB-independent, fast, no Postgres):
 *   RBAC (AC3):
 *     - SENIOR / JUNIOR / HR / DROP → ForbiddenException, thrown BEFORE any DB
 *       access (the stub's `.select()` would throw if ever reached for these).
 *     - ACCOUNTANT / ADMIN → resolve (stub returns an empty aggregate row →
 *       the COALESCE-to-zero path, AC4).
 */
import { describe, expect, it } from 'vitest'
import type { SQL } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { compileWhere } from './__test-helpers__/drizzle-where-introspection'

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

/**
 * Shape of the single aggregation row returned by the SQL `.select().from()`
 * query inside `getAccountantSummary`. Explicit field names ensure that if the
 * production query renames a column the compiler surfaces the mismatch here
 * (unlike `Record<string, number>` which would silently accept any key).
 */
interface AggregateStubRow {
  /** COUNT of PENDING SENIOR_INCOME / DROP_INCOME rows */
  pendingCount: number
  /** SUM of amounts for pending income rows (raw numeric, cents or decimals) */
  pendingAmount: number
  /** COUNT of VALIDATED income rows whose validatedAt falls in the current month */
  validatedCount: number
  /** SUM of amounts for validated-this-month rows */
  validatedAmount: number
  /** SUM of amounts for PAID income/payout rows created in the current month */
  paidAmount: number
  /** COUNT(DISTINCT COALESCE(receiver_id, sender_id)) over income rows */
  recipientCount: number
}

/**
 * Minimal DatabaseService stub for the SQL `.select().from()` aggregating path.
 *
 * `aggregateRow` is what the single aggregation query resolves to. For RBAC
 * resolve-cases (ACCOUNTANT / ADMIN) we hand back an empty aggregate row (all
 * zeros) — that exercises the COALESCE-to-zero mapping (AC4) without a DB. For
 * the forbidden roles the guard throws first, so `.select()` is never invoked;
 * if it ever were (a regression moving the guard below the query), the stub
 * throws and the test fails loudly.
 */
function makeStub(
  aggregateRow: AggregateStubRow = {
    pendingCount: 0,
    pendingAmount: 0,
    validatedCount: 0,
    validatedAmount: 0,
    paidAmount: 0,
    recipientCount: 0,
  },
) {
  const dbStub = {
    db: {
      // task-soft-delete-and-money-audit (AC4): the SQL aggregate now chains
      // a trailing `.where(isNull(deletedAt))` after `.from()` — the stub
      // must mirror that shape or the real query throws
      // "…from(...).where is not a function".
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([aggregateRow]),
        }),
      }),
    },
  }
  return makeTransactionsService({ db: dbStub as never })
}

describe('getAccountantSummary — RBAC guard (AC3)', () => {
  const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'DROP']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for ${role} (before any DB access)`, async () => {
      // Stub whose `.select()` throws — proves the guard fires BEFORE the query.
      const throwingDb = {
        db: {
          select: () => {
            throw new Error('DB must not be queried for forbidden roles')
          },
        },
      }
      const svc = makeTransactionsService({ db: throwingDb as never })
      await expect(svc.getAccountantSummary(user(role))).rejects.toMatchObject({
        response: { code: 'FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN', statusCode: 403 },
      })
    })
  }

  it('resolves for ACCOUNTANT', async () => {
    const svc = makeStub()
    await expect(svc.getAccountantSummary(user('ACCOUNTANT'))).resolves.toBeDefined()
  })

  it('resolves for ADMIN', async () => {
    const svc = makeStub()
    await expect(svc.getAccountantSummary(user('ADMIN'))).resolves.toBeDefined()
  })

  it('maps an empty aggregate row to the zero-valued KPI shape (AC4)', async () => {
    const svc = makeStub()
    const r = await svc.getAccountantSummary(user('ACCOUNTANT'))
    expect(r).toEqual({
      pendingValidation: { count: 0, amount: 0 },
      validatedThisMonth: { count: 0, amount: 0 },
      paidThisMonth: { amount: 0 },
      recipientCount: 0,
    })
  })
})

/**
 * CR-809-H-2 — the `paidThisMonth` window must key on the BUSINESS date
 * (`coalesce(tx_date, created_at)`), not on `created_at`.
 *
 * Why this lives here as well as in the integration spec: Stryker excludes
 * every `*.integration.spec.ts` from discovery (see `vitest.config.mts`
 * `isIntegrationRun`), so a real-DB test — however honest — cannot kill a
 * mutant that swaps the window column back to `created_at`. The aggregate is
 * built as a real Drizzle SQL fragment even against a stubbed executor, so
 * compiling it reads the predicate the production query would send.
 */
describe('getAccountantSummary — paidThisMonth windows on the business date (CR-809-H-2)', () => {
  /** Capture the `.select()` field map the production query builds. */
  function captureSelect() {
    let fields: Record<string, SQL> | undefined
    const dbStub = {
      db: {
        select: (f: Record<string, SQL>) => {
          fields = f
          return {
            from: () => ({
              where: () =>
                Promise.resolve([
                  {
                    pendingCount: 0,
                    pendingAmount: 0,
                    validatedCount: 0,
                    validatedAmount: 0,
                    paidAmount: 0,
                    recipientCount: 0,
                  },
                ]),
            }),
          }
        },
      },
    }
    const svc = makeTransactionsService({ db: dbStub as never })
    return { svc, getFields: () => fields! }
  }

  it('filters the PAID sum on coalesce(tx_date, created_at), never on created_at alone', async () => {
    const { svc, getFields } = captureSelect()
    await svc.getAccountantSummary(user('ACCOUNTANT'))
    const { sql: text } = compileWhere(getFields().paidAmount)

    // The window term, read off the predicate Postgres would receive.
    expect(text).toContain('coalesce("transactions"."tx_date", "transactions"."created_at") >= $1')
    // And the pre-fix shape is gone. Post-fix `created_at` occurs ONLY inside
    // the coalesce, where it is followed by `)` — never by a comparison. This
    // assertion is what discriminates: it HELD before the fix too if written as
    // a lookbehind, so it is spelled as the literal pre-fix term instead.
    expect(text).not.toContain('"transactions"."created_at" >=')
  })

  it('binds exactly one month boundary into the PAID window', async () => {
    const { svc, getFields } = captureSelect()
    await svc.getAccountantSummary(user('ACCOUNTANT'))
    const { params } = compileWhere(getFields().paidAmount)
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    expect(params).toEqual([monthStart])
  })

  it('still keys validatedThisMonth on validatedAt — the business date must NOT leak there', async () => {
    const { svc, getFields } = captureSelect()
    await svc.getAccountantSummary(user('ACCOUNTANT'))
    const { sql: text } = compileWhere(getFields().validatedAmount)
    expect(text).toMatch(/"validated_at"\s*>=/i)
    expect(text).not.toMatch(/tx_date/i)
  })
})
