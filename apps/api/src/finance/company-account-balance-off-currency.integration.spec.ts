import { drizzle } from 'drizzle-orm/node-postgres'
import { inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  computeCompanyAccountBalanceForDisplay,
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'
import { withIsolatedOffCurrencyRow } from './__test-helpers__/off-currency-fixture'
import { hasDatabaseUrl } from '../test/require-real-db'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * C-3 (mega-audit wave 2, AC8) — company-account off-currency integrity
 * (real Postgres, no mocks).
 *
 * `computeCompanyAccountBalanceFromLedger`'s 8 SUM terms each filter on
 * `currency='USDT'` (defence-in-depth on the NUMBER), but a company-shaped
 * row booked in a DIFFERENT currency used to just fall out of every SUM
 * silently — no error, no log, the balance simply omitted money the ledger
 * says belongs to the company. This spec proves the row is now caught with a
 * loud rejection instead (see `assertNoOffCurrencyCompanyRows` in
 * company-account-balance.ts).
 *
 * Run against the scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@127.0.0.1:5432/crm_qa \
 *     pnpm --filter @crm/api test -- company-account-balance-off-currency.integration
 */

const ADMIN_ID = 'cb110000-0000-4000-aa00-000000000001'
const TEST_USER_IDS = [ADMIN_ID]

let _pool: Pool | null = null
let db: ReturnType<typeof drizzle<typeof schema>>

// Spec-namespaced transaction ids so cleanup is surgical and never touches
// another spec's rows sharing the same crm_qa database.
const TX_OFF_CURRENCY_EXPENSE = 'cb110000-0000-4000-cc00-000000000001'
const TX_OK_DEPOSIT = 'cb110000-0000-4000-cc00-000000000002'
// task-cascade-apply (AC9): rows for the SECOND branch of the guard — the
// reverted-IOU class ledger term 9 introduces.
const TX_REVERTED_OFF_CURRENCY = 'cb110000-0000-4000-cc00-000000000003'
const TX_FRESH_IOU = 'cb110000-0000-4000-cc00-000000000004'
const TX_SETTLED_OK = 'cb110000-0000-4000-cc00-000000000005'
const TX_REVERTED_UNLABELLED = 'cb110000-0000-4000-cc00-000000000006'
const TEST_TX_IDS = [
  TX_OFF_CURRENCY_EXPENSE,
  TX_OK_DEPOSIT,
  TX_REVERTED_OFF_CURRENCY,
  TX_FRESH_IOU,
  TX_SETTLED_OK,
  TX_REVERTED_UNLABELLED,
]

async function clearFixtures() {
  await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
}

// SEC-1 (mega-audit wave 2, round 4): the isolation helper (session advisory
// lock so a concurrent gate call in this OR another agent's process blocks
// instead of observing this row and failing) now lives in
// __test-helpers__/off-currency-fixture.ts — shared with
// company-account-ledger.integration.spec.ts's createExpense/paySalary
// behavioural gate tests. See that file's docstring for the full rationale.

describe.skipIf(!hasDatabaseUrl())(
  'C-3: computeCompanyAccountBalanceFromLedger — off-currency company row (real DB, no mocks)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        const check = await probe.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name='transactions' AND column_name='funding_source' LIMIT 1`,
        )
        await probe.end()
        if (check.rowCount === 0) {
          throw new Error(
            '[company-account-balance-off-currency] FAILED — schema not present (funding_source)',
          )
        }
      } catch {
        throw new Error(
          '[company-account-balance-off-currency] FAILED — no DB reachable at DATABASE_URL',
        )
      }

      _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      db = drizzle(_pool, { schema })

      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      await db
        .insert(users)
        .values({
          id: ADMIN_ID,
          email: 'cb-admin@test.spec',
          displayName: 'CB Admin',
          role: 'ADMIN',
          googleId: `test-google-${ADMIN_ID}`,
        })
        .onConflictDoNothing()

      await clearFixtures()
    }, 30_000)

    beforeEach(async () => {
      await clearFixtures()
    })

    afterAll(async () => {
      try {
        await clearFixtures()
        await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // non-fatal
      }
      await _pool?.end()
    }, 15_000)

    it('AC8: a PAID company-account row in a non-USDT currency is rejected loudly, not silently dropped', async () => {
      // A company-funded EXPENSE (fundingSource=COMPANY_ACCOUNT) booked in UAH —
      // the write path is SUPPOSED to hardcode USDT; this row simulates the ONE
      // future-bug scenario C-3 is about (a write path that forgets to).
      await withIsolatedOffCurrencyRow(
        _pool!,
        db,
        {
          id: TX_OFF_CURRENCY_EXPENSE,
          type: 'EXPENSE',
          status: 'PAID',
          amount: '250',
          currency: 'UAH',
          senderId: ADMIN_ID,
          fundingSource: 'COMPANY_ACCOUNT',
          createdBy: ADMIN_ID,
        },
        async () => {
          // task-cascade-apply (AC9) reworded this message: since the guard
          // also matches rows in PENDING_PAYMENT (whose off-currency label
          // lives in `settled_currency`), it may no longer claim every hit is
          // PAID or that the offending column is always `currency`.
          await expect(computeCompanyAccountBalanceFromLedger(db)).rejects.toThrow(
            /currency label is not USDT/i,
          )
        },
      )
    })

    /**
     * task-cascade-apply, AC9 / addendum §1.8 (spec-review SPEC-M-2).
     *
     * Ledger term 9 introduces a NEW class of company-shaped row —
     * `*_PENDING_PAYOUT` + `funding_source='COMPANY_ACCOUNT'` — and the term
     * filters it on `settled_currency='USDT'`. A row of that class carrying a
     * foreign label would drop out of the balance exactly as silently as the
     * rows the original branch exists to catch, so the guard grew a second
     * branch to cover it.
     *
     * WHY THESE TESTS EXIST AT ALL: the unit spec
     * (`company-account-balance-currency.spec.ts`) can only inspect the
     * COMPILED SQL of that branch — a string, not a behaviour. Whether a given
     * ROW matches is a question only Postgres can answer, and a mocked db does
     * not answer it. The unit comment used to CLAIM this row-matching half
     * lived here while it did not; the claim was worse than the gap, because
     * the next reader would have believed it. These are the tests it promised.
     *
     * The general lesson, worth keeping: a test over an aggregate checks the
     * aggregate's ARITHMETIC, not its SELECTION. Positional sums catch a wrong
     * sign or a missing term; which rows land in the SUM is between the query
     * and the database.
     */
    it('AC9: a reverted company IOU whose settled_currency is NOT USDT is caught (real row)', async () => {
      await withIsolatedOffCurrencyRow(
        _pool!,
        db,
        {
          id: TX_REVERTED_OFF_CURRENCY,
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: '260',
          // `currency` is deliberately USDT — the ONLY thing wrong with this
          // row is the label on the column term 9 actually sums. The original
          // branch of the guard cannot see it (it wants status = PAID).
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          settledAmount: '260',
          settledCurrency: 'UAH',
          receiverId: ADMIN_ID,
          createdBy: ADMIN_ID,
        },
        async () => {
          await expect(computeCompanyAccountBalanceFromLedger(db)).rejects.toThrow(
            /currency label is not USDT/i,
          )
        },
      )
    })

    it('AC9: "no label at all" counts as suspect too — an unlabelled accumulator is caught', async () => {
      // `settled_currency IS NULL` is inside the condition on purpose: "there
      // is no label" is not "the label matches".
      await withIsolatedOffCurrencyRow(
        _pool!,
        db,
        {
          id: TX_REVERTED_UNLABELLED,
          type: 'DROP_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: '100',
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          settledAmount: '100',
          settledCurrency: null,
          receiverId: ADMIN_ID,
          createdBy: ADMIN_ID,
        },
        async () => {
          await expect(computeCompanyAccountBalanceFromLedger(db)).rejects.toThrow(
            /currency label is not USDT/i,
          )
        },
      )
    })

    it('AC9: the two shapes the CURRENT code really produces do NOT trip the guard', async () => {
      // This is the half that matters for not breaking production: the new
      // branch must be inert against every row today's write paths can create.
      //
      //  1. A freshly booked IOU: PENDING_PAYMENT, funding_source NULL (the
      //     column is absent from `bookCompanyObligations`' insert), no
      //     accumulator. Not company money yet.
      //  2. A row after the settle flip: PAID, COMPANY_ACCOUNT, USDT on both
      //     the currency and the accumulator label.
      await db.insert(transactions).values([
        {
          id: TX_FRESH_IOU,
          type: 'SENIOR_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: '260',
          currency: 'USDT',
          fundingSource: null,
          settledAmount: null,
          settledCurrency: null,
          receiverId: ADMIN_ID,
          createdBy: ADMIN_ID,
        },
        {
          id: TX_SETTLED_OK,
          type: 'SENIOR_INCOME',
          status: 'PAID',
          amount: '260',
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          settledAmount: '260',
          settledCurrency: 'USDT',
          receiverId: ADMIN_ID,
          createdBy: ADMIN_ID,
        },
      ])

      await expect(computeCompanyAccountBalanceFromLedger(db)).resolves.toEqual(expect.any(Number))
    })

    it('AC9: a reverted IOU with a ZERO accumulator is not company money and does not trip the guard', async () => {
      // The `settled_amount IS NOT NULL AND <> 0` narrowing: a row that never
      // actually took money out of the account has nothing to misreport.
      await db.insert(transactions).values({
        id: TX_REVERTED_UNLABELLED,
        type: 'SENIOR_PENDING_PAYOUT',
        status: 'PENDING_PAYMENT',
        amount: '0',
        currency: 'USDT',
        fundingSource: 'COMPANY_ACCOUNT',
        settledAmount: '0',
        settledCurrency: null,
        receiverId: ADMIN_ID,
        createdBy: ADMIN_ID,
      })

      await expect(computeCompanyAccountBalanceFromLedger(db)).resolves.toEqual(expect.any(Number))
    })

    it('a legitimate all-USDT ledger does NOT throw (no false positive)', async () => {
      await db.insert(transactions).values({
        id: TX_OK_DEPOSIT,
        type: 'COMPANY_DEPOSIT',
        status: 'PAID',
        amount: '100',
        currency: 'USDT',
        senderId: ADMIN_ID,
        createdBy: ADMIN_ID,
      })

      await expect(computeCompanyAccountBalanceFromLedger(db)).resolves.not.toThrow()
    })

    it('a non-USDT row of a type/funding combo that is NOT company money does not trip the guard', async () => {
      // Legacy EXPENSE with NO fundingSource marker — never counted as company
      // money by any of the 8 SUM terms, so a non-USDT currency here is not a
      // "company row in the wrong currency" — it's simply not a company row.
      await db.insert(transactions).values({
        id: TX_OFF_CURRENCY_EXPENSE,
        type: 'EXPENSE',
        status: 'PAID',
        amount: '250',
        currency: 'UAH',
        senderId: ADMIN_ID,
        createdBy: ADMIN_ID,
      })

      await expect(computeCompanyAccountBalanceFromLedger(db)).resolves.not.toThrow()
    })

    // SEC-1 (mega-audit wave 2, review round 2) — real-DB half of the
    // localization guarantee. company-account-balance-currency.spec.ts proves
    // this split against a mocked db; this spec proves it against a genuine
    // Postgres row, end-to-end through the real query path (view, enum
    // columns, params) that the mocked version cannot exercise.
    it('SEC-1: the DISPLAY-safe reader degrades instead of throwing on the SAME real off-currency row', async () => {
      await withIsolatedOffCurrencyRow(
        _pool!,
        db,
        {
          id: TX_OFF_CURRENCY_EXPENSE,
          type: 'EXPENSE',
          status: 'PAID',
          amount: '250',
          currency: 'UAH',
          senderId: ADMIN_ID,
          fundingSource: 'COMPANY_ACCOUNT',
          createdBy: ADMIN_ID,
        },
        async () => {
          // The GATE-style reader still throws (unchanged — createExpense/
          // paySalary/settleByCompany/createDividend all call this one directly).
          await expect(computeCompanyAccountBalanceFromLedger(db)).rejects.toThrow()

          // The DISPLAY-style reader does not — it degrades instead. `balance`
          // stays a plain, finite `number` (round 3: CompanyAccountDto.balance is
          // z.number() in the shared schema, out of this task's zone) — the
          // best-effort ledger sum, not a fabricated/default value. crm_qa is a
          // shared scratch DB with unpredictable pre-existing rows, so we assert
          // the TYPE/finiteness invariant here, not an exact figure.
          const reading = await computeCompanyAccountBalanceForDisplay(db)
          expect(reading.reliable).toBe(false)
          expect(reading.offCurrencyCount).toBeGreaterThan(0)
          expect(typeof reading.balance).toBe('number')
          expect(Number.isFinite(reading.balance)).toBe(true)
        },
      )
    })

    // SEC-1 (mega-audit wave 2, round 5) — polls `pg_locks` until a backend is
    // OBSERVED waiting (`granted = false`) on `pg_advisory_xact_lock`, instead
    // of assuming a fixed sleep was long enough. Round 4's version slept a
    // fixed 100ms and then trusted that the gate's request had, by then,
    // reached Postgres and started waiting — but that is an ASSUMPTION, not an
    // observation: under scheduling jank the gate's query can simply be slow
    // to be ISSUED, arrive at Postgres only after the fixture already
    // unlocked, and be granted immediately (no wait at all) — the exact false
    // GREEN the review round flagged (the causal claim held for the SECOND
    // half of the test — "the grant cannot precede our unlock" — but not the
    // FIRST half, which never verified the gate had actually started waiting
    // BEHIND our lock in the first place). Directly observing `granted =
    // false` closes that gap: once seen, the gate is PROVABLY queued behind
    // our still-held lock, so any later grant is provably caused by our
    // unlock, not coincidental timing.
    async function waitUntilBlockedOnAdvisoryLock(pool: Pool, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const res = await pool.query(
          `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE l.locktype = 'advisory' AND l.granted = false
             AND a.query ILIKE '%pg_advisory_xact_lock%'
           LIMIT 1`,
        )
        if ((res.rowCount ?? 0) > 0) return
        if (Date.now() >= deadline) {
          throw new Error(
            `waitUntilBlockedOnAdvisoryLock: no backend observed WAITING on ` +
              `pg_advisory_xact_lock within ${timeoutMs}ms — the causal-ordering ` +
              `proof below cannot proceed safely (it would silently degrade back ` +
              `into the same false-GREEN risk this poll exists to close).`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    // Proves `withIsolatedOffCurrencyRow` actually ISOLATES, not just that it
    // happens to pass. Fires a REAL gate-style `lockCompanyAccount` acquisition
    // (on a separate connection) WHILE the fixture holds its session lock,
    // waits for Postgres to confirm that call is genuinely QUEUED behind it
    // (not merely "not yet issued"), THEN proves — via a causal ordering
    // signal, not wall-clock timing — that the gate-style call could only
    // complete AFTER the fixture released.
    //
    // SEC-1 (round 6) — CI caught what round 4/5 missed: this test went RED
    // in CI (`expected false to be true`, 17ms, no timeout thrown) while
    // green on every local run, including 65+ repeats here under artificial
    // CPU contention. The CI error text rules out a re-run of round 5's bug —
    // `waitUntilBlockedOnAdvisoryLock` throws its OWN distinct Error on
    // timeout, and that message is absent from the CI log; the plain
    // AssertionError at the `expect()` line below proves the poll DID observe
    // the gate genuinely queued. So the gap was never in the "is it waiting"
    // half — it was in how this test RECORDED the answer to "did the grant
    // happen after our unlock".
    //
    // The DB-level guarantee here was never in question: Postgres cannot grant
    // a conflicting advisory lock to a queued waiter before the current holder
    // releases it — that is enforced by the lock manager itself, not a race.
    // The bug was two JS callbacks racing on a shared variable across TWO
    // INDEPENDENT connections: the old code set `fixtureUnlocked = true` only
    // AFTER awaiting the full round trip of our OWN unlock response (plus a
    // `DELETE` before it, plus client teardown) — meanwhile the gate's
    // continuation runs the instant ITS OWN connection's grant response is
    // processed. Nothing orders "our socket's read callback" before "the
    // gate's socket's read callback" — Node's event loop services whichever
    // fd the OS reports ready first, and that is a property of two unrelated
    // TCP connections, not of the SQL that ran on them. Nothing about that
    // observation is guaranteed by anything Postgres promises.
    //
    // The fix does not touch timing at all — it moves WHEN the JS flag is set
    // to a point that is unconditionally safe by construction: synchronously,
    // in the same tick the unlock command is SENT (not once its response is
    // received). Sending a query happens-before Postgres can possibly process
    // it, which happens-before it could grant the gate's request — so setting
    // the flag there requires no round trip to "win" a race against the
    // gate's connection; there is no race left to lose.
    it('SEC-1 (round 4/5/6): the isolation lock genuinely BLOCKS a concurrent gate-style lock acquisition', async () => {
      let fixtureUnlocked = false
      let gateAcquiredAfterFixtureUnlocked: boolean | undefined
      let gatePromise: Promise<void> | undefined

      await withIsolatedOffCurrencyRow(
        _pool!,
        db,
        {
          id: TX_OFF_CURRENCY_EXPENSE,
          type: 'EXPENSE',
          status: 'PAID',
          amount: '250',
          currency: 'UAH',
          senderId: ADMIN_ID,
          fundingSource: 'COMPANY_ACCOUNT',
          createdBy: ADMIN_ID,
        },
        async () => {
          // At this point the fixture's session lock is DEFINITELY held (it
          // was acquired synchronously before this callback ran) and the row
          // is committed. Start a REAL gate-style lock acquisition on a
          // SEPARATE connection/transaction — fire it, don't await it here.
          gatePromise = db.transaction(async (dbtx) => {
            await lockCompanyAccount(dbtx)
            gateAcquiredAfterFixtureUnlocked = fixtureUnlocked
          })
          // Do NOT proceed to unlock until Postgres itself confirms the gate's
          // request is queued and waiting — an OBSERVATION, not a guess.
          await waitUntilBlockedOnAdvisoryLock(_pool!)
        },
        // Fires synchronously, inside the helper's `finally`, the instant
        // BEFORE the unlock query is sent — see the docstring above for why
        // this specific placement (not "after `withIsolatedOffCurrencyRow`
        // resolves") is what actually closes the race.
        () => {
          fixtureUnlocked = true
        },
      )

      await gatePromise
      // The gate was PROVEN queued behind our lock (the poll above only
      // returns once Postgres reports it waiting), and `fixtureUnlocked` was
      // set before the unlock that could free it was even sent — so however
      // Node's event loop happens to interleave the two connections' response
      // processing, the gate's continuation cannot observe `false` here.
      expect(gateAcquiredAfterFixtureUnlocked).toBe(true)
    })
  },
)
