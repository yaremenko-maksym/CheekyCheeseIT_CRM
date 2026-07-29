import {
  BadRequestException,
  ForbiddenException,
  Global,
  Module,
  NotFoundException,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { readFileSync } from 'fs'
import { join } from 'path'
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
  transactionAuditLog,
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
    //
    // ARCHIVED on purpose: `crm_qa` is shared between spec files, and other
    // suites assert on GLOBAL counters (hr-summary's `activeProjects` delta).
    // An archived project is excluded from every "active projects" query, so
    // this fixture cannot perturb them whatever the file order — while the
    // admin-income path itself does not gate on `archivedAt`.
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
        archivedAt: new Date('2026-01-02T00:00:00Z'),
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
      // Remove the fixture project EXPLICITLY (not via the users cascade): a
      // stray non-archived project shifts the global project counts other
      // suites assert on (hr-summary activeProjects deltas).
      await dbSvc.db.delete(projects).where(eq(projects.id, ADMIN_PROJECT_ID))
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

  // ── MED-E (security-review round 3): receipt swap cannot re-point a credit ─
  // A company-funded ADMIN_INCOME is credited on the strength of its receipt,
  // whose hash is claimed. Swapping that receipt afterwards was unchecked, so
  // the row could be re-pointed at a transfer another settlement had already
  // spent — two crediting rows, one transfer.
  describe('MED-E: receipt swap on a credited admin income', () => {
    it('REFUSES a new receipt whose hash is already spent elsewhere', async () => {
      if (!dbAvailable) return
      const INCOME_HASH = '0x' + 'e1'.repeat(32)
      const DEPOSIT_HASH = '0x' + 'e2'.repeat(32)

      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 700,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${INCOME_HASH}`,
        },
        ADMIN,
      )
      // A separate, legitimate deposit consumes the OTHER transfer.
      scriptValid(DEPOSIT_HASH, 700)
      await companySvc.submitDeposit({ txHashOrLink: DEPOSIT_HASH }, SENIOR)
      const afterBoth = await balance()

      // Re-pointing the income's evidence at the deposit's transfer is refused.
      await expect(
        svc.attachOrReplaceReceipt(
          income.id,
          { receiptExternalUrl: `https://etherscan.io/tx/${DEPOSIT_HASH}` },
          ADMIN,
        ),
      ).rejects.toThrowError(/уже использован/)

      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.txHash).toBe(INCOME_HASH) // evidence unchanged
      expect(await balance()).toBeCloseTo(afterBoth, 6)
    })

    // ── MED-F (round 4): the SECOND receipt entrance must obey the same rule ──
    // Round 3 guarded `attachOrReplaceReceipt` only; `PATCH :id/admin-edit`
    // edits the same field on the same PAID crediting row.
    it('admin-edit REFUSES a receipt whose hash is already spent elsewhere', async () => {
      if (!dbAvailable) return
      const INCOME_HASH = '0x' + 'e5'.repeat(32)
      const DEPOSIT_HASH = '0x' + 'e6'.repeat(32)

      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 800,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${INCOME_HASH}`,
        },
        ADMIN,
      )
      scriptValid(DEPOSIT_HASH, 800)
      await companySvc.submitDeposit({ txHashOrLink: DEPOSIT_HASH }, SENIOR)
      const afterBoth = await balance()

      await expect(
        svc.adminUpdateTransaction(
          income.id,
          { receiptExternalUrl: `https://etherscan.io/tx/${DEPOSIT_HASH}` },
          ADMIN,
        ),
      ).rejects.toThrowError(/уже использован/)

      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.txHash).toBe(INCOME_HASH) // evidence unchanged
      expect(row?.receiptExternalUrl).toBe(`https://etherscan.io/tx/${INCOME_HASH}`)
      expect(await balance()).toBeCloseTo(afterBoth, 6)
    })

    it('admin-edit claims the new transfer on an honest correction', async () => {
      if (!dbAvailable) return
      const WRONG_HASH = '0x' + 'e7'.repeat(32)
      const RIGHT_HASH = '0x' + 'e8'.repeat(32)

      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 250,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${WRONG_HASH}`,
        },
        ADMIN,
      )

      await svc.adminUpdateTransaction(
        income.id,
        { receiptExternalUrl: `https://etherscan.io/tx/${RIGHT_HASH}` },
        ADMIN,
      )

      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.txHash).toBe(RIGHT_HASH)
      const claimed = await dbSvc.db
        .select({ purpose: consumedTxHashes.purpose })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, RIGHT_HASH))
      expect(claimed.length).toBe(1)
    })

    // ── MED-G (round 4): the guard compares the claim OWNER, not the value ────
    it('re-attaching the row OWN receipt is allowed (no false rejection)', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'e9'.repeat(32)
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 310,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${HASH}`,
        },
        ADMIN,
      )

      // The row already owns this claim — a value-only comparison would have
      // rejected the user on their own data.
      await expect(
        svc.attachOrReplaceReceipt(
          income.id,
          { receiptExternalUrl: `https://etherscan.io/tx/${HASH}?utm=mail` },
          ADMIN,
        ),
      ).resolves.toBeDefined()
      await expect(
        svc.adminUpdateTransaction(
          income.id,
          { receiptExternalUrl: `https://etherscan.io/tx/${HASH}#eventlog` },
          ADMIN,
        ),
      ).resolves.toBeDefined()

      const claimed = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(claimed.length).toBe(1) // still exactly one claim
    })

    it('a receipt that DROPS the hash keeps the claim and records the divergence', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'ea'.repeat(32)
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 150,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${HASH}`,
        },
        ADMIN,
      )

      await svc.attachOrReplaceReceipt(
        income.id,
        { receiptExternalUrl: 'https://etherscan.io/address/0xabc' },
        ADMIN,
      )

      // The claim STAYS — that transfer really funded this credit…
      const claimed = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(claimed.length).toBe(1)
      // …the recorded hash stays with it (column and registry agree)…
      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.txHash).toBe(HASH)
      // …and the divergence is recorded rather than silent.
      const audit = await dbSvc.db.query.transactionAuditLog.findFirst({
        where: and(
          eq(transactionAuditLog.targetId, income.id),
          eq(transactionAuditLog.action, 'RECEIPT_DROPPED_ONCHAIN_HASH'),
        ),
      })
      expect(audit).toBeDefined()
    })

    // ── MED-Q (round 6): only a REGISTRY conflict may blame the hash ─────────
    // The reviewer's counterexample: an admin edit that also sets `salaryMonth`
    // can trip `uq_transactions_salary_receiver_month`. Reporting that as
    // «хеш уже использован» sends the operator hunting a hash they never
    // touched — the same "confidently wrong message" class fixed elsewhere.
    it('admin-edit does NOT report an unrelated unique violation as a hash reuse', async () => {
      if (!dbAvailable) return
      const takenMonth = '2031-03'
      const freeMonth = '2031-04'

      // `uq_transactions_salary_receiver_month` is PARTIAL — it binds only rows
      // with `type='SALARY' AND salary_month IS NOT NULL`. So the row under
      // edit must itself be a SALARY, and it must be UNPAID: a PAID row is
      // rejected by the settled-fields guard long before the claim handler this
      // test is about. (Round 6 used a PAID ADMIN_INCOME and therefore proved
      // nothing — MED-R.)
      await dbSvc.db.insert(transactions).values({
        type: 'SALARY',
        status: 'PENDING',
        amount: '100',
        currency: 'USDT',
        receiverId: SENIOR.id,
        salaryMonth: takenMonth,
        createdBy: ADMIN.id,
      })
      const [editable] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'SALARY',
          status: 'PENDING',
          amount: '120',
          currency: 'USDT',
          receiverId: SENIOR.id,
          salaryMonth: freeMonth,
          createdBy: ADMIN.id,
        })
        .returning()

      // Moving it onto the taken month trips the SALARY index — a conflict that
      // has nothing to do with any tx hash.
      const err = await svc
        .adminUpdateTransaction(editable!.id, { salaryMonth: takenMonth }, ADMIN)
        .then(
          () => null,
          (e: unknown) => e,
        )

      expect(err).not.toBeNull()
      // The whole point: the operator must NOT be sent hunting a hash.
      expect(String((err as Error).message)).not.toMatch(/уже использован/)

      await dbSvc.db
        .delete(transactions)
        .where(
          and(
            eq(transactions.type, 'SALARY'),
            inArray(transactions.salaryMonth, [takenMonth, freeMonth]),
          ),
        )
    })

    it('ALLOWS an honest correction and claims the new transfer', async () => {
      if (!dbAvailable) return
      const WRONG_HASH = '0x' + 'e3'.repeat(32)
      const RIGHT_HASH = '0x' + 'e4'.repeat(32)

      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 400,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${WRONG_HASH}`,
        },
        ADMIN,
      )

      await svc.attachOrReplaceReceipt(
        income.id,
        { receiptExternalUrl: `https://etherscan.io/tx/${RIGHT_HASH}` },
        ADMIN,
      )

      const row = await dbSvc.db.query.transactions.findFirst({
        where: eq(transactions.id, income.id),
      })
      expect(row?.txHash).toBe(RIGHT_HASH) // evidence AND recorded hash move together

      // The corrected transfer is now claimed…
      const claimed = await dbSvc.db
        .select({ purpose: consumedTxHashes.purpose })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, RIGHT_HASH))
      expect(claimed.length).toBe(1)
      expect(claimed[0]!.purpose).toBe('ADMIN_INCOME')

      // …so it can no longer be credited a second time as a deposit.
      scriptValid(RIGHT_HASH, 400)
      await expect(
        companySvc.submitDeposit({ txHashOrLink: RIGHT_HASH }, SENIOR),
      ).rejects.toBeInstanceOf(BadRequestException)
    })
  })

  // ── MED-G (round 4): a claim must be releasable, or the fix becomes a lock ──
  // A permanent claim turns a typo into a permanent burn and can strand a
  // deposit that can never be credited. The release is ADMIN-only and journaled.
  describe('MED-G: releasing a mis-claimed hash', () => {
    it('unsticks a deposit whose hash was claimed by someone else', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'f1'.repeat(32)
      const before = await balance()

      // The real payer submits their deposit while the tx is still unconfirmed:
      // nothing is claimed yet (MED-3), so this is allowed.
      verifyScript.set(HASH, {
        found: true,
        toMatches: true,
        fromAddress: EXCHANGE_WALLET,
        confirmed: false,
        confirmations: 1,
        amountUsdt: 500,
      })
      const dep = await companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR2)
      expect(dep.status).toBe('PENDING')

      // …then someone settles a payout with that same hash (a typo — the
      // transfer was not theirs), consuming it first.
      const { requestId, payable } = await seedPayout(SENIOR, '1000')
      scriptValid(HASH, payable)
      await svc.payPayoutRequest(requestId, HASH, SENIOR)

      // Now the honest deposit can NEVER be credited — this is the lock-out.
      scriptValid(HASH, 500)
      await expect(companySvc.getDepositStatus(dep.id, SENIOR2)).rejects.toBeInstanceOf(
        BadRequestException,
      )

      // ADMIN releases the claim, with a reason.
      const released = await svc.releaseOnChainHash(
        HASH,
        'payout settled with a typo’d hash',
        ADMIN,
      )
      expect(released.purpose).toBe('PAYOUT')
      expect(released.referenceId).toBe(requestId)

      // …and the deposit can finally be credited.
      const status = await companySvc.getDepositStatus(dep.id, SENIOR2)
      expect(status.status).toBe('PAID')
      expect(await balance()).toBeCloseTo(before + payable + 500, 6)
    })

    it('is journaled: who, which hash, which claim, why', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'f2'.repeat(32)
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 90,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${HASH}`,
        },
        ADMIN,
      )

      await svc.releaseOnChainHash(HASH, 'wrong receipt pasted by support', ADMIN)

      const audit = await dbSvc.db.query.transactionAuditLog.findFirst({
        where: and(
          eq(transactionAuditLog.targetId, income.id),
          eq(transactionAuditLog.action, 'ONCHAIN_HASH_RELEASED'),
        ),
      })
      expect(audit).toBeDefined()
      expect(audit?.actorId).toBe(ADMIN.id)
      expect(audit?.metadata).toMatchObject({
        txHash: HASH,
        purpose: 'ADMIN_INCOME',
        referenceId: income.id,
        reason: 'wrong receipt pasted by support',
      })
    })

    it('RBAC: only ADMIN may release; a reason is mandatory', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'f3'.repeat(32)
      const { requestId, payable } = await seedPayout(SENIOR, '1000')
      scriptValid(HASH, payable)
      await svc.payPayoutRequest(requestId, HASH, SENIOR)

      // The submitter must NOT be able to un-spend their own transfer —
      // otherwise "release then re-spend" is the new double-spend.
      await expect(svc.releaseOnChainHash(HASH, 'let me redo it', SENIOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      await expect(svc.releaseOnChainHash(HASH, '   ', ADMIN)).rejects.toThrowError(/причину/)

      // Still claimed after both refusals.
      const rows = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(rows.length).toBe(1)
    })

    // ── MED-J (round 5): tombstone, not deletion ─────────────────────────────
    it('leaves a TOMBSTONE carrying who released it, when and why', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'f5'.repeat(32)
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 60,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${HASH}`,
        },
        ADMIN,
      )

      await svc.releaseOnChainHash(HASH, 'duplicate receipt', ADMIN)

      // The row SURVIVES (a DELETE would erase the evidence while the double
      // credit stayed in the ledger).
      const rows = await dbSvc.db
        .select()
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(rows.length).toBe(1)
      expect(rows[0]!.releasedAt).not.toBeNull()
      expect(rows[0]!.releasedBy).toBe(ADMIN.id)
      expect(rows[0]!.releasedReason).toBe('duplicate receipt')
      expect(rows[0]!.referenceId).toBe(income.id)
    })

    it('records the RE-CLAIM of a released transfer (the other half of the pair)', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'f6'.repeat(32)
      await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 70,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${HASH}`,
        },
        ADMIN,
      )
      await svc.releaseOnChainHash(HASH, 'mistake', ADMIN)

      // Spent again — legitimate (that is what a release is FOR)…
      scriptValid(HASH, 70)
      const dep = await companySvc.submitDeposit({ txHashOrLink: HASH }, SENIOR)
      expect(dep.status).toBe('PAID')

      // …and the second half of the pair is now reconstructable.
      const audit = await dbSvc.db.query.transactionAuditLog.findFirst({
        where: and(
          eq(transactionAuditLog.targetId, dep.id),
          eq(transactionAuditLog.action, 'ONCHAIN_HASH_RECLAIMED_AFTER_RELEASE'),
        ),
      })
      expect(audit).toBeDefined()
      expect(audit?.metadata).toMatchObject({ path: 'submitDeposit', txHash: HASH })

      // Both rows coexist: the tombstone and the fresh ACTIVE claim.
      const rows = await dbSvc.db
        .select({ releasedAt: consumedTxHashes.releasedAt })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(rows.length).toBe(2)
      expect(rows.filter((r) => r.releasedAt === null).length).toBe(1)
    })

    // ── MED-K (round 5): look before you release ─────────────────────────────
    it('inspection shows the owner and whether the referent still credits', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'f7'.repeat(32)
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 45,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${HASH}`,
        },
        ADMIN,
      )

      const before = await svc.inspectOnChainHash(HASH, ADMIN)
      expect(before).toMatchObject({
        claimed: true,
        purpose: 'ADMIN_INCOME',
        referenceId: income.id,
        consumedByUserId: ADMIN.id,
        // The decisive fact: the money is still on the books, so releasing
        // makes this transfer spendable a SECOND time.
        referent: { exists: true, settled: true, creditsCompanyAccount: true },
      })

      // The release reports the same consequence in its response.
      const released = await svc.releaseOnChainHash(HASH, 'checked first', ADMIN)
      expect(released.referent).toMatchObject({ settled: true, creditsCompanyAccount: true })

      // After the release the tombstone is still inspectable.
      const after = await svc.inspectOnChainHash(HASH, ADMIN)
      expect(after).toMatchObject({ claimed: false, releasedBy: ADMIN.id })
    })

    // ── MED-P (round 6): "does not credit" is NOT "safe to release" ──────────
    it('a CASH-settled payout reports settled=true with creditsCompanyAccount=false', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'fa'.repeat(32)
      const { requestId } = await seedPayout(SENIOR, '1000')

      // Manual CASH confirmation: a REAL transfer settled it, but the money
      // never entered the pool — `fundingSource` stays null.
      await svc.manualConfirmPayout(requestId, 'CASH', ADMIN, { txHash: HASH })

      const view = await svc.inspectOnChainHash(HASH, ADMIN)
      expect(view).toMatchObject({
        claimed: true,
        purpose: 'PAYOUT',
        referent: {
          exists: true,
          // The transfer WAS spent…
          settled: true,
          // …it just never credited the company account. Releasing this claim
          // still makes a real transfer spendable a second time.
          creditsCompanyAccount: false,
          fundingSource: null,
        },
      })
    })

    // ── LOW-1 (round 7): imported payouts have no PAYOUT stub row ────────────
    // The accounting import brought over settled payouts without the
    // placeholder ledger row `describeReferent` reads. Reporting "not found"
    // for those reads as "safe to release" — on REAL imported data.
    it('an imported payout with no PAYOUT ledger row still reports settled', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'fd'.repeat(32)

      // A payout_request settled the way the import left them: PAID, carrying
      // its hash, with NO PAYOUT transaction row behind it.
      const [imported] = await dbSvc.db
        .insert(payoutRequests)
        .values({
          seniorId: SENIOR.id,
          incomeAmount: '1000',
          payableAmount: '740',
          contractAddress: WALLET,
          txHash: HASH,
          status: 'PAID',
        })
        .returning()
      await dbSvc.db.insert(consumedTxHashes).values({
        txHash: HASH,
        purpose: 'PAYOUT',
        referenceId: imported!.id,
        consumedByUserId: SENIOR.id,
      })

      const view = await svc.inspectOnChainHash(HASH, ADMIN)
      expect(view).toMatchObject({
        claimed: true,
        purpose: 'PAYOUT',
        referent: {
          // The settlement is VISIBLE even without the stub row…
          exists: true,
          settled: true,
          status: 'PAID',
          // …and it correctly does not claim to credit the pool (no ledger row
          // for the balance formula to sum).
          creditsCompanyAccount: false,
        },
      })

      await dbSvc.db.delete(consumedTxHashes).where(eq(consumedTxHashes.txHash, HASH))
      await dbSvc.db.delete(payoutRequests).where(eq(payoutRequests.id, imported!.id))
    })

    it('inspection reports an unknown hash and is denied to non-finance roles', async () => {
      if (!dbAvailable) return
      const UNKNOWN = '0x' + 'f8'.repeat(32)
      await expect(svc.inspectOnChainHash(UNKNOWN, ADMIN)).resolves.toMatchObject({
        claimed: false,
      })
      await expect(svc.inspectOnChainHash(UNKNOWN, SENIOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })

    it('404s on a hash nobody claimed', async () => {
      if (!dbAvailable) return
      await expect(
        svc.releaseOnChainHash('0x' + 'f4'.repeat(32), 'nothing to release', ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  })

  // ── HIGH-4 (security-review round 2): the prod backfill must skip PENDING ──
  // The migration back-fills historic settlements into the registry. Claiming a
  // PENDING deposit would BRICK it: `consumeTxHash` is a bare INSERT, so the
  // later confirm-flip would hit 23505 and roll back forever — and it would
  // re-open the griefing MED-3 closed. This test runs the migration's own
  // deposit predicate against real data.
  describe('HIGH-4: backfill claims only PAID deposits', () => {
    /**
     * Run the REAL migration file — not a hand-copied excerpt.
     *
     * LOW (security-review round 3): a transcribed SQL snippet drifts silently
     * from the file that actually ships to production, and this backfill is
     * exactly where a drift would be invisible AND expensive (see the bricking
     * test below). Executing the file means these tests fail if the shipped
     * predicate changes. The script is idempotent by construction, so running
     * it mid-suite is safe.
     */
    async function runMigrationFile(keepHashes: string[]) {
      const before = await dbSvc.db.select({ id: consumedTxHashes.id }).from(consumedTxHashes)
      const preExisting = new Set(before.map((r) => r.id))

      // Read the SHIPPED file and execute its BACKFILL statements — the part
      // under test. Extracting them (instead of transcribing) is what makes a
      // drift between this test and production impossible. The DDL
      // (CREATE TABLE/INDEX, ALTER) and the audit DO-block are deliberately
      // skipped: they are not what these tests assert, and running DDL mid-suite
      // takes ACCESS EXCLUSIVE locks on `transactions` for every other spec.
      const sqlPath = join(__dirname, '../../drizzle/manual/2026-07-27_consumed_tx_hashes.sql')
      const backfillStatements = readFileSync(sqlPath, 'utf8')
        .split(/;\s*\n/)
        .filter((stmt) => /INSERT\s+INTO\s+consumed_tx_hashes/i.test(stmt))
      expect(backfillStatements.length).toBe(3) // payout + deposit + admin-income
      for (const stmt of backfillStatements) {
        await dbSvc.db.execute(sql.raw(`${stmt};`))
      }

      // The script is GLOBAL by design — it back-fills EVERY historic
      // settlement in the database. Run mid-suite it therefore also claims
      // fixtures left behind by OTHER spec files (crm_qa is shared and rows
      // survive between files), whose fixed test hashes would then hit a
      // legitimate «уже использован» when those suites settle them. Keep only
      // the rows this test asserts on and undo the collateral, so exercising
      // the REAL file stays side-effect-free for everyone else.
      const after = await dbSvc.db
        .select({
          id: consumedTxHashes.id,
          txHash: consumedTxHashes.txHash,
          referenceId: consumedTxHashes.referenceId,
        })
        .from(consumedTxHashes)

      // MED-H (round 4): report what the backfill created BEFORE the cleanup.
      // Asserting after the cleanup made the "claims nothing" test unfalsifiable
      // — the cleanup deleted the very row a broken backfill would have written,
      // so it passed either way. Tests now assert on this snapshot.
      const createdByBackfill = after.filter((r) => !preExisting.has(r.id))

      const collateral = createdByBackfill
        .filter((r) => !keepHashes.includes(r.txHash))
        .map((r) => r.id)
      if (collateral.length > 0) {
        await dbSvc.db.delete(consumedTxHashes).where(inArray(consumedTxHashes.id, collateral))
      }
      return createdByBackfill
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
      await runMigrationFile([HASH])
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
        ON CONFLICT (tx_hash) WHERE released_at IS NULL DO NOTHING
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

    // ── MED-N (round 6): the backfill must never undo a release ──────────────
    // `payout_requests.tx_hash` is immutable after settlement, so the row stays
    // in the backfill's SELECT forever. Without the NOT EXISTS guard every
    // deploy would hand the released hash a fresh ACTIVE claim — silently
    // cancelling the release and re-bricking the deposit it was granted for.
    it('a RELEASED claim survives repeated backfill runs (deploys)', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'fb'.repeat(32)
      const { requestId, payable } = await seedPayout(SENIOR, '1000')
      scriptValid(HASH, payable)
      await svc.payPayoutRequest(requestId, HASH, SENIOR)

      await svc.releaseOnChainHash(HASH, 'settled with the wrong hash', ADMIN)

      // Three consecutive deploys.
      await runMigrationFile([HASH])
      await runMigrationFile([HASH])
      await runMigrationFile([HASH])

      const rows = await dbSvc.db
        .select({ releasedAt: consumedTxHashes.releasedAt })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      // Still exactly the tombstone — no resurrected ACTIVE claim.
      expect(rows.length).toBe(1)
      expect(rows.filter((r) => r.releasedAt === null).length).toBe(0)

      // …and the transfer is still settleable, which is the whole point.
      expect(await svc.inspectOnChainHash(HASH, ADMIN)).toMatchObject({ claimed: false })
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
      await runMigrationFile([HASH])

      const rows = await dbSvc.db
        .select({ referenceId: consumedTxHashes.referenceId })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(rows.length).toBe(1)
      expect(rows[0]!.referenceId).toBe(dep.id)
    })

    // ── MED-D: the THIRD backfill term (admin income) had no coverage at all ──
    // It extracts the hash from a free-text receipt URL with `regexp_match` on
    // live money rows — the least verifiable statement in the script.
    it('back-fills a company-funded ADMIN_INCOME from its explorer receipt', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'c5'.repeat(32)
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 900,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          receiptExternalUrl: `https://etherscan.io/tx/${HASH}`,
        },
        ADMIN,
      )

      // Pre-migration world: the app's own claim is removed, the backfill must
      // restore it from the receipt link alone.
      await dbSvc.db.delete(consumedTxHashes).where(eq(consumedTxHashes.txHash, HASH))
      await runMigrationFile([HASH])

      const rows = await dbSvc.db
        .select({ purpose: consumedTxHashes.purpose, referenceId: consumedTxHashes.referenceId })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(rows.length).toBe(1)
      expect(rows[0]!.purpose).toBe('ADMIN_INCOME')
      expect(rows[0]!.referenceId).toBe(income.id)
    })

    it('does NOT back-fill a PERSONAL admin income (it never credited the pool)', async () => {
      if (!dbAvailable) return
      const HASH = '0x' + 'c6'.repeat(32)
      // No fundingSource → personal declaration; the transfer belongs to the
      // admin's own wallet and must stay spendable by its real payer.
      await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 120,
          currency: 'USDT',
          receiptExternalUrl: `https://etherscan.io/tx/${HASH}`,
        },
        ADMIN,
      )

      // Keep the hash so a wrong claim would SURVIVE to the assertion (MED-H).
      const created = await runMigrationFile([HASH])
      expect(created.filter((r) => r.txHash === HASH)).toEqual([])

      const rows = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.txHash, HASH))
      expect(rows.length).toBe(0)
    })

    it('does NOT back-fill an admin income whose receipt carries no hash', async () => {
      if (!dbAvailable) return
      const income = await svc.createAdminIncome(
        {
          projectId: ADMIN_PROJECT_ID,
          amount: 130,
          currency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
          // An address link passes receipt validation but carries no tx hash.
          receiptExternalUrl: 'https://etherscan.io/address/0xabc',
        },
        ADMIN,
      )
      // MED-H: assert on what the backfill actually WROTE, captured before the
      // helper's collateral cleanup. Previously the cleanup removed any claim
      // this row produced BEFORE the assertion ran, so the test passed even on
      // a backfill that wrongly claimed — it could not fail.
      const created = await runMigrationFile([])
      expect(created.filter((r) => r.referenceId === income.id)).toEqual([])

      const rows = await dbSvc.db
        .select({ id: consumedTxHashes.id })
        .from(consumedTxHashes)
        .where(eq(consumedTxHashes.referenceId, income.id))
      expect(rows.length).toBe(0)

      // …and the credit-without-claim is RECORDED (MED-1), not silent.
      const audit = await dbSvc.db.query.transactionAuditLog.findFirst({
        where: and(
          eq(transactionAuditLog.targetId, income.id),
          eq(transactionAuditLog.action, 'CREDIT_WITHOUT_ONCHAIN_CLAIM'),
        ),
      })
      expect(audit).toBeDefined()
      expect(audit?.metadata).toMatchObject({ path: 'createAdminIncome' })
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
