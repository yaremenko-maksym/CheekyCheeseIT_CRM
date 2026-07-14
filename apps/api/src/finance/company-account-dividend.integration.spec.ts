import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { CompanyAccountService } from './company-account.service'
import type { EtherscanService } from './etherscan.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * MED (audit 2026-06-27) — createDividend BALANCE GATE + TOCTOU (real DB).
 *
 * Before the fix, createDividend inserted a PAID DIVIDEND_TO_ADMIN debit
 * UNCONDITIONALLY — the company USDT account could be overdrawn into a negative
 * balance. The fix mirrors createExpense / paySalary: gate-read + debit-write
 * wrapped in ONE DB transaction under the SHARED `pg_advisory_xact_lock`
 * (COMPANY_ACCOUNT_LOCK_KEY), refusing `amount > balance` and serializing
 * against every other company-account debit (closes the TOCTOU).
 *
 * Asserts against REAL PostgreSQL (crm_qa scratch — NEVER crm_db):
 *   1. dividend > balance → BadRequest, NO debit row written, balance unchanged.
 *   2. dividend ≤ balance → ok, balance reduced by exactly the amount.
 *   3. two concurrent dividends, balance covers ONE → exactly one succeeds and
 *      the account never goes negative (advisory-lock serialization).
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- company-account-dividend.integration
 */

const ADMIN: SessionUser = {
  id: 'fd440000-0000-4000-aa00-000000000001',
  email: 'div-admin@test.spec',
  displayName: 'Dividend Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ADMIN_B: SessionUser = {
  ...ADMIN,
  id: 'fd440000-0000-4000-aa00-000000000002',
  email: 'div-admin-b@test.spec',
  displayName: 'Dividend Admin B',
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'fd440000-0000-4000-aa00-000000000003',
  email: 'div-senior@test.spec',
  displayName: 'Dividend Senior',
  role: 'SENIOR',
}

const ALL = [ADMIN, ADMIN_B, SENIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)
const DEPOSIT_ID = 'fd440000-0000-4000-cc00-000000000001'

const stubEtherscan = {} as unknown as EtherscanService

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        // >1 connection so the two concurrent dividends genuinely run on SEPARATE
        // connections — the only way the advisory lock can actually serialize them.
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 })
        const db = drizzle(_pool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _pool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _pool?.end() ?? Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [TestDatabaseModule],
  providers: [
    {
      provide: CompanyAccountService,
      useFactory: (db: DatabaseService) => new CompanyAccountService(db, stubEtherscan),
      inject: [DatabaseService],
    },
  ],
})
class DividendTestModule {}

// task-receipts-backend (review round 1): createDividend now requires a
// mandatory explorer-link receipt (USDT-only withdrawal). This spec is about
// the balance gate + advisory lock, not the receipt — a fixed valid explorer
// url keeps every call site deterministic and unrelated to the receipt gate
// itself (covered by finance.receipts.spec.ts).
const DIVIDEND_RECEIPT = { receiptExternalUrl: 'https://etherscan.io/tx/0xcompanydividendspec' }

