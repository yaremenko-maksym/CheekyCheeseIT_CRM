import { BadRequestException, Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { CompanyAccountService } from './company-account.service'
import type { DepositVerification, EtherscanService } from './etherscan.service'
import { withDerivedMinorUnits, type ScriptedVerification } from './__test-helpers__/etherscan-fake'
import { sweepOrphanConsumedTxHashes } from './__test-helpers__/consumed-tx-hashes'
import { companyAccount, consumedTxHashes, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-company-account-backend — AC3 (auto-credit invariant) + AC4 (idempotency)
 * against REAL PostgreSQL with a controllable EtherscanService.
 *
 *   AC3: a deposit whose on-chain recipient ≠ company wallet, OR whose
 *        confirmations are below the threshold, is NOT credited (stays PENDING,
 *        balance unchanged). A matching + confirmed deposit → PAID, balance +=.
 *   AC4: re-submitting the same txHash does NOT create a second COMPANY_DEPOSIT
 *        and the balance is not doubled.
 *   AC5 (integration): polling getDepositStatus flips PENDING→PAID once the
 *        (mock) confirmations cross the threshold.
 *
 * The Etherscan layer is a controllable fake so we can drive mismatch / pending
 * / confirmed deterministically without the network. The DB, the idempotency
 * index, and the balance derivation are REAL.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- company-account.deposit.integration
 */

const WALLET = '0xfeedfacefeedfacefeedfacefeedfacefeedface'
/**
 * task-onchain-payment-integrity — an exchange hot wallet. The on-chain sender
 * is RECORDED, never enforced (staff withdraw straight from exchanges), so this
 * "foreign" sender must still credit. Lowercase = the stored/normalised form.
 */
const EXCHANGE_WALLET = '0x3333333333333333333333333333333333333333'
const THRESHOLD = 12

const SENIOR: SessionUser = {
  id: 'da110000-0000-4000-aa00-000000000001',
  email: 'dep-senior@test.spec',
  displayName: 'Dep Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ADMIN: SessionUser = {
  ...SENIOR,
  id: 'da110000-0000-4000-aa00-000000000002',
  email: 'dep-admin@test.spec',
  displayName: 'Dep Admin',
  role: 'ADMIN',
  seniorSharePercent: 0,
}

const ALL = [SENIOR, ADMIN]
const TEST_USER_IDS = ALL.map((u) => u.id)
const ACCOUNT_ID = 'da110000-0000-4000-cc00-000000000001'

const HASH_OK = '0x' + 'a'.repeat(64)
const HASH_MISMATCH = '0x' + 'b'.repeat(64)
const HASH_PENDING = '0x' + 'c'.repeat(64)

// ── Controllable fake Etherscan: per-hash scripted verification ───────────────
const verifyScript = new Map<string, ScriptedVerification>()
const fakeEtherscan: Pick<EtherscanService, 'verifyDeposit'> = {
  verifyDeposit: (txHash: string): Promise<DepositVerification> =>
    Promise.resolve(withDerivedMinorUnits(verifyScript.get(txHash))),
}

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
      provide: CompanyAccountService,
      useFactory: (db: DatabaseService) =>
        new CompanyAccountService(db, fakeEtherscan as EtherscanService),
      inject: [DatabaseService],
    },
  ],
})
class DepositTestModule {}

