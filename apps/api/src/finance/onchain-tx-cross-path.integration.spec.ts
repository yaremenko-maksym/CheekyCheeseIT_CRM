import { BadRequestException, Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { CompanyAccountService } from './company-account.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { sweepOrphanConsumedTxHashes } from './__test-helpers__/consumed-tx-hashes'
import { withDerivedMinorUnits, type ScriptedVerification } from './__test-helpers__/etherscan-fake'
import type { DepositVerification, EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { computeCompanyAccountBalanceFromLedger } from './company-account-balance'
import {
  companyAccount,
  consumedTxHashes,
  payoutRequests,
  transactions,
  users,
} from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-onchain-payment-integrity (HOLE 2) — CROSS-PATH double-spend, real DB.
 *
 * THE BUG THIS PINS: one on-chain transfer could credit the company account
 * TWICE, because the two money paths guarded hash re-use in DIFFERENT tables
 * and were blind to each other:
 *
 *   payPayoutRequest  → scanned `payout_requests`  (index: uq_payout_requests_txhash_paid)
 *   submitDeposit     → scanned `transactions`     (index: uq_transactions_company_deposit_tx_hash,
 *                                                   partial WHERE type='COMPANY_DEPOSIT')
 *
 * Both indexes are partial and DISJOINT, so the same hash could legally live in
 * both tables — and `computeCompanyAccountBalanceFromLedger` sums BOTH terms.
 * One SENIOR/DROP, no collusion, order interchangeable. The fix is the shared
 * `consumed_tx_hashes` registry, claimed INSIDE the crediting transaction.
 *
 * Everything here is REAL except the chain: the DB, both services, the unique
 * index and the balance derivation. The race test uses genuine concurrency
 * against Postgres — it is the only way to prove the DB (not a check-then-act
 * read) is what decides the winner.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api exec vitest run onchain-tx-cross-path.integration.spec
 */

const WALLET = '0xC0FFEE0000000000000000000000000000000abc'
const THRESHOLD = 12
/** Exchange hot wallet — sender is recorded, never enforced. */
const EXCHANGE_WALLET = '0x3333333333333333333333333333333333333333'

const SENIOR: SessionUser = {
  id: 'cf110000-0000-4000-aa00-000000000001',
  email: 'xpath-senior@test.spec',
  displayName: 'XPath Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR2: SessionUser = {
  ...SENIOR,
  id: 'cf110000-0000-4000-aa00-000000000002',
  email: 'xpath-senior2@test.spec',
  displayName: 'XPath Senior Two',
}
const ADMIN: SessionUser = {
  ...SENIOR,
  id: 'cf110000-0000-4000-aa00-000000000003',
  email: 'xpath-admin@test.spec',
  displayName: 'XPath Admin',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

const ALL = [SENIOR, SENIOR2, ADMIN]
const TEST_USER_IDS = ALL.map((u) => u.id)
const ACCOUNT_ID = 'cf110000-0000-4000-cc00-000000000001'

const verifyScript = new Map<string, ScriptedVerification>()
const fakeEtherscan: Pick<EtherscanService, 'verifyDeposit'> = {
  verifyDeposit: (txHash: string): Promise<DepositVerification> =>
    Promise.resolve(withDerivedMinorUnits(verifyScript.get(txHash))),
}

const fakeNbu: Pick<NbuCurrencyService, 'getRates'> = {
  getRates: () =>
    Promise.resolve({ usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260727' }),
}

const stubInvoices = {
  autoCreateForPayout: () => Promise.resolve(),
  autoCreateForSeniorPayout: () => Promise.resolve(),
  autoCreateForSalary: () => Promise.resolve(),
} as never
const stubDocuments = {} as never

let _pool: Pool | null = null
let dbAvailable = true

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
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
          documentsService: stubDocuments,
          nbuCurrencyService: fakeNbu as NbuCurrencyService,
          etherscanService: fakeEtherscan as EtherscanService,
        }),
      inject: [DatabaseService],
    },
    {
      provide: CompanyAccountService,
      useFactory: (db: DatabaseService) =>
        new CompanyAccountService(db, fakeEtherscan as EtherscanService),
      inject: [DatabaseService],
    },
  ],
})
class CrossPathTestModule {}

