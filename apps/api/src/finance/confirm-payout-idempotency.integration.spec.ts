/**
 * BIZ-02 — confirmPayout double-credit (HIGH): within-path + cross-path tests
 *
 * Within-path (AC1-a/b/c): two concurrent/sequential calls to `confirmPayout`
 * for the same PAYOUT row only produce ONE PAYOUT_CONFIRMED credit and the
 * PAYOUT row flips to PAID exactly once.
 *
 * Cross-path (BIZ-02 describe block): after a successful confirmPayout(P), the
 * linked payout_request R is atomically flipped to PAID in the SAME transaction.
 * This blocks the `payPayoutRequest` path (which gates on req.status === 'PENDING')
 * from creating a second credit on the same request. Tests use real DB writes and
 * assert both ledger state (PAYOUT_CONFIRMED count) and request state (status=PAID).
 *
 * HIGH-4 fix: persona IDs were invalid UUID format (7-2-4-4-4-12 layout);
 * replaced with valid 8-4-4-4-12 format that Postgres accepts.
 *
 * Run against the scratch DB:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- confirm-payout-idempotency.integration
 */
import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray, and } from 'drizzle-orm'
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

// ── Personas (stable IDs, namespaced to this spec) ────────────────────────
// HIGH-4 fix: IDs must be valid UUID v4 format (8-4-4-4-12 hex groups).
// Previous IDs ('biz02-00-0000-4000-aa00-000000000001') used a 7-2-4-4-4-12
// layout which Postgres rejects as invalid uuid syntax → beforeAll crashed.
const ADMIN: SessionUser = {
  id: 'b1020000-0000-4000-aa00-000000000001',
  email: 'biz02-admin@test.spec',
  displayName: 'BIZ02 Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const ADMIN2: SessionUser = {
  id: 'b1020000-0000-4000-aa00-000000000002',
  email: 'biz02-admin2@test.spec',
  displayName: 'BIZ02 Admin 2',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 0,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  id: 'b1020000-0000-4000-aa00-000000000003',
  email: 'biz02-senior@test.spec',
  displayName: 'BIZ02 Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}

const ALL = [ADMIN, ADMIN2, SENIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)
const ACCOUNT_ID = 'b1020000-0000-4000-cc00-000000000001'
const WALLET = '0xBIZ020000000000000000000000000000000def'

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({
      usdUah: '40.0000',
      usdtUah: '40.0000',
      eurUah: '44.0000',
      date: '20260703',
    }),
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
class TestDbModule {}

@Module({
  imports: [TestDbModule],
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
class TestModule {}

describe('confirmPayout — BIZ-02 double-credit idempotency (real DB)', () => {
  let svc: TransactionsService
  let dbSvc: DatabaseService

  async function cleanup() {
    const db = dbSvc.db
    await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
    await db.delete(transactions).where(inArray(transactions.receiverId, TEST_USER_IDS))
    await db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
  }

  /**
   * Seed a PAYOUT transaction in PENDING_PAYMENT state.
   * Returns the payout transaction id.
   */
  async function seedPayoutTx(amount = '500', payoutRequestId?: string): Promise<string> {
    const [payout] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'PAYOUT',
        status: 'PENDING_PAYMENT',
        amount,
        currency: 'USDT',
        senderId: SENIOR.id,
        receiverId: SENIOR.id,
        payoutRequestId: payoutRequestId ?? null,
        createdBy: SENIOR.id,
      })
      .returning()
    return payout!.id
  }

  /**
   * HIGH-3: Seed a payout_request R (status PENDING) + linked PAYOUT P.
   * Returns { requestId, payoutTxId }.
   * Used for cross-path tests: confirmPayout(P) should flip R to PAID so
   * that payPayoutRequest(R) cannot open a second credit.
   */
  async function seedPayoutRequestWithPayout(
    amount = '500',
  ): Promise<{ requestId: string; payoutTxId: string }> {
    const [req] = await dbSvc.db
      .insert(payoutRequests)
      .values({
        seniorId: SENIOR.id,
        incomeAmount: amount,
        payableAmount: amount,
        contractAddress: '0x0000000000000000000000000000000000000000',
        status: 'PENDING',
      })
      .returning()
    const requestId = req!.id

    const payoutTxId = await seedPayoutTx(amount, requestId)
    return { requestId, payoutTxId }
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='transactions' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[confirm-payout-idempotency] SKIPPED — transactions table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[confirm-payout-idempotency] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
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
          googleId: `test-google-biz02-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    const existing = await db.query.companyAccount.findFirst()
    if (!existing) {
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

  it('AC1-a: two concurrent confirmPayout → exactly one PAYOUT_CONFIRMED, second throws', async () => {
    if (!dbAvailable) return
    const payoutTxId = await seedPayoutTx('1000')
    const CRYPTO_HASH = '0x' + 'aa'.repeat(32) + 'bb'
    const CRYPTO_HASH2 = '0x' + 'cc'.repeat(32) + 'dd'

    const results = await Promise.allSettled([
      svc.confirmPayout(payoutTxId, ADMIN.id, ADMIN, { method: 'CRYPTO', txHash: CRYPTO_HASH }),
      svc.confirmPayout(payoutTxId, ADMIN2.id, ADMIN, { method: 'CRYPTO', txHash: CRYPTO_HASH2 }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // Exactly ONE PAYOUT_CONFIRMED row must exist
    const confirmed = await dbSvc.db.query.transactions.findMany({
      where: and(
        eq(transactions.type, 'PAYOUT_CONFIRMED'),
        // Both admins were candidates — check total count
      ),
    })
    const confirmedForThisPayout = confirmed.filter(
      (tx) => tx.createdBy === ADMIN.id || tx.createdBy === ADMIN2.id,
    )
    // The key invariant: only 1 PAYOUT_CONFIRMED was inserted
    expect(
      confirmed.filter(
        (tx) =>
          tx.senderId === SENIOR.id || tx.receiverId === ADMIN.id || tx.receiverId === ADMIN2.id,
      ).length,
    ).toBe(1)

    // The PAYOUT row must be PAID
    const payoutRow = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, payoutTxId),
    })
    expect(payoutRow?.status).toBe('PAID')
    void confirmedForThisPayout
  }, 30_000)

  it('AC1-b: sequential second confirmPayout throws BadRequest (already confirmed)', async () => {
    if (!dbAvailable) return
    const payoutTxId = await seedPayoutTx('500')
    const HASH = '0x' + 'ee'.repeat(32) + 'ff'

    await svc.confirmPayout(payoutTxId, ADMIN.id, ADMIN, { method: 'CRYPTO', txHash: HASH })

    await expect(
      svc.confirmPayout(payoutTxId, ADMIN.id, ADMIN, {
        method: 'CRYPTO',
        txHash: '0x' + '11'.repeat(32) + '22',
      }),
    ).rejects.toThrow()

    // Still only one PAYOUT_CONFIRMED
    const confirmed = await dbSvc.db.query.transactions.findMany({
      where: eq(transactions.type, 'PAYOUT_CONFIRMED'),
    })
    expect(confirmed).toHaveLength(1)
  }, 30_000)

  it('AC1-c: CASH method confirmPayout is idempotent — second call throws, no double credit', async () => {
    if (!dbAvailable) return
    const payoutTxId = await seedPayoutTx('250')

    await svc.confirmPayout(payoutTxId, ADMIN.id, ADMIN, { method: 'CASH', txHash: null })

    await expect(
      svc.confirmPayout(payoutTxId, ADMIN.id, ADMIN, { method: 'CASH', txHash: null }),
    ).rejects.toThrow()

    const confirmed = await dbSvc.db.query.transactions.findMany({
      where: eq(transactions.type, 'PAYOUT_CONFIRMED'),
    })
    expect(confirmed).toHaveLength(1)
  }, 30_000)

  // ── HIGH-3: Real cross-path integration tests ────────────────────────────
  //
  // These are the ACTUAL cross-path tests referenced in the file header:
  // confirmPayout(PAYOUT_P) atomically flips payout_request R to PAID, so
  // payPayoutRequest(R) (which gates on req.status === 'PENDING') is blocked.
  // Previously this describe block only contained confirmPayout×confirmPayout
  // (within-path). The cross-path tests are here.
  describe('BIZ-02 cross-path: confirmPayout then payPayoutRequest blocked', () => {
    it('after confirmPayout(P) → payout_request R is PAID → payPayoutRequest(R) throws "already paid"', async () => {
      if (!dbAvailable) return
      const { requestId, payoutTxId } = await seedPayoutRequestWithPayout('600')

      // Step 1: ADMIN confirms via confirmPayout (the "direct PAYOUT confirm" path)
      await svc.confirmPayout(payoutTxId, ADMIN.id, ADMIN, { method: 'CASH', txHash: null })

      // Step 2: the linked payout_request must now be PAID (BIZ-02 cross-path flip)
      const reqAfter = await dbSvc.db.query.payoutRequests.findFirst({
        where: eq(payoutRequests.id, requestId),
      })
      expect(reqAfter?.status).toBe('PAID')

      // Step 3: SENIOR attempting payPayoutRequest on the now-PAID request must be
      // rejected — "already paid" guard in payPayoutRequest (req.status !== 'PENDING').
      await expect(
        svc.payPayoutRequest(requestId, '0xSIMdeadbeefdeadbeef', SENIOR, 'success'),
      ).rejects.toThrow('already paid')

      // Step 4: no double-credit — exactly ONE PAYOUT_CONFIRMED row for this payout
      const confirmed = await dbSvc.db.query.transactions.findMany({
        where: and(
          eq(transactions.type, 'PAYOUT_CONFIRMED'),
          eq(transactions.receiverId, ADMIN.id),
        ),
      })
      expect(confirmed).toHaveLength(1)

      // Step 5: PAYOUT row is PAID exactly once, no duplicate ledger entries
      const payoutRow = await dbSvc.db.query.transactions.findFirst({
        where: and(eq(transactions.payoutRequestId, requestId), eq(transactions.type, 'PAYOUT')),
      })
      expect(payoutRow?.status).toBe('PAID')
    }, 30_000)

    it('after confirmPayout(P) → second confirmPayout on same PAYOUT tx throws, no double credit', async () => {
      if (!dbAvailable) return
      const { payoutTxId } = await seedPayoutRequestWithPayout('400')

      // First confirm succeeds
      await svc.confirmPayout(payoutTxId, ADMIN.id, ADMIN, { method: 'CASH', txHash: null })

      // Second confirm on the same PAYOUT tx must be rejected (within-path guard)
      await expect(
        svc.confirmPayout(payoutTxId, ADMIN2.id, ADMIN, { method: 'CASH', txHash: null }),
      ).rejects.toThrow()

      // Still only one PAYOUT_CONFIRMED total
      const confirmed = await dbSvc.db.query.transactions.findMany({
        where: eq(transactions.type, 'PAYOUT_CONFIRMED'),
      })
      expect(confirmed.length).toBe(1)
    }, 30_000)
  })
})