describe('company-account deposits — auto-credit invariant + idempotency (real DB)', () => {
  let svc: CompanyAccountService
  let dbSvc: DatabaseService

  async function clearDeposits() {
    await dbSvc.db
      .delete(transactions)
      .where(
        and(
          eq(transactions.type, 'COMPANY_DEPOSIT'),
          inArray(transactions.senderId, TEST_USER_IDS),
        ),
      )
    await dbSvc.db
      .delete(transactions)
      .where(
        and(
          eq(transactions.type, 'DIVIDEND_TO_ADMIN'),
          inArray(transactions.createdBy, TEST_USER_IDS),
        ),
      )
    // task-onchain-payment-integrity: the consumed-hash registry outlives the
    // deposit row by design, so re-using the fixed test hashes across tests
    // needs an explicit sweep (see the helper's header).
    await sweepOrphanConsumedTxHashes(dbSvc)
  }

  async function balance(): Promise<number> {
    const acc = await svc.getAccount(ADMIN)
    return acc.balance
  }

  beforeAll(async () => {
    try {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probe.query('SELECT 1')
      const check = await probe.query(
        `SELECT table_name FROM information_schema.tables WHERE table_name='company_account' LIMIT 1`,
      )
      await probe.end()
      if (check.rowCount === 0) {
        console.warn('[company-account deposit] SKIPPED — company_account table not found')
        dbAvailable = false
        return
      }
    } catch {
      console.warn('[company-account deposit] SKIPPED — no DB reachable at DATABASE_URL')
      dbAvailable = false
      return
    }

    const moduleRef = await Test.createTestingModule({ imports: [DepositTestModule] }).compile()
    await moduleRef.init()
    svc = moduleRef.get(CompanyAccountService)
    dbSvc = moduleRef.get(DatabaseService)

    const db = dbSvc.db
    await clearDeposits()
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
          googleId: `test-google-${u.id}`,
        })),
      )
      .onConflictDoNothing()

    // Configure the single company_account row to the test wallet.
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
    await clearDeposits()
    verifyScript.clear()
  })

  afterAll(async () => {
    if (!dbAvailable) return
    try {
      await clearDeposits()
      await dbSvc.db.delete(companyAccount).where(inArray(companyAccount.id, [ACCOUNT_ID]))
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
    } catch {
      // non-fatal
    }
    await _pool?.end()
  }, 15_000)

  // ── AC3: recipient mismatch must NOT credit ─────────────────────────────────
  it('SECURITY: deposit to a DIFFERENT recipient → PENDING, balance unchanged', async () => {
    if (!dbAvailable) return
    const before = await balance()
    verifyScript.set(HASH_MISMATCH, {
      found: true,
      toMatches: false,
      confirmed: false,
      confirmations: 99,
      amountUsdt: 1000,
    })
    const dto = await svc.submitDeposit({ txHashOrLink: HASH_MISMATCH }, SENIOR)
    expect(dto.status).toBe('PENDING')
    expect(dto.toMatches).toBe(false)
    expect(await balance()).toBe(before) // no credit
  })

  // ── AC3: below-threshold must NOT credit ────────────────────────────────────
  it('SECURITY: matching recipient but below threshold → PENDING, balance unchanged', async () => {
    if (!dbAvailable) return
    const before = await balance()
    verifyScript.set(HASH_PENDING, {
      found: true,
      toMatches: true,
      confirmed: false,
      confirmations: 3,
      amountUsdt: null,
    })
    const dto = await svc.submitDeposit({ txHashOrLink: HASH_PENDING }, SENIOR)
    expect(dto.status).toBe('PENDING')
    expect(await balance()).toBe(before)
  })

  // ── AC3: confirmed + match → PAID, balance grows ────────────────────────────
  it('confirmed + matching recipient → PAID, balance += amount', async () => {
    if (!dbAvailable) return
    const before = await balance()
    verifyScript.set(HASH_OK, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: 500,
    })
    const dto = await svc.submitDeposit({ txHashOrLink: HASH_OK }, SENIOR)
    expect(dto.status).toBe('PAID')
    expect(dto.amountUsdt).toBe(500)
    expect(await balance()).toBe(before + 500)
  })

  // ── AC4: idempotency — same hash twice ──────────────────────────────────────
  it('IDEMPOTENCY: re-submitting the same txHash → no second row, balance not doubled', async () => {
    if (!dbAvailable) return
    const before = await balance()
    verifyScript.set(HASH_OK, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: 700,
    })
    const first = await svc.submitDeposit({ txHashOrLink: HASH_OK }, SENIOR)
    const afterFirst = await balance()
    expect(afterFirst).toBe(before + 700)

    // Second submit of the SAME hash (even via a full Etherscan link wrapper).
    const second = await svc.submitDeposit(
      { txHashOrLink: `https://etherscan.io/tx/${HASH_OK}` },
      SENIOR,
    )
    expect(second.id).toBe(first.id) // same row returned
    expect(await balance()).toBe(afterFirst) // NOT doubled

    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.type, 'COMPANY_DEPOSIT'), eq(transactions.txHash, HASH_OK)))
    expect(rows.length).toBe(1)
  })

  // ── AC5 (integration): polling flips PENDING → PAID at threshold ────────────
  it('STATUS: getDepositStatus flips PENDING→PAID once confirmations reach threshold', async () => {
    if (!dbAvailable) return
    // Submit while still pending (3 confirmations).
    verifyScript.set(HASH_PENDING, {
      found: true,
      toMatches: true,
      confirmed: false,
      confirmations: 3,
      amountUsdt: null,
    })
    const dto = await svc.submitDeposit({ txHashOrLink: HASH_PENDING }, SENIOR)
    expect(dto.status).toBe('PENDING')

    // Now the chain advances to the threshold; the next poll must credit it.
    verifyScript.set(HASH_PENDING, {
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: 250,
    })
    const status = await svc.getDepositStatus(dto.id, SENIOR)
    expect(status.status).toBe('PAID')
    expect(status.amountUsdt).toBe(250)

    // And the row is now PAID + the balance reflects it.
    const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, dto.id) })
    expect(row?.status).toBe('PAID')
  })

  // ── task-onchain-payment-integrity: recorded sender ─────────────────────────
  it('records the on-chain sender on the deposit row (third-party sender is NOT blocked)', async () => {
    if (!dbAvailable) return
    const HASH = '0x' + '7'.repeat(64)
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      // Mixed-case exchange hot wallet: legitimate (staff withdraw from an
      // exchange), must credit AND be stored normalised.
      fromAddress: EXCHANGE_WALLET.toUpperCase().replace('0X', '0x'),
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: 120,
      amountUsdtMinor: '120000000',
    })

    const dto = await svc.submitDeposit({ txHashOrLink: HASH }, SENIOR)
    expect(dto.status).toBe('PAID')

    const row = await dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, dto.id) })
    expect(row?.txFromAddress).toBe(EXCHANGE_WALLET)
  })

  // ── task-onchain-payment-integrity, HOLE 2: CROSS-PATH double spend ─────────
  // A hash already consumed by a PAID payout must not credit the company
  // account a second time as a deposit. The two paths guard different tables,
  // so before the shared registry this was a real double credit.
  it('SECURITY: a hash already consumed by a PAYOUT cannot be submitted as a deposit', async () => {
    if (!dbAvailable) return
    const HASH = '0x' + '8'.repeat(64)
    const before = await balance()

    // Simulate the payout path having consumed this hash (this suite has no
    // payout fixtures; the payout side of the pair is asserted end-to-end in
    // onchain-tx-cross-path.integration.spec.ts).
    await dbSvc.db
      .insert(consumedTxHashes)
      .values({ txHash: HASH, purpose: 'PAYOUT', referenceId: null, consumedByUserId: SENIOR.id })

    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      fromAddress: EXCHANGE_WALLET,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: 999,
      amountUsdtMinor: '999000000',
    })

    await expect(svc.submitDeposit({ txHashOrLink: HASH }, SENIOR)).rejects.toThrowError(
      /уже использован/,
    )
    // No deposit row, no credit.
    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.type, 'COMPANY_DEPOSIT'), eq(transactions.txHash, HASH)))
    expect(rows.length).toBe(0)
    expect(await balance()).toBe(before)

    await dbSvc.db.delete(consumedTxHashes).where(eq(consumedTxHashes.txHash, HASH))
  })

  // ── RACE (real DB, not a mock): two concurrent submits, one winner ──────────
  it('RACE: two parallel submits of the same hash → exactly one row, balance credited once', async () => {
    if (!dbAvailable) return
    const HASH = '0x' + '6'.repeat(64)
    const before = await balance()
    verifyScript.set(HASH, {
      found: true,
      toMatches: true,
      fromAddress: EXCHANGE_WALLET,
      confirmed: true,
      confirmations: THRESHOLD,
      amountUsdt: 300,
      amountUsdtMinor: '300000000',
    })

    // Fired together so both pass the check-then-act lookups; the DB decides.
    const results = await Promise.allSettled([
      svc.submitDeposit({ txHashOrLink: HASH }, SENIOR),
      svc.submitDeposit({ txHashOrLink: HASH }, SENIOR),
    ])

    // Neither request may 500 — a loser is either the idempotent re-read of the
    // winner's row or a clean 400.
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(BadRequestException)
      }
    }

    const rows = await dbSvc.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.type, 'COMPANY_DEPOSIT'), eq(transactions.txHash, HASH)))
    expect(rows.length).toBe(1) // exactly one deposit row
    expect(await balance()).toBe(before + 300) // credited ONCE

    const registry = await dbSvc.db
      .select({ id: consumedTxHashes.id })
      .from(consumedTxHashes)
      .where(eq(consumedTxHashes.txHash, HASH))
    expect(registry.length).toBe(1) // the unique index held
  })
})
