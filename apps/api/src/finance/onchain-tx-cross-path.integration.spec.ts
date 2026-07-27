import { BadRequestException, Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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
  projects,
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
/** ADMIN-owned project — `createAdminIncome` requires an admin owner (HIGH-3). */
const ADMIN_PROJECT_ID = 'cf110000-0000-4000-bb00-000000000001'

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
    await dbSvc.db.delete(transactions).where(eq(transactions.projectId, ADMIN_PROJECT_ID))
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

    // ADMIN-owned project so `createAdminIncome` (HIGH-3) is authorised.
    await db
      .insert(projects)
      .values({
        id: ADMIN_PROJECT_ID,
        name: 'XPath Admin Project',
        companyName: 'XPath Client Ltd',
        domain: 'AI',
        rate: 50,
        startDate: new Date('2026-01-01T00:00:00Z'),
        seniorId: ADMIN.id,
      })
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

  // ── HIGH-1 (security-review PR #438): input FORMAT must not bypass the registry
  // The exploit needed no malice: pasting an explorer LINK into manual-confirm
  // (the format the neighbouring deposit endpoint advertises) credited the
  // company account with a `tx_hash` the anchored registry regex could not
  // recognise → no claim → the same transfer was still free to be credited
  // again as a deposit, by a DIFFERENT role.
  it('THE FORMAT EXPLOIT: manual-confirm with an explorer LINK, then the same hash as a deposit → rejected', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + 'd7'.repeat(32)
    const LINK = `https://etherscan.io/tx/${HASH}`
    scriptValid(HASH, payable)

    // ADMIN settles the payout off the on-chain path, pasting the LINK.
    const confirmed = await svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN, {
      txHash: LINK,
    })
    expect(confirmed.status).toBe('PAID')
    const afterPayout = await balance()
    expect(afterPayout).toBeCloseTo(before + payable, 6)

    // ── The second half of the exploit — a DIFFERENT role, same transfer.
    // Asserted FIRST so a regression shows up as MONEY (a doubled balance),
    // not merely as a stored-format detail.
    await expect(companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(await balance()).toBeCloseTo(afterPayout, 6) // NOT doubled

    // The LINK must have been reduced to the bare, lowercase hash…
    const pr = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    expect(pr?.txHash).toBe(HASH)
    // …and claimed in the registry, so the transfer is spent.
    const registry = await dbSvc.db
      .select({ purpose: consumedTxHashes.purpose })
      .from(consumedTxHashes)
      .where(eq(consumedTxHashes.txHash, HASH))
    expect(registry.length).toBe(1)
  })

  it('THE FORMAT EXPLOIT, REVERSED: deposit by LINK, then manual-confirm with the bare hash → rejected', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + 'd8'.repeat(32)
    scriptValid(HASH, 500)

    const dep = await companySvc.submitDeposit(
      { txHashOrLink: `https://etherscan.io/tx/${HASH}` },
      SENIOR,
    )
    expect(dep.status).toBe('PAID')
    const afterDeposit = await balance()

    await expect(
      svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN, { txHash: HASH }),
    ).rejects.toThrowError(/уже использован/)
    expect(await balance()).toBeCloseTo(afterDeposit, 6)
  })

  it('a MIXED-CASE hash in manual-confirm collides with the lowercase registry entry', async () => {
    if (!dbAvailable) return
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const second = await seedPayout(SENIOR2, '1000')
    const HASH = '0x' + 'd9'.repeat(32)
    scriptValid(HASH, payable)

    await svc.payPayoutRequest(requestId, HASH, SENIOR)
    const afterPayout = await balance()

    await expect(
      svc.manualConfirmPayout(second.requestId, 'COMPANY_ACCOUNT', ADMIN, {
        txHash: HASH.toUpperCase().replace('0X', '0x'),
      }),
    ).rejects.toThrowError(/уже использован/)
    expect(await balance()).toBeCloseTo(afterPayout, 6)
  })

  it('manual-confirm with an UNPARSEABLE hash fails loud (no unregistered credit)', async () => {
    if (!dbAvailable) return
    const before = await balance()
    const { requestId } = await seedPayout(SENIOR, '1000')

    // Truncated hash — previously accepted verbatim (`length >= 10`), credited,
    // and left unregistered.
    await expect(
      svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN, {
        txHash: '0xabcdef0123456789',
      }),
    ).rejects.toThrowError(/Некорректный hash/)

    const pr = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    expect(pr?.status).toBe('PENDING')
    expect(await balance()).toBe(before)
  })

  it('manual-confirm WITHOUT a hash still works (0xMANUAL marker, nothing claimed)', async () => {
    if (!dbAvailable) return
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const before = await balance()

    const confirmed = await svc.manualConfirmPayout(requestId, 'COMPANY_ACCOUNT', ADMIN, {})
    expect(confirmed.status).toBe('PAID')
    expect(await balance()).toBeCloseTo(before + payable, 6)

    const pr = await dbSvc.db.query.payoutRequests.findFirst({
      where: eq(payoutRequests.id, requestId),
    })
    expect(pr?.txHash).toMatch(/^0xMANUAL/)
    // Synthetic markers reference no on-chain transfer → nothing to consume.
    const registry = await dbSvc.db
      .select({ id: consumedTxHashes.id })
      .from(consumedTxHashes)
      .where(eq(consumedTxHashes.txHash, pr!.txHash!))
    expect(registry.length).toBe(0)
  })

  // ── HIGH-3 (security-review round 2): the SECOND ADMIN_INCOME writer ──────
  // `createAdminIncome` credits the pool with the same ledger predicate as
  // `declareUsdtProjectIncome` (ADMIN_INCOME + PAID + USDT + COMPANY_ACCOUNT)
  // but did not claim its hash — so an honestly registered client inflow left
  // the transfer spendable, and any SENIOR/DROP could re-credit it as a deposit.
  describe('HIGH-3: createAdminIncome claims its hash when it credits the pool', () => {
    const RECEIPT_HASH = '0x' + 'c1'.repeat(32)

    it('THE EXPLOIT: admin registers a client inflow, then the same hash is submitted as a deposit → rejected', async () => {
      if (!dbAvailable) return
      const before = await balance()

      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 5000,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${RECEIPT_HASH}`,
        },
        ADMIN,
      )
      const afterIncome = await balance()
      expect(afterIncome).toBeCloseTo(before + 5000, 6)

      // The transfer is now spoken for…
      const registry = await dbSvc.db
        .select({ purpose: consumedTxHashes.purpose, referenceId: consumedTxHashes.referenceId })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, RECEIPT_HASH))
      expect(registry.length).toBe(1)
      expect(registry[0]!.purpose).toBe('ADMIN_INCOME')
      expect(registry[0]!.referenceId).toBe(income.id)

      // …so the second credit is refused (this used to go through).
      scriptValid(RECEIPT_HASH, 5000)
      await expect(
        companySvc.submitDeposit({ txHashOrLink: RECEIPT_HASH }, SENIOR),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(await balance()).toBeCloseTo(afterIncome, 6) // NOT doubled
    })

    it('the hash is recorded on the income row itself (attribution)', async () => {
      if (!dbAvailable) return
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 100,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${RECEIPT_HASH}`,
        },
        ADMIN,
      )
      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.txHash).toBe(RECEIPT_HASH)
    })

    it('a PERSONAL admin income does NOT claim (it never credits the pool)', async () => {
      if (!dbAvailable) return
      const before = await balance()
      // No fundingSource → legacy personal income: the company balance is
      // untouched, so burning the transfer would grief its real payer.
      await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 250,
          currency: 'USDT',
          receiptExternalUrl: `https://etherscan.io/tx/${RECEIPT_HASH}`,
        },
        ADMIN,
      )
      expect(await balance()).toBeCloseTo(before, 6) // pool untouched

      const registry = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, RECEIPT_HASH))
      expect(registry.length).toBe(0) // nothing burned

      // …and the transfer remains usable by the path that really owns it.
      const { requestId, payable } = await seedPayout(SENIOR, '1000')
      scriptValid(RECEIPT_HASH, payable)
      const paid = await svc.payPayoutRequest(requestId, RECEIPT_HASH, SENIOR)
      expect(paid.status).toBe('PAID')
    })

    it('a hash already spent by a deposit cannot then be registered as admin income', async () => {
      if (!dbAvailable) return
      scriptValid(RECEIPT_HASH, 400)
      const dep = await companySvc.submitDeposit({ txHashOrLink: RECEIPT_HASH }, SENIOR)
      expect(dep.status).toBe('PAID')
      const afterDeposit = await balance()

      await expect(
        svc.createAdminIncome(
          {
            projectId: ADMIN_PROJECT_ID,
            amount: 400,
            currency: 'USDT',
            fundingSource: 'COMPANY_ACCOUNT',
            receiptExternalUrl: `https://etherscan.io/tx/${RECEIPT_HASH}`,
          },
          ADMIN,
        ),
      ).rejects.toThrowError(/уже использован/)
      expect(await balance()).toBeCloseTo(afterDeposit, 6)
    })
  })

  // ── HIGH-4 (security-review round 2): the prod backfill must skip PENDING ──
  // The migration back-fills historic settlements into the registry. Claiming a
  // PENDING deposit would BRICK it: `consumeTxHash` is a bare INSERT, so the
  // later confirm-flip would hit 23505 and roll back forever — and it would
  // re-open the griefing MED-3 closed. This test runs the migration's own
  // deposit predicate against real data.
  describe('HIGH-4: backfill claims only PAID deposits', () => {
    /** Mirrors apps/api/drizzle/manual/2026-07-27_consumed_tx_hashes.sql (deposits). */
    async function runDepositBackfill() {
      await dbSvc.db.execute(sql`
        INSERT INTO consumed_tx_hashes (tx_hash, purpose, reference_id, consumed_by_user_id)
        SELECT DISTINCT ON (lower(t.tx_hash))
               lower(t.tx_hash), 'COMPANY_DEPOSIT', t.id, t.sender_id
          FROM transactions t
         WHERE t.type = 'COMPANY_DEPOSIT'
           AND t.status = 'PAID'
           AND t.tx_hash ~* '^0x[0-9a-f]{64}$'
         ORDER BY lower(t.tx_hash), t.created_at ASC
        ON CONFLICT (tx_hash) DO NOTHING
      `)
    }

    it('a back-filled PENDING deposit still reaches PAID (not bricked)', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'c2'.repeat(32)
      const before = await balance()

      // A deposit submitted before the tx confirmed → PENDING, uncredited.
      verifyScript.set(HASH, {
        found: true,
        toMatches: true,
        fromAddress: EXCHANGE_WALLET,
        confirmed: false,
        confirmations: 2,
        amountUsdt: 250,
      })
      const dep = await companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR)
      expect(dep.status).toBe('PENDING')

      // The migration runs (as it will on prod, with this row already present).
      await runDepositBackfill()
      const claimedByBackfill = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(claimedByBackfill.length).toBe(0) // PENDING is NOT claimed

      // The chain confirms → the deposit credits and claims ITSELF.
      scriptValid(HASH, 250)
      const status = await companySvc.getDepositStatus(dep.id, SENIOR)
      expect(status.status).toBe('PAID')
      expect(await balance()).toBeCloseTo(before + 250, 6)

      const claimedOnCredit = await dbSvc.db
        .select({ purpose: consumedTxHashes.purpose })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(claimedOnCredit.length).toBe(1)
      expect(claimedOnCredit[0]!.purpose).toBe('COMPANY_DEPOSIT')
    })

    it('DEMONSTRATION: the UNFILTERED backfill would brick a PENDING deposit', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'c4'.repeat(32)
      const before = await balance()

      verifyScript.set(HASH, {
        found: true,
        toMatches: true,
        fromAddress: EXCHANGE_WALLET,
        confirmed: false,
        confirmations: 1,
        amountUsdt: 175,
      })
      const dep = await companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR)
      expect(dep.status).toBe('PENDING')

      // The migration as originally written — NO `t.status = 'PAID'` filter.
      await dbSvc.db.execute(sql`
        INSERT INTO consumed_tx_hashes (tx_hash, purpose, reference_id, consumed_by_user_id)
        SELECT DISTINCT ON (lower(t.tx_hash))
               lower(t.tx_hash), 'COMPANY_DEPOSIT', t.id, t.sender_id
          FROM transactions t
         WHERE t.type = 'COMPANY_DEPOSIT'
           AND t.tx_hash ~* '^0x[0-9a-f]{64}$'
         ORDER BY lower(t.tx_hash), t.created_at ASC
        ON CONFLICT (tx_hash) DO NOTHING
      `)
      const claimed = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(claimed.length).toBe(1) // the PENDING row got claimed — the defect

      // …and now the deposit can NEVER be credited: the confirm-flip claims the
      // hash again, hits 23505, and rolls the whole flip back. Money on the
      // company wallet stays invisible in the balance, with no way out.
      scriptValid(HASH, 175)
      await expect(companySvc.getDepositStatus(dep.id, SENIOR)).rejects.toBeInstanceOf(
        BadRequestException,
      )
      const stillPending = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, dep.id),
      })
      expect(stillPending?.status).toBe('PENDING')
      expect(await balance()).toBeCloseTo(before, 6) // never credited

      // Undo the simulated bad backfill so the suite stays deterministic.
      await dbSvc.db.delete(consumedTxHashes).where(eq(consumedTxHashes.txHash, HASH))
    })

    it('a PAID deposit IS claimed by the backfill (historic settlements stay spent)', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'c3'.repeat(32)
      scriptValid(HASH, 300)
      const dep = await companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR)
      expect(dep.status).toBe('PAID')

      // Simulate a pre-migration world: drop the claim the app just made, then
      // let the backfill restore it.
      await dbSvc.db.delete(consumedTxHashes).where(eq(consumedTxHashes.txHash, HASH))
      await runDepositBackfill()

      const rows = await dbSvc.db
        .select({ referenceId: consumedTxHashes.referenceId })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(rows.length).toBe(1)
      expect(rows[0]!.referenceId).toBe(dep.id)
    })
  })

  // ── MED-3 (security-review PR #438): an UNVERIFIED deposit burns nothing ───
  // The company wallet address is published to every payer, so any SENIOR/DROP
  // can read a stranger's incoming transfer off the explorer. If merely
  // SUBMITTING its hash claimed it system-wide, the attacker could block the
  // real payer's settlement («хеш уже использован») without ever crediting
  // anything. The claim now accompanies MONEY: a PENDING, uncredited deposit
  // leaves the transfer free.
  it('MED-3: a PENDING (unverified) deposit does NOT burn the hash for the real payer', async () => {
    if (!dbAvailable) return
    const { requestId, payable } = await seedPayout(SENIOR, '1000')
    const HASH = '0x' + 'da'.repeat(32)

    // The front-runner submits the hash while the tx is still un-confirmed.
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      fromAddress: EXCHANGE_WALLET,
      confirmed: false, // below threshold → NOT credited
      confirmations: 2,
      amountUsdt: payable,
    })
    const dep = await companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR2)
    expect(dep.status).toBe('PENDING')

    // Nothing claimed — the transfer is still spendable by its rightful owner.
    const registryAfterSubmit = await dbSvc.db
      .select({ id: consumedTxHashes.id })
      .from(consumedTxHashes)
      .where(eq(consumedTxHashes.txHash, HASH))
    expect(registryAfterSubmit.length).toBe(0)

    // The real payer settles their payout with it — must NOT be blocked.
    const before = await balance()
    scriptValid(HASH, payable)
    const paid = await svc.payPayoutRequest(requestId, HASH, SENIOR)
    expect(paid.status).toBe('PAID')
    expect(await balance()).toBeCloseTo(before + payable, 6)

    // And now that it IS spent, the front-runner's pending deposit can never be
    // credited by polling — the flip rolls back on the registry collision.
    await expect(companySvc.getDepositStatus(dep.id, SENIOR2)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    const depRow = await dbSvc.db.query.transactions.findFirst({
      where: eq(transactions.id, dep.id),
    })
    expect(depRow?.status).toBe('PENDING')
    expect(await balance()).toBeCloseTo(before + payable, 6) // still credited ONCE
  })

  // ── MED-4 (security-review PR #438): the dev-simulate switch is fail-CLOSED ─
  // `simulateResult:'success'` bypasses Etherscan entirely, synthesises a
  // `0xSIM…` marker (which the registry rightly ignores) and STILL credits the
  // company account — i.e. "not registered AND credits". The old gate was
  // `NODE_ENV !== 'production'`, so an UNSET or typo'd NODE_ENV ('staging', '')
  // opened it in a real deployment. It now mirrors the hardened EtherscanService
  // rule: only an explicit development/test is non-prod.
  describe('MED-4: dev-simulate is unreachable outside development/test', () => {
    const ORIGINAL_NODE_ENV = process.env['NODE_ENV']
    afterEach(() => {
      if (ORIGINAL_NODE_ENV === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = ORIGINAL_NODE_ENV
    })

    it.each(['staging', 'production', ''])(
      'NODE_ENV=%o → simulate is IGNORED, real verification decides',
      async (nodeEnv) => {
        if (!dbAvailable) return
        process.env['NODE_ENV'] = nodeEnv
        const before = await balance()
        const { requestId } = await seedPayout(SENIOR, '1000')

        // No hash + simulate: with the gate closed there is nothing to verify,
        // so the request is refused instead of minting a 0xSIM credit.
        await expect(
          svc.payPayoutRequest(requestId, undefined, SENIOR, 'success'),
        ).rejects.toBeInstanceOf(BadRequestException)

        const pr = await dbSvc.db.query.payoutRequests.findFirst({
          where: eq(payoutRequests.id, requestId),
        })
        expect(pr?.status).toBe('PENDING')
        expect(await balance()).toBe(before)
      },
    )

    it('NODE_ENV=test → simulate still works (dev rehearsal preserved)', async () => {
      if (!dbAvailable) return
      process.env['NODE_ENV'] = 'test'
      const { requestId, payable } = await seedPayout(SENIOR, '1000')
      const before = await balance()

      const result = await svc.payPayoutRequest(requestId, undefined, SENIOR, 'success')
      expect(result.status).toBe('PAID')
      expect(await balance()).toBeCloseTo(before + payable, 6)
    })
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
