import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { companyAccount, payoutRequests, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * Audit 2026-06-27 (LOW #6) — manualConfirmPayout TOCTOU (real DB).
 *
 * The PENDING→PAID flip is now a CONDITIONAL UPDATE (WHERE status='PENDING')
 * inside the cascade transaction, and the txHash-reuse guard re-runs INSIDE that
 * serialized flip (guardTxHashReuse). This proves, against REAL PostgreSQL with
 * genuine concurrency:
 *   1. Two concurrent manual-confirms of the SAME payout → exactly one succeeds,
 *      the other is rejected "already paid" (no double cascade / double credit).
 *   2. A REAL on-chain hash already consumed by a PAID COMPANY_ACCOUNT payout
 *      cannot be reused to confirm a SECOND one (no double company-balance credit).
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- manual-confirm-toctou.integration
 */

const ADMIN: SessionUser = {
  id: 'fc700000-0000-4000-aa00-000000000001',
  email: 'mct-admin@test.spec',
  displayName: 'MCT Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'fc700000-0000-4000-aa00-000000000002',
  email: 'mct-senior@test.spec',
  displayName: 'MCT Senior',
  role: 'SENIOR',
  seniorSharePercent: 26,
}

const ALL = [ADMIN, SENIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)
const ACCOUNT_ID = 'fc700000-0000-4000-cc00-000000000001'
const WALLET = '0xC0FFEE0000000000000000000000000000000def'

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260620' }),
}
const stubInvoices = {
  autoCreateForPayout: () => Promise.resolve(),
  autoCreateForSeniorPayout: () => Promise.resolve(),
  autoCreateForSalary: () => Promise.resolve(),
} as unknown as InvoicesService

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        // >1 connection so the two concurrent manual-confirms genuinely run on
        // SEPARATE connections — required for the row-lock serialization to bite.
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
        makeTransactionsService({
          db,
          invoicesService: stubInvoices,
          nbuCurrencyService: fakeNbu as NbuCurrencyService,
        }),
      inject: [DatabaseService],
    },
  ],
})
class ManualConfirmToctouModule {}

describe('manualConfirmPayout — TOCTOU serialization (LOW #6, real DB)', () => {
  let svc: TransactionsService
  let dbSvc: DatabaseService

  async function cleanup() {
    const db = dbSvc.db
    await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
    await db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
  }

  // Seed a PENDING payout request (real createPayoutRequest path) over a fresh
  // VALIDATED senior income, and return its id.
  async function seedPendingPayout(): Promise<string> {
    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '1000',
        currency: 'USDT',
        receiverId: SENIOR.id,
        seniorSharePercent: 26,
        createdBy: SENIOR.id,
      })
      .returning()
    const pr = await svc.createPayoutRequest([income!.id], SENIOR)
    return pr.id
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='payout_requests' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[manual-confirm-toctou] SKIPPED — payout_requests table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[manual-confirm-toctou] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ManualConfirmToctouModule],
    }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await cleanup()
    await db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
    await db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    await db
      .insert(users)
      .values(
        ALL.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: u.role === 'SENIOR' ? 26 : 0,
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // createPayoutRequest reads companyAccount.walletAddress — ensure one exists.
    const existing = await db.query.companyAccount.findFirst()
    if (existing) {
      await db
        .update(companyAccount)
        .set({ walletAddress: WALLET })
        .where(eq(companyAccount.id, existing.id))
    } else {
      await db.insert(companyAccount).values({
        id: ACCOUNT_ID,
        walletAddress: WALLET,
        confirmationThreshold: 12,
        updatedBy: ADMIN.id,
      })
    }
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

  it('two concurrent manual-confirms of the SAME payout → exactly one succeeds', async () => {
    if (!dbAvailable) return
    const payoutId = await seedPendingPayout()

    const results = await Promise.allSettled([
      svc.manualConfirmPayout(payoutId, 'CASH', ADMIN),
      svc.manualConfirmPayout(payoutId, 'CASH', ADMIN),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already paid/)

    // The payout flipped to PAID exactly once.
    const pr = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, payoutId),
    })
    expect(pr?.status).toBe('PAID')
  }, 30_000)

  it('a real on-chain hash consumed by a PAID COMPANY_ACCOUNT payout cannot be reused', async () => {
    if (!dbAvailable) return
    const realHash = '0x' + 'ab'.repeat(32) // 0x + 64 hex
    const first = await seedPendingPayout()
    const second = await seedPendingPayout()

    // First confirm consumes the hash and credits the company account.
    await svc.manualConfirmPayout(first, 'COMPANY_ACCOUNT', ADMIN, { txHash: realHash })
    const prFirst = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, first),
    })
    expect(prFirst?.status).toBe('PAID')

    // Second confirm with the SAME real hash on a COMPANY_ACCOUNT payout → rejected.
    await expect(
      svc.manualConfirmPayout(second, 'COMPANY_ACCOUNT', ADMIN, { txHash: realHash }),
    ).rejects.toThrowError(/уже использован/)

    // The second payout stays PENDING (no double credit).
    const prSecond = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, second),
    })
    expect(prSecond?.status).toBe('PENDING')
  }, 30_000)

  it('re-confirming an already-PAID payout → rejected "already paid"', async () => {
    if (!dbAvailable) return
    const payoutId = await seedPendingPayout()
    await svc.manualConfirmPayout(payoutId, 'CASH', ADMIN)
    await expect(svc.manualConfirmPayout(payoutId, 'CASH', ADMIN)).rejects.toThrowError(
      /already paid/,
    )
  }, 30_000)
})