describe('createDividend — balance gate + advisory lock (MED, real DB)', () => {
  let svc: CompanyAccountService
  let dbSvc: DatabaseService

  async function cleanup() {
    const db = dbSvc.db
    await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.id, [DEPOSIT_ID]))
  }

  async function liveBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  // Scoped delta = THIS spec's company-account contribution (deposit − dividends),
  // restricted to our personas. The GLOBAL balance is a shared aggregate other
  // parallel specs mutate, so asserting our own delta is deterministic.
  async function myContribution(): Promise<number> {
    const sumByType = async (type: string): Promise<number> => {
      const rows = await dbSvc.db
        .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.type, type as never),
            eq(transactions.status, 'PAID' as never),
            inArray(transactions.createdBy, TEST_USER_IDS),
          ),
        )
      const total = parseFloat(rows[0]?.total ?? '0')
      return Number.isFinite(total) ? total : 0
    }
    const [deposits, dividends] = await Promise.all([
      sumByType('COMPANY_DEPOSIT'),
      sumByType('DIVIDEND_TO_ADMIN'),
    ])
    return deposits - dividends
  }

  async function seedDeposit(amount: number) {
    await dbSvc.db.insert(transactions).values({
      id: DEPOSIT_ID,
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: String(amount),
      currency: 'USDT',
      senderId: SENIOR.id,
      createdBy: ADMIN.id,
    })
  }

  async function countDividends(): Promise<number> {
    const rows = await dbSvc.db
      .select({ c: sql<string>`COUNT(*)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'DIVIDEND_TO_ADMIN'),
          inArray(transactions.createdBy, TEST_USER_IDS),
        ),
      )
    return parseInt(rows[0]?.c ?? '0', 10)
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='transactions' AND column_name='funding_source' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[company-account-dividend] SKIPPED — funding_source column not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[company-account-dividend] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [DividendTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(CompanyAccountService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await cleanup()
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await db
      .insert(users)
      .values(
        ALL.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await cleanup()
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await cleanup()
  })

  it('dividend ≤ balance → ok, balance reduced by exactly the amount', async () => {
    if (!dbAvailable) return
    await seedDeposit(1000)
    const before = await myContribution()

    const res = await svc.createDividend({ amount: 400, ...DIVIDEND_RECEIPT }, ADMIN)
    expect(res.amount).toBe(400)
    expect(res.receiverId).toBe(ADMIN.id)

    // Persisted as PAID DIVIDEND_TO_ADMIN.
    const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, res.id) })
    expect((row as { type?: string }).type).toBe('DIVIDEND_TO_ADMIN')
    expect((row as { status?: string }).status).toBe('PAID')

    // Scoped contribution dropped by exactly 400.
    expect(await myContribution()).toBe(before - 400)
  }, 30_000)

  it('dividend > balance → BadRequest, NO debit row, contribution unchanged', async () => {
    if (!dbAvailable) return
    await seedDeposit(1000)
    const before = await myContribution()
    const dividendsBefore = await countDividends()

    // Ask for far more than the GLOBAL balance so the gate trips even under
    // concurrent deposits from a parallel spec.
    const tooMuch = (await liveBalance()) + 1_000_000
    await expect(
      svc.createDividend({ amount: tooMuch, ...DIVIDEND_RECEIPT }, ADMIN),
    ).rejects.toThrowError(/Недостаточно средств/)

    // The rejected dividend left NO row and did NOT move our contribution.
    expect(await countDividends()).toBe(dividendsBefore)
    expect(await myContribution()).toBe(before)
    // Global account never went negative.
    expect(await liveBalance()).toBeGreaterThanOrEqual(0)
  }, 30_000)

  it('two concurrent dividends, balance covers one → exactly one succeeds, account stays ≥ 0', async () => {
    if (!dbAvailable) return
    // Seed a deposit far larger than any residual so OUR funds dominate the global
    // balance window. Each dividend = 0.6× the live balance: ONE fits (0.6 < 1.0)
    // but TWO do not (1.2 > 1.0). With the advisory lock exactly one clears.
    await seedDeposit(1_000_000)
    const before = await liveBalance()
    expect(before).toBeGreaterThan(0)
    const amount = Math.round(before * 0.6)
    const myBefore = await myContribution()

    const results = await Promise.allSettled([
      svc.createDividend({ amount, adminId: ADMIN.id, ...DIVIDEND_RECEIPT }, ADMIN),
      svc.createDividend({ amount, adminId: ADMIN_B.id, ...DIVIDEND_RECEIPT }, ADMIN),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/Недостаточно средств/)

    // Exactly ONE dividend debit applied → our contribution dropped by one amount.
    expect(await myContribution()).toBe(myBefore - amount)
    // Safety: the GLOBAL account never goes negative under concurrency.
    expect(await liveBalance()).toBeGreaterThanOrEqual(0)
  }, 30_000)

  it('second dividend over the reduced balance is rejected (gate re-reads after first)', async () => {
    if (!dbAvailable) return
    await seedDeposit(1_000_000)
    const before = await liveBalance()
    const amount = Math.round(before * 0.6)
    const myBefore = await myContribution()

    // First dividend succeeds (one fits).
    await svc.createDividend({ amount, ...DIVIDEND_RECEIPT }, ADMIN)
    expect(await myContribution()).toBe(myBefore - amount)

    // Second dividend of `amount` now exceeds the reduced balance → rejected.
    await expect(svc.createDividend({ amount, ...DIVIDEND_RECEIPT }, ADMIN)).rejects.toThrowError(
      /Недостаточно средств/,
    )
    expect(await myContribution()).toBe(myBefore - amount)
  }, 30_000)
})