describe('on-chain hash consumption is CROSS-PATH (payout ⟷ deposit, real DB)', () => {
  let svc: TransactionsService
  let companySvc: CompanyAccountService
  let dbSvc: DatabaseService

  async function clearAll() {
    await dbSvc.db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    await dbSvc.db.delete(transactions).where(inArray(transactions.senderId, TEST_USER_IDS))
    await dbSvc.db.delete(payoutRequests).where(inArray(payoutRequests.seniorId, TEST_USER_IDS))
    await sweepOrphanConsumedTxHashes(dbSvc)
  }

  /** Gate balance straight off the ledger — the figure that funds salaries. */
  async function balance(): Promise<number> {
    return computeCompanyAccountBalanceFromLedger(dbSvc.db)
  }

  async function seedPayout(
    owner: SessionUser,
    amount: string,
  ): Promise<{ requestId: string; payable: number }> {
    const [income] = await dbSvc.db
      .insert(transactions)
      .values({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount,
        currency: 'USDT',
        receiverId: owner.id,
        seniorSharePercent: 26,
        createdBy: owner.id,
      })
      .returning()
    const pr = await svc.createPayoutRequest([income!.id], owner)
    return { requestId: pr.id, payable: parseFloat(pr.payableAmount) }
  }

  /** Script a fully-valid on-chain transfer of `usdt` into the company wallet. */
  function scriptValid(hash: string, usdt: number): void {
    verifyScript.set(hash, {
      found: true,
      toMatches: true,
      fromAddress: EXCHANGE_WALLET,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: usdt,
    })
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='consumed_tx_hashes' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[onchain-tx cross-path] SKIPPED — consumed_tx_hashes table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[onchain-tx cross-path] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [CrossPathTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(TransactionsService)
    companySvc = moduleRef.get(CompanyAccountService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
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
    await clearAll()

    const existing = await db.query.companyAccount.findFirst()
    if (existing) {
      await db
        .update(companyAccount)
        .set({ walletAddress: WALLET, confirmationThreshold: THRESHOLD })
        .where(eq(companyAccount.id, existing.id))
    } else {
      await db.insert(companyAccount).values({
        id: ACCOUNT_ID,
        walletAddress: WALLET,
        confirmationThreshold: THRESHOLD,
        updatedBy: ADMIN.id,
      })
    }
  }, 30_000)

  beforeEach(async () => {
    if (!dbAvailable) return
    await clearAll()
    verifyScript.clear()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await clearAll()
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  // ── Direction 1: payout first, then deposit ────────────────────────────────
  it('THE EXPLOIT: pay a payout with H, then submit H as a deposit → rejected, balance credited ONCE', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000') // payable 740
    const HASH = '0x' + 'd1'.repeat(32)
    scriptValid(HASH, payable)

    const paid = await svc.payPayoutRequest(requestId, HASH, SENIOR)
    expect(paid.status).toBe('PAID')
    const afterPayout = await balance()
    expect(afterPayout).toBeCloseTo(before + payable, 6)

    // Same transfer, other path — this is what used to double-credit.
    await expect(companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR)).rejects.toBeInstanceOf(
      BadRequestException,
    )

    expect(await balance()).toBeCloseTo(afterPayout, 6) // NOT doubled
    const deposits = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.type, 'COMPANY_DEPOSIT'), eq(transactions.txHash, HASH)))
    expect(deposits.length).toBe(0)
  })

  // ── Direction 2: deposit first, then payout (order is interchangeable) ─────
  it('THE EXPLOIT, REVERSED: credit H as a deposit, then pay a payout with H → rejected', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + 'd2'.repeat(32)
    scriptValid(HASH, 500)

    const dep = await companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR)
    expect(dep.status).toBe('PAID')
    const afterDeposit = await balance()
    expect(afterDeposit).toBeCloseTo(before + 500, 6)

    await expect(svc.payPayoutRequest(requestId, HASH, SENIOR)).rejects.toThrowError(
      /уже использован/,
    )

    const pr = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    expect(pr?.status).toBe('PENDING') // payout NOT settled by someone else's deposit
    expect(await balance()).toBeCloseTo(afterDeposit, 6) // NOT doubled
  })

  // ── The registry is the SINGLE source of truth ─────────────────────────────
  it('a settled payout registers its hash exactly once, attributed to the payer', async () => {
    if (!dbAvailable) return
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + 'd3'.repeat(32)
    scriptValid(HASH, payable)
    await svc.payPayoutRequest(requestId, HASH, SENIOR)

    const rows = await dbSvc.db
      .select()
      .from(consumedTxHashes)
      .where(eq(consumedTxHashes.txHash, HASH))
    expect(rows.length).toBe(1)
    expect(rows[0]!.purpose).toBe('PAYOUT')
    expect(rows[0]!.referenceId).toBe(requestId)
    expect(rows[0]!.consumedByUserId).toBe(SENIOR.id)
  })

  it('case-flipping the hash does NOT bypass the registry', async () => {
    if (!dbAvailable) return
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const LOWER = '0x' + 'd4'.repeat(32)
    const UPPER = '0x' + 'D4'.repeat(32)
    scriptValid(LOWER, payable)
    scriptValid(UPPER, 500)

    await svc.payPayoutRequest(requestId, LOWER, SENIOR)
    const afterPayout = await balance()

    // Same transfer, different casing — normalisation must collapse them.
    await expect(companySvc.submitDeposit({ txHashOrLink: UPPER }, SENIOR)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(await balance()).toBeCloseTo(afterPayout, 6)
  })

  // ── RACE (genuine concurrency, real Postgres) ──────────────────────────────
  it('RACE: two payouts settled in parallel with the SAME hash → exactly one PAID', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const first = await seedPayout(SENIOR, '1000')
    const second = await seedPayout(SENIOR2, '1000') // identical payable
    expect(second.payable).toBe(first.payable)

    const HASH = '0x' + 'd5'.repeat(32)
    scriptValid(HASH, first.payable)

    // Both requests pass their pre-checks before either commits — the unique
    // index on consumed_tx_hashes is what has to break the tie.
    const results = await Promise.allSettled([
      svc.payPayoutRequest(first.requestId, HASH, SENIOR),
      svc.payPayoutRequest(second.requestId, HASH, SENIOR2),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBe(1) // exactly one winner
    for (const r of results) {
      // The loser must be a clean 400, never a 500 / raw pg error.
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(BadRequestException)
    }

    const paidRequests = await dbSvc.db
      .select({ id: payoutRequests.id })
      .from(payoutRequests)
      .where(
        and(
          inArray(payoutRequests.id, [first.requestId, second.requestId]),
          eq(payoutRequests.status, 'PAID'),
        ),
      )
    expect(paidRequests.length).toBe(1)

    const registry = await dbSvc.db
      .select({ id: consumedTxHashes.id })
      .from(consumedTxHashes)
      .where(eq(consumedTxHashes.txHash, HASH))
    expect(registry.length).toBe(1)

    // Credited ONCE.
    expect(await balance()).toBeCloseTo(before + first.payable, 6)
  })

  it('RACE across PATHS: payout and deposit settled in parallel with the SAME hash → one winner', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + 'd6'.repeat(32)
    scriptValid(HASH, payable)

    const [payoutResult, depositResult] = await Promise.allSettled([
      svc.payPayoutRequest(requestId, HASH, SENIOR),
      companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR),
    ])

    // Exactly one of the two CREDITED the account. (A deposit that loses the
    // race may still resolve as an uncredited row via the idempotent re-read,
    // so we assert on the money, not on the promise states.)
    expect(await balance()).toBeCloseTo(before + payable, 6)

    for (const r of [payoutResult, depositResult]) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(BadRequestException)
    }

    const registry = await dbSvc.db
      .select({ id: consumedTxHashes.id })
      .from(consumedTxHashes)
      .where(eq(consumedTxHashes.txHash, HASH))
    expect(registry.length).toBe(1)
  })
})
