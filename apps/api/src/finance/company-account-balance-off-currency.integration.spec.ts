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
let dbAvailable = true
let db: ReturnType<typeof drizzle<typeof schema>>

// Spec-namespaced transaction ids so cleanup is surgical and never touches
// another spec's rows sharing the same crm_qa database.
const TX_OFF_CURRENCY_EXPENSE = 'cb110000-0000-4000-cc00-000000000001'
const TX_OK_DEPOSIT = 'cb110000-0000-4000-cc00-000000000002'
const TEST_TX_IDS = [TX_OFF_CURRENCY_EXPENSE, TX_OK_DEPOSIT]

async function clearFixtures() {
  await db.delete(transactions).where(inArray(transactions.id, TEST_TX_IDS))
}

// SEC-1 (mega-audit wave 2, round 4): the isolation helper (session advisory
// lock so a concurrent gate call in this OR another agent's process blocks
// instead of observing this row and failing) now lives in
// __test-helpers__/off-currency-fixture.ts — shared with
// company-account-ledger.integration.spec.ts's createExpense/paySalary
// behavioural gate tests. See that file's docstring for the full rationale.

describe('C-3: computeCompanyAccountBalanceFromLedger — off-currency company row (real DB, no mocks)', () => {
  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='transactions' AND column_name='funding_source' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn(
          '[company-account-balance-off-currency] SKIPPED — schema not present (funding_source)',
        )
        dbAvailable = false
        return
      }
    } catch {
      console.warn(
        '[company-account-balance-off-currency] SKIPPED — no DB reachable at DATABASE_URL',
      )
      dbAvailable = false
      return
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
    if (!dbAvailable) return
    await clearFixtures()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await clearFixtures()
      await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  it('AC8: a PAID company-account row in a non-USDT currency is rejected loudly, not silently dropped', async () => {
    if (!dbAvailable) return
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
        await expect(computeCompanyAccountBalanceFromLedger(db)).rejects.toThrow(
          /non-USDT|off-currency|currency other than USDT/i,
        )
      },
    )
  })

  it('a legitimate all-USDT ledger does NOT throw (no false positive)', async () => {
    if (!dbAvailable) return
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
    if (!dbAvailable) return
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
    if (!dbAvailable) return
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

  // SEC-1 (mega-audit wave 2, round 4) — proves `withIsolatedOffCurrencyRow`
  // actually ISOLATES, not just that it happens to pass. Fires a REAL
  // gate-style `lockCompanyAccount` acquisition (on a separate connection)
  // WHILE the fixture holds its session lock, then proves — via a causal
  // ordering signal, not wall-clock timing — that the gate-style call could
  // only complete AFTER the fixture released. Postgres itself guarantees
  // the ordering: the gate's blocked lock request cannot be granted until
  // the session lock is released, so its response physically cannot reach
  // this process before the fixture's unlock does.
  it('SEC-1 (round 4): the isolation lock genuinely BLOCKS a concurrent gate-style lock acquisition', async () => {
    if (!dbAvailable) return
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
        // Give Postgres time to actually receive and queue-block the gate's
        // request before we proceed to unlock — otherwise the request might
        // not have reached the server yet and the "after" signal would be
        // true by accident, not by genuine blocking.
        await new Promise((resolve) => setTimeout(resolve, 100))
      },
    )
    // The fixture's `finally` block (inside withIsolatedOffCurrencyRow) has
    // now fully completed, including its `pg_advisory_unlock` round-trip —
    // `await` above does not return until that happens.
    fixtureUnlocked = true

    await gatePromise
    // Postgres cannot grant the gate's lock request until it has PROCESSED
    // the fixture's unlock — a server-side causal dependency, not a race.
    // So by the time the gate's continuation ran, `fixtureUnlocked` was
    // necessarily already `true`.
    expect(gateAcquiredAfterFixtureUnlocked).toBe(true)
  })
})
