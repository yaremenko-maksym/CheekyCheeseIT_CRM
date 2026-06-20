import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { InvoicesService } from '../invoices/invoices.service'
import { DocumentsService } from '../documents/documents.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import { transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * MED-1 (TOCTOU) — company-account debits must be SERIALIZED.
 *
 * The company USDT balance is a GLOBAL ledger aggregate (SUM over many rows),
 * not a stored column. Before this fix the three debit paths read the balance,
 * checked `balance >= amount`, then wrote — all OUTSIDE a lock. Two concurrent
 * debits could both read the same balance, both pass the gate, and both write →
 * the account goes NEGATIVE.
 *
 * The fix wraps "gate-read + debit-write" in a DB transaction guarded by a
 * `pg_advisory_xact_lock(COMPANY_ACCOUNT_LOCK_KEY)`. The second concurrent debit
 * blocks on the lock, then re-reads the already-reduced balance and correctly
 * fails. This spec proves it against REAL PostgreSQL with genuine concurrency
 * (Promise.all over two pooled connections).
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- company-account-debit-race.integration
 */

const ADMIN: SessionUser = {
  id: 'fa330000-0000-4000-aa00-000000000001',
  email: 'race-admin@test.spec',
  displayName: 'Race Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR_A: SessionUser = {
  ...ADMIN,
  id: 'fa330000-0000-4000-aa00-000000000002',
  email: 'race-junior-a@test.spec',
  displayName: 'Race Junior A',
  role: 'JUNIOR',
  seniorSharePercent: 0,
}
const JUNIOR_B: SessionUser = {
  ...ADMIN,
  id: 'fa330000-0000-4000-aa00-000000000003',
  email: 'race-junior-b@test.spec',
  displayName: 'Race Junior B',
  role: 'JUNIOR',
  seniorSharePercent: 0,
}

const ALL = [ADMIN, JUNIOR_A, JUNIOR_B]
const TEST_USER_IDS = ALL.map((u) => u.id)
// Namespaced deposit row so this spec's company-account contribution is
// deterministic regardless of the residual crm_qa balance from other specs.
const DEPOSIT_ID = 'fa330000-0000-4000-cc00-000000000001'

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        // A small pool (>1 connection) so the two concurrent paySalary
        // transactions genuinely run on SEPARATE connections — the only way the
        // advisory lock can actually serialize them.
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
      provide: TransactionsService,
      useFactory: (db: DatabaseService) =>
        new TransactionsService(
          db,
          // safeAutoCreateInvoice swallows errors, so a noop stub is enough; we
          // only assert balance/serialization behaviour here.
          { autoCreateForSalary: () => Promise.resolve() } as unknown as InvoicesService,
          {} as unknown as DocumentsService,
        ),
      inject: [DatabaseService],
    },
  ],
})
class RaceTestModule {}

describe('company-account debits — serialized via advisory lock (MED-1, real DB)', () => {
  let svc: TransactionsService
  let dbSvc: DatabaseService

  async function cleanup() {
    const db = dbSvc.db
    await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.id, [DEPOSIT_ID]))
  }

  async function liveBalance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  // Seed a confirmed company deposit. Returned so callers can size amounts
  // relative to the GLOBAL aggregate (residual crm_qa balance may be non-zero).
  async function seedDeposit(amount: number) {
    await dbSvc.db.insert(transactions).values({
      id: DEPOSIT_ID,
      type: 'COMPANY_DEPOSIT',
      status: 'PAID',
      amount: String(amount),
      currency: 'USDT',
      senderId: ADMIN.id,
      createdBy: ADMIN.id,
    })
  }

  // Create a PENDING company-funded salary directly (bypasses the create gate)
  // so paySalary's PENDING→PAID debit can be raced. Returns the row id.
  async function seedPendingSalary(receiverId: string, amount: number): Promise<string> {
    const [row] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SALARY',
        status: 'PENDING',
        amount: String(amount),
        currency: 'USDT',
        senderId: null,
        senderLabel: 'Счёт компании',
        receiverId,
        salaryMonth: '2026-06',
        fundingSource: 'COMPANY_ACCOUNT',
        createdBy: ADMIN.id,
      })
      .returning()
    return row!.id
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
        console.warn('[company-account-debit-race] SKIPPED — funding_source column not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[company-account-debit-race] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [RaceTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
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

  // CORE MED-1 PROOF: two concurrent paySalary calls, balance covers ONLY one.
  it('two concurrent paySalary debits, balance covers one → exactly one succeeds, account stays ≥ 0', async () => {
    if (!dbAvailable) return

    // The company balance is a GLOBAL aggregate, so crm_qa may carry a non-zero
    // residual. Seed a deposit so the balance is guaranteed positive, read it
    // live, then size EACH salary to the FULL current balance: two such debits
    // would need 2×balance but only 1×balance exists. With the advisory lock
    // exactly one clears; without it both would pass the gate and drive the
    // account to −balance.
    await seedDeposit(600)
    const before = await liveBalance()
    expect(before).toBeGreaterThan(0)
    const amount = before

    const salaryA = await seedPendingSalary(JUNIOR_A.id, amount)
    const salaryB = await seedPendingSalary(JUNIOR_B.id, amount)

    const results = await Promise.allSettled([
      svc.paySalary(salaryA, { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' }, ADMIN),
      svc.paySalary(salaryB, { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' }, ADMIN),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/Недостаточно средств/)

    // The account must NOT go negative: exactly one `amount` debit applied →
    // balance dropped by exactly `amount` and lands at ≥ 0.
    const after = await liveBalance()
    expect(after).toBe(before - amount)
    expect(after).toBeGreaterThanOrEqual(0)
  }, 30_000)

  // Sequential sanity: after the first debit drains the balance, a second debit
  // of the same size over the now-reduced balance is correctly rejected (the gate
  // re-reads the reduced balance — the same guarantee the lock enforces under
  // concurrency, verified deterministically).
  it('second debit over the reduced balance is rejected (gate re-reads after first debit)', async () => {
    if (!dbAvailable) return

    await seedDeposit(500)
    const before = await liveBalance()
    const amount = before // each salary = the full live balance

    const salaryA = await seedPendingSalary(JUNIOR_A.id, amount)
    const salaryB = await seedPendingSalary(JUNIOR_B.id, amount)

    // First debit drains the balance to 0.
    await svc.paySalary(salaryA, { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' }, ADMIN)
    expect(await liveBalance()).toBe(before - amount)

    // Second debit of `amount` now exceeds the reduced (0) balance → rejected.
    await expect(
      svc.paySalary(salaryB, { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' }, ADMIN),
    ).rejects.toThrowError(/Недостаточно средств/)
    expect(await liveBalance()).toBe(before - amount)
  }, 30_000)

  // The lock must NOT block a row that is no longer PENDING — a double-pay of the
  // SAME salary is rejected by the in-lock status re-check (not a balance error).
  it('double-paying the same salary → second call rejected as not PENDING', async () => {
    if (!dbAvailable) return

    await seedDeposit(1_000_000) // plenty — isolate the status guard from balance
    const salary = await seedPendingSalary(JUNIOR_A.id, 100)

    const [first, second] = await Promise.allSettled([
      svc.paySalary(salary, { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' }, ADMIN),
      svc.paySalary(salary, { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' }, ADMIN),
    ])

    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled')
    const rejected = [first, second].filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/not PENDING/)

    const row = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, salary),
    })
    expect((row as { status?: string }).status).toBe('PAID')
  }, 30_000)
})
